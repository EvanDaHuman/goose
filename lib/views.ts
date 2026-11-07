// Read models for the pages. Everything shown comes from the database or the job's files.
import fs from "node:fs";
import path from "node:path";
import { config, jobDir } from "./config";
import { one, q } from "./db";
import { STAGES, type Job } from "./jobs";
import { jobSpend } from "./records";

const readJson = (p: string) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

export async function jobBase(id: string) {
  const job = await one<Job & { account_name: string; contact_name: string | null; contact_email: string | null; account_kind: string; acquired_via: string | null }>(
    `SELECT j.*, a.name AS account_name, a.contact_name, a.contact_email, a.kind AS account_kind, a.acquired_via
       FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.id = $1`, [id]);
  if (!job) return null;
  const spend = await jobSpend(id);
  const run = await one<any>("SELECT * FROM check_runs WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1", [id]);
  return { job, spend, run, stageLabel: STAGES[job.stage]?.label ?? job.stage };
}

export async function customerView(id: string) {
  const base = await jobBase(id);
  if (!base) return null;
  const proposal = await one<any>("SELECT * FROM proposals WHERE job_id = $1 ORDER BY version DESC LIMIT 1", [id]);
  const questions = await q<any>("SELECT * FROM questions WHERE job_id = $1 AND audience = 'customer' ORDER BY id", [id]);
  const messages = await q<any>("SELECT * FROM messages WHERE job_id = $1 ORDER BY id", [id]);
  const artifacts = await q<any>("SELECT id, kind, label, sha256, size_bytes, attempt, created_at FROM artifacts WHERE job_id = $1 AND customer_visible ORDER BY id", [id]);
  const approvals = await q<any>("SELECT * FROM approvals WHERE job_id = $1 ORDER BY id", [id]);
  const runs = await q<any>("SELECT attempt, total, passed, failed, verdict, created_at FROM check_runs WHERE job_id = $1 ORDER BY attempt", [id]);
  const invoice = await one<any>("SELECT * FROM invoices WHERE job_id = $1", [id]);
  return { ...base, proposal, questions, messages, artifacts, approvals, runs, invoice };
}

export async function opsJobView(id: string) {
  const base = await jobBase(id);
  if (!base) return null;
  const plans = await q<any>("SELECT version, author_kind, author, naive_session_id, guard_problems, changed_because, plan->>'decision' AS decision, plan->>'title' AS title, created_at FROM plans WHERE job_id = $1 ORDER BY version", [id]);
  const origins = await q<{ origin: string | null; n: number }>("SELECT origin, COUNT(*)::int AS n FROM events WHERE job_id = $1 GROUP BY origin ORDER BY 2 DESC", [id]);
  const [events, stageRuns, costs, approvals, interventions, repairs, runs, artifacts, sessions, questions, messages, showroom] = await Promise.all([
    q<any>("SELECT * FROM events WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM stage_runs WHERE job_id = $1 ORDER BY id", [id]),
    q<any>(`SELECT actor, stage, basis, kind, COUNT(*)::int AS n, SUM(micro_usd)::bigint AS micro, SUM(quantity) AS qty, MIN(unit) AS unit
              FROM cost_entries WHERE job_id = $1 GROUP BY 1,2,3,4 ORDER BY MIN(id)`, [id]),
    q<any>("SELECT * FROM approvals WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM interventions WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM repairs WHERE job_id = $1 ORDER BY attempt", [id]),
    q<any>("SELECT * FROM check_runs WHERE job_id = $1 ORDER BY attempt", [id]),
    q<any>("SELECT id, kind, label, sha256, size_bytes, attempt, created_by, frozen, customer_visible FROM artifacts WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM naive_sessions WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM questions WHERE job_id = $1 ORDER BY id", [id]),
    q<any>("SELECT * FROM messages WHERE job_id = $1 ORDER BY id", [id]),
    one<any>("SELECT * FROM showrooms WHERE job_id = $1", [id]),
  ]);
  return { plans, origins, ...base, events, stageRuns, costs, approvals, interventions, repairs, runs, artifacts, sessions, questions, messages, showroom };
}

