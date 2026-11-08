import crypto from "node:crypto";
import { Webhook } from "svix";
import { tx } from "../db";

export function agentMailInboundStatus(){
  const mode=process.env.AGENTMAIL_INBOUND_MODE??"test";
  const secret=process.env.AGENTMAIL_WEBHOOK_SECRET??"";
  const missing=[!secret?"AGENTMAIL_WEBHOOK_SECRET":null,!process.env.AGENTMAIL_INBOX_ID?"AGENTMAIL_INBOX_ID":null].filter((v):v is string=>!!v);
  const issues:string[]=[];
  if(!["test","live"].includes(mode))issues.push("AGENTMAIL_INBOUND_MODE must be test or live");
  if(secret){try{if(!secret.startsWith("whsec_"))throw new Error();new Webhook(secret);}catch{issues.push("AGENTMAIL_WEBHOOK_SECRET must be a valid Svix signing secret");}}
  return {provider:"agentmail",ready:missing.length===0&&issues.length===0,mode,missing,issues,
    detail:"Register /api/webhooks/agentmail for message.received. Inbox matching and server-configured test/live provenance apply; received email never authenticates access to an existing job."};
}
export function verifyAgentMail(raw:Buffer,headers:Headers){
  const secret=process.env.AGENTMAIL_WEBHOOK_SECRET;if(!secret)throw new Error("AgentMail signing secret is not configured");
  const id=headers.get("svix-id")??"",stamp=headers.get("svix-timestamp")??"",signature=headers.get("svix-signature")??"";
  if(!id||id.length>300||/[\s,]/.test(id)||!/^\d+$/.test(stamp)||signature.length>4096)throw new Error("Invalid Svix headers");
  new Webhook(secret).verify(raw,{"svix-id":id,"svix-timestamp":stamp,"svix-signature":signature});
  return {event:JSON.parse(raw.toString("utf8")),deliveryId:id};
}
function senderAddress(raw:unknown):{name:string;email:string}|null{
  if(typeof raw!=="string"||raw.length>1000||/[\r\n]/.test(raw))return null;
  const s=raw.trim(),match=s.match(/^(.*?)\s*<([^<>]+)>$/);
  const address=(match?match[2]:s).trim();
  if(address.length>254||!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(address))return null;
  if(match&&/[<>]/.test(match[1]))return null;
  const name=match?match[1].trim().replace(/^"|"$/g,""):address;
  return {name:(name.length>=2?name:address).slice(0,160),email:address.toLowerCase()};
}
function htmlPreview(raw:string){
  // Plain-text display only. Exact HTML remains in the private receipt; no HTML is rendered or fetched.
  return raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"").replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi,"\n")
    .replace(/<[^>]*>/g,"").replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,s=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":"\"","&apos;":"'","&nbsp;":" "}[s]!));
}
export async function receiveAgentMail(raw:Buffer,event:any,deliveryId:string){
  if(event?.type!=="event"||typeof event.event_id!=="string"||!event.event_id||event.event_id.length>256||/[\u0000-\u001f]/.test(event.event_id)||typeof event.event_type!=="string")throw new Error("Invalid AgentMail event envelope");
  const hash=crypto.createHash("sha256").update(raw).digest("hex"),isTest=(process.env.AGENTMAIL_INBOUND_MODE??"test")!=="live";
  return tx(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["agentmail:"+event.event_id]);
    const old=(await c.query("SELECT payload_sha256,outcome,inquiry_id,is_test FROM commerce_inbound_messages WHERE event_id=$1",[event.event_id])).rows[0];
    if(old){if(old.payload_sha256!==hash)throw new Error("Conflicting AgentMail event replay");return{received:true,duplicate:true,outcome:old.outcome,isTest:old.is_test};}
    const m=event.message??{},sender=senderAddress(m.from);
    let outcome:"inquiry"|"ignored"|"needs_review"="inquiry",reason:string|null=null;
    // a reply on a thread started by prospect outreach (lib/outreach.ts) is recorded against that prospect
    const outreach=typeof m.thread_id==="string"&&m.thread_id?(await c.query("SELECT * FROM outreach_messages WHERE thread_id=$1 AND status='sent' ORDER BY id DESC LIMIT 1",[m.thread_id])).rows[0]??null:null;
    const inboxOk=m.inbox_id===process.env.AGENTMAIL_INBOX_ID||(!!outreach&&m.inbox_id===outreachInbox());
    if(event.event_type!=="message.received"){outcome="ignored";reason="Unsupported or filtered event type";}
    else if(!inboxOk){outcome="ignored";reason="Event does not match the configured inbox";}
    else if(typeof m.message_id!=="string"||!sender){outcome="needs_review";reason="Missing message ID or ambiguous sender";}
    else if(Array.isArray(m.labels)&&m.labels.some((l:unknown)=>typeof l==="string"&&["spam","blocked","unauthenticated"].includes(l.toLowerCase()))){outcome="ignored";reason="Filtered message label";}
    const plain=typeof m.text==="string"?m.text:typeof m.html==="string"?htmlPreview(m.html):null;
    if(outcome==="inquiry"&&(!plain?.trim())){outcome="needs_review";reason="Message has no usable inline body; review it in AgentMail before intake";}
    let inquiryId:number|null=null;
    if(outcome==="inquiry"&&outreach&&sender){
      const { recordOutreachReply } = await import("../outreach");
      const r=await recordOutreachReply(c,outreach,{messageId:m.message_id,from:String(m.from),subject:typeof m.subject==="string"?m.subject:"",text:plain??""});
      inquiryId=r.inquiryId;
      if(r.kind!=="reply"){outcome="ignored";reason=`Outreach ${r.kind.replace("_"," ")} recorded for prospect ${outreach.prospect_id}`;}
    }
    else if(outcome==="inquiry"&&sender){
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["inquiry:"+sender.email]);
      const recent=(await c.query("SELECT count(*)::int AS n FROM commerce_inquiries WHERE email=$1 AND created_at>now()-interval '1 hour'",[sender.email])).rows[0].n;
      if(recent>=5){outcome="needs_review";reason="Inbound inquiry volume limit reached for this sender";}
      else{
        const subject=typeof m.subject==="string"?m.subject:"(no subject)";
        const fullGoal=`Subject: ${subject}\n\n${plain}`;
        const goal=fullGoal.length<=10000?fullGoal:fullGoal.slice(0,9890)+"\n[Preview truncated. The full original email remains in the private incoming receipt.]";
        const inserted=await c.query(`INSERT INTO commerce_inquiries(public_id,name,email,organization,goal,is_test,source,external_event_id,payload_sha256)
          VALUES($1,$2,$3,'Email inquiry',$4,$5,'agentmail_native',$6,$7) RETURNING id`,
          [crypto.randomUUID(),sender.name,sender.email,goal,isTest,"agentmail:"+event.event_id,hash]);
        inquiryId=inserted.rows[0].id;
      }
    }
    const string=(v:unknown)=>typeof v==="string"?v:null;
    await c.query(`INSERT INTO commerce_inbound_messages(event_id,svix_id,event_type,payload_sha256,inbox_id,message_id,sender,subject,text_body,html_body,is_test,outcome,reason,inquiry_id,outreach_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [event.event_id,deliveryId,event.event_type,hash,string(m.inbox_id),string(m.message_id),string(m.from),string(m.subject),string(m.text),string(m.html),isTest,outcome,reason,inquiryId,outreach?.id??null]);
    await c.query(`INSERT INTO commerce_webhook_events(provider,event_id,event_type,payload_sha256) VALUES('agentmail',$1,$2,$3)`,[event.event_id,event.event_type,hash]);
    await c.query(`INSERT INTO events(job_id,actor,kind,summary,detail,origin) VALUES(NULL,'customer','message',$1,$2,'tool')`,
      [`${isTest?"TEST ":""}AgentMail inbound event recorded: ${outcome}.`,JSON.stringify({event_id:event.event_id,inquiry_id:inquiryId,outcome,reason})]);
    return{received:true,duplicate:false,outcome,isTest};
  });
}

// ------------------------------------------------------------------ outbound (prospect outreach)

const AGENTMAIL_API = "https://api.agentmail.to/v0";
export const outreachInbox = () => process.env.AGENTMAIL_OUTREACH_INBOX_ID || process.env.AGENTMAIL_INBOX_ID || "";

/** The HTTP status is kept so callers can tell a definite rejection (nothing sent) from an unknown outcome. */
export class AgentMailError extends Error { constructor(message: string, readonly status: number | null) { super(message); } }

async function agentMail(path: string, init: RequestInit = {}) {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new AgentMailError("AGENTMAIL_API_KEY is not configured", 0);
  let res: Response;
  try {
    res = await fetch(AGENTMAIL_API + path, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000) });
  } catch (e) { throw new AgentMailError(`AgentMail request did not complete: ${(e as Error).message}`, null); }
  const text = await res.text();
  if (!res.ok) throw new AgentMailError(`AgentMail returned HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  try { return JSON.parse(text); } catch { throw new AgentMailError("AgentMail returned a response that is not JSON", null); }
}

