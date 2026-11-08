// Autonomous recovery. Any job that stops with status waiting_founder is resolved by the worker without a person:
//   infrastructure (Docker down)       start it and resume                          (lib/infraRecovery.ts)
//   spending limit                     raise the limit, up to a hard per-job ceiling
//   repair budget used up              grant extra repairs, up to a bound
//   a data question for the founder    route it to the customer, whose data it is
//   unsafe or impossible to continue   end the job honestly ("not a fit"); nothing is invoiced before delivery
//   anything else (agent/step failure) retry the step with exponential backoff, up to a bound, then end the job
// A job whose reason starts "Stopped by the operator" or "Paused by the operator" was halted on purpose and is left alone.
// Every action is a recorded system event, not a founder intervention. GOOSE_PUBLIC_JOBS_REQUIRE_APPROVAL, when an
// operator deliberately sets it, is the one wait left for a person.
import { q } from "./db";
import { config } from "./config";
import { stageAttempt, type Job } from "./jobs";
import { isInfraWait } from "./infraWait";
import { serviceInfraRecovery } from "./infraRecovery";
import { logEvent, usd } from "./records";

const MAX_RETRIES = () => Math.max(1, Number(process.env.GOOSE_AUTO_RECOVERY_MAX ?? 6) || 6);
const COST_CEILING = () => Math.round(Math.max(1, Number(process.env.GOOSE_AUTO_COST_CEILING_USD ?? 50) || 50) * 1_000_000);
const EXTRA_ROUNDS = () => Math.max(0, Number(process.env.GOOSE_AUTO_EXTRA_ROUNDS ?? 1) || 0);
const EXTRA_REPAIRS = () => Math.max(0, Number(process.env.GOOSE_AUTO_EXTRA_REPAIRS ?? 2) || 0);
const APPROVAL_WAIT = "Your request is awaiting operator approval";

export type Recovery = "infra" | "approval" | "operator_hold" | "new_round" | "raise_limit" | "extra_repair" | "route_question" | "end" | "retry" | "backoff";

/** A person deliberately stopped or paused this job: recovery never restarts it. */
export const OPERATOR_HOLD = /^(Stopped|Paused) by the operator\b/i;

/** Decide what to do with a waiting job. Pure: tested in tests/integration/autonomy.test.ts. */
export function classify(reason: string, job: { auto_recoveries: number; auto_extra_repairs: number; cost_limit_micro_usd: number; mode?: string; round?: number }, now = Date.now(), lastAt: number | null = null): { action: Recovery; why: string } {
  const r = reason ?? "";
  if (OPERATOR_HOLD.test(r)) return { action: "operator_hold", why: "a person stopped this job on purpose; only they resume it" };
  if (isInfraWait(r)) return { action: "infra", why: "execution backend" };
  if (r.startsWith(APPROVAL_WAIT)) return { action: "approval", why: "operator approval was explicitly required (GOOSE_PUBLIC_JOBS_REQUIRE_APPROVAL)" };
  if (/integrity|evidence changed|no longer reproduce/i.test(r)) return { action: "end", why: "the frozen acceptance evidence could not be trusted, so the work cannot be verified" };
  // a new discovery round inherits the previous round's real execution evidence for the same source
  if (/exhausted eight bounded attempts/i.test(r)) return (job.round ?? 1) <= EXTRA_ROUNDS() ? { action: "new_round", why: "all eight discovery attempts used; starting another round with their evidence" }
    : { action: "end", why: "Goose could not reproduce a working environment and acceptance checks for this repository" };
  if (/Additional execution support is needed|cannot run yet|No repair is available|no known repair applies|No worker step/i.test(r)) return { action: "end", why: r.slice(0, 300) };
  if (/requires live Naive|needs the live|not running in local mode|requires the live/i.test(r) && (job.mode ?? config.mode) !== "naive") return { action: "end", why: "this work needs the live agent team, which is not running" };
  if (/^Spending limit reached/i.test(r)) return job.cost_limit_micro_usd < COST_CEILING() ? { action: "raise_limit", why: r } : { action: "end", why: `the job reached its ${usd(COST_CEILING(), 0)} cost ceiling without finishing` };
  if (/repair budget/i.test(r)) return job.auto_extra_repairs < EXTRA_REPAIRS() ? { action: "extra_repair", why: r } : { action: "end", why: "the checks still failed after every repair attempt" };
  if (/data decision needs the founder/i.test(r)) return { action: "route_question", why: r };
  if (job.auto_recoveries >= MAX_RETRIES()) return { action: "end", why: `the step kept failing after ${job.auto_recoveries} automatic retries (last: ${r.slice(0, 200)})` };
  const wait = Math.min(30, 2 ** (job.auto_recoveries + 1)) * 60_000;   // 2, 4, 8, 16, 30, 30 minutes
  if (lastAt && now - lastAt < wait) return { action: "backoff", why: `next retry in ${Math.ceil((wait - (now - lastAt)) / 60_000)} min` };
  return { action: "retry", why: r };
}