export async function opsOverview() {
  const jobs = await q<any>(
    `SELECT j.*, a.name AS account_name,
            (SELECT COALESCE(SUM(micro_usd),0)::bigint FROM cost_entries c WHERE c.job_id = j.id) AS spent,
            (SELECT row_to_json(r) FROM (SELECT attempt, total, passed, failed, verdict FROM check_runs c WHERE c.job_id = j.id ORDER BY attempt DESC LIMIT 1) r) AS run,
            (SELECT COUNT(*)::int FROM repairs r WHERE r.job_id = j.id) AS repairs,
            (SELECT COUNT(*)::int FROM interventions i WHERE i.job_id = j.id) AS interventions,
            (SELECT COUNT(*)::int FROM questions x WHERE x.job_id = j.id AND x.status = 'open') AS open_questions
       FROM jobs j JOIN accounts a ON a.id = j.account_id ORDER BY j.created_at DESC`);
  const totals = await one<any>(
    `SELECT (SELECT COUNT(*)::int FROM jobs) AS jobs,
            (SELECT COUNT(*)::int FROM jobs WHERE status = 'waiting_founder') AS founder,
            (SELECT COUNT(*)::int FROM jobs WHERE status = 'waiting_customer') AS customer,
            (SELECT COUNT(*)::int FROM jobs WHERE status = 'running') AS running,
            (SELECT COALESCE(SUM(micro_usd),0)::bigint FROM cost_entries) AS spent,
            (SELECT COALESCE(SUM(minutes),0)::int FROM interventions) AS founder_minutes,
            (SELECT COUNT(*)::int FROM interventions) AS interventions`);
  return { jobs, totals };
}

export async function companyView() {
  const [prospects, bookings, invoices, payments, followups, interventions, costByBasis, accounts] = await Promise.all([
    q<any>("SELECT * FROM prospects ORDER BY CASE fit_score WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, name"),
    q<any>(`SELECT p.job_id, p.version, p.price_cents, p.decided_at, j.kind, j.title, a.name AS account
              FROM proposals p JOIN jobs j ON j.id = p.job_id JOIN accounts a ON a.id = j.account_id WHERE p.status = 'accepted' ORDER BY p.decided_at`),
    q<any>(`SELECT i.*, j.title FROM invoices i JOIN jobs j ON j.id = i.job_id ORDER BY i.id`),
    q<any>(`SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id = p.invoice_id ORDER BY p.id`),
    q<any>(`SELECT f.*, j.title FROM followups f JOIN jobs j ON j.id = f.job_id ORDER BY f.due_at`),
    q<any>(`SELECT i.*, j.kind AS job_kind FROM interventions i LEFT JOIN jobs j ON j.id = i.job_id ORDER BY i.id DESC`),
    q<any>(`SELECT basis, kind, COUNT(*)::int AS n, COALESCE(SUM(micro_usd),0)::bigint AS micro FROM cost_entries GROUP BY 1,2`),
    q<any>(`SELECT kind, COUNT(*)::int AS n FROM accounts GROUP BY 1`),
  ]);
  return { prospects, bookings, invoices, payments, followups, interventions, costByBasis, accounts };
}

