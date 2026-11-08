import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { one, q, tx } from "./db";
import { config, jobDir } from "./config";
import { createJob, getSetting, jobById } from "./jobs";
import { addIntervention, logEvent } from "./records";
import { agentMailInboundStatus } from "./integrations/agentmail";
import { deliverEmail, emailStatus } from "./integrations/email";
import { createStripeCheckout, paymentStatus, publicBaseUrl } from "./integrations/stripe";
import { digest } from "./integrations/webhooks";

const text = (value: unknown, name: string, max: number, min = 1) => {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) throw new Error(`${name} must contain ${min} to ${max} characters`);
  return value.trim();
};
const email = (value: unknown) => {
  const s = text(value, "Email", 254);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) throw new Error("Enter a valid email address");
  return s.toLowerCase();
};
export const positiveId = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid record ID"); return n; };

export async function createInquiry(input: any, source = "website", external?: { id: string; payloadHash: string }) {
  const name = text(input.name, "Name", 160, 2), address = email(input.email), organization = text(input.organization, "Organization", 200, 2);
  const goal = text(input.goal, "Goal", 10000, 10);
  let repository: string | null = null;
  if (input.repositoryUrl) {
    const url = new URL(text(input.repositoryUrl, "Repository URL", 2000));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error("Repository URL must be an HTTP(S) address without credentials");
    repository = url.toString();
  }
  const record = await tx(async c => {
    if (external) {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["inquiry-event:" + external.id]);
      const old = (await c.query("SELECT id,public_id,status,payload_sha256 FROM commerce_inquiries WHERE external_event_id=$1", [external.id])).rows[0];
      if (old) {
        if (old.payload_sha256 !== external.payloadHash) throw new Error("Conflicting inquiry event replay");
        return { ...old, duplicate: true };
      }
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["inquiry:" + address]);
    const recent = await c.query("SELECT count(*)::int AS n FROM commerce_inquiries WHERE email=$1 AND created_at > now()-interval '1 hour'", [address]);
    if (recent.rows[0].n >= 5) throw new Error("An inquiry is already with our team. Please wait before submitting again.");
    const r = await c.query(`INSERT INTO commerce_inquiries(public_id,name,email,organization,goal,repository_url,is_test,source,external_event_id,payload_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,public_id,status`,
      [crypto.randomUUID(), name, address, organization, goal, repository, input.isTest === true, source, external?.id ?? null, external?.payloadHash ?? null]);
    return r.rows[0];
  });
  if (!record.duplicate) await logEvent(null, "customer", "message", `New ${input.isTest === true ? "TEST " : ""}engineering inquiry from ${organization}.`, { inquiry_id: record.id, source });
  return { id: record.public_id, status: record.status, message: "Your request is recorded. Upload the source to begin an executable assessment.", startUrl: `/start?inquiry=${record.public_id}` };
}

export async function linkInquiry(inquiryId: number | string, jobId: string) {
  const job = await jobById(jobId); if (!job) throw new Error("Job not found");
  if (typeof inquiryId === "string") {
    const candidate = await one<any>("SELECT i.email,i.is_test,a.contact_email FROM commerce_inquiries i JOIN accounts a ON a.id=$2 WHERE i.public_id=$1", [inquiryId,job.account_id]);
    if (!candidate || candidate.email !== String(candidate.contact_email ?? "").trim().toLowerCase() || candidate.is_test !== (job.kind === "demo"))
      throw new Error("Inquiry and job customer identity do not match");
  }
  const row = await one<any>(`UPDATE commerce_inquiries SET job_id=$2,status='linked' WHERE ${typeof inquiryId === "number" ? "id" : "public_id"}=$1
    AND (job_id IS NULL OR job_id=$2) RETURNING *`, [inquiryId, jobId]);
  if (!row) throw new Error("Inquiry not found or already linked");
  await logEvent(jobId, "coordinator", "status", "Customer inquiry linked to an executable engineering job.", { inquiry_id: row.id });
  return row;
}

