import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pool, one, q } from "../../lib/db";
import { createJob, jobById } from "../../lib/jobs";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";
import { createInquiry, linkInquiry, draftEmail, sendEmail, reconcileEmail, checkout, settleTestInvoice, processStripeEvent,
  createTicket, startChangeRequest, subscribeMaintenance, runMaintenanceChecks, customerCommerce, commerceDashboard, syncCommerceForJob, serviceCommerce, setTransactionalPolicy, transactionalPolicy } from "../../lib/commerce";
import { digest, verifySignature } from "../../lib/integrations/webhooks";
import { GET as customerGet, POST as customerPost } from "../../app/api/commerce/jobs/[id]/route";
import { GET as operatorGet, POST as operatorPost } from "../../app/api/commerce/route";
import { POST as stripeWebhook } from "../../app/api/webhooks/stripe/route";
import { operatorSession } from "../../lib/operatorAuth";
import { remainingSupportBudget } from "../../lib/actions";
import { deliverEmail } from "../../lib/integrations/email";
import { createStripeCheckout } from "../../lib/integrations/stripe";
import { POST as inquiryWebhook } from "../../app/api/webhooks/inquiries/route";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "goose-commerce-"));
const source = path.join(temp, "source.zip"); fs.writeFileSync(source, "synthetic fixture: not executed");
const made: string[] = [];
after(async () => { for (const id of made) { makeWritable(jobDir(id)); fs.rmSync(jobDir(id), { recursive: true, force: true }); } fs.rmSync(temp, { recursive: true, force: true }); await pool.end(); });
async function fixture(kind: "demo" | "real" = "demo", contactEmail = `commerce-${crypto.randomUUID()}@example.com`) {
  const created = await createJob({ accountName: "Commerce fixture", contactName: "Fixture Customer", contactEmail, kind,
    title: "Verified fixture", slug: "commerce-fixture", timezone: "UTC", repoZip: source, costLimitUsd: 3 });
  made.push(created.id);
  await q("UPDATE jobs SET stage='closed',status='done',price_cents=24000 WHERE id=$1", [created.id]);
  const inv = await one<any>(`INSERT INTO invoices(job_id,number,status,is_test,amount_cents,line_items,issued_at)
    VALUES($1,$2,'issued',$3,24000,'[]',now()) RETURNING *`, [created.id, `TEST-COM-${crypto.randomUUID()}`, kind === "demo"]);
  return { ...created, invoice: inv, email: contactEmail };
}

function signature(raw: string, secret: string, stamp = Math.floor(Date.now()/1000)) {
  return `t=${stamp},v1=${crypto.createHmac("sha256", secret).update(`${stamp}.${raw}`).digest("hex")}`;
}

test("webhooks authenticate raw bytes and reject altered, expired, and ambiguous timestamps", () => {
  const raw = '{"id":"evt_1"}', secret = "whsec_fixture";
  assert.doesNotThrow(() => verifySignature(raw, signature(raw, secret), secret));
  assert.throws(() => verifySignature(raw + " ", signature(raw, secret), secret), /Invalid/);
  assert.throws(() => verifySignature(raw, signature(raw, secret, Math.floor(Date.now()/1000)-301), secret), /Expired/);
  assert.throws(() => verifySignature(raw, signature(raw, secret, Math.floor(Date.now()/1000)+301), secret), /Expired/);
  assert.throws(() => verifySignature(raw, signature(raw, secret)+",t=123", secret), /timestamp/);
  assert.throws(() => verifySignature(raw, signature(raw, secret), ""), /not configured/);
});

test("signed inquiry retries create one request and public linking requires matching customer identity", async () => {
  const address = `inquiry-${crypto.randomUUID()}@example.com`;
  const input = { name: "A Customer", email: address, organization: "Fixture Company", goal: "Move this service to Rust while preserving its API.", isTest: true };
  const external = { id: crypto.randomUUID(), payloadHash: digest(JSON.stringify(input)) };
  const [a,b] = await Promise.all([createInquiry(input, "signed_inbound_webhook", external), createInquiry(input, "signed_inbound_webhook", external)]);
  assert.equal(a.id,b.id);
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_inquiries WHERE external_event_id=$1", [external.id]))!.n, 1);
  await assert.rejects(createInquiry(input, "signed_inbound_webhook", { ...external, payloadHash: "bad" }), /Conflicting/);
  const wrong = await fixture();
  await assert.rejects(linkInquiry(a.id,wrong.id), /identity/);
  const correct = await fixture("demo", address);
  const linked = await linkInquiry(a.id,correct.id); assert.equal(linked.job_id,correct.id);
});