/** Everything the main result screen needs: old app, new app, what moved, checks, attention. */
export async function resultView(id: string) {
  const base = await jobBase(id);
  if (!base) return null;
  const { job } = base;
  const assessment = readJson(jobDir(id, "work", "assessment.json"));
  const scope = readJson(jobDir(id, "work", "scope.json"));
  const gen = readJson(jobDir(id, "build", "attempt-1", "generation.json"));
  const runs = await q<any>("SELECT * FROM check_runs WHERE job_id = $1 ORDER BY attempt", [id]);
  const last = runs[runs.length - 1];
  const report = last?.report_path ? readJson(last.report_path) : null;
  const repairs = await q<any>("SELECT * FROM repairs WHERE job_id = $1 ORDER BY attempt", [id]);
  const moved: { table: string; before: number; after: number; ok: boolean; fieldsOk: boolean | null; note?: string }[] = [];
  if (assessment && report) {
    const res = report.results as any[];
    for (const [t, info] of Object.entries<any>(assessment.tables)) {
      const count = res.find((r) => r.id === `records.count.${t}`);
      const fields = res.find((r) => r.id === `records.fields.${t}`);
      const ph = (scope?.orphan_decisions ?? []).filter((o: any) => o.decision === "placeholder" && o.references.split(".")[0] === t)
        .reduce((n: number, o: any) => n + o.placeholders.length, 0);
      moved.push({ table: t, before: info.row_count, after: Number(count?.actual ?? 0), ok: count?.status === "pass",
        fieldsOk: fields ? fields.status === "pass" : null, note: ph ? `+${ph} agreed placeholder` : undefined });
    }
  }
  const upgradedDir = jobDir(id, "build", `attempt-${job.attempt}`, "upgraded");
  const codeFiles = fs.existsSync(upgradedDir) ? listFiles(upgradedDir).filter((f) => f.endsWith(".py")) : [];
  const codeLines = codeFiles.reduce((n, f) => n + fs.readFileSync(path.join(upgradedDir, f), "utf8").split("\n").length, 0);
  const pkg = await one<any>("SELECT id, sha256, size_bytes FROM artifacts WHERE job_id = $1 AND kind = 'delivery_package'", [id]);
  const showroom = await one<any>("SELECT * FROM showrooms WHERE job_id = $1", [id]);
  return { ...base, assessment, scope, gen, runs, report, repairs, moved, codeFiles, codeLines, pkg, showroom };
}

export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(path.relative(base, p));
  }
  return out.sort();
}

