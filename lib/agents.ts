// What the agents decide and do.
//   naive mode - each task is a typed, budgeted Naive session (lib/naive/run.ts); its result passes deterministic guards
//                before the job acts on it, and the event is recorded with origin "agent" and the session id.
//   local mode - deterministic rules on this machine, recorded with origin "tool". No AI model is called.
// Guards always win: no agent can pick a tool whose preconditions fail, name parts of the app that inspection did not find,
// repair past the repair budget, or pass a failed verification.
import fs from "node:fs";
import { config } from "./config";
import { naiveClient } from "./naive/client";
import { downloadFile, uploadFile } from "./naive/files";
import { runAgentTask, type TaskResult } from "./naive/run";

export type Ctx = { jobId: string; stage: string; attempt: number; budgetMicroUsd: number };
const S = { type: "string" } as const;
const strArr = { type: "array", items: S } as const;
const obj = (props: Record<string, unknown>, required = Object.keys(props)) =>
  ({ type: "object", additionalProperties: false, required, properties: props });

// ------------------------------------------------------------------ assessment agent: the plan

export const PLAN_SCHEMA = obj({
  decision: { type: "string", enum: ["supported", "unsupported", "needs_information", "needs_live_agents"] },
  recommended: { ...S, description: "recipe id from the list, or empty when unsupported" },
  reasons: strArr,
  changes: { type: "array", items: obj({ id: S, title: S, reason: S, kind: { type: "string", enum: ["code", "data", "config", "dependencies", "tests"] },
    files: strArr, component_ids: strArr, finding_ids: strArr, by: { type: "string", enum: ["tool", "agent"] } }) },
  preserve: { type: "array", items: obj({ what: S, reason: S, component_ids: strArr }) },
  intended_differences: { type: "array", items: obj({ id: S, title: S, reason: S }) },
  questions: { type: "array", items: obj({ id: S, prompt: S, options: strArr, recommended: S, blocking: { type: "boolean" } }) },
  acceptance_checks: { type: "array", items: obj({ id: S, text: S, mandatory: { type: "boolean" } }) },
  follow_ups: { type: "array", items: obj({ finding_id: S, title: S, why_not_now: S }) },
  findings_added: { type: "array", items: obj({ title: S, detail: S, severity: { type: "string", enum: ["high", "medium", "low"] },
    file: S, line: { type: "integer" } }) },
});

export async function planWithAgent(ctx: Ctx, input: {
  repoZip: string; goal: string; constraints: string[]; notes: string | null; inspection: any; toolPlan: any; answers: Record<string, unknown>;
  previous?: { plan: any; changedBecause: string } | null; guardProblems?: string[];
}): Promise<TaskResult & { fileId?: string }> {
  const c = naiveClient();
  const up = await uploadFile(c, ctx.jobId, input.repoZip, `${ctx.jobId}-repository.zip`, ["repository"]);
  const insp = input.inspection;
  const summary = {
    stack: insp.stack, size: insp.size,
    components: insp.components.map((x: any) => ({ id: x.id, kind: x.kind, name: x.name, file: x.file, line: x.line, summary: String(x.summary).slice(0, 160) })),
    connections: insp.edges, findings: insp.findings.map((f: any) => ({ id: f.id, severity: f.severity, title: f.title, detail: String(f.detail).slice(0, 300),
      evidence: f.evidence.slice(0, 4), component_ids: f.component_ids })),
  };
  const message = [
    `Job ${ctx.jobId}. The customer's repository is file ${up.id} (a zip). Read it before you decide.`,
    `Customer goal (their words): ${input.goal}`,
    `Constraints they selected: ${input.constraints.join(", ") || "none"}${input.notes ? `. Their notes: ${input.notes}` : ""}`,
    `Answers they have given so far: ${JSON.stringify(input.answers)}`,
    `Inspection by our deterministic tools (component ids are the only ids you may use): ${JSON.stringify(summary)}`,
    `Recipes Goose can execute, with whether each can run on this application now (choose only from these; "agent-change" means you list the code changes and our implementation agent makes them): ${JSON.stringify(
      input.toolPlan.options.map((o: any) => ({ recipe: o.recipe, title: o.title, work_type: o.work_type, executable_now: o.executable_now, blocked_by: o.blocked_by, tool: o.tool })))}`,
    input.previous ? `Your previous plan (keep what still holds and say what changed): ${JSON.stringify(input.previous.plan).slice(0, 6000)}. It changed because: ${input.previous.changedBecause}` : "",
    input.guardProblems?.length ? `Our guard rejected your last answer for these reasons; fix them: ${input.guardProblems.join("; ")}` : "",
    "Submit the plan. Mark each change by: \"tool\" when the recipe's tool does it, \"agent\" when our implementation agent must edit code.",
  ].filter(Boolean).join("\n\n");
  const r = await runAgentTask(c, { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "assessment", purpose: "plan",
    title: "Read the application and plan the work", message, outputSchema: PLAN_SCHEMA, budgetMicroUsd: ctx.budgetMicroUsd, timeoutMs: 20 * 60_000 });
  return { ...r, fileId: up.id };
}

