// Jobs: creation, the stage machine, durable execution and recovery.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, jobDir, ROLES, type Role } from "./config";
import { one, q, tx } from "./db";
import { logEvent, spendGate, usd } from "./records";

export type Job = {
  id: string; account_id: number; title: string; kind: "demo" | "real"; app_slug: string; timezone: string;
  mode: "local" | "naive"; stage: string; status: string; waiting_reason: string | null; responsible: Role;
  round: number; attempt: number; repair_budget: number; repairs_used: number; price_cents: number | null;
  cost_limit_micro_usd: number; test_fault: string | null; customer_token: string; checks_manifest_sha: string | null;
  created_at: string; updated_at: string;
  pipeline: number; goal: string | null; constraints: string[]; constraint_notes: string | null; recipe: string | null;
  work_type: string | null; source_stack: Record<string, any> | null;
};

export type StageResult = {
  next: string;
  status?: "running" | "waiting_customer" | "waiting_founder" | "done" | "rejected" | "declined";
  waiting?: string | null;
  responsible?: Role;
  output?: Record<string, unknown>;
  patch?: Partial<Pick<Job, "attempt" | "repairs_used" | "checks_manifest_sha" | "round" | "recipe" | "work_type">>;
};

// owner = the role in the first version (history); owner2 = the role in plan-driven jobs (pipeline 2), when different
export const STAGES: Record<string, { label: string; ops?: string; owner: Role; owner2?: Role; quoteSeconds: number; attemptKey: "round" | "attempt" | "one" }> = {
  intake: { label: "Checking your files", ops: "Checking the customer's files", owner: "commercial", owner2: "coordinator", quoteSeconds: 30, attemptKey: "round" },
  inspect: { label: "Inspecting your application", owner: "assessment", quoteSeconds: 60, attemptKey: "round" },
  plan: { label: "Planning the work", owner: "assessment", quoteSeconds: 60, attemptKey: "round" },
  assess: { label: "Assessing the application", owner: "commercial", quoteSeconds: 60, attemptKey: "round" },
  awaiting_info: { label: "Waiting for your answer", ops: "Waiting for the customer's answer", owner: "commercial", owner2: "coordinator", quoteSeconds: 0, attemptKey: "round" },
  propose: { label: "Preparing the proposal", owner: "commercial", owner2: "coordinator", quoteSeconds: 30, attemptKey: "round" },
  awaiting_acceptance: { label: "Waiting for you to accept the proposal", ops: "Waiting for the customer to accept the proposal", owner: "commercial", owner2: "coordinator", quoteSeconds: 0, attemptKey: "round" },
  baseline: { label: "Recording how the current app behaves", owner: "verification", quoteSeconds: 120, attemptKey: "one" },
  freeze: { label: "Freezing the acceptance checks", owner: "verification", quoteSeconds: 60, attemptKey: "one" },
  modernize: { label: "Upgrading the code", owner: "modernization", quoteSeconds: 120, attemptKey: "attempt" },
  implement: { label: "Making the agreed changes", owner: "implementation", quoteSeconds: 180, attemptKey: "attempt" },
  migrate: { label: "Rehearsing the data move", owner: "modernization", owner2: "implementation", quoteSeconds: 300, attemptKey: "attempt" },
  verify: { label: "Checking the upgrade independently", owner: "verification", quoteSeconds: 600, attemptKey: "attempt" },
  repair: { label: "Repairing failed checks", owner: "modernization", owner2: "implementation", quoteSeconds: 120, attemptKey: "attempt" },
  package: { label: "Preparing the delivery", owner: "coordinator", quoteSeconds: 60, attemptKey: "one" },
  delivered: { label: "Delivered - waiting for your acceptance", ops: "Delivered - waiting for the customer's acceptance", owner: "coordinator", quoteSeconds: 0, attemptKey: "one" },
  invoice: { label: "Preparing the invoice", owner: "coordinator", quoteSeconds: 10, attemptKey: "one" },
  follow_up: { label: "Scheduling follow-up", owner: "coordinator", quoteSeconds: 10, attemptKey: "one" },
  closed: { label: "Complete", owner: "coordinator", quoteSeconds: 0, attemptKey: "one" },
  rejected: { label: "Not a fit yet", owner: "commercial", owner2: "coordinator", quoteSeconds: 0, attemptKey: "one" },
  declined: { label: "Proposal declined", owner: "commercial", owner2: "coordinator", quoteSeconds: 0, attemptKey: "one" },
};

export function stageOwner(job: Pick<Job, "pipeline">, stage: string): Role {
  const m = STAGES[stage];
  return (job.pipeline >= 2 ? m?.owner2 ?? m?.owner : m?.owner) ?? "coordinator";
}

