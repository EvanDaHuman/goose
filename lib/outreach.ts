// Prospect outreach: the last step of the growth pipeline.
//   research agent      finds a repository/organisation and the outdated software (public evidence)
//   qualification agent decides which Goose recipe would fix it, and what is out of scope
//   outreach agent      writes the draft (lib/growth.ts)
//   this module         resolves a published business contact, composes the exact email (site link, postal address,
//                       opt-out), sends it over AgentMail, and records replies, opt-outs and bounces.
// A real send needs either the founder's authorization of that exact message, or the outreach policy (explicitly enabled,
// with a daily cap). Suppressed addresses are never written to. A failed send is never retried automatically.
import dns from "node:dns/promises";
import net from "node:net";
import type pg from "pg";
import { one, q, tx } from "./db";
import { getSetting } from "./jobs";
import { addIntervention, logEvent } from "./records";
import { digest } from "./integrations/webhooks";
import { AgentMailError, agentMailSend, agentMailThread, outreachInbox, senderAddress } from "./integrations/agentmail";
import { repositoryUrl } from "./publicResearch";
import {
  autoReplyKind, chooseBusinessEmail, composeOutreach, extractEmails, identityProblems, isOptOut, type OutreachIdentity,
  publicWebsite, replyText, usableProfileEmail,
} from "./outreachRules";

export const identity = (): OutreachIdentity => ({
  signer: process.env.OUTREACH_SIGNER ?? "",
  websiteUrl: process.env.GOOSE_PUBLIC_URL ?? "",
  postalAddress: process.env.OUTREACH_POSTAL_ADDRESS ?? "",
});
const testRecipient = () => (process.env.OUTREACH_TEST_RECIPIENT ?? "").trim().toLowerCase();
const HARD_DAILY_MAX = () => Math.max(1, Math.min(200, Number(process.env.OUTREACH_DAILY_MAX ?? 20) || 20));

export function outreachStatus() {
  const missing = [!process.env.AGENTMAIL_API_KEY ? "AGENTMAIL_API_KEY" : null, !outreachInbox() ? "AGENTMAIL_OUTREACH_INBOX_ID" : null]
    .filter((v): v is string => !!v);
  const realBlockers = [...missing, ...identityProblems(identity())];
  return { provider: "agentmail", inbox: outreachInbox() || null, canSendTest: missing.length === 0 && !!testRecipient(),
    canSendReal: realBlockers.length === 0, realBlockers, testRecipient: testRecipient() || null, website: publicWebsite(identity().websiteUrl),
    dailyMax: HARD_DAILY_MAX() };
}

// ------------------------------------------------------------------ policy

export type OutreachPolicy = { enabled: boolean; dailyCap: number; minFit: "High" | "Medium"; id: string | null; authorizedAt: string | null };
const POLICY_OFF: OutreachPolicy = { enabled: false, dailyCap: 5, minFit: "High", id: null, authorizedAt: null };
export const outreachPolicy = () => getSetting<OutreachPolicy>("outreach.policy", POLICY_OFF);
export const POLICY_PHRASE = "Authorize prospect outreach";

export async function setOutreachPolicy(input: any) {
  if (typeof input?.enabled !== "boolean") throw new Error("Choose enabled true or false");
  if (input.enabled && input.authorization !== POLICY_PHRASE) throw new Error(`Type "${POLICY_PHRASE}" to let the outreach agent send without per-message approval`);
  const cap = Math.round(Number(input.dailyCap ?? 5));
  if (!Number.isFinite(cap) || cap < 1 || cap > HARD_DAILY_MAX()) throw new Error(`dailyCap must be 1 to ${HARD_DAILY_MAX()}`);
  const minFit = input.minFit === "Medium" ? "Medium" : "High";
  const policy: OutreachPolicy = { enabled: input.enabled, dailyCap: cap, minFit, id: crypto.randomUUID(), authorizedAt: new Date().toISOString() };
  await q("INSERT INTO settings(key,value) VALUES('outreach.policy',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify(policy)]);
  await addIntervention(null, "outreach_policy", policy.enabled ? `Founder let the outreach agent send up to ${cap} prospect email(s) a day (fit ${minFit} and above).`
    : "Founder turned automatic prospect outreach off.", policy, 0);
  return policy;
}

// ------------------------------------------------------------------ public contact resolution

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
async function assertPublicHost(host: string) {
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("not a public host");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address } of addrs) {
    if ((net.isIPv4(address) && PRIVATE_V4.test(address)) || (net.isIPv6(address) && /^(::1|f[cd]|fe80|::ffff:(10|127|192\.168)\.)/i.test(address)))
      throw new Error("resolves to a private address");
  }
}