// ------------------------------------------------------------------ implementation agent: code changes and repairs

const CHANGE_SCHEMA = obj({
  result_file_id: { ...S, description: "the fil_ id publish_file returned for result.zip" },
  summary: S,
  changed_files: { type: "array", items: obj({ file: S, why: S }) },
  tests: obj({ command: S, passed: { type: "boolean" }, output_tail: S }),
  not_done: strArr,
});

export async function changeWithAgent(ctx: Ctx, input: { candidateZip: string; items: any[]; context: string; evidence?: any; outZip: string }) {
  const c = naiveClient();
  const up = await uploadFile(c, ctx.jobId, input.candidateZip, `${ctx.jobId}-candidate-a${ctx.attempt}.zip`, ["candidate"]);
  const message = [
    `Job ${ctx.jobId}, attempt ${ctx.attempt}. The repository to change is file ${up.id} (a zip).`,
    `Make exactly these approved changes and nothing else: ${JSON.stringify(input.items)}`,
    input.context,
    input.evidence ? `Verification failed. Evidence (failed checks, expected and actual, and the verification agent's explanation): ${JSON.stringify(input.evidence).slice(0, 12000)}` : "",
    input.evidence ? "This is a focused repair. Follow the independent diagnosis exactly and preserve parts it identifies as passing. Do not make speculative consistency, style or cleanup changes outside the failed requirement. Run relevant checks available in your workspace, then publish the candidate; the host reruns the complete frozen acceptance suite. Avoid repeating unrelated or unavailable upstream tests. Report local testing limitations truthfully and distinguish them from genuinely unfinished requested work." : "",
    "Publish result.zip with publish_file and submit its file id, every file you changed and why, the tests you ran, and anything you did not do.",
  ].filter(Boolean).join("\n\n");
  const r = await runAgentTask(c, { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "implementation",
    purpose: input.evidence ? "repair" : "implement", title: input.evidence ? "Repair the failed checks using their evidence" : "Make the approved code changes",
    message, outputSchema: CHANGE_SCHEMA, budgetMicroUsd: ctx.budgetMicroUsd, timeoutMs: 30 * 60_000,
    continuationMessage: "Continue within the approved scope and follow the independent repair diagnosis when provided. Preserve parts explicitly identified as already passing; undo speculative changes outside the failed requirement. If the requested changes are complete, publish the complete result.zip and submit the structured result now. The host performs definitive acceptance in its reproduced environment. Do not keep repeating unavailable or unrelated upstream tests in your workspace; truthfully report local test limitations and any genuinely unfinished work. Never invent passing results." });
  if (!r.ok) return r;
  const id = String(r.output.result_file_id || "");
  if (!/^fil_/.test(id)) return { ok: false as const, reason: "no_output" as const, message: "The agent did not return a published file id.", sessionId: r.sessionId };
  const dl = await downloadFile(c, ctx.jobId, id, input.outZip);
  return { ...r, download: dl };
}

// ------------------------------------------------------------------ verification agent: why checks failed

const EXPLAIN_SCHEMA = obj({ explanation: S, likely_cause: S, files: { type: "array", items: obj({ file: S, line: { type: "integer" }, why: S }) },
  repair_guidance: strArr, plain_summary: S });

export async function explainWithAgent(ctx: Ctx, input: { failed: any[]; diffFile: string }) {
  const c = naiveClient();
  const up = await uploadFile(c, ctx.jobId, input.diffFile, `${ctx.jobId}-change-a${ctx.attempt}.diff`, ["diff"]);
  const message = `Job ${ctx.jobId}, verification attempt ${ctx.attempt} failed. The code change under test is file ${up.id} (a unified diff).\n\n` +
    `Failed checks with expected and actual values: ${JSON.stringify(input.failed.slice(0, 25)).slice(0, 14000)}\n\nExplain the most likely cause, ` +
    "cite file and line in the diff, give repair guidance, and a two-sentence plain summary for the customer.";
  return runAgentTask(c, { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "verification", purpose: "explain",
    title: "Explain the failed checks", message, outputSchema: EXPLAIN_SCHEMA, budgetMicroUsd: ctx.budgetMicroUsd, timeoutMs: 10 * 60_000 });
}