async function resume(job: Job, set = "") {
  const attempt = stageAttempt(job, job.stage);
  await q("UPDATE stage_runs SET status='failed', error=COALESCE(error,output->>'waiting'), output=NULL WHERE job_id=$1 AND stage=$2 AND attempt=$3", [job.id, job.stage, attempt]);
  await q(`UPDATE jobs SET status='running', waiting_reason=NULL, next_run_at=now(), updated_at=now()${set} WHERE id=$1 AND status='waiting_founder'`, [job.id]);
}

export async function serviceAutonomy(now = Date.now()) {
  await serviceInfraRecovery();
  const jobs = await q<Job & { auto_recoveries: number; auto_extra_repairs: number; auto_recovered_at: string | null }>(
    "SELECT * FROM jobs WHERE status='waiting_founder' ORDER BY id");
  const done: { id: string; action: Recovery }[] = [];
  for (const job of jobs) {
    const reason = job.waiting_reason ?? "";
    const c = classify(reason, job, now, job.auto_recovered_at ? Date.parse(job.auto_recovered_at) : null);
    if (c.action === "infra" || c.action === "backoff" || c.action === "operator_hold") continue;
    if (c.action === "approval") { if (config.publicJobsRequireApproval) continue; await resume(job); }
    else if (c.action === "new_round") {
      await q("UPDATE proposals SET status='superseded' WHERE job_id=$1 AND status='sent'", [job.id]);
      await q("UPDATE jobs SET stage='intake', status='running', waiting_reason=NULL, round=round+1, next_run_at=now(), updated_at=now() WHERE id=$1 AND status='waiting_founder'", [job.id]);
    }
    else if (c.action === "retry") await resume(job, ", auto_recoveries=auto_recoveries+1, auto_recovered_at=now()");
    else if (c.action === "raise_limit") {
      const to = Math.min(COST_CEILING(), Math.round(job.cost_limit_micro_usd * 1.5));
      await q("UPDATE jobs SET cost_limit_micro_usd=$2 WHERE id=$1", [job.id, to]);
      await resume(job);
      await logEvent(job.id, "coordinator", "decision", `Spending limit raised automatically from ${usd(job.cost_limit_micro_usd)} to ${usd(to)} (ceiling ${usd(COST_CEILING(), 0)}).`, { from: job.cost_limit_micro_usd, to }, { origin: "system", important: true });
    } else if (c.action === "extra_repair") {
      await q(`UPDATE jobs SET repair_budget=repair_budget+1, auto_extra_repairs=auto_extra_repairs+1, stage=CASE WHEN stage='verify' THEN 'repair' ELSE stage END,
        status='running', waiting_reason=NULL, next_run_at=now(), updated_at=now() WHERE id=$1 AND status='waiting_founder'`, [job.id]);
    } else if (c.action === "route_question") {
      await q("UPDATE questions SET audience='customer' WHERE job_id=$1 AND status='open' AND audience='founder'", [job.id]);
      await q("UPDATE jobs SET status='waiting_customer', waiting_reason='Waiting for the customer to answer a question about their data', updated_at=now() WHERE id=$1", [job.id]);
    } else if (c.action === "end") {
      const note = `Goose stopped this job without delivering: ${c.why}. Nothing has been invoiced. You can reply here or submit an updated repository to try again.`;
      await q("UPDATE jobs SET stage='rejected', status='rejected', waiting_reason=$2, updated_at=now() WHERE id=$1 AND status='waiting_founder'", [job.id, note.slice(0, 1000)]);
      await q("INSERT INTO messages(job_id,sender,body,handled_by) VALUES($1,'coordinator',$2,'autonomous recovery')", [job.id, note]);
    }
    if (c.action !== "raise_limit")
      await logEvent(job.id, "coordinator", "decision", `Autonomous recovery (${c.action.replace("_", " ")}): ${c.why.slice(0, 300)}`, { reason, action: c.action }, { origin: "system", important: true });
    done.push({ id: job.id, action: c.action });
  }
  return done;
}