/** The operator's wording for a stage; the plain labels speak to the customer. */
export const opsStageLabel = (stage: string) => STAGES[stage]?.ops ?? STAGES[stage]?.label ?? stage;

export const DELIVERY_STEPS = ["assess", "propose", "baseline", "freeze", "modernize", "verify", "package", "delivered", "invoice"];
export const DELIVERY_STEPS_V2 = ["inspect", "plan", "propose", "baseline", "freeze", "implement", "verify", "package", "delivered", "invoice"];

export function stageAttempt(job: Job, stage: string) {
  const k = STAGES[stage]?.attemptKey ?? "one";
  return k === "round" ? job.round : k === "attempt" ? job.attempt : 1;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const r = await one<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return r ? r.value : fallback;
}

export async function pilotOffer() {
  const o = await getSetting<Record<string, number>>("pilot_offer", {});
  return {
    price_usd: o.price_usd ?? config.pilot.priceUsd, price_code_usd: o.price_code_usd ?? 900, price_data_usd: o.price_data_usd ?? 1200,
    cost_limit_usd: o.cost_limit_usd ?? config.pilot.costLimitUsd, repair_budget: o.repair_budget ?? config.pilot.repairBudget,
    delivery_days: o.delivery_days ?? config.pilot.deliveryDays,
  };
}