// ------------------------------------------------------------------ coordinator

export async function afterFailedVerification(ctx: Ctx, report: any, repairsUsed: number, repairBudget: number,
  opts: { explanation?: string | null; repairable?: boolean } = {}) {
  const left = repairBudget - repairsUsed;
  const integrity = report.integrity?.ok !== false;
  const canRepair = opts.repairable !== false;
  const local = !integrity
    ? { action: "escalate", reason: "The frozen checks failed their integrity check. Nobody may repair or deliver until the founder looks." }
    : !canRepair
      ? { action: "escalate", reason: `${report.summary.failed} checks failed and no repair is available in this mode: the recipe has no deterministic repair rules and the live implementation agent is not running. Escalating to the founder.` }
      : left > 0
        ? { action: "repair", reason: `${report.summary.failed} checks failed. Repair budget allows ${left} more attempt(s); returning the job to the implementation agent.` }
        : { action: "escalate", reason: `${report.summary.failed} checks still fail and the repair budget (${repairBudget}) is used up. Escalating to the founder.` };
  if (config.mode !== "naive") return { ...local, by: "local rule", origin: "tool" as const };
  const out = await runAgentTask(naiveClient(), { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "coordinator", purpose: "after-failure",
    title: "Decide after a failed verification", outputSchema: obj({ action: { type: "string", enum: ["repair", "escalate"] }, reason: S }),
    budgetMicroUsd: ctx.budgetMicroUsd, timeoutMs: 8 * 60_000,
    message: `Verification failed: ${report.summary.failed} of ${report.summary.total} checks. Failed: ${JSON.stringify(
      report.failed.slice(0, 15).map((f: any) => `${f.id}: ${f.title}`))}. Repairs used ${repairsUsed} of ${repairBudget}. Spending left: ` +
      `${(ctx.budgetMicroUsd / 1e6).toFixed(2)} USD. ${opts.explanation ? `Verification agent's explanation: ${opts.explanation}` : ""} ` +
      "Choose repair (only if repair budget remains and the cause looks fixable) or escalate, with a one-sentence reason." });
  if (!out.ok) return { ...local, by: `local rule (coordinator session failed: ${out.reason})`, origin: "tool" as const };
  if (out.output.action === "repair" && (left <= 0 || !integrity || !canRepair)) {
    return { ...local, by: "coordinator overruled by guard: no repair possible", origin: "agent" as const, sessionId: out.sessionId, agent_said: out.output };
  }
  return { action: out.output.action as string, reason: out.output.reason as string, by: "coordinator agent", origin: "agent" as const, sessionId: out.sessionId };
}

export async function proposalWording(ctx: Ctx, plan: any, quote: { totalUsd: number; days: number }) {
  const local = {
    headline: `${plan.title} - fixed price $${quote.totalUsd.toLocaleString("en-US")}.`,
    plain_summary: `${plan.reasons?.[0] ?? ""} Before we change anything we record how your current app behaves and freeze the checks it must ` +
      `pass. You pay only when the result passes them and you accept the delivery. Expected delivery: within ${quote.days} working days.`,
  };
  if (config.mode !== "naive") return { ...local, by: "template", origin: "tool" as const };
  const out = await runAgentTask(naiveClient(), { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "coordinator", purpose: "proposal",
    title: "Word the proposal", outputSchema: obj({ headline: S, plain_summary: S }), budgetMicroUsd: ctx.budgetMicroUsd, timeoutMs: 6 * 60_000,
    message: `Write a headline and a short plain-English summary of this plan for the customer. The price is fixed at $${quote.totalUsd} ` +
      `(do not change or comment on it). Plan: ${JSON.stringify({ title: plan.title, changes: plan.changes?.map((c: any) => c.title),
        preserve: plan.preserve?.map((p: any) => p.what), differences: plan.intended_differences?.map((d: any) => d.title), days: quote.days })}` });
  if (!out.ok) return { ...local, by: `template (coordinator session failed: ${out.reason})`, origin: "tool" as const };
  return { ...out.output, by: "coordinator agent", origin: "agent" as const, sessionId: out.sessionId };
}