test("exact outbound drafts require authorization, retain test provenance, and cannot send twice", async () => {
  const job = await fixture();
  const draft = await draftEmail({ to:job.email, subject:"Fixture delivery", body:"A test receipt with no external message.", jobId:job.id, isTest:true });
  await assert.rejects(sendEmail(draft.id,"yes"), /Explicit/);
  const receipt = await sendEmail(draft.id,"Send this exact message"); assert.equal(receipt.provider,"local_test");
  await assert.rejects(sendEmail(draft.id,"Send this exact message"), /unsent draft/);
  const mutated = await draftEmail({ to:job.email,subject:"Mutation fixture",body:"Original text",isTest:true });
  await q("UPDATE commerce_outbox SET body='Different text' WHERE id=$1",[mutated.id]);
  await assert.rejects(sendEmail(mutated.id,"Send this exact message"), /content changed/);
  await assert.rejects(reconcileEmail(mutated.id,"sent","Checked provider logs",undefined),/receipt/);
  const retryable = await reconcileEmail(mutated.id,"not_sent","Local test provider confirmed no external send");
  assert.equal(retryable.status,"draft");
  await assert.rejects(sendEmail(mutated.id,"Send this exact message"), /content changed/);
  await assert.rejects(draftEmail({to:job.email,subject:"Real mail",body:"Cannot send demo as real",jobId:job.id,isTest:false}), /Demonstration/);
  await syncCommerceForJob(job.id); await syncCommerceForJob(job.id);
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_outbox WHERE dedupe_key=$1",[`invoice:${job.invoice.id}`]))!.n,1);
});

