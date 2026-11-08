import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJob } from "../../lib/jobs";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";
import { after,test } from "node:test";
import { Webhook } from "svix";
import { pool,one,q } from "../../lib/db";
import { POST } from "../../app/api/webhooks/agentmail/route";
import { GET as receiptGet } from "../../app/api/commerce/inbound/[id]/route";
import { agentMailInboundStatus } from "../../lib/integrations/agentmail";
const secret="whsec_"+Buffer.from("synthetic-agentmail-webhook-test-key").toString("base64");
const keys=["AGENTMAIL_WEBHOOK_SECRET","AGENTMAIL_INBOX_ID","AGENTMAIL_INBOUND_MODE","GOOSE_OPERATOR_TOKEN"];
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
process.env.AGENTMAIL_WEBHOOK_SECRET=secret;process.env.AGENTMAIL_INBOX_ID="fixture@agentmail.to";process.env.AGENTMAIL_INBOUND_MODE="test";process.env.GOOSE_OPERATOR_TOKEN="agentmail-test-operator-token-at-least-24";
after(async()=>{for(const k of keys){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}await pool.end();});
function fixture(){const id=crypto.randomUUID();return {type:"event",event_type:"message.received",event_id:`evt_${id}`,message:{inbox_id:"fixture@agentmail.to",thread_id:`thread_${id}`,message_id:`message_${id}`,from:`"Inbound Customer" <inbound-${id}@example.com>`,to:["fixture@agentmail.to"],labels:["inbox"],timestamp:"2026-11-07T12:00:00Z",created_at:"2026-11-07T12:00:00Z",updated_at:"2026-11-07T12:00:00Z",size:100,subject:"Assess this service",text:"  Please assess our service migration.\nKeep these exact words.\n",html:"<p>Please assess our service migration.</p>"},thread:{inbox_id:"fixture@agentmail.to",thread_id:`thread_${id}`,message_count:1,labels:["inbox"],senders:["inbound@example.com"],recipients:["fixture@agentmail.to"],timestamp:"2026-11-07T12:00:00Z",created_at:"2026-11-07T12:00:00Z",updated_at:"2026-11-07T12:00:00Z",size:100}};}
function request(event:any,id=`msg_${crypto.randomUUID()}`,when=new Date(),changes:Record<string,string>={}){const raw=JSON.stringify(event),signature=new Webhook(secret).sign(id,when,raw);return new Request("http://localhost/api/webhooks/agentmail",{method:"POST",headers:{"svix-id":id,"svix-timestamp":String(Math.floor(when.getTime()/1000)),"svix-signature":signature,...changes},body:raw});}