/** Read-only GET of a public https page: no credentials, three redirects, 512 KiB, 8 seconds. */
async function fetchPublic(raw: string, accept = "text/html,application/json") {
  let url = new URL(raw);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("only plain https URLs are fetched");
    await assertPublicHost(url.hostname);
    const res = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(8000),
      headers: { Accept: accept, "User-Agent": "Goose-Outreach-Research/1.0" } });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel(); const loc = res.headers.get("location"); if (!loc) throw new Error("redirect without location");
      url = new URL(loc, url); continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const reader = res.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.byteLength; if (size > 512 * 1024) { await reader.cancel(); break; } parts.push(p.value); }
    return { url: url.toString(), text: Buffer.concat(parts).toString("utf8") };
  }
  throw new Error("too many redirects");
}

const httpsUrls = (s: string) => [...String(s ?? "").matchAll(/https:\/\/[^\s)>\]"',]+/g)].map((m) => m[0].replace(/[.;:]+$/, ""));
const isGithub = (u: string) => /^https:\/\/([a-z0-9-]+\.)?(github\.com|githubusercontent\.com)\//i.test(u + "/");

export type ContactResult = { email: string | null; source: string | null; kind: "business" | "profile" | null; note: string };

/**
 * Find an address the organisation itself publishes for contact. Order: a role address on the organisation's own website
 * (from the prospect's contact channel or its GitHub profile's website), then the email the owner chose to show on their
 * public GitHub profile. Commit-author addresses are never harvested.
 */
export async function findContact(p: { url: string; contact_channel?: string | null }): Promise<ContactResult> {
  const notes: string[] = [];
  let profile: any = null;
  const repo = repositoryUrl(p.url);
  if (repo) {
    const owner = new URL(repo).pathname.split("/")[1];
    try {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "Goose-Outreach-Research" };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) profile = await res.json(); else notes.push(`GitHub profile lookup returned HTTP ${res.status}`);
    } catch (e) { notes.push(`GitHub profile lookup failed: ${(e as Error).message}`); }
  }
  const blog = typeof profile?.blog === "string" && profile.blog.trim() ? (/^https?:\/\//i.test(profile.blog) ? profile.blog.trim() : `https://${profile.blog.trim()}`).replace(/^http:/i, "https:") : null;
  const sites = [...new Set([...httpsUrls(p.contact_channel ?? ""), ...(blog ? [blog] : []), ...(isGithub(p.url) ? [] : [p.url])])].filter((u) => !isGithub(u)).slice(0, 3);
  let fetches = 0;
  for (const site of sites) {
    let host: string; try { host = new URL(site).hostname; } catch { continue; }
    const pages = [site, ...["/contact", "/contact-us", "/about"].map((s) => new URL(s, site).toString())];
    for (const page of [...new Set(pages)]) {
      if (fetches++ >= 8) break;
      try {
        const r = await fetchPublic(page);
        const email = chooseBusinessEmail(extractEmails(r.text), host);
        if (email) return { email, source: r.url, kind: "business", note: `Published on ${r.url}` };
      } catch (e) { notes.push(`${page}: ${(e as Error).message}`); }
    }
  }
  const pe = usableProfileEmail(profile?.email);
  if (pe) return { email: pe, source: profile.html_url ?? repo, kind: "profile", note: "Public email on the owner's GitHub profile" };
  return { email: null, source: null, kind: null, note: ["No published contact email found", ...notes.slice(0, 4)].join(". ") };
}