export async function createJob(opts: {
  accountName: string; contactName?: string; contactEmail?: string; kind: "demo" | "real"; acquiredVia?: string;
  title: string; slug: string; timezone: string; repoZip: string; dbFile?: string | null; costLimitUsd?: number;
  goal?: string; constraints?: string[]; constraintNotes?: string | null; documents?: { file: string; name: string }[];
  migrationRequest?: { target: string; dataChanges: string };
  workspaceRequest?: boolean;
  inquiryPublicId?: string;
}) {
  const offer = await pilotOffer();
  return await tx(async (c) => {
    // Claim the inquiry before allocating a job. A rejected or concurrent linkage must
    // not leave a running job whose private customer token was never returned.
    if (opts.inquiryPublicId) {
      const inquiry = (await c.query("SELECT email,is_test,job_id FROM commerce_inquiries WHERE public_id=$1 FOR UPDATE", [opts.inquiryPublicId])).rows[0];
      if (!inquiry || inquiry.email !== String(opts.contactEmail ?? "").trim().toLowerCase() || inquiry.is_test !== (opts.kind === "demo"))
        throw new Error("Inquiry and job customer identity do not match");
      if (inquiry.job_id) throw new Error("This inquiry is already linked to a job");
    }
    const acc = await c.query(
      "INSERT INTO accounts (name, contact_name, contact_email, kind, acquired_via) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [opts.accountName, opts.contactName ?? null, opts.contactEmail ?? null, opts.kind, opts.acquiredVia ?? null]);
    const n = await c.query("UPDATE job_counter SET next_value = next_value + 1 WHERE id = 1 RETURNING next_value - 1 AS v");
    const id = `GS-${n.rows[0].v}`;
    const token = crypto.randomBytes(12).toString("base64url");
    await c.query(
      `INSERT INTO jobs (id, account_id, title, kind, app_slug, timezone, mode, stage, status, responsible, repair_budget,
                         cost_limit_micro_usd, customer_token, pipeline, goal, constraints, constraint_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'intake','running','coordinator',$8,$9,$10,2,$11,$12,$13)`,
      [id, acc.rows[0].id, opts.title, opts.kind, opts.slug, opts.timezone, config.mode, offer.repair_budget,
       Math.round((opts.costLimitUsd ?? offer.cost_limit_usd) * 1_000_000), token,
       opts.goal?.trim() || "Update this application while keeping its current behaviour.", JSON.stringify(opts.constraints ?? []),
       opts.constraintNotes ?? null]);
    const inputs = jobDir(id, "inputs");
    fs.mkdirSync(inputs, { recursive: true });
    if (opts.workspaceRequest) {
      const requestFile = path.join(inputs, "workspace-request.json");
      fs.writeFileSync(requestFile, JSON.stringify({ version: 1, goal: opts.goal }), { mode: 0o444, flag: "wx" });
      await c.query("UPDATE jobs SET recipe='workspace-change',work_type='code' WHERE id=$1", [id]);
    }
    if (opts.migrationRequest?.target) {
      const requestFile = path.join(inputs, "migration-request.json");
      const requestBody = JSON.stringify(opts.migrationRequest, null, 2);
      fs.writeFileSync(requestFile, requestBody, { mode: 0o444, flag: "wx" });
      await c.query("INSERT INTO job_inputs (job_id,kind,filename,size_bytes,sha256,stored_path) VALUES($1,'document','migration-request.json',$2,$3,$4)",
        [id, Buffer.byteLength(requestBody), crypto.createHash("sha256").update(requestBody).digest("hex"), requestFile]);
    }
    const files: [string, string | null | undefined, string?][] = [["repository", opts.repoZip], ["database", opts.dbFile],
      ...(opts.documents ?? []).map((d, i) => ["document", d.file, `doc-${i + 1}-${path.basename(d.name).replace(/[^\w.-]/g, "_")}`] as [string, string, string])];
    for (const [kind, file, docName] of files) {
      if (!file) continue;
      const dbFileName = /\.sql\.gz$/i.test(file) ? "database.sql.gz" : /\.sql$/i.test(file) ? "database.sql" : "database.sqlite";
      const dest = path.join(inputs, kind === "repository" ? "repository.zip" : kind === "database" ? dbFileName : docName!);
      fs.copyFileSync(file, dest);
      fs.chmodSync(dest, 0o444);
      const sha = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
      await c.query("INSERT INTO job_inputs (job_id, kind, filename, size_bytes, sha256, stored_path) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, kind, docName ? docName.replace(/^doc-\d+-/, "") : path.basename(file), fs.statSync(dest).size, sha, dest]);
    }
    if (opts.inquiryPublicId) {
      await c.query("UPDATE commerce_inquiries SET job_id=$2,status='linked' WHERE public_id=$1", [opts.inquiryPublicId,id]);
      await c.query("INSERT INTO events(job_id,actor,kind,summary,detail,source,origin) VALUES($1,'coordinator','status','Customer inquiry linked to an executable engineering job.',$2,'local','tool')", [id,JSON.stringify({inquiry_public_id:opts.inquiryPublicId})]);
    }
    return { id, token };
  });
}

// ------------------------------------------------------------------ worker side

const WORKER_ID = `${os.hostname()}:${process.pid}`;
export const LEASE_SECONDS = 45;

export async function releaseDeadLeases() {
  const held = await q<{ id: string; lease_owner: string }>("SELECT id, lease_owner FROM jobs WHERE lease_owner IS NOT NULL");
  for (const j of held) {
    const [host, pid] = j.lease_owner.split(":");
    if (host !== os.hostname() || Number(pid) === process.pid) continue;
    let alive = true;
    try { process.kill(Number(pid), 0); } catch { alive = false; }
    if (!alive) {
      await q("UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2", [j.id, j.lease_owner]);
      await logEvent(j.id, "system", "status", `Worker ${j.lease_owner} stopped while holding this job; another worker will resume it.`,
        undefined, { important: true });
    }
  }
}

export async function claimJob(): Promise<Job | null> {
  return await one<Job>(
    `UPDATE jobs SET lease_owner = $1, lease_expires_at = now() + ($2 || ' seconds')::interval
      WHERE id = (SELECT id FROM jobs WHERE status = 'running' AND mode = $3 AND next_run_at <= now()
                     AND (lease_expires_at IS NULL OR lease_expires_at < now())
                   ORDER BY next_run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [WORKER_ID, String(LEASE_SECONDS), config.mode]);
}

export async function renewLease(jobId: string) {
  await q("UPDATE jobs SET lease_expires_at = now() + ($2 || ' seconds')::interval WHERE id = $1 AND lease_owner = $3",
    [jobId, String(LEASE_SECONDS), WORKER_ID]);
}

export async function releaseLease(jobId: string) {
  await q("UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2", [jobId, WORKER_ID]);
}

/** Run the job's current stage once. Succeeded stages are never repeated; interrupted ones resume. */
export async function runCurrentStage(job: Job, impl: Record<string, (job: Job, attempt: number) => Promise<StageResult>>) {
  const stage = job.stage;
  const meta = STAGES[stage];
  const fn = impl[stage];
  if (!meta || !fn) {
    await q("UPDATE jobs SET status = 'waiting_founder', waiting_reason = $2, updated_at = now() WHERE id = $1",
      [job.id, `No worker step for stage ${stage}`]);
    return;
  }
  const attempt = stageAttempt(job, stage);
  const prior = await one<{ status: string; output: StageResult | null; runs: number }>(
    "SELECT status, output, runs FROM stage_runs WHERE job_id = $1 AND stage = $2 AND attempt = $3", [job.id, stage, attempt]);
  if (prior?.status === "succeeded" && prior.output) {
    await applyResult(job, stage, attempt, prior.output, false);   // finished before a crash, but the job never moved on
    return;
  }
  const quote = Math.round(meta.quoteSeconds * config.computerMicroUsdPerSecond) +
    (config.mode === "naive" ? 2_000_000 : 0);
  const gate = await spendGate(job.id, job.cost_limit_micro_usd, quote);
  if (!gate.ok) {
    await q("UPDATE jobs SET status = 'waiting_founder', waiting_reason = $2, updated_at = now() WHERE id = $1",
      [job.id, `Spending limit reached: ${usd(gate.spent)} of ${usd(gate.limit)} used; "${meta.label}" needs up to ${usd(gate.quote)}. ` +
       "Stopped before spending more."]);
    await logEvent(job.id, "coordinator", "decision", `Stopped at the spending limit before "${meta.label}" ` +
      `(${usd(gate.spent)} spent of ${usd(gate.limit)}, next step quoted at ${usd(gate.quote)}).`, gate, { important: true });
    return;
  }
  if (prior) {
    await q("UPDATE stage_runs SET status = 'running', runs = runs + 1, started_at = now(), error = NULL WHERE job_id = $1 AND stage = $2 AND attempt = $3",
      [job.id, stage, attempt]);
    await logEvent(job.id, "system", "status", `Resuming "${meta.label}" (attempt ${attempt}) after an interruption - run ${prior.runs + 1}.`,
      undefined, { important: true });
  } else {
    await q("INSERT INTO stage_runs (job_id, stage, attempt, status, actor, mode) VALUES ($1,$2,$3,'running',$4,$5)",
      [job.id, stage, attempt, stageOwner(job, stage), config.mode]);
    await logEvent(job.id, "coordinator", "handoff", `${meta.label}: assigned to the ${ROLES[stageOwner(job, stage)].name.toLowerCase()}` +
      (attempt > 1 ? ` (attempt ${attempt})` : ""), { stage, attempt });
  }
  await q("UPDATE jobs SET responsible = $2, updated_at = now() WHERE id = $1", [job.id, stageOwner(job, stage)]);
  const beat = setInterval(() => { renewLease(job.id).catch(() => undefined); }, 15_000);
  try {
    const result = await fn(job, attempt);
    await applyResult(job, stage, attempt, result, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await q("UPDATE stage_runs SET status = 'failed', error = $4, finished_at = now() WHERE job_id = $1 AND stage = $2 AND attempt = $3",
      [job.id, stage, attempt, msg.slice(0, 4000)]);
    await q("UPDATE jobs SET status = 'waiting_founder', waiting_reason = $2, updated_at = now() WHERE id = $1",
      [job.id, `"${meta.label}" failed: ${msg.slice(0, 300)}`]);
    await logEvent(job.id, "system", "error", `"${meta.label}" stopped with an error; the founder has been asked to look.`,
      { error: msg.slice(0, 2000) }, { important: true });
  } finally {
    clearInterval(beat);
  }
}

async function applyResult(job: Job, stage: string, attempt: number, r: StageResult, fresh: boolean) {
  await tx(async (c) => {
    if (fresh) {
      await c.query("UPDATE stage_runs SET status = 'succeeded', output = $4, finished_at = now() WHERE job_id = $1 AND stage = $2 AND attempt = $3",
        [job.id, stage, attempt, JSON.stringify(r)]);
    }
    const nextStatus = r.status ?? "running";
    const owner = r.responsible ?? (STAGES[r.next] ? stageOwner(job, r.next) : job.responsible);
    await c.query(
      `UPDATE jobs SET stage = $2, status = $3, waiting_reason = $4, responsible = $5,
              attempt = COALESCE($6, attempt), repairs_used = COALESCE($7, repairs_used),
              checks_manifest_sha = COALESCE($8, checks_manifest_sha), round = COALESCE($9, round),
              recipe = COALESCE($10, recipe), work_type = COALESCE($11, work_type),
              next_run_at = now(), updated_at = now() WHERE id = $1`,
      [job.id, r.next, nextStatus, r.waiting ?? null, owner, r.patch?.attempt ?? null, r.patch?.repairs_used ?? null,
       r.patch?.checks_manifest_sha ?? null, r.patch?.round ?? null, r.patch?.recipe ?? null, r.patch?.work_type ?? null]);
  });
}

export async function jobById(id: string) {
  return await one<Job>("SELECT * FROM jobs WHERE id = $1", [id]);
}

export async function jobByToken(id: string, token: string) {
  return await one<Job>("SELECT * FROM jobs WHERE id = $1 AND customer_token = $2", [id, token]);
}
