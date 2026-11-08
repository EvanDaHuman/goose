// Prospect outreach end to end against a disposable database, with AgentMail mocked: authorization, suppression,
// the daily limit, reply polling, opt-outs, bounces and the webhook path. No email leaves the machine.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { Webhook } from "svix";
import { one, pool, q } from "../../lib/db";
import { cancelOutreach, outreachPausedUntil, pollReplies, queueOutreach, sendOutreach, setOutreachPolicy, serviceOutreach } from "../../lib/outreach";
import { POST as webhook } from "../../app/api/webhooks/agentmail/route";

const env: Record<string, string> = {
  AGENTMAIL_API_KEY: "am_fixture", AGENTMAIL_INBOX_ID: "fixture@agentmail.to", AGENTMAIL_OUTREACH_INBOX_ID: "fixture@agentmail.to",
  OUTREACH_SIGNER: "Fixture Founder", GOOSE_PUBLIC_URL: "https://goose.example.org", OUTREACH_POSTAL_ADDRESS: "1 Fixture Way, Testville, CA 94000",
  OUTREACH_TEST_RECIPIENT: "founder@example.org", OUTREACH_DAILY_MAX: "2", AGENTMAIL_INBOUND_MODE: "test",
  AGENTMAIL_WEBHOOK_SECRET: "whsec_" + Buffer.from("synthetic-outreach-webhook-key").toString("base64"),
};
const original = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const sent: any[] = [];
let threads: Record<string, any[]> = {};
let failNext: number | null = null;
let failBody = "nope";

before(() => {
  Object.assign(process.env, env);
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith("/messages/send")) {
      if (failNext) { const s = failNext; failNext = null; return new Response(failBody, { status: s }); }
      const body = JSON.parse(init.body); const n = sent.push(body);
      return Response.json({ message_id: `<m${n}@agentmail>`, thread_id: `t${n}` });
    }
    const t = url.match(/\/threads\/([^/?]+)$/);
    if (t) return Response.json({ messages: threads[decodeURIComponent(t[1])] ?? [] });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await pool.end();
});

async function prospect(name: string, email: string | null, fit = "High") {
  const url = `https://github.com/fixture/${crypto.randomUUID().slice(0, 8)}`;
  return (await one<any>(`INSERT INTO prospects(name,url,category,summary,evidence,fit_score,status,outreach_draft,contact_email,contact_kind,contact_checked_at,found_by)
    VALUES($1,$2,'c','Fixture',$3,$4,'draft_ready',$5,$6,'business',now(),'research agent') RETURNING *`,
    [name, url, JSON.stringify([{ text: "pins Flask==1.1.4", url: url + "/blob/main/requirements.txt" }]), fit,
     `Subject: Upgrading ${name}\n\nHello,\n\n${name} pins Flask==1.1.4.\n\nWe have no past customers to point to yet.\n\n[Founder name], Goose`, email]))!;
}
const received = (from: string, subject: string, text: string, id = crypto.randomUUID()) =>
  ({ message_id: `<r${id}@mail>`, labels: ["received"], from, subject, extracted_text: text, timestamp: new Date(Date.now() + 1000).toISOString() });

test("a real send needs exact authorization, goes to the published contact, and marks the prospect contacted", async () => {
  const p = await prospect("Acme Orders", "hello@acme.example");
  const m = await queueOutreach(p.id);
  assert.equal(m.delivered_to, "hello@acme.example");
  assert.match(m.body, /Fixture Founder, Goose/);
  assert.match(m.body, /https:\/\/goose\.example\.org/);
  assert.match(m.body, /1 Fixture Way/);
  assert.equal((await queueOutreach(p.id)).id, m.id, "queueing again reuses the stored draft");
  await assert.rejects(sendOutreach(m.id, "yes"), /Explicit authorization/);
  const r = await sendOutreach(m.id, "Send this exact message");
  assert.equal(r.threadId, `t${sent.length}`);
  assert.deepEqual(sent.at(-1).to, ["hello@acme.example"]);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [p.id]))!.status, "contacted");
  await assert.rejects(sendOutreach(m.id, "Send this exact message"), /Only an unsent draft/);
  await assert.rejects(queueOutreach(p.id), /already contacted/);
});