export async function resolveContact(prospectId: number) {
  const p = await one<any>("SELECT * FROM prospects WHERE id=$1", [prospectId]);
  if (!p) throw new Error("Prospect not found");
  const r = await findContact(p);
  await q(`UPDATE prospects SET contact_email=$2,contact_source=$3,contact_kind=$4,contact_note=$5,contact_checked_at=now(),updated_at=now() WHERE id=$1`,
    [p.id, r.email, r.source, r.kind, r.note.slice(0, 1000)]);
  await logEvent(null, "outreach", "status", r.email ? `Found a published contact for ${p.name} (${r.kind}, ${r.source}).` : `No published contact email for ${p.name}.`,
    { prospect: p.url, ...r }, { origin: "tool", originDetail: { tool: "outreach.findContact" } });
  return r;
}

// ------------------------------------------------------------------ queue and send

const suppressed = async (email: string) => !!(await one("SELECT 1 FROM outreach_suppressions WHERE email=$1", [email.toLowerCase()]));
export async function suppress(email: string, reason: string, source: string, c?: pg.PoolClient) {
  const sql = "INSERT INTO outreach_suppressions(email,reason,source) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING";
  const args = [email.toLowerCase(), reason.slice(0, 300), source.slice(0, 300)];
  if (c) await c.query(sql, args); else await q(sql, args);
}