export async function answerCustomer(ctx: Ctx, question: string, facts: Record<string, any>) {
  const t = question.toLowerCase();
  let answer: string | null = null;
  if (/(when|how long|status|progress|done|finish|ready)/.test(t)) {
    answer = `Your job is at the "${facts.stageLabel}" step. ${facts.nextStep}`;
  } else if (/(price|cost|pay|invoice|charge|bill)/.test(t)) {
    answer = facts.price ? `The price is fixed at ${facts.price}. You are invoiced only after the result passes the agreed checks and you ` +
      "accept the delivery. Nothing extra is charged without your written approval." : null;
  } else if (/(data|safe|secure|privacy|copy|delete)/.test(t)) {
    answer = "We work on copies. Your uploaded files are stored unchanged and read-only, and every test runs on a separate copy in an " +
      "isolated environment. We never change your live systems.";
  } else if (/(roll ?back|undo|go back|revert)/.test(t)) {
    answer = "Yes. The delivery includes a rollback guide, and your current application and data are not touched by the work.";
  } else if (/(check|test|verif|prove|proof)/.test(t)) {
    answer = facts.checks ? `The latest verification ran ${facts.checks.total} checks: ${facts.checks.passed} passed, ${facts.checks.failed} failed. ` +
      "The report lists exactly what was and was not tested." : "The checks are frozen before any code changes and run once the work is built.";
  }
  const local = { answer: answer ?? "Thanks for your question. I've passed it to our founder, who will reply here.", needs_founder: answer === null };
  if (config.mode !== "naive") return { ...local, by: "local rule", origin: "tool" as const };
  const out = await runAgentTask(naiveClient(), { jobId: ctx.jobId, stage: ctx.stage, attempt: ctx.attempt, role: "coordinator", purpose: "support",
    title: "Answer a customer question", outputSchema: obj({ answer: S, needs_founder: { type: "boolean" } }), budgetMicroUsd: ctx.budgetMicroUsd,
    timeoutMs: 6 * 60_000, message: `Answer this customer question using only these facts. If the facts do not answer it, set needs_founder to true.\n` +
      `Question: ${question}\nFacts: ${JSON.stringify(facts)}` });
  if (!out.ok) return { ...local, by: `local rule (coordinator session failed: ${out.reason})`, origin: "tool" as const };
  return { answer: String(out.output.answer), needs_founder: Boolean(out.output.needs_founder), by: "coordinator agent", origin: "agent" as const,
    sessionId: out.sessionId };
}

// ------------------------------------------------------------------ first version (pipeline 1): deterministic, kept for its jobs

export async function reviewAssessment(_ctx: unknown, a: any) {
  const decision = a.fit.decision as "supported" | "unsupported" | "needs_info";
  const high = a.findings.filter((f: any) => f.severity === "high").map((f: any) => f.title);
  return {
    decision, reasons: a.fit.reasons as string[], risks: [...high, ...a.risks].slice(0, 8), by: "local worker",
    customer_message: decision === "unsupported"
      ? `Thank you for sending your application. We can't take this job on yet: ${a.fit.blockers.join(" ")} We only accept work we can finish and prove.`
      : decision === "needs_info" ? "Thanks - we've read your code. Before we can prepare a fixed price we need an answer to the question below."
        : `Good news: your application fits the upgrade we offer. We found ${a.findings.length} things worth knowing, ${high.length} of them important.`,
  };
}

export async function proposalSummary(_ctx: unknown, scope: any, priceUsd: number, days: number) {
  return {
    headline: `Upgrade ${scope.app_title} to FastAPI and PostgreSQL, with proof it still works - fixed price $${priceUsd.toLocaleString("en-US")}.`,
    plain_summary: "We move your application to a maintained framework and your data to PostgreSQL. Before we change anything we record how " +
      "your current app behaves and lock the checks it must pass. You pay only when the upgraded app passes them and you accept the delivery. " +
      `Expected delivery: within ${days} working days of acceptance.`,
    by: "local worker",
  };
}

export function invoiceLines(job: any, priceCents: number, planTitle?: string | null) {
  return [{ description: planTitle ? `Fixed-price pilot: ${planTitle} (${job.title}), with verification report and rollback guide`
    : `Fixed-price pilot: upgrade of ${job.title} (Flask + SQLite to FastAPI + PostgreSQL), data migration, verification report and rollback guide`,
    amount_cents: priceCents }];
}

export function followupDrafts(job: any, contactName: string) {
  const who = contactName || "there";
  return [
    { kind: "check_in_day_3", days: 3, draft: `Hi ${who}, a quick check-in on ${job.title}. Has the switch-over gone as planned? If anything ` +
      "behaves differently from before, reply here and we'll look at it against the verification report." },
    { kind: "rollback_window_day_25", days: 25, draft: `Hi ${who}, the 30-day rollback window for ${job.title} closes in five days. ` +
      "If you are happy, you can archive the old copy as the run book describes." },
  ];
}

export function readText(p: string) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