test("test copies only ever reach the founder's address", async () => {
  const p = await prospect("Test Copy Co", "info@testcopy.example");
  const m = await queueOutreach(p.id, { test: true });
  await sendOutreach(m.id, "Send this exact message");
  assert.deepEqual(sent.at(-1).to, ["founder@example.org"]);
  assert.match(sent.at(-1).subject, /^\[TEST for info@testcopy\.example\]/);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [p.id]))!.status, "draft_ready");
});

test("a rejected send is failed (not retried); edited content invalidates authorization; daily limit holds", async () => {
  const p = await prospect("Rejected Co", "hello@rejected.example");
  const m = await queueOutreach(p.id);
  failNext = 422;
  await assert.rejects(sendOutreach(m.id, "Send this exact message"), /HTTP 422/);
  assert.equal((await one<any>("SELECT status FROM outreach_messages WHERE id=$1", [m.id]))!.status, "failed");
  await cancelOutreach(m.id);
  const p2 = await prospect("Tampered Co", "hello@tampered.example");
  const m2 = await queueOutreach(p2.id);
  await q("UPDATE outreach_messages SET body=body||' extra' WHERE id=$1", [m2.id]);
  await assert.rejects(sendOutreach(m2.id, "Send this exact message"), /content changed/);
  await q("UPDATE outreach_messages SET status='cancelled' WHERE id=$1", [m2.id]);
  // OUTREACH_DAILY_MAX=2: one real send so far today, one more is allowed
  const p3 = await prospect("Second Co", "hello@second.example"); await sendOutreach((await queueOutreach(p3.id)).id, "Send this exact message");
  const p4 = await prospect("Third Co", "hello@third.example");
  await assert.rejects(sendOutreach((await queueOutreach(p4.id)).id, "Send this exact message"), /Daily outreach limit of 2/);
  await q("UPDATE outreach_messages SET status='cancelled' WHERE prospect_id=$1", [p4.id]);
});

test("replies: a human reply opens an inquiry; an opt-out or bounce suppresses the address for good", async () => {
  await q("UPDATE outreach_messages SET authorized_at=now()-interval '2 days' WHERE NOT is_test");   // clear today's limit
  const ids = [] as any[];
  for (const [name, email] of [["Reply Co", "hello@reply.example"], ["OptOut Co", "hello@optout.example"], ["Bounce Co", "hello@bounce.example"]] as const) {
    const p = await prospect(name, email); const r = await sendOutreach((await queueOutreach(p.id)).id, "Send this exact message"); ids.push({ p, r });
    await q("UPDATE outreach_messages SET authorized_at=now()-interval '2 days' WHERE NOT is_test");
  }
  threads[ids[0].r.threadId] = [received("Jane Reply <jane@reply.example>", "Re: Upgrading Reply Co", "Yes, please send the assessment.\n\nOn Mon, Goose wrote:\n> reply \"unsubscribe\"")];
  threads[ids[1].r.threadId] = [received("Owner <owner@optout.example>", "Re: Upgrading OptOut Co", "Please unsubscribe us.")];
  threads[ids[2].r.threadId] = [received("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found")];
  const polled = await pollReplies();
  assert.deepEqual(polled.filter((x) => ids.some((i) => i.r.id === x.id)).map((x) => x.kind).sort(), ["bounce", "opt_out", "reply"]);
  const reply = (await one<any>("SELECT status FROM prospects WHERE id=$1", [ids[0].p.id]))!;
  assert.equal(reply.status, "replied");
  const inquiry = (await one<any>("SELECT * FROM commerce_inquiries WHERE email='jane@reply.example'"))!;
  assert.equal(inquiry.source, "outreach_reply"); assert.match(inquiry.goal, /send the assessment/); assert.doesNotMatch(inquiry.goal, /unsubscribe/);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [ids[1].p.id]))!.status, "lost");
  const sup = (await q<any>("SELECT email,reason FROM outreach_suppressions ORDER BY email")).map((s) => `${s.email}:${s.reason}`);
  assert.ok(sup.includes("hello@optout.example:opted out") && sup.includes("owner@optout.example:opted out") && sup.includes("hello@bounce.example:bounced"));
  assert.equal((await pollReplies()).filter((x) => ids.some((i) => i.r.id === x.id)).length, 0, "already-handled threads are not polled again");
  const again = await prospect("OptOut Co again", "hello@optout.example");
  await assert.rejects(queueOutreach(again.id), /opted out or bounced/);
});