/** Compose and store the exact email for a prospect. A test copy goes to OUTREACH_TEST_RECIPIENT, never to the prospect. */
export async function queueOutreach(prospectId: number, opts: { test?: boolean } = {}) {
  const p = await one<any>("SELECT * FROM prospects WHERE id=$1", [prospectId]);
  if (!p) throw new Error("Prospect not found");
  if (!p.outreach_draft) throw new Error("Draft outreach for this prospect first");
  const test = opts.test === true;
  const id = identity();
  let recipient: string, deliveredTo: string;
  if (test) {
    if (!testRecipient()) throw new Error("Set OUTREACH_TEST_RECIPIENT to your own address to send test copies");
    recipient = p.contact_email ?? "(no contact found)"; deliveredTo = testRecipient();
  } else {
    const problems = identityProblems(id);
    if (problems.length) throw new Error(`Real outreach is not configured: ${problems.join("; ")}`);
    if (!p.contact_email) throw new Error("No published contact email for this prospect");
    if (await suppressed(p.contact_email)) throw new Error("This address opted out or bounced; it is never written to again");
    if (["contacted", "replied", "won", "lost"].includes(p.status)) throw new Error(`Prospect is already ${p.status}`);
    recipient = deliveredTo = p.contact_email.toLowerCase();
  }
  const composed = composeOutreach(p.outreach_draft, test ? { signer: id.signer || "[Founder name]", websiteUrl: id.websiteUrl || "https://<your site>",
    postalAddress: id.postalAddress || "(postal address not configured)" } : id);
  const subject = test ? `[TEST for ${recipient}] ${composed.subject}` : composed.subject;
  const hash = digest(`${deliveredTo}\n${subject}\n${composed.body}`);
  if (!test) {
    const existing = await one<any>("SELECT * FROM outreach_messages WHERE prospect_id=$1 AND NOT is_test AND status IN ('draft','sending','sent','uncertain')", [p.id]);
    if (existing?.status === "draft" && existing.content_sha256 !== hash)
      return (await one<any>("UPDATE outreach_messages SET recipient=$2,delivered_to=$2,subject=$3,body=$4,content_sha256=$5 WHERE id=$1 AND status='draft' RETURNING *",
        [existing.id, recipient, subject, composed.body, hash]))!;
    if (existing) return existing;
  }
  return (await one<any>(`INSERT INTO outreach_messages(prospect_id,recipient,delivered_to,subject,body,content_sha256,is_test) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.id, recipient, deliveredTo, subject, composed.body, hash, test]))!;
}

async function sentToday() {
  return Number((await one<{ n: number }>("SELECT count(*)::int AS n FROM outreach_messages WHERE NOT is_test AND status IN ('sending','sent','uncertain') AND authorized_at > now()-interval '24 hours'"))?.n ?? 0);
}

async function dispatch(id: number, by: string, cap: number) {
  const pre = await one<any>("SELECT * FROM outreach_messages WHERE id=$1", [id]);
  if (!pre) throw new Error("Message not found");
  if (digest(`${pre.delivered_to}\n${pre.subject}\n${pre.body}`) !== pre.content_sha256) throw new Error("Message content changed; authorization is invalid");
  if (!pre.is_test) {
    if (await suppressed(pre.delivered_to)) { await q("UPDATE outreach_messages SET status='cancelled',error='address suppressed' WHERE id=$1 AND status='draft'", [id]); throw new Error("Address is suppressed"); }
    if ((await sentToday()) >= cap) throw new Error(`Daily outreach limit of ${cap} reached`);
    const problems = identityProblems(identity()); if (problems.length) throw new Error(`Real outreach is not configured: ${problems.join("; ")}`);
  }
  const m = await one<any>("UPDATE outreach_messages SET status='sending',authorized_by=$2,authorized_at=now(),error=NULL WHERE id=$1 AND status='draft' RETURNING *", [id, by]);
  if (!m) throw new Error("Only an unsent draft can be sent. An uncertain send must be reconciled in AgentMail first.");
  const p = (await one<any>("SELECT * FROM prospects WHERE id=$1", [m.prospect_id]))!;
  try {
    const r = await agentMailSend({ to: m.delivered_to, subject: m.subject, text: m.body, labels: ["outreach", m.is_test ? "test" : "prospect", `prospect-${p.id}`] });
    await q("UPDATE outreach_messages SET status='sent',provider_message_id=$2,thread_id=$3,sent_at=now() WHERE id=$1", [id, r.messageId, r.threadId]);
    if (!m.is_test) await q("UPDATE prospects SET status='contacted',contacted_at=now(),updated_at=now() WHERE id=$1", [p.id]);
    await logEvent(null, "outreach", "message", m.is_test ? `TEST copy of the outreach to ${p.name} sent to ${m.delivered_to}.` : `Outreach to ${p.name} sent to ${m.delivered_to} over AgentMail.`,
      { prospect: p.url, outreach_message_id: id, provider_message_id: r.messageId, thread_id: r.threadId, authorized_by: by }, { important: !m.is_test, origin: "tool", originDetail: { tool: "agentmail" } });
    return { id, messageId: r.messageId, threadId: r.threadId };
  } catch (e) {
    // a definite HTTP rejection means nothing went out; anything else (timeout, network) may have been accepted
    const definite = e instanceof AgentMailError && typeof e.status === "number";
    await q("UPDATE outreach_messages SET status=$2,error=$3 WHERE id=$1", [id, definite ? "failed" : "uncertain", (e as Error).message.slice(0, 1000)]);
    await logEvent(null, "outreach", "error", `Outreach to ${p.name} ${definite ? "was rejected" : "has an unknown outcome"}: ${(e as Error).message}`, { outreach_message_id: id }, { important: true });
    throw e;
  }
}

/** The founder authorizes one exact message. */
export async function sendOutreach(id: number, authorization: unknown) {
  if (authorization !== "Send this exact message") throw new Error("Explicit authorization of this exact message is required");
  const m = await one<any>("SELECT is_test,prospect_id FROM outreach_messages WHERE id=$1", [id]);
  if (m && !m.is_test) await addIntervention(null, "authorize_outreach", "Founder authorized one exact prospect email.", { outreach_message_id: id, prospect_id: m.prospect_id }, 0);
  return dispatch(id, "founder", HARD_DAILY_MAX());
}

export async function cancelOutreach(id: number) {
  const r = await one("UPDATE outreach_messages SET status='cancelled' WHERE id=$1 AND status IN ('draft','failed') RETURNING id", [id]);
  if (!r) throw new Error("Only a draft or failed message can be cancelled");
  return { ok: true };
}

/** After checking AgentMail by hand: record whether an uncertain message actually went out. */
export async function reconcileOutreach(id: number, outcome: "sent" | "not_sent") {
  const r = await one<any>(`UPDATE outreach_messages SET status=$2,authorized_at=CASE WHEN $2='sent' THEN authorized_at END,sent_at=CASE WHEN $2='sent' THEN now() END
    WHERE id=$1 AND status IN ('uncertain','failed') RETURNING *`, [id, outcome === "sent" ? "sent" : "cancelled"]);
  if (!r) throw new Error("Only uncertain or failed messages need reconciliation");
  if (outcome === "sent" && !r.is_test) await q("UPDATE prospects SET status='contacted',contacted_at=now() WHERE id=$1", [r.prospect_id]);
  return r;
}

// ------------------------------------------------------------------ replies

/**
 * Record a reply on an outreach thread. Opt-outs and bounces suppress the address; an out-of-office is ignored; a human
 * reply marks the prospect replied and opens a customer inquiry so the commercial workflow can take it from there.
 */
export async function recordOutreachReply(c: pg.PoolClient, om: any, reply: { messageId: string; from: string; subject: string; text: string }) {
  const p = (await c.query("SELECT * FROM prospects WHERE id=$1", [om.prospect_id])).rows[0];
  const sender = senderAddress(reply.from);
  const auto = autoReplyKind(reply.from, reply.subject);
  if (auto === "auto") return { kind: "auto" as const, inquiryId: null };
  if (auto === "bounce") {
    if (!om.is_test) await suppress(om.delivered_to, "bounced", `agentmail:${reply.messageId}`, c);
    await c.query("UPDATE outreach_messages SET error='bounced' WHERE id=$1", [om.id]);
    await c.query(`INSERT INTO events(job_id,actor,kind,summary,detail,origin) VALUES(NULL,'outreach','status',$1,$2,'tool')`,
      [`Outreach to ${p.name} bounced; ${om.delivered_to} is suppressed.`, JSON.stringify({ outreach_message_id: om.id })]);
    return { kind: "bounce" as const, inquiryId: null };
  }
  await c.query("UPDATE outreach_messages SET replied_at=COALESCE(replied_at,now()) WHERE id=$1", [om.id]);
  if (isOptOut(reply.text)) {
    if (!om.is_test) {
      await suppress(om.delivered_to, "opted out", `agentmail:${reply.messageId}`, c);
      if (sender) await suppress(sender.email, "opted out", `agentmail:${reply.messageId}`, c);
      await c.query("UPDATE prospects SET status='lost',replied_at=now(),notes=concat_ws(E'\\n',notes,'Opted out of outreach.'),updated_at=now() WHERE id=$1", [p.id]);
    }
    await c.query(`INSERT INTO events(job_id,actor,kind,summary,detail,important,origin) VALUES(NULL,'outreach','message',$1,$2,true,'tool')`,
      [`${om.is_test ? "TEST " : ""}${p.name} opted out of outreach; the address will not be emailed again.`, JSON.stringify({ outreach_message_id: om.id })]);
    return { kind: "opt_out" as const, inquiryId: null };
  }
  if (!om.is_test) await c.query("UPDATE prospects SET status='replied',replied_at=now(),updated_at=now() WHERE id=$1", [p.id]);
  let inquiryId: number | null = null;
  if (sender) {
    const goal = `Reply to Goose outreach about ${p.name} (${p.url}).\n\nSubject: ${reply.subject}\n\n${replyText(reply.text).slice(0, 9000)}`;
    const ins = await c.query(`INSERT INTO commerce_inquiries(public_id,name,email,organization,goal,repository_url,is_test,source,external_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'outreach_reply',$8) ON CONFLICT(external_event_id) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), sender.name, sender.email, p.name.slice(0, 200), goal, repositoryUrl(p.url), om.is_test, `agentmail-msg:${reply.messageId}`]);
    inquiryId = ins.rows[0]?.id ?? null;
  }
  await c.query(`INSERT INTO events(job_id,actor,kind,summary,detail,important,origin) VALUES(NULL,'customer','message',$1,$2,true,'tool')`,
    [`${om.is_test ? "TEST " : ""}${p.name} replied to outreach${inquiryId ? `; inquiry #${inquiryId} opened` : ""}.`, JSON.stringify({ outreach_message_id: om.id, inquiry_id: inquiryId })]);
  return { kind: "reply" as const, inquiryId };
}

/** Poll AgentMail threads of recent sends for replies (works without a public webhook URL). */
export async function pollReplies(limit = 25) {
  const open = await q<any>(`SELECT * FROM outreach_messages WHERE status='sent' AND thread_id IS NOT NULL AND replied_at IS NULL AND error IS DISTINCT FROM 'bounced'
    AND sent_at > now()-interval '30 days' ORDER BY sent_at DESC LIMIT $1`, [limit]);
  const out: { id: number; kind: string }[] = [];
  for (const om of open) {
    let messages;
    try { messages = await agentMailThread(om.thread_id); } catch (e) { console.error("[outreach] thread", om.thread_id, (e as Error).message); continue; }
    const inbound = messages.filter((m) => m.labels.includes("received") && m.message_id !== om.provider_message_id && (!om.sent_at || Date.parse(m.timestamp) >= Date.parse(om.sent_at) - 60_000));
    for (const m of inbound) {
      const r = await tx((c) => recordOutreachReply(c, om, { messageId: m.message_id, from: m.from, subject: m.subject, text: m.text }));
      out.push({ id: om.id, kind: r.kind });
      if (r.kind !== "auto") break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the worker

let lastTick = 0, lastPoll = 0, busy = false;
/** Called from the worker loop. Resolves contacts, sends under the policy, and polls for replies. Never blocks jobs. */
export async function serviceOutreach(now = Date.now()) {
  if (busy || now - lastTick < 60_000) return;
  if (!process.env.AGENTMAIL_API_KEY) return;
  busy = true; lastTick = now;
  try {
    // 1. contacts for drafted prospects that have not been looked up yet (a few per minute: public rate limits)
    for (const p of await q<any>("SELECT id FROM prospects WHERE outreach_draft IS NOT NULL AND contact_checked_at IS NULL ORDER BY id LIMIT 3"))
      await resolveContact(p.id).catch((e) => console.error("[outreach] contact", p.id, e.message));
    // 2. send one message per tick under the policy, spaced at least 3 minutes apart
    const policy = await outreachPolicy();
    if (policy.enabled && outreachStatus().canSendReal) {
      const cap = Math.min(policy.dailyCap, HARD_DAILY_MAX());
      const recent = await one("SELECT 1 FROM outreach_messages WHERE NOT is_test AND authorized_at > now()-interval '3 minutes'");
      if (!recent && (await sentToday()) < cap) {
        const next = await one<any>(`SELECT p.id FROM prospects p WHERE p.status='draft_ready' AND p.contact_email IS NOT NULL
          AND p.fit_score = ANY($1) AND NOT EXISTS(SELECT 1 FROM outreach_suppressions s WHERE s.email=lower(p.contact_email))
          AND NOT EXISTS(SELECT 1 FROM outreach_messages m WHERE m.prospect_id=p.id AND NOT m.is_test AND m.status<>'cancelled')
          AND NOT EXISTS(SELECT 1 FROM prospects o WHERE o.id<>p.id AND lower(o.contact_email)=lower(p.contact_email) AND o.contacted_at > now()-interval '90 days')
          ORDER BY CASE p.fit_score WHEN 'High' THEN 0 ELSE 1 END, p.id LIMIT 1`, [policy.minFit === "High" ? ["High"] : ["High", "Medium"]]);
        if (next) {
          const m = await queueOutreach(next.id);
          if (m.status === "draft") await dispatch(m.id, `policy:${policy.id}`, cap).catch((e) => console.error("[outreach] send", e.message));
        }
      }
    }
    // 3. replies, every 5 minutes
    if (now - lastPoll > 5 * 60_000) { lastPoll = now; await pollReplies(); }
  } finally { busy = false; }
}

export async function outreachDashboard() {
  const [messages, suppressions] = await Promise.all([
    q<any>("SELECT m.*,p.name AS prospect_name FROM outreach_messages m JOIN prospects p ON p.id=m.prospect_id ORDER BY m.id DESC LIMIT 100"),
    q<any>("SELECT * FROM outreach_suppressions ORDER BY created_at DESC LIMIT 100")]);
  return { status: outreachStatus(), policy: await outreachPolicy(), sentToday: await sentToday(), messages, suppressions };
}
