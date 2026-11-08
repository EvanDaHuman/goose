// Things people do: the customer (answers, approvals, questions) and the founder (interventions).
// Customer approvals and founder interventions are stored in different tables and never mixed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as agents from "./agents";
import { jobDir } from "./config";
import { one, q, tx } from "./db";
import { jobById, stageAttempt, STAGES, type Job } from "./jobs";
import { addIntervention, jobSpend, logEvent, usd } from "./records";

function must(job: Job | null): Job {
  if (!job) throw new Error("job not found");
  return job;
}

export async function answerQuestion(jobId: string, key: string, answer: Record<string, unknown>, by: string, audience: "customer" | "founder") {
  const job = must(await jobById(jobId));
  const qrow = await one<{ id: number; audience: string; status: string }>("SELECT id, audience, status FROM questions WHERE job_id = $1 AND key = $2", [jobId, key]);
  if (!qrow || qrow.status !== "open") throw new Error("no open question with that key");
  if (qrow.audience !== audience) throw new Error("This question requires the designated audience");
  await q("UPDATE questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = now() WHERE job_id = $1 AND key = $2",
    [jobId, key, JSON.stringify(answer), by]);
  if (audience === "founder") {
    await addIntervention(jobId, "answered_question", `Founder answered: ${key}`, answer);
  } else {
    await logEvent(jobId, "customer", "message", `Customer answered "${key}": ${JSON.stringify(answer)}`, { by });
  }
  const open = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM questions WHERE job_id = $1 AND status = 'open' AND blocking", [jobId]);
  if (!open?.n && job.stage === "awaiting_info") {
    const reupload = key.startsWith("upload-") || key === "Q-db";
    // plan-driven jobs go back to the planner: a new answer may change the plan
    await q("UPDATE jobs SET stage = $2, status = 'running', waiting_reason = NULL, round = round + 1, next_run_at = now(), updated_at = now() WHERE id = $1",
      [jobId, reupload ? "intake" : job.pipeline >= 2 ? "plan" : "propose"]);
  }
}

