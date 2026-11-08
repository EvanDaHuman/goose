// One agent task on Naive: a session with a typed result and a spend cap. Found again by its idempotency key after a
// restart, so a crash never starts a second session for the same task. Every stop reason is handled (naive-api-notes §12).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, type VettaClient } from "@usenaive-sdk/vetta";
import { config, jobDir, type Role } from "../config";
import { one, q } from "../db";
import { logEvent } from "../records";
import { describeError } from "./client";
import { agentId, taskCeiling, type TeamRole } from "./team";

export type TaskResult =
  | { ok: true; output: Record<string, any>; sessionId: string; model: string | null; consumedMicroUsd: number }
  | { ok: false; reason: "budget" | "failed" | "timeout" | "no_output" | "blocked"; message: string; sessionId?: string };

const FLOOR_MICRO_USD = 50_000;      // do not start a session that the first pre-flight quote would refuse

// jobId is null for company work that belongs to no customer job (the growth agents); its records are kept with job_id NULL
// and its transcripts under var/company/naive/.
export async function runAgentTask(client: VettaClient, opts: {
  jobId: string | null; stage: string; attempt: number; role: TeamRole; purpose: string; title: string; message: string;
  outputSchema: Record<string, unknown>; budgetMicroUsd: number; timeoutMs?: number; pollMs?: number;
  continuationMessage?: string;
}): Promise<TaskResult> {
  const key = crypto.createHash("sha256").update([opts.jobId ?? "company", opts.stage, opts.attempt, opts.role, opts.purpose, opts.message].join("\u0000"))
    .digest("hex").slice(0, 48);
  const prior = await one<{ session_id: string; status: string; output: any; model: string | null; consumed_micro_usd: number }>(
    "SELECT session_id, status, output, model, consumed_micro_usd FROM naive_sessions WHERE idem_key = $1", [key]);
  if (prior?.status === "completed" && prior.output) {
    return { ok: true, output: prior.output, sessionId: prior.session_id, model: prior.model, consumedMicroUsd: Number(prior.consumed_micro_usd) };
  }
  const budget = Math.min(opts.budgetMicroUsd, taskCeiling(opts.role));
  if (!prior && budget < FLOOR_MICRO_USD) {
    return { ok: false, reason: "budget", message: `Only ${(opts.budgetMicroUsd / 1e6).toFixed(4)} USD left in the job's spending limit; not starting a session.` };
  }
  let sessionId = prior?.session_id;
  try {
    if (!sessionId) {
      const s = await client.sessions.create({
        agent_id: await agentId(opts.role as Role), message: opts.message, output_schema: opts.outputSchema,
        structured_output_required: true, budget_micro_usd: budget,
        metadata: { company: "goose", job_id: opts.jobId, stage: opts.stage, attempt: String(opts.attempt), purpose: opts.purpose },
      } as any, { idempotencyKey: key });
      sessionId = s.id;
      await q(`INSERT INTO naive_sessions (job_id, stage, role, session_id, status, idem_key, attempt, purpose, model)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id) DO NOTHING`,
        [opts.jobId, opts.stage, opts.role, s.id, s.status, key, opts.attempt, opts.purpose, (s as any).model ?? null]);
      await logEvent(opts.jobId, opts.role as Role, "handoff", `Naive session ${s.id} started: ${opts.title}`, { session_id: s.id, budget_micro_usd: budget },
        { origin: "agent", originDetail: { session_id: s.id } });
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let continues = 0;
    const continuedStops = new Set<number>();
    let s: any;
    for (;;) {
      s = await client.sessions.get(sessionId);
      await recordSession(opts.jobId, opts.stage, opts.attempt, opts.role, s);
      const settled = ["completed", "failed", "cancelled"].includes(s.status) || (s.status === "idle" && s.stop_reason !== "awaiting_delegation");
      if (Date.now() > deadline && (!settled || s.stop_reason === "max_iterations")) {
        await client.sessions.cancel(sessionId).catch(() => undefined);
        await saveTranscript(client, opts.jobId, sessionId);
        return { ok: false, reason: "timeout", message: "The agent did not finish in time; the session was cancelled.", sessionId };
      }
      if (settled && s.stop_reason === "max_iterations" && continuedStops.has(s.last_seq)) {
        // The read endpoint may briefly return the old idle state after accepting a continuation.
        await sleep(opts.pollMs ?? 3000);
        continue;
      }
      if (settled && s.stop_reason === "max_iterations" && continues < 3) {
        const stopSeq = s.last_seq;
        try {
          await client.sessions.send(sessionId, { message: opts.continuationMessage ?? "Continue, then submit the result." } as any, { idempotencyKey: `${key}:continue:seq-${stopSeq}` });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409 || e.code !== "session_running") throw e;
          const current = await client.sessions.get(sessionId);
          // Another continuation was already accepted. Observe that work; never interrupt or duplicate it.
          await recordSession(opts.jobId, opts.stage, opts.attempt, opts.role, current);
        }
        continuedStops.add(stopSeq);
        continues++;
        await sleep(opts.pollMs ?? 3000);
        continue;
      }
      if (settled) break;
      await sleep(opts.pollMs ?? 3000);
    }
    const events = await saveTranscript(client, opts.jobId, sessionId);
    // A session that ends idle (rather than completed) carries its submitted result on the final session.idle event, not on the
    // session object; read it from there so a finished result is never mistaken for a missing one.
    if (!(s.structured_output && typeof s.structured_output === "object")) {
      const idle = [...events].reverse().find((e: any) => e.type === "session.idle" && e.data?.structured_output && typeof e.data.structured_output === "object");
      if (idle) s = { ...s, structured_output: idle.data.structured_output };
    }
    if (s.stop_reason === "budget_paused") {
      return { ok: false, reason: "budget", message: "Naive paused the session at its budget.", sessionId };
    }
    if (s.stop_reason === "awaiting_approval" || s.stop_reason === "awaiting_answer") {
      for (const p of s.pending_actions ?? []) {
        if (p.kind === "tool") await client.sessions.confirmTool(sessionId, { tool_call_id: p.tool_call_id, decision: "deny", reason: "not allowed for this task" } as any).catch(() => undefined);
      }
      await client.sessions.cancel(sessionId).catch(() => undefined);
      return { ok: false, reason: "blocked", message: `The agent asked for ${s.stop_reason === "awaiting_answer" ? "an answer" : "approval"}, which this task does not allow; cancelled.`, sessionId };
    }
    if (s.structured_output && typeof s.structured_output === "object") {
      await q("UPDATE naive_sessions SET status = 'completed', output = $2, updated_at = now() WHERE session_id = $1", [sessionId, JSON.stringify(s.structured_output)]);
      return { ok: true, output: s.structured_output, sessionId, model: s.model ?? null, consumedMicroUsd: Number(s.consumed_micro_usd ?? 0) };
    }
    return { ok: false, reason: s.status === "failed" ? "failed" : "no_output",
      message: `The session ended (${s.status}/${s.stop_reason ?? "-"}) without a structured result.${await lastError(client, sessionId, s)}`, sessionId };
  } catch (e) {
    const d = describeError(e);
    if(sessionId) {
      // A failed continuation/request does not prove the provider stopped working.
      // Settle orphaned work and reconcile its meter before returning control to the job.
      try {
        let latest:any=await client.sessions.get(sessionId);
        if(!["completed","failed","cancelled","idle"].includes(latest.status)) {
          await client.sessions.cancel(sessionId);
          latest=await client.sessions.get(sessionId);
        }
        await recordSession(opts.jobId,opts.stage,opts.attempt,opts.role,latest);
      }catch{/* Keep the original error; the provider may be unreachable. */}
      await saveTranscript(client,opts.jobId,sessionId).catch(()=>undefined);
    }
    await logEvent(opts.jobId, "system", "error", `Naive call failed during "${opts.title}": ${d.message}`, d, { important: true });
    return { ok: false, reason: "failed", message: String(d.message), sessionId };
  }
}