export type TransactionalPurpose = "proposal" | "delivery" | "invoice" | "support";
export async function draftEmail(input: any, purpose?: TransactionalPurpose) {
  const to = email(input.to), subject = text(input.subject, "Subject", 300), body = text(input.body, "Message", 30000);
  if (/[\r\n]/.test(subject)) throw new Error("Subject must be a single line");
  const jobId = input.jobId ? String(input.jobId) : null;
  if (jobId && !(await jobById(jobId))) throw new Error("Job not found");
  const isTest = input.isTest === true;
  if (jobId) {
    const job = (await jobById(jobId))!;
    if (job.kind === "demo" && !isTest) throw new Error("Demonstration jobs can create test messages only");
  }
  const hash = digest(`${to}\n${subject}\n${body}`);
  return await one<any>(`INSERT INTO commerce_outbox(recipient,subject,body,content_sha256,job_id,inquiry_id,is_test,dedupe_key,purpose)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *`,
    [to, subject, body, hash, jobId, input.inquiryId ? positiveId(input.inquiryId) : null, isTest, input.dedupeKey ?? null, purpose ?? null]);
}

export type TransactionalPolicy = { enabled: boolean; allowReal: boolean; id: string | null; authorizedAt: string | null };
export async function transactionalPolicy(): Promise<TransactionalPolicy> {
  return getSetting("commerce.transactional_policy", { enabled: false, allowReal: false, id: null, authorizedAt: null });
}
export async function setTransactionalPolicy(input: any) {
  if (typeof input.enabled !== "boolean" || typeof input.allowReal !== "boolean") throw new Error("Choose explicit policy settings");
  if (input.enabled && input.authorization !== "Authorize transactional customer emails") throw new Error("Explicit transactional email authorization is required");
  const policy: TransactionalPolicy = { enabled: input.enabled, allowReal: input.enabled && input.allowReal, id: crypto.randomUUID(), authorizedAt: new Date().toISOString() };
  await q("INSERT INTO settings(key,value) VALUES('commerce.transactional_policy',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify(policy)]);
  await addIntervention(null,"transactional_email_policy", policy.enabled ? `Operator authorized routine customer notifications (${policy.allowReal ? "real and test" : "test only"}).` : "Operator disabled routine customer notifications.", policy,0);
  return policy;
}
async function dispatchEmail(id: number, policy?: TransactionalPolicy) {
  if (policy) {
    const eligibility = await one<any>(`SELECT o.*,a.contact_email,j.kind FROM commerce_outbox o JOIN jobs j ON j.id=o.job_id JOIN accounts a ON a.id=j.account_id WHERE o.id=$1`,[id]);
    if (!policy.enabled || !eligibility?.purpose || !['proposal','delivery','invoice','support'].includes(eligibility.purpose)
      || eligibility.recipient !== String(eligibility.contact_email ?? "").trim().toLowerCase()
      || eligibility.is_test !== (eligibility.kind === "demo") || (!eligibility.is_test && !policy.allowReal))
      throw new Error("Message is outside the authorized transactional policy");
    const current = await transactionalPolicy();
    if (current.id !== policy.id || !current.enabled) throw new Error("Transactional policy changed before dispatch");
  }
  const claimed = await one<any>(`UPDATE commerce_outbox SET status='sending',authorized_by=$2,authorized_at=now(),error=NULL
    WHERE id=$1 AND status='draft' RETURNING *`, [id,policy ? `policy:${policy.id}` : "operator"]);
  if (!claimed) throw new Error("Only an unsent draft can be sent. Uncertain delivery must be reconciled with the provider.");
  if (!policy) await addIntervention(claimed.job_id, "authorize_email", "Operator authorized one exact outbound message.", { outbox_id: id, content_sha256: claimed.content_sha256 }, 0);
  try {
    const receipt = await deliverEmail(claimed);
    await q("UPDATE commerce_outbox SET status='sent',provider=$2,provider_id=$3,sent_at=now() WHERE id=$1", [id, receipt.provider, receipt.id]);
    await logEvent(claimed.job_id, "coordinator", "message", claimed.is_test ? "TEST outbound message completed locally. No email was sent." : "Authorized message accepted by email provider.", { outbox_id: id, provider_id: receipt.id, policy_id:policy?.id ?? null });
    return receipt;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A timeout can happen after acceptance. Never automatically retry an external send.
    await q("UPDATE commerce_outbox SET status=$2,error=$3 WHERE id=$1", [id, claimed.is_test || !emailStatus().ready ? "failed" : "uncertain", message]);
    throw e;
  }
}
export async function sendEmail(id: number, authorization: unknown) {
  if (authorization !== "Send this exact message") throw new Error("Explicit authorization of this exact message is required");
  return dispatchEmail(id);
}

export async function reconcileEmail(id: number, outcome: unknown, reason: unknown, providerReference?: unknown) {
  if (!["sent", "not_sent"].includes(String(outcome))) throw new Error("Choose sent or not_sent after checking the provider");
  const explanation = text(reason, "Reconciliation evidence", 2000, 10);
  const reference = outcome === "sent" ? text(providerReference, "Provider receipt", 300, 2) : null;
  const row = await one<any>(`UPDATE commerce_outbox SET status=$2,provider_id=COALESCE($3,provider_id),error=NULL,
    sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,authorized_at=NULL,authorized_by=NULL
    WHERE id=$1 AND status IN ('failed','uncertain') RETURNING *`, [id, outcome === "sent" ? "sent" : "draft", reference]);
  if (!row) throw new Error("Only failed or uncertain messages need reconciliation");
  await addIntervention(row.job_id, "reconcile_email", explanation, { outbox_id:id, outcome, provider_reference:reference }, 0);
  return row;
}

export async function checkout(jobId: string) {
  return tx(async c => {
    const r = await c.query(`SELECT i.*,j.customer_token FROM invoices i JOIN jobs j ON j.id=i.job_id WHERE i.job_id=$1 FOR UPDATE OF i`, [jobId]);
    const invoice = r.rows[0];
    if (!invoice || invoice.status === "void" || invoice.status === "draft") throw new Error("No issued invoice is available");
    if (invoice.status === "paid") throw new Error("Invoice is already paid");
    if (!Number.isSafeInteger(invoice.amount_cents) || invoice.amount_cents <= 0) throw new Error("Invoice must have a positive amount");
    const existing = (await c.query("SELECT * FROM commerce_checkouts WHERE invoice_id=$1", [invoice.id])).rows[0];
    if (existing && existing.status !== "expired") return { url: existing.url, isTest: existing.is_test, provider: existing.provider, id: existing.provider_id };
    let session;
    if (invoice.is_test && (!paymentStatus().ready || paymentStatus().mode !== "test")) {
      const id = `test_checkout_${invoice.id}`;
      session = { provider: "local_test", id, isTest: true, url: `${publicBaseUrl()}/jobs/${jobId}?t=${encodeURIComponent(invoice.customer_token)}&testCheckout=${id}` };
    } else session = await createStripeCheckout(invoice, invoice.customer_token, existing ? `after-${existing.provider_id}` : "first");
    await c.query(`INSERT INTO commerce_checkouts(invoice_id,provider,provider_id,url,is_test) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(invoice_id) DO UPDATE SET provider=EXCLUDED.provider,provider_id=EXCLUDED.provider_id,url=EXCLUDED.url,is_test=EXCLUDED.is_test,status='open',created_at=now()`, [invoice.id, session.provider, session.id, session.url, session.isTest]);
    return session;
  });
}

export async function settleTestInvoice(jobId: string) {
  return tx(async c => {
    const invoice = (await c.query("SELECT * FROM invoices WHERE job_id=$1 FOR UPDATE", [jobId])).rows[0];
    if (!invoice || !invoice.is_test) throw new Error("Only demonstration invoices permit local test settlement");
    if (!['issued', 'paid'].includes(invoice.status)) throw new Error("Invoice is not payable");
    const ref = `TEST:${invoice.id}`;
    const existing = (await c.query("SELECT id FROM payments WHERE invoice_id=$1 LIMIT 1", [invoice.id])).rows[0];
    if (!existing) await c.query(`INSERT INTO payments(invoice_id,amount_cents,is_test,method,reference,recorded_by)
      VALUES($1,$2,true,'local_test',$3,'explicit test checkout')`, [invoice.id, invoice.amount_cents, ref]);
    await c.query("UPDATE invoices SET status='paid' WHERE id=$1", [invoice.id]);
    await c.query("UPDATE commerce_checkouts SET status='paid' WHERE invoice_id=$1", [invoice.id]);
    return { ok: true, isTest: true, message: "TEST payment recorded. No money moved.", duplicate: !!existing };
  });
}

export async function processStripeEvent(raw: string) {
  const event = JSON.parse(raw);
  if (typeof event.id !== "string" || typeof event.type !== "string" || typeof event.livemode !== "boolean") throw new Error("Invalid Stripe event");
  return tx(async c => {
    const old = (await c.query("SELECT payload_sha256 FROM commerce_webhook_events WHERE provider='stripe' AND event_id=$1", [event.id])).rows[0];
    if (old) {
      if (old.payload_sha256 !== digest(raw)) throw new Error("Conflicting replay for an existing Stripe event");
      return { received: true, duplicate: true };
    }
    const inserted = await c.query(`INSERT INTO commerce_webhook_events(provider,event_id,event_type,payload_sha256) VALUES('stripe',$1,$2,$3)
      ON CONFLICT DO NOTHING RETURNING event_id`, [event.id, event.type, digest(raw)]);
    if (!inserted.rowCount) {
      const concurrent = (await c.query("SELECT payload_sha256 FROM commerce_webhook_events WHERE provider='stripe' AND event_id=$1", [event.id])).rows[0];
      if (concurrent.payload_sha256 !== digest(raw)) throw new Error("Conflicting replay for an existing Stripe event");
      return { received: true, duplicate: true };
    }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) return { received: true, ignored: true };
    const session = event.data?.object;
    if (event.type === "checkout.session.expired") {
      await c.query("UPDATE commerce_checkouts SET status='expired' WHERE provider='stripe' AND provider_id=$1 AND status='open' AND is_test=$2", [session?.id, !event.livemode]);
      return { received: true, expired: true };
    }
    if (session?.payment_status !== "paid") return { received: true, pending: true };
    const checkoutRow = (await c.query(`SELECT co.*,i.amount_cents,i.currency,i.status AS invoice_status FROM commerce_checkouts co
      JOIN invoices i ON i.id=co.invoice_id WHERE co.provider='stripe' AND co.provider_id=$1 FOR UPDATE OF i`, [session.id])).rows[0];
    if (!checkoutRow) throw new Error("Checkout session is not registered to a Goose invoice");
    if (checkoutRow.is_test !== !event.livemode || session.livemode !== event.livemode) throw new Error("Stripe event mode does not match the invoice");
    if (session.amount_total !== checkoutRow.amount_cents || session.currency?.toLowerCase() !== checkoutRow.currency.toLowerCase()) throw new Error("Stripe payment amount or currency does not match the invoice");
    if (String(session.metadata?.invoice_id) !== String(checkoutRow.invoice_id)) throw new Error("Stripe invoice metadata does not match");
    if (checkoutRow.invoice_status === "void") throw new Error("Cannot settle a void invoice");
    const existing = (await c.query("SELECT id FROM payments WHERE invoice_id=$1 LIMIT 1", [checkoutRow.invoice_id])).rows[0];
    if (!existing) await c.query(`INSERT INTO payments(invoice_id,amount_cents,is_test,method,reference,recorded_by)
      VALUES($1,$2,$3,'stripe',$4,'verified Stripe webhook')`, [checkoutRow.invoice_id, checkoutRow.amount_cents, checkoutRow.is_test, session.id]);
    await c.query("UPDATE invoices SET status='paid' WHERE id=$1", [checkoutRow.invoice_id]);
    await c.query("UPDATE commerce_checkouts SET status='paid' WHERE invoice_id=$1", [checkoutRow.invoice_id]);
    return { received: true, settled: true, isTest: checkoutRow.is_test };
  });
}