export async function agentMailSend(msg: { to: string; subject: string; text: string; labels?: string[] }) {
  const inbox = outreachInbox();
  if (!inbox) throw new AgentMailError("AGENTMAIL_OUTREACH_INBOX_ID (or AGENTMAIL_INBOX_ID) is not configured", 0);
  const r = await agentMail(`/inboxes/${encodeURIComponent(inbox)}/messages/send`, { method: "POST",
    body: JSON.stringify({ to: [msg.to], subject: msg.subject, text: msg.text, labels: msg.labels ?? [] }) });
  if (typeof r?.message_id !== "string" || !r.message_id) throw new AgentMailError("AgentMail did not return a message id; reconcile before retrying", null);
  return { messageId: r.message_id as string, threadId: typeof r.thread_id === "string" ? r.thread_id : null };
}

export type ThreadMessage = { message_id: string; labels: string[]; from: string; subject: string; text: string; timestamp: string };
export async function agentMailThread(threadId: string): Promise<ThreadMessage[]> {
  const r = await agentMail(`/inboxes/${encodeURIComponent(outreachInbox())}/threads/${encodeURIComponent(threadId)}`);
  return (Array.isArray(r?.messages) ? r.messages : []).map((m: any) => ({ message_id: String(m.message_id ?? ""), labels: Array.isArray(m.labels) ? m.labels : [],
    from: String(m.from ?? ""), subject: String(m.subject ?? ""), text: String(m.extracted_text ?? m.text ?? (typeof m.html === "string" ? htmlPreview(m.html) : m.preview ?? "")),
    timestamp: String(m.timestamp ?? "") }));
}
export { senderAddress };