export async function addUpload(jobId: string, kind: "repository" | "database", tmpFile: string, filename: string) {
  const dest = jobDir(jobId, "inputs", `${kind === "repository" ? "repository" : "database"}-${Date.now()}${kind === "repository" ? ".zip" : ".sqlite"}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(tmpFile, dest);
  fs.chmodSync(dest, 0o444);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
  await q("INSERT INTO job_inputs (job_id, kind, filename, size_bytes, sha256, stored_path) VALUES ($1,$2,$3,$4,$5,$6)",
    [jobId, kind, filename, fs.statSync(dest).size, sha, dest]);
  await logEvent(jobId, "customer", "message", `Customer uploaded a new ${kind} file (${filename}).`, { sha256: sha });
}

export async function acceptProposal(jobId: string, version: number, byName: string, byEmail: string | null, statement: string) {
  const accepted = await tx(async (c) => {
    const job = must((await c.query<Job>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0] ?? null);
    if (job.stage !== "awaiting_acceptance") throw new Error("no proposal is waiting for acceptance");
    const p = (await c.query<{ id: number; version: number; scope: any; scope_sha256: string; status: string; price_cents: number }>(
      "SELECT id,version,scope,scope_sha256,status,price_cents FROM proposals WHERE job_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE", [jobId])).rows[0];
    if (!p || p.version !== version || p.status !== "sent") throw new Error("that proposal version is not open");
    const prior = await c.query("SELECT 1 FROM approvals WHERE job_id=$1 AND kind='proposal' AND decision='accepted'", [jobId]);
    if (prior.rowCount) throw new Error("a proposal has already been accepted");
    // The same row lock protects the decision and the exact selected proposal's frozen files.
    // A failed transaction cannot start engineering; a later valid acceptance replaces these files.
    const planned = p.scope?.plan ? p.scope : null;
    const files: [string, unknown][] = [[jobDir(jobId, "work", "scope.json"), planned ? planned.detail ?? {} : p.scope]];
    if (planned) files.push([jobDir(jobId, "work", "accepted-plan.json"), planned.plan]);
    fs.mkdirSync(jobDir(jobId, "work"), { recursive: true });
    for (const [file, data] of files) {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o444 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    if (!planned) fs.rmSync(jobDir(jobId, "work", "accepted-plan.json"), { force: true });
    await c.query("UPDATE proposals SET status='accepted',decided_at=now() WHERE id=$1", [p.id]);
    await c.query("INSERT INTO approvals (job_id,kind,decision,by_name,by_email,statement,reference) VALUES ($1,'proposal','accepted',$2,$3,$4,$5)",
      [jobId, byName, byEmail, statement, `proposal v${version} sha256 ${p.scope_sha256}`]);
    await c.query("UPDATE jobs SET stage='baseline',status='running',waiting_reason=NULL,next_run_at=now(),updated_at=now() WHERE id=$1", [jobId]);
    return p;
  });
  await logEvent(jobId, "customer", "approval", `${byName} accepted proposal v${version} ($${(accepted.price_cents / 100).toLocaleString("en-US")} fixed).`,
    { version, statement }, { important: true });
}

export async function declineProposal(jobId: string, version: number, byName: string, reason: string) {
  await tx(async (c) => {
    const job = must((await c.query<Job>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0] ?? null);
    if (job.stage !== "awaiting_acceptance") throw new Error("no proposal is waiting for acceptance");
    const proposal = (await c.query<{ id:number; version:number; status:string }>(
      "SELECT id,version,status FROM proposals WHERE job_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE", [jobId])).rows[0];
    if (!proposal || proposal.version !== version || proposal.status !== "sent") throw new Error("that proposal version is not open");
    const accepted = await c.query("SELECT 1 FROM approvals WHERE job_id=$1 AND kind='proposal' AND decision='accepted'", [jobId]);
    if (accepted.rowCount) throw new Error("a proposal has already been accepted");
    await c.query("UPDATE proposals SET status='declined',decided_at=now() WHERE id=$1", [proposal.id]);
    await c.query("INSERT INTO approvals (job_id,kind,decision,by_name,statement,reference) VALUES ($1,'proposal','declined',$2,$3,$4)",
      [jobId, byName, reason || "Declined", `proposal v${version}`]);
    await c.query("UPDATE jobs SET stage='declined',status='declined',waiting_reason=NULL,updated_at=now() WHERE id=$1", [jobId]);
  });
  await logEvent(jobId, "customer", "approval", `${byName} declined proposal v${version}.`, { reason }, { important: true });
}

export async function acceptDelivery(jobId: string, byName: string, byEmail: string | null, statement: string) {
  await tx(async (c) => {
    const job = must((await c.query<Job>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0] ?? null);
    if (job.stage !== "delivered") throw new Error("nothing is waiting for delivery acceptance");
    const pkg = (await c.query<{ sha256:string; path:string }>(
      "SELECT sha256,path FROM artifacts WHERE job_id=$1 AND kind='delivery_package' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE", [jobId])).rows[0];
    if (!pkg?.sha256 || !fs.existsSync(pkg.path) || !fs.statSync(pkg.path).isFile()) throw new Error("delivery package is missing or has no recorded integrity hash");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(pkg.path)).digest("hex");
    if (actual !== pkg.sha256) throw new Error("delivery package integrity check failed; acceptance was not recorded");
    const accepted = await c.query("SELECT 1 FROM approvals WHERE job_id=$1 AND kind='delivery' AND decision='accepted'", [jobId]);
    if (accepted.rowCount) throw new Error("delivery has already been accepted");
    await c.query("INSERT INTO approvals (job_id,kind,decision,by_name,by_email,statement,reference) VALUES ($1,'delivery','accepted',$2,$3,$4,$5)",
      [jobId, byName, byEmail, statement, `delivery package sha256 ${pkg.sha256}`]);
    await c.query("UPDATE jobs SET stage='invoice',status='running',waiting_reason=NULL,next_run_at=now(),updated_at=now() WHERE id=$1", [jobId]);
  });
  await logEvent(jobId, "customer", "approval", `${byName} accepted the delivery.`, { statement }, { important: true });
}

export async function remainingSupportBudget(jobId: string, capMicroUsd: number) {
  const spent = await jobSpend(jobId);
  return Math.max(0, Math.min(500_000, capMicroUsd - spent.total));
}

export async function customerMessage(jobId: string, body: string) {
  const job = must(await jobById(jobId));
  const msg = await one<{ id: number }>("INSERT INTO messages (job_id, sender, body) VALUES ($1,'customer',$2) RETURNING id", [jobId, body]);
  const run = await one<any>("SELECT total, passed, failed FROM check_runs WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1", [jobId]);
  const facts = {
    stageLabel: STAGES[job.stage]?.label ?? job.stage,
    nextStep: job.status === "waiting_customer" ? `It is waiting for you: ${job.waiting_reason ?? ""}`
      : job.status === "waiting_founder" ? "It is waiting for our founder to review something; we'll update you here."
        : job.status === "done" ? "The job is complete." : "The agents are working on it now; this page updates as each step finishes.",
    price: job.price_cents ? `$${(job.price_cents / 100).toLocaleString("en-US")}` : null,
    checks: run,
  };
  const answerer = job.pipeline >= 2 ? "coordinator" : "commercial";
  const supportBudget = await remainingSupportBudget(jobId, job.cost_limit_micro_usd);
  const reply = await agents.answerCustomer({ jobId, stage: "support", attempt: msg!.id, budgetMicroUsd: supportBudget }, body, facts);
  await q("INSERT INTO messages (job_id, sender, body, in_reply_to, handled_by, needs_founder) VALUES ($1,$2,$3,$4,$5,$6)",
    [jobId, answerer, reply.answer, msg!.id, reply.by, reply.needs_founder]);
  await logEvent(jobId, answerer, "message", reply.needs_founder ? "Customer question passed to the founder." : "Answered a customer question.",
    { question: body, by: reply.by }, { origin: reply.origin, originDetail: "sessionId" in reply ? { session_id: (reply as any).sessionId } : undefined });
  return reply;
}

// ------------------------------------------------------------------ founder interventions

export async function raiseCostLimit(jobId: string, newLimitUsd: number, reason: string, minutes = 1) {
  const job = must(await jobById(jobId));
  const micro = Math.round(newLimitUsd * 1_000_000);
  const spent = await jobSpend(jobId);
  await q(`UPDATE jobs SET cost_limit_micro_usd = $2,
             status = CASE WHEN status = 'waiting_founder' AND waiting_reason LIKE 'Spending limit%' THEN 'running' ELSE status END,
             waiting_reason = CASE WHEN waiting_reason LIKE 'Spending limit%' THEN NULL ELSE waiting_reason END,
             next_run_at = now(), updated_at = now() WHERE id = $1`, [jobId, micro]);
  await addIntervention(jobId, "raise_cost_limit", `Raised the spending limit from ${usd(job.cost_limit_micro_usd)} to ${usd(micro)} (${usd(spent.total)} spent). ${reason}`,
    { from: job.cost_limit_micro_usd, to: micro }, minutes);
}

export async function injectTestFault(jobId: string, fault: string, minutes = 1) {
  const job = must(await jobById(jobId));
  if (["modernize", "migrate", "verify", "repair", "package", "delivered", "invoice", "follow_up", "closed"].includes(job.stage) && job.attempt > 1) {
    throw new Error("a test fault can only be set before the first code generation");
  }
  await q("UPDATE jobs SET test_fault = $2, updated_at = now() WHERE id = $1", [jobId, fault]);
  await addIntervention(jobId, "inject_test_fault", `TEST FAULT scheduled: "${fault}" will be injected after code generation, to demonstrate detection and repair.`,
    { fault }, minutes);
}

export async function grantRepairAttempt(jobId: string, reason: string, minutes = 2) {
  const job = must(await jobById(jobId));
  await q(`UPDATE jobs SET repair_budget = repair_budget + 1, stage = CASE WHEN stage = 'verify' THEN 'repair' ELSE stage END,
             status = 'running', waiting_reason = NULL, next_run_at = now(), updated_at = now() WHERE id = $1`, [jobId]);
  await addIntervention(jobId, "grant_repair", `Granted one more repair attempt (budget ${job.repair_budget} -> ${job.repair_budget + 1}). ${reason}`,
    undefined, minutes);
}

export async function retryStage(jobId: string, reason: string, minutes = 2) {
  const job = must(await jobById(jobId));
  if (job.status !== "waiting_founder") throw new Error("Only a job waiting for founder recovery can be retried");
  const attempt = stageAttempt(job, job.stage);
  // A stage can return a waiting_founder result without throwing. Invalidate that cached result
  // while retaining its run count and error, so an explicit retry resumes the actual work.
  await q("UPDATE stage_runs SET status='failed', error=COALESCE(error,output->>'waiting'), output=NULL WHERE job_id=$1 AND stage=$2 AND attempt=$3", [jobId, job.stage, attempt]);
  await q("UPDATE jobs SET status = 'running', waiting_reason = NULL, next_run_at = now(), updated_at = now() WHERE id = $1", [jobId]);
  await addIntervention(jobId, "retry_stage", `Asked the agents to retry "${STAGES[job.stage]?.label ?? job.stage}". ${reason}`, undefined, minutes);
}

/** Founder: inspect and plan again from the start (only before the customer accepted a proposal). */
export async function replan(jobId: string, reason: string, minutes = 3) {
  await tx(async (c) => {
    const job = must((await c.query<Job & {lease_owner:string|null}>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [jobId])).rows[0] ?? null) as Job & {lease_owner:string|null};
    if (!["intake", "inspect", "assess", "plan", "propose", "awaiting_info", "awaiting_acceptance"].includes(job.stage)) {
      throw new Error("a job can be planned again only before its proposal is accepted");
    }
    const accepted = await c.query(`SELECT 1 FROM proposals WHERE job_id=$1 AND status='accepted'
      UNION ALL SELECT 1 FROM approvals WHERE job_id=$1 AND kind='proposal' AND decision='accepted'`, [jobId]);
    if (accepted.rowCount) throw new Error("a job can be planned again only before its proposal is accepted");
    if (job.lease_owner) throw new Error("wait for the active worker step to finish before replanning");
    await c.query("UPDATE proposals SET status='superseded' WHERE job_id=$1 AND status='sent'", [jobId]);
    // A new round gets new durable stage keys. Keep all prior assessment and verification evidence.
    // Revalidate uploads so missing, replaced or previously rejected source never bypasses intake.
    await c.query("UPDATE jobs SET stage='intake',status='running',waiting_reason=NULL,round=round+1,next_run_at=now(),updated_at=now() WHERE id=$1", [jobId]);
  });
  await addIntervention(jobId, "replan", `Founder asked for a new inspection and plan: ${reason}`, undefined, minutes);
}

export async function recordTestPayment(jobId: string) {
  const inv = await one<{ id: number; amount_cents: number; is_test: boolean; status: string }>("SELECT id, amount_cents, is_test, status FROM invoices WHERE job_id = $1", [jobId]);
  if (!inv) throw new Error("no invoice");
  if (!inv.is_test) throw new Error("real payments must be recorded with a bank reference, not as a test");
  await q("INSERT INTO payments (invoice_id, amount_cents, is_test, method, reference, recorded_by) VALUES ($1,$2,true,'test','TEST PAYMENT - no money moved','founder')",
    [inv.id, inv.amount_cents]);
  await q("UPDATE invoices SET status = 'paid' WHERE id = $1", [inv.id]);
  await addIntervention(jobId, "record_test_payment", "Recorded a TEST payment against a test invoice (no money moved).", undefined, 0);
}

export async function logFounderTime(jobId: string | null, minutes: number, note: string) {
  await addIntervention(jobId, "founder_time", note, undefined, minutes);
}

/** After the founder fixes the playbook: rebuild the code and re-run the data move and checks. The frozen checks stay frozen. */
export async function rebuildFromGeneration(jobId: string, reason: string, minutes = 10) {
  const job = must(await jobById(jobId));
  if (!["modernize", "migrate", "verify", "repair"].includes(job.stage)) throw new Error("the job is not in the upgrade steps");
  await q("DELETE FROM stage_runs WHERE job_id = $1 AND stage IN ('modernize','migrate','verify','repair') AND attempt = $2", [jobId, job.attempt]);
  fs.rmSync(jobDir(jobId, "build", `attempt-${job.attempt}`), { recursive: true, force: true });
  fs.rmSync(jobDir(jobId, "runtime", `attempt-${job.attempt}`), { recursive: true, force: true });
  await q("UPDATE jobs SET stage = CASE WHEN pipeline >= 2 THEN 'implement' ELSE 'modernize' END, status = 'running', waiting_reason = NULL, next_run_at = now(), updated_at = now() WHERE id = $1", [jobId]);
  await addIntervention(jobId, "rebuild", `Rebuilt the upgrade from code generation after a playbook fix. ${reason}`, { attempt: job.attempt }, minutes);
}