export async function createTicket(jobId: string, input: any) {
  const job = await jobById(jobId); if (!job) throw new Error("Job not found");
  const subject = text(input.subject, "Subject", 200), body = text(input.body, "Request", 15000, 5);
  const change = input.requestChange === true;
  const out = await tx(async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",["support:"+jobId]);
    const count = (await c.query("SELECT count(*)::int AS n FROM commerce_tickets WHERE job_id=$1 AND created_at>now()-interval '1 hour'",[jobId])).rows[0].n;
    if(count>=10) throw new Error("This workspace has reached its hourly support request limit. Existing requests remain available.");
    const ticket = (await c.query("INSERT INTO commerce_tickets(job_id,subject,body,status) VALUES($1,$2,$3,$4) RETURNING *", [jobId, subject, body, change ? "change_requested" : "open"])).rows[0];
    let request = null;
    if (change) request = (await c.query(`INSERT INTO commerce_change_requests(parent_job_id,ticket_id,goal,budget_micro_usd)
      VALUES($1,$2,$3,$4) RETURNING *`, [jobId, ticket.id, `${subject}\n\n${body}`, Math.min(job.cost_limit_micro_usd, 25_000_000)])).rows[0];
    return { ticket, changeRequest: request };
  });
  await logEvent(jobId, "customer", "message", change ? "Customer requested a bounded follow-up engineering job." : "Customer opened a support ticket.", { ticket_id: out.ticket.id });
  try {
    const { customerMessage } = await import("./actions");
    const answer = await customerMessage(jobId, `${subject}\n\n${body}`);
    if (!change && !answer.needs_founder) {
      await q("UPDATE commerce_tickets SET status='resolved',resolution=$2,resolved_at=now() WHERE id=$1", [out.ticket.id, answer.answer]);
      out.ticket.status = "resolved"; out.ticket.resolution = answer.answer;
    }
  } catch (e) {
    await logEvent(jobId, "coordinator", "error", "Support reply needs review; the customer request remains recorded.", { ticket_id: out.ticket.id, error: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

export async function resolveTicket(id: number, resolution: unknown) {
  const message = text(resolution, "Resolution", 15000, 5);
  const ticket = await one<any>("UPDATE commerce_tickets SET status='resolved',resolution=$2,resolved_at=now() WHERE id=$1 RETURNING *", [id, message]);
  if (!ticket) throw new Error("Ticket not found");
  await q("INSERT INTO messages(job_id,sender,body,handled_by) VALUES($1,'coordinator',$2,'operator support response')", [ticket.job_id, message]);
  await addIntervention(ticket.job_id, "resolve_support", "Operator resolved a support ticket.", { ticket_id: id }, 0);
  return ticket;
}

export async function startChangeRequest(id: number, input: { repoZip: string; dbFile?: string; target?: string }) {
  const request = await one<any>("UPDATE commerce_change_requests SET status='starting',starting_at=now() WHERE id=$1 AND status='awaiting_source' RETURNING *", [id]);
  if (!request) {
    const existing = await one<any>("SELECT r.*,j.customer_token FROM commerce_change_requests r LEFT JOIN jobs j ON j.id=r.child_job_id WHERE r.id=$1", [id]);
    if (existing?.status === "started") return { id: existing.child_job_id, token: existing.customer_token };
    throw new Error("Change request is already starting or is not awaiting source");
  }
  try {
    const parent = await one<any>("SELECT j.*,a.name,a.contact_name,a.contact_email FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.id=$1", [request.parent_job_id]);
    const workspaceRequest = parent.recipe === "workspace-change" || fs.existsSync(jobDir(parent.id,"inputs","workspace-request.json"));
    const child = await createJob({ accountName: parent.name, contactName: parent.contact_name, contactEmail: parent.contact_email, kind: parent.kind,
      acquiredVia: `change-request:${id}`, title: `Follow-up: ${parent.title}`, slug: `${parent.app_slug}-followup`, timezone: parent.timezone,
      repoZip: input.repoZip, dbFile: input.dbFile, costLimitUsd: request.budget_micro_usd / 1_000_000, goal: request.goal,
      workspaceRequest, adaptiveRequest:workspaceRequest && fs.existsSync(jobDir(parent.id,"inputs","workspace-request.json")) && JSON.parse(fs.readFileSync(jobDir(parent.id,"inputs","workspace-request.json"),"utf8")).adaptive===true, constraints: parent.constraints ?? [], constraintNotes: parent.constraint_notes,
      ...(!workspaceRequest && input.target ? { migrationRequest: { target: input.target, dataChanges: request.goal } } : {}) });
    await q("UPDATE commerce_change_requests SET status='started',child_job_id=$2 WHERE id=$1", [id, child.id]);
    await logEvent(parent.id, "coordinator", "handoff", `Follow-up ${child.id} created with a fresh source snapshot and separate approval gates.`, { change_request_id: id, child_job_id: child.id });
    return child;
  } catch (e) {
    await q("UPDATE commerce_change_requests SET status='awaiting_source' WHERE id=$1 AND child_job_id IS NULL", [id]);
    throw e;
  }
}

export async function subscribeMaintenance(jobId: string, input: any) {
  if (input.consent !== true) throw new Error("Explicit consent to recurring checks is required");
  if (![7,30].includes(Number(input.intervalDays))) throw new Error("Choose a 7 or 30 day check interval");
  const job = await jobById(jobId);
  if (!job || !['delivered','invoice','follow_up','closed'].includes(job.stage)) throw new Error("Maintenance starts after verified delivery");
  const scope = text(input.scope, "Maintenance scope", 2000, 5);
  const row = await one<any>(`INSERT INTO commerce_maintenance(job_id,scope,interval_days,consent_at) VALUES($1,$2,$3,now())
    ON CONFLICT(job_id) DO UPDATE SET scope=EXCLUDED.scope,interval_days=EXCLUDED.interval_days,status='active',consent_at=now(),next_run_at=now() RETURNING *`, [jobId, scope, Number(input.intervalDays)]);
  await logEvent(jobId, "customer", "approval", "Customer enabled recurring delivery-integrity checks. New engineering work requires a separate proposal.", { plan_id: row.id, interval_days: row.interval_days });
  return row;
}

/** Performs real artifact/evidence integrity checks. It does not claim to test production or discover new upstream releases. */
export async function runMaintenanceChecks(planId?: number) {
  const plans = await q<any>(`UPDATE commerce_maintenance SET lease_until=now()+interval '5 minutes' WHERE id IN
    (SELECT id FROM commerce_maintenance WHERE status='active' AND (lease_until IS NULL OR lease_until<now())
      AND ($1::bigint IS NULL AND next_run_at<=now() OR id=$1) ORDER BY next_run_at LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`, [planId ?? null]);
  const results = [];
  for (const plan of plans) {
    const check = await one<any>("INSERT INTO commerce_checks(plan_id,status) VALUES($1,'running') RETURNING id", [plan.id]);
    try {
      const files = await q<any>("SELECT kind,path,sha256 FROM artifacts WHERE job_id=$1 AND (kind='delivery_package' OR frozen) ORDER BY id", [plan.job_id]);
      const checks = files.map(f => {
        const root = path.resolve(jobDir(plan.job_id)), p = path.resolve(f.path);
        const allowed = p.startsWith(root + path.sep);
        const present = allowed && fs.existsSync(p) && fs.statSync(p).isFile();
        const actual = present ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null;
        return { kind: f.kind, passed: !!f.sha256 && actual === f.sha256, reason: !allowed ? "Path outside job" : !present ? "Artifact missing" : actual !== f.sha256 ? "Artifact changed" : "Hash unchanged" };
      });
      const latest = await one<any>("SELECT verdict,integrity_ok,total,passed FROM check_runs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1", [plan.job_id]);
      const ok = checks.some(c => c.kind === "delivery_package") && checks.every(c => c.passed) && latest?.verdict === "pass" && latest.integrity_ok;
      const detail = { checks, lastVerification: latest, scope: "Delivered package and frozen-evidence integrity only", notChecked: ["Production deployment", "New dependency releases", "Runtime regression rerun"] };
      await q("UPDATE commerce_checks SET status=$2,detail=$3,finished_at=now() WHERE id=$1", [check!.id, ok ? "passed" : "attention", JSON.stringify(detail)]);
      if (!ok) await q(`INSERT INTO commerce_change_requests(parent_job_id,check_id,goal,budget_micro_usd) VALUES($1,$2,$3,25000000) ON CONFLICT(check_id) DO NOTHING`,
        [plan.job_id, check!.id, `Investigate maintenance integrity failure for ${plan.job_id}. Restore an independently verified delivery. A fresh source snapshot is required.`]);
      await logEvent(plan.job_id, "verification", "check", `Scheduled delivery-integrity check ${ok ? "passed" : "requires attention"}.`, { check_id: check!.id, ...detail });
      results.push({ id: check!.id, status: ok ? "passed" : "attention" });
    } catch (e) {
      await q("UPDATE commerce_checks SET status='failed',detail=$2,finished_at=now() WHERE id=$1", [check!.id, JSON.stringify({ error: e instanceof Error ? e.message : String(e) })]);
      results.push({ id: check!.id, status: "failed" });
    } finally {
      await q("UPDATE commerce_maintenance SET lease_until=NULL,next_run_at=now()+(interval_days||' days')::interval WHERE id=$1", [plan.id]);
    }
  }
  return results;
}

/** Trusted lifecycle templates always target the linked customer. Policy dispatch never selects prospect drafts. */
export async function syncCommerceForJob(jobId: string) {
  const job = await one<any>("SELECT j.*,a.contact_email,a.contact_name FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE j.id=$1",[jobId]);
  if (!job?.contact_email) return;
  const workspace = `${publicBaseUrl()}/jobs/${jobId}?t=${encodeURIComponent(job.customer_token)}`;
  const prefix = job.kind === "demo" ? "TEST " : "";
  const greeting = `${job.contact_name || "Hello"},\n\n`;
  const suffix = `\n\nReview your private workspace: ${workspace}` + (job.kind === "demo" ? "\n\nDemonstration only. No email is sent and no money is owed." : "");
  const draft = (purpose: TransactionalPurpose, key: string, subject: string, body: string) => draftEmail({ to:job.contact_email,subject:prefix+subject,body:greeting+body+suffix,jobId,isTest:job.kind === "demo",dedupeKey:key },purpose);
  if (job.stage === "awaiting_acceptance") {
    const proposal = await one<any>("SELECT * FROM proposals WHERE job_id=$1 AND status='sent' ORDER BY version DESC LIMIT 1",[jobId]);
    if (proposal) await draft("proposal",`proposal:${proposal.id}`,`Goose proposal for ${job.title}`,`Your proposal is ready: ${(proposal.price_cents/100).toFixed(2)} USD. Review the scope and acceptance checks before approving. Engineering work starts after your acceptance.`);
  }
  if (['delivered','invoice','follow_up','closed'].includes(job.stage)) {
    const artifact = await one<any>("SELECT id FROM artifacts WHERE job_id=$1 AND kind='delivery_package' ORDER BY id DESC LIMIT 1",[jobId]);
    if (artifact) await draft("delivery",`delivery:${artifact.id}`,`Goose delivery for ${job.title}`,"Your verified delivery and its evidence are ready. Review the files and accept the delivery in your workspace.");
  }
  const invoice = await one<any>("SELECT * FROM invoices WHERE job_id=$1 AND status='issued'",[jobId]);
  if (invoice) await draft("invoice",`invoice:${invoice.id}`,`Goose invoice ${invoice.number}`,`Your accepted delivery has invoice ${invoice.number}: ${(invoice.amount_cents/100).toFixed(2)} ${invoice.currency}. Open your workspace to review payment options.`);
  const replies = await q<any>(`SELECT m.id,m.body FROM messages m WHERE m.job_id=$1 AND m.in_reply_to IS NOT NULL AND m.sender IN ('coordinator','commercial')
    AND NOT EXISTS(SELECT 1 FROM commerce_outbox o WHERE o.dedupe_key='support:'||m.id) ORDER BY m.id LIMIT 20`,[jobId]);
  for(const reply of replies) await draft("support",`support:${reply.id}`,`Goose support update for ${job.title}`,reply.body);
}

export async function serviceCommerce() {
  // Recover an interrupted network send conservatively; a provider receipt may exist.
  await q("UPDATE commerce_outbox SET status='uncertain',error='Worker stopped during delivery; check the provider before retrying' WHERE status='sending' AND authorized_at<now()-interval '5 minutes'");
  // Recover a child created before a worker/process stopped while linking it back to support.
  await q(`UPDATE commerce_change_requests r SET status='started',child_job_id=j.id FROM jobs j JOIN accounts a ON a.id=j.account_id
    WHERE r.status='starting' AND a.acquired_via='change-request:'||r.id`);
  await q(`UPDATE commerce_change_requests r SET status='awaiting_source',starting_at=NULL
    WHERE r.status='starting' AND r.starting_at<now()-interval '5 minutes' AND NOT EXISTS
    (SELECT 1 FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE a.acquired_via='change-request:'||r.id)`);
  const jobs = await q<any>(`SELECT DISTINCT j.id FROM jobs j LEFT JOIN proposals p ON p.job_id=j.id AND p.status='sent'
    LEFT JOIN invoices i ON i.job_id=j.id AND i.status='issued'
    LEFT JOIN artifacts a ON a.job_id=j.id AND a.kind='delivery_package'
    WHERE (j.stage='awaiting_acceptance' AND p.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_outbox o WHERE o.dedupe_key='proposal:'||p.id))
      OR (j.stage IN ('delivered','invoice','follow_up','closed') AND a.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_outbox o WHERE o.dedupe_key='delivery:'||a.id))
      OR (i.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM commerce_outbox o WHERE o.dedupe_key='invoice:'||i.id))
      OR EXISTS(SELECT 1 FROM messages m WHERE m.job_id=j.id AND m.in_reply_to IS NOT NULL AND m.sender IN ('coordinator','commercial') AND NOT EXISTS(SELECT 1 FROM commerce_outbox o WHERE o.dedupe_key='support:'||m.id))
    ORDER BY j.id LIMIT 100`);
  const errors: string[] = [];
  for(const job of jobs) { try { await syncCommerceForJob(job.id); } catch(e) { errors.push(`${job.id}: ${e instanceof Error ? e.message : String(e)}`); } }
  const policy = await transactionalPolicy();
  let dispatched = 0;
  if (policy.enabled) {
    const drafts = await q<any>(`SELECT id,is_test FROM commerce_outbox WHERE status='draft' AND purpose IS NOT NULL AND (is_test OR $1) ORDER BY id LIMIT 30`,[policy.allowReal]);
    for(const draft of drafts) {
      if (!draft.is_test && !emailStatus().ready) continue;
      try { await dispatchEmail(draft.id,policy); dispatched++; }
      catch(e) { errors.push(`outbox ${draft.id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  return { synced:jobs.length,dispatched,errors };
}

export async function customerCommerce(jobId: string) {
  const [invoice, checkouts, tickets, maintenance, changeRequests] = await Promise.all([
    one<any>("SELECT * FROM invoices WHERE job_id=$1", [jobId]),
    q<any>("SELECT co.* FROM commerce_checkouts co JOIN invoices i ON i.id=co.invoice_id WHERE i.job_id=$1", [jobId]),
    q<any>("SELECT * FROM commerce_tickets WHERE job_id=$1 ORDER BY id DESC", [jobId]),
    q<any>("SELECT * FROM commerce_maintenance WHERE job_id=$1", [jobId]),
    q<any>("SELECT r.*,j.customer_token AS child_customer_token FROM commerce_change_requests r LEFT JOIN jobs j ON j.id=r.child_job_id WHERE r.parent_job_id=$1 ORDER BY r.id DESC", [jobId])]);
  return { invoice, checkouts, tickets, maintenance, changeRequests };
}

export async function commerceDashboard() {
  const [inquiries, outbox, invoices, payments, tickets, maintenance, checks, changeRequests, revenue, inboundMessages] = await Promise.all([
    q<any>("SELECT * FROM commerce_inquiries ORDER BY id DESC LIMIT 100"), q<any>("SELECT * FROM commerce_outbox ORDER BY id DESC LIMIT 100"),
    q<any>("SELECT * FROM invoices ORDER BY id DESC LIMIT 100"), q<any>("SELECT * FROM payments ORDER BY id DESC LIMIT 100"),
    q<any>("SELECT * FROM commerce_tickets ORDER BY id DESC LIMIT 100"), q<any>("SELECT * FROM commerce_maintenance ORDER BY id DESC LIMIT 100"),
    q<any>("SELECT c.*,m.job_id FROM commerce_checks c JOIN commerce_maintenance m ON m.id=c.plan_id ORDER BY c.id DESC LIMIT 100"),
    q<any>("SELECT * FROM commerce_change_requests ORDER BY id DESC LIMIT 100"),
    one<any>("SELECT COALESCE(sum(amount_cents) FILTER(WHERE NOT is_test),0)::bigint AS real,COALESCE(sum(amount_cents) FILTER(WHERE is_test),0)::bigint AS test FROM payments"),
    q<any>("SELECT id,event_type,sender,subject,is_test,outcome,reason,inquiry_id,received_at FROM commerce_inbound_messages ORDER BY id DESC LIMIT 100")]);
  return { integrations: { email: emailStatus(), payments: paymentStatus(), agentMailInbound:agentMailInboundStatus() }, transactionalPolicy: await transactionalPolicy(), inquiries, outbox, invoices, payments, tickets, maintenance, checks, changeRequests, inboundMessages,
    summary: { realRevenueCents: revenue?.real ?? 0, testRevenueCents: revenue?.test ?? 0, openInquiries: inquiries.filter(i => i.status === "new").length,
      pendingMessages: outbox.filter(o => o.status === "draft").length, openTickets: tickets.filter(t => t.status !== "resolved").length, activePlans: maintenance.filter(p => p.status === "active").length } };
}
