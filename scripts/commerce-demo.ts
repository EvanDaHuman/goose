// A repeatable local commercial lifecycle attached to an actual verified DEMONSTRATION delivery.
// Run: GOOSE_MODE=local node --env-file=.env --import tsx scripts/commerce-demo.ts GS-1001
// No external email, provider calls, real payments, or child engineering jobs are allowed here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../lib/config";
import { one, q, pool } from "../lib/db";
import { createInquiry, linkInquiry, checkout, settleTestInvoice, createTicket, subscribeMaintenance,
  runMaintenanceChecks, serviceCommerce, setTransactionalPolicy, transactionalPolicy } from "../lib/commerce";
import { paymentStatus } from "../lib/integrations/stripe";
import { digest } from "../lib/integrations/webhooks";

if (config.mode !== "local") throw new Error("Run this local business demonstration with GOOSE_MODE=local. Engineering evidence remains unchanged.");
if (paymentStatus().ready) throw new Error("This demonstration requires unconfigured Stripe so it cannot contact a provider. Use the isolated integration tests when Stripe is configured.");
const id = process.argv[2] ?? "GS-1001";
if (!/^GS-\d+$/.test(id)) throw new Error("Supply a Goose job ID");
try {
  const job = await one<any>(`SELECT j.*,a.name AS account_name,a.contact_name,a.contact_email,i.id AS invoice_id,i.is_test,i.status AS invoice_status,i.amount_cents
    FROM jobs j JOIN accounts a ON a.id=j.account_id JOIN invoices i ON i.job_id=j.id WHERE j.id=$1`,[id]);
  if (!job || job.kind !== "demo" || !job.is_test || !['delivered','invoice','follow_up','closed'].includes(job.stage))
    throw new Error("The job must already have a verified demonstration delivery and a TEST invoice");
  if (!job.contact_email) throw new Error("The synthetic job must have a contact email for policy-scoped local receipts");
  const verification = await one<any>("SELECT verdict,integrity_ok,total,passed,failed FROM check_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1",[id]);
  if (verification?.verdict !== "pass" || !verification.integrity_ok) throw new Error("Independent engineering verification must have passed first");
  const packages = await q<any>("SELECT path,sha256 FROM artifacts WHERE job_id=$1 AND kind='delivery_package'",[id]);
  if (!packages.length) throw new Error("No verified delivery package");
  for(const file of packages) if(!fs.existsSync(file.path) || crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex")!==file.sha256)
    throw new Error("Delivery package no longer matches its verified hash");
  const policy = await transactionalPolicy();
  if(policy.enabled && policy.allowReal) throw new Error("Do not override an existing live-send policy for a synthetic demonstration");
  const input={name:job.contact_name || "Demonstration Customer",email:job.contact_email,organization:job.account_name,
    goal:job.goal || "Demonstrate the complete local commercial workflow around this verified engineering delivery.",isTest:true};
  const inquiry=await createInquiry(input,"local_commerce_demonstration",{id:`commerce-demo-${id}-v1`,payloadHash:digest(JSON.stringify(input))});
  const linked=await linkInquiry(inquiry.id,id);
  if(!policy.enabled) await setTransactionalPolicy({enabled:true,allowReal:false,authorization:"Authorize transactional customer emails"});
  const first=await serviceCommerce();
  const invoice=await one<any>("SELECT status FROM invoices WHERE id=$1",[job.invoice_id]);
  const paymentLink=invoice?.status === "paid" ? {provider:"local_test",isTest:true,id:`TEST:${job.invoice_id}`} : await checkout(id);
  const payment=await settleTestInvoice(id);
  let support=await one<any>("SELECT * FROM commerce_tickets WHERE job_id=$1 AND subject='Commerce demonstration: delivery evidence' ORDER BY id DESC LIMIT 1",[id]);
  if(!support) support=(await createTicket(id,{subject:"Commerce demonstration: delivery evidence",body:"What has been delivered, and where can I review the verification evidence?",requestChange:false})).ticket;
  let change=await one<any>("SELECT r.* FROM commerce_change_requests r JOIN commerce_tickets t ON t.id=r.ticket_id WHERE r.parent_job_id=$1 AND t.subject='Commerce demonstration: follow-up request' ORDER BY r.id DESC LIMIT 1",[id]);
  if(!change) change=(await createTicket(id,{subject:"Commerce demonstration: follow-up request",body:"Assess a future enhancement after a fresh source snapshot is supplied. Preserve the existing behavior and require a separate approved proposal before implementation.",requestChange:true})).changeRequest;
  const plan=await subscribeMaintenance(id,{scope:"Check the delivered package and frozen verification evidence for integrity changes.",intervalDays:7,consent:true});
  const maintenance=await runMaintenanceChecks(plan.id);
  const second=await serviceCommerce();
  const outbox=await q<any>("SELECT id,purpose,status,provider,authorized_by FROM commerce_outbox WHERE job_id=$1 ORDER BY id",[id]);
  const rows=await q<any>("SELECT amount_cents,is_test,method,reference FROM payments WHERE invoice_id=$1",[job.invoice_id]);
  const requests=await q<any>("SELECT id,status,parent_job_id,child_job_id,budget_micro_usd FROM commerce_change_requests WHERE parent_job_id=$1 ORDER BY id",[id]);
  const report={generatedAt:new Date().toISOString(),jobId:id,source:"local commercial lifecycle around a separately recorded live Naive engineering delivery",
    isSyntheticCustomer:true,commercialModelCalls:0,externalEmailsSent:0,realMoneyMovedCents:0,engineeringVerification:verification,
    engineeringPackagesUnchanged:packages.every(f=>crypto.createHash("sha256").update(fs.readFileSync(f.path)).digest("hex")===f.sha256),
    inquiry:{id:linked.id,status:linked.status,source:linked.source},policy:{enabled:true,allowReal:false},dispatch:[first,second],outbox,
    checkout:{provider:paymentLink.provider,isTest:paymentLink.isTest},payment,invoicePayments:rows,support:{id:support.id,status:support.status,replyMode:"local deterministic support response"},
    followup:{id:change.id,status:change.status,childStarted:false},maintenance,changeRequests:requests,
    limitations:["Synthetic customer actions and local test settlement", "No real customer acquisition, email delivery, or payment provider exercised", "Support reply used local mode; no additional Naive model call", "Maintenance checked delivered artifact integrity, not production behavior or new dependency releases"]};
  const folder=path.join(config.varDir,"evidence");fs.mkdirSync(folder,{recursive:true});const output=path.join(folder,`commerce-${id}.json`);
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));console.log(`Evidence written to ${output}`);
} finally {await pool.end();}