async function recordSession(jobId: string | null, stage: string, attempt: number, role: string, s: any) {
  await q(`UPDATE naive_sessions SET status = $2, stop_reason = $3, consumed_micro_usd = GREATEST(consumed_micro_usd,$4), model = COALESCE($5, model), token_usage = $6,
           updated_at = now() WHERE session_id = $1`,
    [s.id, s.status, s.stop_reason ?? null, Number(s.consumed_micro_usd ?? 0), s.model ?? null, s.token_usage ? JSON.stringify(s.token_usage) : null]);
  // consumed_micro_usd is the session's running total (model and computer); keep one cost row per session at the latest value
  const n = await q("UPDATE cost_entries SET micro_usd = GREATEST(micro_usd,$2::bigint), quantity = GREATEST(quantity,$2::numeric), at = now() WHERE naive_session_id = $1 RETURNING id",
    [s.id, Number(s.consumed_micro_usd ?? 0)]);
  if (!n.length) {
    await q(`INSERT INTO cost_entries (job_id, actor, stage, attempt, kind, quantity, unit, micro_usd, basis, naive_session_id, note)
             VALUES ($1,$2,$3,$4,'model',$5::numeric,'micro_usd',$5::bigint,'naive_metered',$6,'Naive session total (model and computer), as metered by Naive')`,
      [jobId, role, stage, attempt, Number(s.consumed_micro_usd ?? 0), s.id]);
  }
}

async function saveTranscript(client: VettaClient, jobId: string | null, sessionId: string): Promise<any[]> {
  const out = jobId ? jobDir(jobId, "naive", `${sessionId}.jsonl`) : path.join(config.varDir, "company", "naive", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const lines: string[] = [];
  const all: any[] = [];
  let after: number | undefined;
  for (let page = 0; page < 50; page++) {
    const res: any = await client.sessions.events(sessionId, { limit: 100, ...(after !== undefined ? { after_seq: after } : {}) } as any).catch(() => null);
    if (!res) break;
    for (const ev of res.data ?? []) {
      lines.push(JSON.stringify(ev));
      all.push(ev);
      after = ev.seq ?? after;
    }
    if (!res.has_more) break;
  }
  fs.writeFileSync(out, lines.join("\n") + "\n");
  await q("UPDATE naive_sessions SET transcript_path = $2 WHERE session_id = $1", [sessionId, out]);
  return all;
}

async function lastError(client: VettaClient, sessionId: string, s: any) {
  try {
    const res: any = await client.sessions.events(sessionId, { limit: 20, after_seq: Math.max(0, (s.last_seq ?? 20) - 20) } as any);
    const idle = [...(res.data ?? [])].reverse().find((e: any) => e.type === "session.idle");
    return idle?.data?.error ? ` Naive said: ${String(idle.data.error).slice(0, 300)}` : "";
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