export function sourceFile(id: string, which: "original" | "upgraded", rel: string, attempt = 1) {
  const root = which === "original" ? jobDir(id, "source") : jobDir(id, "build", `attempt-${attempt}`, "upgraded");
  const p = path.resolve(root, rel);
  if (!p.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

export const MODE_LABEL = config.mode === "naive"
  ? "Naive mode - agents run on Naive Managed Agents"
  : "Local mode - deterministic workers on this machine, no AI model calls, not running on Naive";

// ------------------------------------------------------------------ plan-driven workspace (pipeline 2)

/** Requests the old and the new app both answered, side by side (from the frozen recording and the latest verification). */
function comparePairs(id: string, attempt: number | null) {
  if (!attempt) return [];
  const before = readJson(jobDir(id, "vault", "baseline.json"));
  if (before?.recorded?.results) {
    const checks = readJson(jobDir(id, "verify", `attempt-${attempt}`, "report.json"))?.checks ?? [];
    const contract = readJson(jobDir(id, "vault", "contract.json"));
    return before.recorded.results.map((r: any) => {
      const after = checks.find((c: any) => c.id === `legacy.${r.id}`)?.actual;
      const step = contract?.legacy_requests.find((s: any) => s.id === r.id);
      return { step: r.id, method: step?.method, path: step?.path,
        before: { status: r.status, body: JSON.stringify(r.body).slice(0, 600) },
        after: after ? { status: after.status, body: JSON.stringify(after.body).slice(0, 600) } : null };
    });
  }
  const after = readJson(jobDir(id, "verify", `attempt-${attempt}`, "recording.json")) ??
    readJson(jobDir(id, "verify", `attempt-${attempt}`, "upgraded-recording.json"));
  if (!before?.results || !after?.results) return [];
  const byStep = new Map(after.results.map((r: any) => [r.step, r]));
  const short = (b: any) => (b == null ? "" : typeof b === "string" ? b.replace(/\s+/g, " ").slice(0, 600) : JSON.stringify(b).slice(0, 600));
  return before.results.map((a: any) => {
    const b: any = byStep.get(a.step);
    return { step: a.step, method: a.method, path: a.path, before: { status: a.status, body: short(a.body) },
      after: b ? { status: b.status, body: short(b.body) } : null };
  });
}

export async function workspaceView(id: string) {
  const c = await customerView(id);
  if (!c) return null;
  const plans = await q<any>("SELECT version, author_kind, author, naive_session_id, plan, guard_problems, changed_because, created_at FROM plans WHERE job_id = $1 ORDER BY version", [id]);
  const events = await q<any>("SELECT id, at, actor, kind, summary, origin, origin_detail, source FROM events WHERE job_id = $1 AND important ORDER BY id", [id]);
  const inspection = readJson(jobDir(id, "work", "inspection.json"));
  const latest = c.runs.at(-1);
  const report = latest ? readJson(jobDir(id, "verify", `attempt-${latest.attempt}`, "report.json")) : null;
  const diffArt = [...c.artifacts].reverse().find((a: any) => a.kind === "change_diff");
  const diff = diffArt ? (() => { try { return fs.readFileSync(jobDir(id, "build", `attempt-${diffArt.attempt}`, "change.diff"), "utf8"); } catch { return null; } })() : null;
  const sessions = await q<any>("SELECT session_id, role, purpose, status, stop_reason, consumed_micro_usd, model, created_at FROM naive_sessions WHERE job_id = $1 ORDER BY id", [id]);
  const interventions = await q<any>("SELECT kind, reason, minutes, at FROM interventions WHERE job_id = $1 ORDER BY id", [id]);
  const live = inspection?.stack?.framework === "SuiteCRM" ? await liveCrm(id) : null;
  const preview = c.job.recipe === "agent-replatform" ? await one<any>("SELECT status,port,detail FROM showrooms WHERE job_id=$1", [id]) : null;
  return { ...c, plans, plan: plans.at(-1) ?? null, events, inspection, report, diff, pairs: comparePairs(id, latest?.attempt ?? null), sessions, interventions, live, preview };
}

/** For SuiteCRM jobs: is the original (the customer's) and the delivered workspace answering right now? */
async function liveCrm(id: string) {
  const ping = (url: string) => fetch(url, { signal: AbortSignal.timeout(700) }).then((r) => r.status < 500).catch(() => false);
  const original = process.env.GOOSE_CRM_ORIGINAL_URL ?? "http://localhost:8081";
  let ws: string | null = null;
  try { ws = fs.readFileSync(path.join(path.dirname(jobDir(id)), "..", "suitecrm", "workspace-url"), "utf8").trim(); } catch { /* not started */ }
  const cut = await q<{ at: string }>("SELECT at FROM events WHERE job_id = $1 AND summary LIKE 'Switch-over: final snapshot moved%' ORDER BY id DESC LIMIT 1", [id]);
  return { original: { url: original, up: await ping(`${original}/index.php?action=Login&module=Users`) },
    workspace: ws ? { url: ws, up: await ping(`${ws}/healthz`) } : null, cutover: cut[0]?.at ?? null };
}

/** One file of the customer's own source snapshot, for the "view source" links on findings. */
export function sourceLines(id: string, rel: string, line: number | null, around = 14) {
  const root = jobDir(id, "source");
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).size > 500_000) return null;
  // never show a secret from a customer's configuration file, even to the customer
  const lines = fs.readFileSync(file, "utf8").split("\n").map((l) =>
    l.replace(/((?:pass(?:word)?|secret|unique_key|api_key|token)[\w']*\s*(?:=>|=|:)\s*)(['"])(?!REDACTED\2)[^'"]+\2/i, "$1$2[redacted]$2"));
  const at = line && line > 0 ? line : 1;
  const start = Math.max(1, at - around);
  return { path: rel, line: line ?? null, start, lines: lines.slice(start - 1, Math.min(lines.length, at + around)) };
}