test("local checkout settles only demonstration invoices and records exactly one test payment", async () => {
  const saved = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  try {
    const job = await fixture();
    const link = await checkout(job.id); assert.equal(link.provider,"local_test"); assert.equal(link.isTest,true);
    const [a,b] = await Promise.all([settleTestInvoice(job.id),settleTestInvoice(job.id)]);
    assert.equal(a.isTest,true); assert.equal(b.isTest,true);
    const payments = await q<any>("SELECT * FROM payments WHERE invoice_id=$1",[job.invoice.id]);
    assert.equal(payments.length,1); assert.equal(payments[0].is_test,true); assert.equal(payments[0].amount_cents,24000);
    const real = await fixture("real"); await assert.rejects(settleTestInvoice(real.id), /Only demonstration/);
    await assert.rejects(checkout(real.id), /Configure/);
    const dashboard = await commerceDashboard(); assert.ok(dashboard.summary.testRevenueCents >= 24000); assert.equal(dashboard.summary.realRevenueCents,0);
  } finally { if(saved === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY=saved; }
});

test("Stripe settlement validates mode, amount, metadata and currency; replay cannot duplicate money", async () => {
  const job = await fixture(); const sessionId = `cs_test_${crypto.randomUUID()}`;
  await q("INSERT INTO commerce_checkouts(invoice_id,provider,provider_id,url,is_test) VALUES($1,'stripe',$2,'https://checkout.stripe.com/test',true)",[job.invoice.id,sessionId]);
  const base = { id:`evt_${crypto.randomUUID()}`,type:"checkout.session.completed",livemode:false,data:{object:{id:sessionId,livemode:false,payment_status:"paid",amount_total:24000,currency:"usd",metadata:{invoice_id:String(job.invoice.id)}}} };
  for (const altered of [
    {...base,livemode:true},
    {...base,data:{object:{...base.data.object,amount_total:1}}},
    {...base,data:{object:{...base.data.object,currency:"eur"}}},
    {...base,data:{object:{...base.data.object,metadata:{invoice_id:"999999"}}}}
  ]) await assert.rejects(processStripeEvent(JSON.stringify(altered)), /match/);
  assert.equal((await q("SELECT * FROM payments WHERE invoice_id=$1",[job.invoice.id])).length,0);
  const raw = JSON.stringify(base);
  await Promise.all([processStripeEvent(raw),processStripeEvent(raw)]);
  await processStripeEvent(JSON.stringify({...base,id:`evt_${crypto.randomUUID()}`,type:"checkout.session.async_payment_succeeded"}));
  const rows = await q<any>("SELECT * FROM payments WHERE invoice_id=$1",[job.invoice.id]);
  assert.equal(rows.length,1); assert.equal(rows[0].method,"stripe"); assert.equal(rows[0].is_test,true);
  await assert.rejects(processStripeEvent(JSON.stringify({...base,livemode:true})),/Conflicting/);
});

test("support change requests create real capped child jobs from fresh snapshots and preserve parent scope", async () => {
  const parent = await fixture();
  const opened = await createTicket(parent.id,{subject:"Add a reporting endpoint",body:"Please add a read-only report while preserving existing API responses.",requestChange:true});
  assert.equal(opened.ticket.status,"change_requested"); assert.equal(opened.changeRequest.parent_job_id,parent.id);
  assert.equal(opened.changeRequest.budget_micro_usd,3_000_000);
  const child = await startChangeRequest(opened.changeRequest.id,{repoZip:source,target:"node"}); made.push(child.id);
  assert.equal((await jobById(child.id))!.stage,"intake"); assert.equal((await jobById(child.id))!.cost_limit_micro_usd,3_000_000);
  assert.equal((await jobById(parent.id))!.stage,"closed");
  const again = await startChangeRequest(opened.changeRequest.id,{repoZip:source}); assert.equal(again.id,child.id);
  const data = await customerCommerce(parent.id); assert.equal(data.changeRequests[0].child_job_id,child.id); assert.equal(data.changeRequests[0].child_customer_token,child.token);
  const broad = await fixture(); await q("UPDATE jobs SET recipe='workspace-change',work_type='code' WHERE id=$1",[broad.id]);
  const broadTicket = await createTicket(broad.id,{subject:"Extend the CLI contract",body:"Add a new command while preserving current CLI behavior.",requestChange:true});
  const broadChild = await startChangeRequest(broadTicket.changeRequest.id,{repoZip:source,target:"rust"}); made.push(broadChild.id);
  assert.equal((await jobById(broadChild.id))!.recipe,"workspace-change");
  assert.ok(fs.existsSync(jobDir(broadChild.id,"inputs","workspace-request.json")));
  assert.equal(fs.existsSync(jobDir(broadChild.id,"inputs","migration-request.json")),false);
  const denied = await customerGet(new Request(`http://localhost/api/commerce/jobs/${parent.id}?t=wrong`),{params:Promise.resolve({id:parent.id})}); assert.equal(denied.status,404);
  const allowed = await customerGet(new Request(`http://localhost/api/commerce/jobs/${parent.id}?t=${parent.token}`),{params:Promise.resolve({id:parent.id})}); assert.equal(allowed.status,200);
});

test("scheduled maintenance checks actual evidence integrity and raises a bounded request after tampering", async () => {
  const job = await fixture(); const delivered = jobDir(job.id,"delivery.zip"); fs.writeFileSync(delivered,"verified delivery bytes");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(delivered)).digest("hex");
  await q("INSERT INTO artifacts(job_id,kind,label,path,sha256,created_by,frozen) VALUES($1,'delivery_package','Fixture',$2,$3,'verification',true)",[job.id,delivered,hash]);
  await q(`INSERT INTO check_runs(job_id,attempt,integrity_ok,total,passed,failed,skipped,verdict,by_category,failed_checks)
    VALUES($1,1,true,1,1,0,0,'pass','{}','[]')`,[job.id]);
  await assert.rejects(subscribeMaintenance(job.id,{scope:"Check delivery integrity",intervalDays:7,consent:false}),/consent/);
  const plan = await subscribeMaintenance(job.id,{scope:"Check delivery integrity",intervalDays:7,consent:true});
  const first = await runMaintenanceChecks(plan.id); assert.equal(first[0].status,"passed");
  assert.deepEqual(await runMaintenanceChecks(),[]);
  fs.writeFileSync(delivered,"changed without verification");
  const second = await runMaintenanceChecks(plan.id); assert.equal(second[0].status,"attention");
  const request = await one<any>("SELECT * FROM commerce_change_requests WHERE check_id=$1",[second[0].id]);
  assert.equal(request.parent_job_id,job.id); assert.equal(request.status,"awaiting_source");
  const check = await one<any>("SELECT detail FROM commerce_checks WHERE id=$1",[second[0].id]);
  assert.ok(check.detail.notChecked.includes("Runtime regression rerun"));
});


