// The activity record, the cost ledger and the spending gate.
import { config, type Role } from "./config";
import { one, q } from "./db";

export type Actor = Role | "customer" | "founder" | "system";

export async function logEvent(
  jobId: string | null,
  actor: Actor,
  kind: string,
  summary: string,
  detail?: unknown,
  opts: { important?: boolean; source?: "local" | "naive"; origin?: Origin; originDetail?: Record<string, unknown> } = {},
) {
  const origin = opts.origin ?? (actor === "customer" || actor === "founder" ? "human" : actor === "system" ? "system" : "tool");
  await q(
    "INSERT INTO events (job_id, actor, kind, summary, detail, important, source, origin, origin_detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [jobId, actor, kind, summary, detail === undefined ? null : JSON.stringify(detail), opts.important ?? false,
     opts.source ?? (origin === "agent" ? "naive" : "local"), origin, opts.originDetail ? JSON.stringify(opts.originDetail) : null],
  );
}

/** Where a recorded step came from. "agent" only ever means a Naive session that actually ran. */
export type Origin = "agent" | "tool" | "human" | "fixture" | "system";

export async function recordCost(entry: {
  jobId: string | null;
  actor: Actor;
  stage?: string;
  attempt?: number;
  kind: "model" | "compute" | "search" | "other";
  quantity: number;
  unit: string;
  microUsd: number;
  basis: "naive_metered" | "estimate_naive_rate" | "none";
  naiveSessionId?: string;
  note?: string;
}) {
  await q(
    `INSERT INTO cost_entries (job_id, actor, stage, attempt, kind, quantity, unit, micro_usd, basis, naive_session_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [entry.jobId, entry.actor, entry.stage ?? null, entry.attempt ?? null, entry.kind, entry.quantity, entry.unit,
     Math.round(entry.microUsd), entry.basis, entry.naiveSessionId ?? null, entry.note ?? null],
  );
}

/** Measured seconds of local compute, priced at Naive's published computer rate as an estimate. */
export async function recordCompute(jobId: string, actor: Actor, stage: string, attempt: number, ms: number, note: string) {
  const seconds = Math.max(ms, 1) / 1000;
  await recordCost({
    jobId, actor, stage, attempt, kind: "compute", quantity: Number(seconds.toFixed(3)), unit: "seconds",
    microUsd: seconds * config.computerMicroUsdPerSecond, basis: "estimate_naive_rate", note,
  });
}

export async function jobSpend(jobId: string) {
  const r = await one<{ total: number; metered: number; estimated: number }>(
    `SELECT COALESCE(SUM(micro_usd),0)::bigint AS total,
            COALESCE(SUM(micro_usd) FILTER (WHERE basis = 'naive_metered'),0)::bigint AS metered,
            COALESCE(SUM(micro_usd) FILTER (WHERE basis = 'estimate_naive_rate'),0)::bigint AS estimated
       FROM cost_entries WHERE job_id = $1`, [jobId]);
  return r ?? { total: 0, metered: 0, estimated: 0 };
}

/** Pre-flight gate, the same idea as Naive's budget gate: price the step before running it. */
export async function spendGate(jobId: string, limitMicroUsd: number, quoteMicroUsd: number) {
  const s = await jobSpend(jobId);
  return { ok: s.total + quoteMicroUsd <= limitMicroUsd, spent: s.total, limit: limitMicroUsd, quote: quoteMicroUsd };
}

export function usd(micro: number | string | null | undefined, digits = 4) {
  const n = Number(micro ?? 0) / 1_000_000;
  return `$${n.toFixed(digits)}`;
}

export async function addIntervention(jobId: string | null, kind: string, reason: string, detail?: unknown, minutes = 0) {
  await q("INSERT INTO interventions (job_id, kind, reason, detail, minutes) VALUES ($1,$2,$3,$4,$5)",
    [jobId, kind, reason, detail === undefined ? null : JSON.stringify(detail), minutes]);
  await logEvent(jobId, "founder", "intervention", reason, detail, { important: true });
}