test("a reply delivered by webhook is matched to its outreach thread", async () => {
  const p = await prospect("Webhook Co", "hello@webhook.example");
  const r = await sendOutreach((await queueOutreach(p.id)).id, "Send this exact message");
  await q("UPDATE outreach_messages SET authorized_at=now()-interval '2 days' WHERE NOT is_test");
  const id = crypto.randomUUID();
  const event = { type: "event", event_type: "message.received", event_id: `evt_${id}`, message: { inbox_id: "fixture@agentmail.to", thread_id: r.threadId,
    message_id: `<w${id}@mail>`, from: "Sam <sam@webhook.example>", to: ["fixture@agentmail.to"], labels: ["received"], subject: "Re: Upgrading Webhook Co", text: "Interested - what would the assessment need from us?" } };
  const raw = JSON.stringify(event), svixId = `msg_${id}`, when = new Date();
  const res = await webhook(new Request("http://localhost/api/webhooks/agentmail", { method: "POST", body: raw,
    headers: { "svix-id": svixId, "svix-timestamp": String(Math.floor(when.getTime() / 1000)), "svix-signature": new Webhook(env.AGENTMAIL_WEBHOOK_SECRET).sign(svixId, when, raw) } }));
  assert.equal(res.status, 200);
  const rec = (await one<any>("SELECT outcome,outreach_message_id,inquiry_id FROM commerce_inbound_messages WHERE event_id=$1", [event.event_id]))!;
  assert.equal(rec.outcome, "inquiry"); assert.equal(Number(rec.outreach_message_id), r.id); assert.ok(rec.inquiry_id);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [p.id]))!.status, "replied");
});

test("the automatic policy needs the exact phrase, then sends one High-fit prospect per tick within its cap", async () => {
  await assert.rejects(setOutreachPolicy({ enabled: true, dailyCap: 1 }), /Authorize prospect outreach/);
  await q("UPDATE prospects SET status='lost' WHERE status='draft_ready'");
  const hi = await prospect("Policy High", "hello@policyhigh.example", "High");
  const med = await prospect("Policy Medium", "hello@policymed.example", "Medium");
  const manual = await prospect("Policy Manual", "hello@policymanual.example", "High");
  await q("UPDATE prospects SET found_by='founder research' WHERE id=$1", [manual.id]);
  await setOutreachPolicy({ enabled: true, dailyCap: 1, minFit: "High", authorization: "Authorize prospect outreach" });
  const before = sent.length;
  await serviceOutreach(Date.now() + 10 * 60_000);
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1).to, ["hello@policyhigh.example"]);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [hi.id]))!.status, "contacted");
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [med.id]))!.status, "draft_ready", "Medium fit is not sent under a High-only policy");
  await serviceOutreach(Date.now() + 30 * 60_000);
  assert.equal((await one<any>("SELECT status FROM prospects WHERE id=$1", [manual.id]))!.status, "draft_ready", "only research-agent prospects are sent automatically");
  await setOutreachPolicy({ enabled: false });
});

test("a provider rate limit queues the exact message again and pauses all sending until the stated time", async () => {
  await q("UPDATE outreach_messages SET authorized_at=now()-interval '2 days' WHERE NOT is_test");
  const p = await prospect("Limited Co", "hello@limited.example");
  const m = await queueOutreach(p.id);
  const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
  failNext = 429; failBody = JSON.stringify({ name: "RateLimitError", message: `New account recipient limit exceeded. The limit rises to 25 at ${until} and lifts later.` });
  await assert.rejects(sendOutreach(m.id, "Send this exact message"), /paused/);
  const row = (await one<any>("SELECT status,authorized_at FROM outreach_messages WHERE id=$1", [m.id]))!;
  assert.equal(row.status, "draft"); assert.equal(row.authorized_at, null);
  assert.equal(await outreachPausedUntil(), until);
  const before = sent.length;
  await assert.rejects(sendOutreach(m.id, "Send this exact message"), /paused/);
  assert.equal(sent.length, before, "nothing is attempted while paused");
  await q("UPDATE settings SET value=to_jsonb($1::text) WHERE key='outreach.paused_until'", [new Date(Date.now() - 1000).toISOString()]);
  await sendOutreach(m.id, "Send this exact message");
  assert.deepEqual(sent.at(-1).to, ["hello@limited.example"]);
});