test("opt-in policy sends only trusted linked-customer lifecycle messages and counts one authorization", async () => {
  assert.equal((await transactionalPolicy()).enabled,false);
  const job = await fixture(); const real = await fixture("real");
  const unsolicited = await draftEmail({to:"prospect@example.com",subject:"Proposal",body:"An operator draft must never be sent by transactional policy",isTest:true});
  const wrongRecipient = await draftEmail({to:"unrelated@example.com",subject:"Wrong recipient",body:"Must not escape linked customer identity",jobId:job.id,isTest:true},"invoice");
  await syncCommerceForJob(job.id);
  await serviceCommerce();
  let invoiceMail = await one<any>("SELECT * FROM commerce_outbox WHERE dedupe_key=$1",[`invoice:${job.invoice.id}`]);
  assert.equal(invoiceMail.status,"draft");
  await assert.rejects(setTransactionalPolicy({enabled:true,allowReal:true,authorization:"yes"}),/Explicit/);
  const before = (await one<any>("SELECT count(*)::int AS n FROM interventions WHERE kind='authorize_email'"))!.n;
  await setTransactionalPolicy({enabled:true,allowReal:false,authorization:"Authorize transactional customer emails"});
  await serviceCommerce(); await serviceCommerce();
  invoiceMail = await one<any>("SELECT * FROM commerce_outbox WHERE dedupe_key=$1",[`invoice:${job.invoice.id}`]);
  assert.equal(invoiceMail.status,"sent"); assert.equal(invoiceMail.provider,"local_test"); assert.match(invoiceMail.authorized_by,/^policy:/);
  assert.equal((await one<any>("SELECT status FROM commerce_outbox WHERE id=$1",[unsolicited.id]))!.status,"draft");
  assert.equal((await one<any>("SELECT status FROM commerce_outbox WHERE id=$1",[wrongRecipient.id]))!.status,"draft");
  assert.equal((await one<any>("SELECT status FROM commerce_outbox WHERE dedupe_key=$1",[`invoice:${real.invoice.id}`]))!.status,"draft");
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM interventions WHERE kind='authorize_email'"))!.n,before);
  assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_outbox WHERE dedupe_key=$1",[`invoice:${job.invoice.id}`]))!.n,1);
  await setTransactionalPolicy({enabled:false,allowReal:false});
});


test("commerce routes enforce operator auth, customer scope, origin checks and signed callbacks", async () => {
  const oldToken=process.env.GOOSE_OPERATOR_TOKEN,oldWebhook=process.env.STRIPE_WEBHOOK_SECRET;
  process.env.GOOSE_OPERATOR_TOKEN="commerce-test-operator-token-1234567890";
  process.env.STRIPE_WEBHOOK_SECRET="whsec_commerce_route_test";
  try {
    const denied=await operatorGet(new Request("http://localhost/api/commerce")); assert.equal(denied.status,401);
    const authed=await operatorGet(new Request("http://localhost/api/commerce",{headers:{authorization:`Bearer ${process.env.GOOSE_OPERATOR_TOKEN}`}}));
    assert.equal(authed.status,200); assert.equal(authed.headers.get("cache-control"),"private, no-store");
    const forged=await operatorPost(new Request("http://localhost/api/commerce",{method:"POST",headers:{cookie:`goose_operator=${operatorSession()}`,origin:"https://attacker.invalid","content-type":"application/json"},body:'{"action":"service_run"}'}));
    assert.equal(forged.status,403);
    const job=await fixture();
    const customerDenied=await customerPost(new Request(`http://localhost/api/commerce/jobs/${job.id}`,{method:"POST",headers:{origin:"http://localhost","content-type":"application/json"},body:JSON.stringify({t:"wrong",action:"test_checkout"})}),{params:Promise.resolve({id:job.id})});
    assert.equal(customerDenied.status,404);
    const raw=JSON.stringify({id:`evt_route_${crypto.randomUUID()}`,type:"unhandled.fixture",livemode:false});
    assert.equal((await stripeWebhook(new Request("http://localhost/api/webhooks/stripe",{method:"POST",body:raw}))).status,401);
    const valid=await stripeWebhook(new Request("http://localhost/api/webhooks/stripe",{method:"POST",headers:{"stripe-signature":signature(raw,process.env.STRIPE_WEBHOOK_SECRET)},body:raw}));
    assert.equal(valid.status,200);
    const invalidJson="not json";
    const rejected=await stripeWebhook(new Request("http://localhost/api/webhooks/stripe",{method:"POST",headers:{"stripe-signature":signature(invalidJson,process.env.STRIPE_WEBHOOK_SECRET)},body:invalidJson}));
    assert.equal(rejected.status,400);
  } finally {
    if(oldToken===undefined)delete process.env.GOOSE_OPERATOR_TOKEN;else process.env.GOOSE_OPERATOR_TOKEN=oldToken;
    if(oldWebhook===undefined)delete process.env.STRIPE_WEBHOOK_SECRET;else process.env.STRIPE_WEBHOOK_SECRET=oldWebhook;
  }
});