test("official Svix documentation vector matches the installed verifier signing protocol",()=>{
  const webhook=new Webhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw");
  assert.equal(webhook.sign("msg_p5jXN8AQM9LWM0D4loKWxJek",new Date(1614265330*1000),'{"test": 2432232314}'),"v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});
test("native callback authenticates exact raw bytes and rejects missing, stale, future and ambiguous headers",async()=>{
  const e=fixture(),raw=JSON.stringify(e);
  assert.equal((await POST(new Request("http://localhost/api/webhooks/agentmail",{method:"POST",body:raw}))).status,401);
  const signed=request(e);assert.equal((await POST(new Request(signed.url,{method:"POST",headers:signed.headers,body:raw+" "}))).status,401);
  for(const offset of [-301,301])assert.equal((await POST(request(e,undefined,new Date(Date.now()+offset*1000)))).status,401);
  assert.equal((await POST(request(e,undefined,undefined,{"svix-timestamp":"123,456"}))).status,401);
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_inbound_messages WHERE event_id=$1",[e.event_id]))!.n,0);
});
test("documented message.received creates one inquiry across concurrent deliveries with distinct Svix IDs and preserves exact mail",async()=>{
  const e=fixture();const responses=await Promise.all([POST(request(e)),POST(request(e))]);assert.ok(responses.every(r=>r.status===200));
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values.filter(r=>r.duplicate).length,1);
  const row=(await one<any>("SELECT * FROM commerce_inbound_messages WHERE event_id=$1",[e.event_id]))!;
  assert.equal(row.sender,e.message.from);assert.equal(row.text_body,e.message.text);assert.equal(row.html_body,e.message.html);assert.equal(row.is_test,true);assert.equal(row.outcome,"inquiry");
  const inquiry=(await one<any>("SELECT * FROM commerce_inquiries WHERE id=$1",[row.inquiry_id]))!;assert.equal(inquiry.job_id,null);assert.equal(inquiry.source,"agentmail_native");assert.equal(inquiry.is_test,true);assert.match(inquiry.goal,/Keep these exact words/);
  const conflict=await POST(request({...e,message:{...e.message,text:"Changed provider content"}}));assert.equal(conflict.status,400);
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_inquiries WHERE external_event_id=$1",["agentmail:"+e.event_id]))!.n,1);
  const ctx={params:Promise.resolve({id:String(row.id)})};assert.equal((await receiptGet(new Request("http://localhost/api/commerce/inbound/"+row.id),ctx)).status,401);
  const operator=await receiptGet(new Request("http://localhost/api/commerce/inbound/"+row.id,{headers:{Authorization:`Bearer ${process.env.GOOSE_OPERATOR_TOKEN}`}}),ctx);
  assert.equal(operator.status,200);assert.equal(operator.headers.get("cache-control"),"private, no-store");assert.equal((await operator.json()).text_body,e.message.text);
});
test("native inbound mode comes only from server configuration and never auto-links existing jobs",async()=>{
  process.env.AGENTMAIL_INBOUND_MODE="live";
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"goose-inbound-identity-")),source=path.join(temporary,"fixture.zip");fs.writeFileSync(source,"Synthetic identity fixture, never executed");let jobId:string|null=null;
  try{const e={...fixture(),is_test:true};
    const customerEmail=e.message.from.match(/<([^>]+)>/)![1];
    const existing=await createJob({accountName:"Existing private customer",contactEmail:customerEmail,kind:"real",title:"Private job",slug:"private",timezone:"UTC",repoZip:source});jobId=existing.id;
    const result=await POST(request(e));assert.equal(result.status,200);assert.equal((await result.json()).isTest,false);
    const row=(await one<any>("SELECT i.is_test,i.job_id FROM commerce_inquiries i JOIN commerce_inbound_messages m ON m.inquiry_id=i.id WHERE m.event_id=$1",[e.event_id]))!;assert.equal(row.is_test,false);assert.equal(row.job_id,null);
  }finally{process.env.AGENTMAIL_INBOUND_MODE="test";if(jobId){makeWritable(jobDir(jobId));fs.rmSync(jobDir(jobId),{recursive:true,force:true});}fs.rmSync(temporary,{recursive:true,force:true});}
});
test("filtered events, wrong inboxes and ambiguous senders do not create inquiries",async()=>{
  const cases=[{event_type:"message.received.spam"},{event_type:"message.sent"},{message:{...fixture().message,inbox_id:"another@agentmail.to"}},{message:{...fixture().message,from:"A <a@example.com>, B <b@example.com>"}},{message:{...fixture().message,labels:["unauthenticated"]}}];
  for(const patch of cases){const e={...fixture(),...patch};const res=await POST(request(e));assert.equal(res.status,200);assert.ok(["ignored","needs_review"].includes((await res.json()).outcome));assert.equal((await one<any>("SELECT inquiry_id FROM commerce_inbound_messages WHERE event_id=$1",[e.event_id]))!.inquiry_id,null);}
});
test("HTML-only email gets a plain preview while omitted large bodies are held without fetching body URLs",async()=>{
  const e=fixture();delete (e.message as any).text;e.message.html="<script>doNotRun()</script><p>Preserve this request &amp; review the service.</p>";
  assert.equal((await POST(request(e))).status,200);const row=(await one<any>("SELECT i.goal,m.html_body FROM commerce_inbound_messages m JOIN commerce_inquiries i ON i.id=m.inquiry_id WHERE m.event_id=$1",[e.event_id]))!;assert.ok(!row.goal.includes("doNotRun"));assert.ok(row.goal.includes("request & review"));assert.equal(row.html_body,e.message.html);
  const omitted=fixture();delete (omitted.message as any).text;delete (omitted.message as any).html;(omitted.message as any).body_url="http://169.254.169.254/private";
  const oldFetch=globalThis.fetch;globalThis.fetch=(async()=>{throw new Error("Webhook intake must not fetch attachment/body URLs");}) as typeof fetch;
  try{const res=await POST(request(omitted));assert.equal(res.status,200);assert.equal((await res.json()).outcome,"needs_review");}finally{globalThis.fetch=oldFetch;}
});
test("inbound setup is explicit and oversized webhook streams are rejected before storage",async()=>{
  assert.equal(agentMailInboundStatus().ready,true);
  const e=fixture();const requestTooLarge=new Request("http://localhost/api/webhooks/agentmail",{method:"POST",body:"x".repeat(256*1024+1)});assert.equal((await POST(requestTooLarge)).status,413);
  const saved=process.env.AGENTMAIL_WEBHOOK_SECRET;delete process.env.AGENTMAIL_WEBHOOK_SECRET;
  try{assert.equal(agentMailInboundStatus().ready,false);assert.equal((await POST(request(e))).status,503);}finally{process.env.AGENTMAIL_WEBHOOK_SECRET=saved;}
});