test("support allowance cannot request more than the remaining job budget", async () => {
  const job=await fixture();
  assert.equal(await remainingSupportBudget(job.id,3_000_000),500_000);
  await q("INSERT INTO cost_entries(job_id,actor,stage,kind,quantity,unit,micro_usd,basis) VALUES($1,'assessment','plan','model',1,'request',2800000,'naive_metered')",[job.id]);
  assert.equal(await remainingSupportBudget(job.id,3_000_000),200_000);
  await q("INSERT INTO cost_entries(job_id,actor,stage,kind,quantity,unit,micro_usd,basis) VALUES($1,'implementation','implement','model',1,'request',400000,'naive_metered')",[job.id]);
  assert.equal(await remainingSupportBudget(job.id,3_000_000),0);
});


test("AgentMail adapter sends the documented body, captures receipts and fails safely", async () => {
  const keys=["GOOSE_EMAIL_PROVIDER","AGENTMAIL_API_KEY","AGENTMAIL_INBOX_ID","GOOSE_EMAIL_WEBHOOK_URL","GOOSE_EMAIL_WEBHOOK_TOKEN"];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const originalFetch=globalThis.fetch;
  try {
    process.env.GOOSE_EMAIL_PROVIDER="agentmail";process.env.AGENTMAIL_API_KEY="fixture-api-key";process.env.AGENTMAIL_INBOX_ID="fixture@example.com";
    const message={id:918,recipient:"customer@example.com",subject:"Delivery ready",body:"Your verified delivery is ready.",is_test:false,content_sha256:digest("customer@example.com\nDelivery ready\nYour verified delivery is ready.")};
    let calls=0;
    globalThis.fetch=(async (url:any,init:any)=>{
      calls++;assert.equal(String(url),"https://api.agentmail.to/v0/inboxes/fixture%40example.com/messages/send");
      assert.equal(init.method,"POST");assert.equal(init.headers.Authorization,"Bearer fixture-api-key");
      assert.equal(init.headers["Idempotency-Key"],"goose-email-918");
      assert.deepEqual(JSON.parse(init.body),{to:["customer@example.com"],subject:message.subject,text:message.body});
      return Response.json({message_id:"message_fixture",thread_id:"thread_fixture"});
    }) as typeof fetch;
    assert.deepEqual((await deliverEmail(message)).id,"message_fixture");assert.equal(calls,1);
    globalThis.fetch=(async()=>new Response("upstream detail must not leak",{status:403})) as typeof fetch;
    await assert.rejects(deliverEmail(message),/^Error: Email provider returned HTTP 403$/);
    globalThis.fetch=(async()=>Response.json({})) as typeof fetch;
    await assert.rejects(deliverEmail(message),/did not return a delivery receipt/);
    process.env.GOOSE_EMAIL_PROVIDER="webhook";process.env.GOOSE_EMAIL_WEBHOOK_URL="http://unsafe.example/send";process.env.GOOSE_EMAIL_WEBHOOK_TOKEN="fixture-gateway";
    await assert.rejects(deliverEmail(message),/HTTPS/);
    process.env.GOOSE_EMAIL_WEBHOOK_URL="https://gateway.example/send";
    globalThis.fetch=(async(url:any,init:any)=>{assert.equal(String(url),"https://gateway.example/send");assert.equal(init.headers.Authorization,"Bearer fixture-gateway");assert.equal(JSON.parse(init.body).idempotency_key,"goose-email-918");return Response.json({id:"gateway_fixture"});}) as typeof fetch;
    assert.equal((await deliverEmail(message)).id,"gateway_fixture");
    globalThis.fetch=(async()=>{throw new Error("No provider request allowed for test messages");}) as typeof fetch;
    assert.equal((await deliverEmail({...message,is_test:true})).provider,"local_test");
  }finally{globalThis.fetch=originalFetch;for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});

test("Stripe checkout uses exact form fields, stable idempotency and matching payment modes", async () => {
  const keys=["STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET","GOOSE_PUBLIC_URL"];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const originalFetch=globalThis.fetch;
  try {
    process.env.STRIPE_SECRET_KEY="sk_test_fixture";process.env.STRIPE_WEBHOOK_SECRET="whsec_fixture";process.env.GOOSE_PUBLIC_URL="https://goose.example";
    const invoice={id:319,job_id:"GS-999",number:"TEST-319",is_test:true,amount_cents:12345,currency:"USD"};
    globalThis.fetch=(async(url:any,init:any)=>{
      assert.equal(String(url),"https://api.stripe.com/v1/checkout/sessions");assert.equal(init.method,"POST");
      assert.equal(init.headers.Authorization,"Bearer sk_test_fixture");assert.equal(init.headers["Idempotency-Key"],"goose-invoice-319-first");
      const form=new URLSearchParams(init.body);assert.equal(form.get("mode"),"payment");assert.equal(form.get("line_items[0][price_data][unit_amount]"),"12345");
      assert.equal(form.get("line_items[0][price_data][currency]"),"usd");assert.equal(form.get("metadata[invoice_id]"),"319");assert.equal(form.get("metadata[job_id]"),"GS-999");
      assert.equal(new URL(form.get("success_url")!).searchParams.get("t"),"private-fixture-token");
      return Response.json({id:"cs_test_fixture",url:"https://checkout.stripe.com/c/pay/fixture",livemode:false});
    }) as typeof fetch;
    const session=await createStripeCheckout(invoice,"private-fixture-token");assert.equal(session.isTest,true);assert.equal(session.id,"cs_test_fixture");
    await assert.rejects(createStripeCheckout({...invoice,is_test:false},"token"),/modes do not match/);
    globalThis.fetch=(async()=>Response.json({id:"cs_test_fixture",url:"https://attacker.example",livemode:false})) as typeof fetch;
    await assert.rejects(createStripeCheckout(invoice,"token"),/unexpected checkout URL/);
    globalThis.fetch=(async()=>Response.json({id:"cs_test_fixture",url:"https://checkout.stripe.com/c/pay/fixture",livemode:true})) as typeof fetch;
    await assert.rejects(createStripeCheckout(invoice,"token"),/invalid checkout session/);
    globalThis.fetch=(async()=>new Response("do not expose provider body",{status:402})) as typeof fetch;
    await assert.rejects(createStripeCheckout(invoice,"token"),/^Error: Stripe checkout returned HTTP 402$/);
    process.env.STRIPE_SECRET_KEY="sk_live_fixture";process.env.GOOSE_PUBLIC_URL="http://localhost:3100";
    await assert.rejects(createStripeCheckout({...invoice,is_test:false},"token"),/HTTPS/);
    process.env.GOOSE_PUBLIC_URL="https://goose.example";
    globalThis.fetch=(async()=>{throw new Error("A demonstration invoice must not call the live provider");}) as typeof fetch;
    const demonstration=await fixture();
    assert.equal((await checkout(demonstration.id)).provider,"local_test");
  }finally{globalThis.fetch=originalFetch;for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});

test("inbound inquiry callback rejects unsigned content and deduplicates authenticated provider retries", async () => {
  const old=process.env.GOOSE_INQUIRY_WEBHOOK_SECRET;process.env.GOOSE_INQUIRY_WEBHOOK_SECRET="fixture-inbound-secret";
  try{
    const input={event_id:`inbound_${crypto.randomUUID()}`,name:"Signed Customer",email:`signed-${crypto.randomUUID()}@example.com`,organization:"Signed fixture",goal:"Assess a migration with explicit verification requirements",isTest:true};
    const raw=JSON.stringify(input);
    const make=(body=raw)=>new Request("http://localhost/api/webhooks/inquiries",{method:"POST",headers:{"x-goose-signature":signature(body,process.env.GOOSE_INQUIRY_WEBHOOK_SECRET!)},body});
    const unsigned=await inquiryWebhook(new Request("http://localhost/api/webhooks/inquiries",{method:"POST",body:raw}));assert.equal(unsigned.status,401);
    const responses=await Promise.all([inquiryWebhook(make()),inquiryWebhook(make())]);assert.ok(responses.every(r=>r.status===200));
    const again=await inquiryWebhook(make());assert.equal((await again.json()).duplicate,true);
    const altered=await inquiryWebhook(make(JSON.stringify({...input,goal:"Altered content on an existing provider event ID"})));assert.equal(altered.status,400);
    assert.equal((await one<any>("SELECT count(*)::int AS n FROM commerce_inquiries WHERE external_event_id=$1",[input.event_id]))!.n,1);
  }finally{if(old===undefined)delete process.env.GOOSE_INQUIRY_WEBHOOK_SECRET;else process.env.GOOSE_INQUIRY_WEBHOOK_SECRET=old;}
});
