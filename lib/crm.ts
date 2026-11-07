// SuiteCRM jobs (recipe suitecrm-sales-workspace). Same durable stages, records, costs and approvals as every other job; the
// steps differ: the customer's MySQL dump is restored into Goose's own workbench database inside the local Linux VM, the
// original application is recorded on a disposable copy, the sales-workspace template is configured from the inspection, the
// data is moved with a deterministic migration, and the frozen checks run against the delivered backend.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { one, q } from "./db";
import type { Job, StageResult } from "./jobs";
import { createDb, dbName, dropDb } from "./pgadmin";
import { cleanEnv, freePort, run, startServer, type SandboxSpec } from "./proc";
import { logEvent, recordCompute } from "./records";
import * as v1 from "./stages";

const { J, readJson, mkdir, sha256, artifact, engineSandbox, makeVenv, makeReadOnly, makeWritable } = v1;
const tool = (name: string) => ({ origin: "tool" as const, originDetail: { tool: name } });
const WORKBENCH = path.join(config.varDir, "workbench");
const TEMPLATE = path.join(config.engineDir, "targets", "sales_workspace");
const BASELINE = path.join(config.engineDir, "data", "suitecrm", "7.11.23", "baseline.json");
const COMPAT = path.join(config.engineDir, "data", "suitecrm", "compat.json");
export const ORIGINAL_URL = process.env.GOOSE_CRM_ORIGINAL_URL ?? "http://localhost:8081";

export const isCrm = (job: Job) => (job.recipe ?? "").startsWith("suitecrm") || (job.source_stack as any)?.framework === "SuiteCRM" ||
  fs.existsSync(J(job, "snapshot", "database.mysql.sql.gz"));
const mysqlDb = (job: Job, label: string) => `gs_${job.id.toLowerCase().replace(/[^a-z0-9]/g, "")}_${label}`;
const sandbox = (job: Job, read: string[], write: string[], vault = false): SandboxSpec => {
  const s = engineSandbox(job, [WORKBENCH, ...read], write, { vault });
  return s;
};

/** Goose's own Python tools, with extra environment (database URLs never go on the command line). */
async function pyEnv(job: Job, actor: any, stage: string, attempt: number, module: string, args: string[], sb: SandboxSpec | undefined,
  env: Record<string, string> = {}, timeoutMs = 15 * 60_000) {
  const res = await run({ cmd: config.python.engine, args: ["-E", "-s", "-m", module, ...args], cwd: config.engineDir,
    env: cleanEnv(env, J(job, "work")), sandbox: sb, timeoutMs, logFile: path.join(J(job, "work"), `${module.split(".").pop()}.log`),
    profileFile: path.join(J(job, "work"), `.sb-${module.replace(/\W/g, "_")}.sb`) });
  await recordCompute(job.id, actor, stage, attempt, res.ms, `${module.split(".").pop()} ${args[0] ?? ""}`.trim());
  if (res.code !== 0) throw new Error(`${module} exited ${res.code}${res.timedOut ? " (timeout)" : ""}: ${(res.stderr || res.stdout).slice(-1500)}`);
  return JSON.parse((res.stdout.trim().split("\n").pop() || "{}"));
}

/** The workbench (Docker in the local VM): not sandboxed because it drives Docker; it never runs customer code outside a container. */
async function workbench(job: Job, actor: any, stage: string, attempt: number, args: string[], note: string) {
  const res = await run({ cmd: config.python.engine, args: ["-E", "-s", "-m", "goose_engine.suitecrm.workbench", ...args], cwd: config.engineDir,
    env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: config.home, LANG: "en_US.UTF-8" }, timeoutMs: 30 * 60_000,
    logFile: path.join(mkdir(J(job, "work")), "workbench.log") });
  await recordCompute(job.id, actor, stage, attempt, res.ms, note);
  if (res.code !== 0) throw new Error(`workbench ${args[0]} failed: ${(res.stderr || res.stdout).slice(-1500)}`);
  return JSON.parse(res.stdout.trim().split("\n").pop() || "{}");
}

// ======================================================================== intake and inspection

export async function intake(job: Job, round: number): Promise<StageResult> {
  const inputs = await q<{ kind: string; stored_path: string; filename: string }>(
    "SELECT DISTINCT ON (kind) kind, stored_path, filename FROM job_inputs WHERE job_id = $1 ORDER BY kind, id DESC", [job.id]);
  const repo = inputs.find((i) => i.kind === "repository");
  const db = inputs.find((i) => i.kind === "database");
  if (!repo) throw new Error("no repository upload");
  mkdir(J(job, "work"));
  const source = J(job, "source");
  makeWritable(source);
  fs.rmSync(source, { recursive: true, force: true });
  const out = path.join(J(job, "work"), `intake-${round}.json`);
  await v1.py(job, "commercial", "intake", round, "goose_engine.intake", ["--repo", repo.stored_path, "--source-dir", source,
    ...(db ? ["--db", db.stored_path] : []), "--out", out], engineSandbox(job, [J(job, "inputs")], [source, J(job, "work")]));
  const res = readJson(out);
  const problems: string[] = [...res.repository.problems, ...(res.database?.problems ?? [])];
  if (problems.length) {
    await q(`INSERT INTO questions (job_id, key, asked_by, audience, prompt, fields, blocking) VALUES ($1,$2,'commercial','customer',$3,$4,true)
             ON CONFLICT (job_id, key) DO NOTHING`, [job.id, `upload-${round}`, `We could not use the files you sent: ${problems.join(" ")} Please upload them again.`,
      JSON.stringify([{ type: "upload", key: "repository" }, { type: "upload", key: "database" }])]);
    return { next: "awaiting_info", status: "waiting_customer", waiting: "New files needed from the customer" };
  }
  makeReadOnly(source);
  await artifact(job, "source_snapshot", "Unchanged source snapshot", repo.stored_path, { by: "commercial", frozen: true, ...tool("intake") });
  let restored: any = null;
  if (db) {
    const snap = mkdir(J(job, "snapshot"));
    const dest = path.join(snap, "database.mysql.sql.gz");
    if (fs.existsSync(dest)) fs.chmodSync(dest, 0o644);
    fs.copyFileSync(db.stored_path, dest);
    fs.chmodSync(dest, 0o444);
    restored = await workbench(job, "commercial", "intake", round, ["restore", "--dump", dest, "--db", mysqlDb(job, "snapshot")],
      "restore the database dump into the job's workbench database");
    await artifact(job, "database_snapshot", "Unchanged database dump (MySQL)", dest, { by: "commercial", frozen: true, ...tool("workbench restore") });
  }
  if (job.kind === "demo") {
    await logEvent(job.id, "system", "status", "The inputs are a demonstration fixture: a made-up business with synthetic data.", undefined,
      { origin: "fixture", originDetail: { fixture: "demo inputs" } });
  }
  await logEvent(job.id, "commercial", "decision", `Files accepted: ${res.repository.files.toLocaleString("en-US")} files` +
    (restored ? `, a MySQL dump restored into Goose's own workbench database (${restored.tables} tables, ${(restored.bytes / 1e6).toFixed(1)} MB, ` +
      `${restored.seconds} s). Your live system is never connected to.` : ", no database yet."), { repository: res.repository, restored },
    { important: true, ...tool("intake + workbench restore") });
  return { next: "inspect" };
}

export async function inspect(job: Job, round: number): Promise<StageResult> {
  const work = J(job, "work");
  const meta = path.join(work, "suitecrm-meta.json");
  await workbench(job, "assessment", "inspect", round, ["php-meta", "--src", J(job, "source"), "--out", meta],
    "read SuiteCRM's configuration and metadata (isolated PHP 7.4, no network)");
  const out = path.join(work, "inspection.json");
  await pyEnv(job, "assessment", "inspect", round, "goose_engine.suitecrm.inspect", ["--repo", J(job, "source"), "--meta", meta,
    "--db", mysqlDb(job, "snapshot"), "--baseline", BASELINE, "--compat", COMPAT, "--today", new Date().toISOString().slice(0, 10), "--out", out],
    sandbox(job, [J(job, "source"), work], [work]));
  const insp = readJson(out);
  await artifact(job, "inspection", "Application map and findings", out, { by: "assessment", attempt: round, visible: true, ...tool("suitecrm inspect") });
  await q("UPDATE jobs SET source_stack = $2 WHERE id = $1", [job.id, JSON.stringify(insp.stack)]);
  const f = (id: string) => insp.findings.find((x: any) => x.id === id);
  await logEvent(job.id, "assessment", "decision", `Inspected SuiteCRM ${insp.stack.framework_version}: ${insp.size.sales_rows.toLocaleString("en-US")} sales records, ` +
    `${insp.findings.length} findings, each tied to a file and line or a database query. Customizations found by comparing with SuiteCRM's own file ` +
    `checksums and a clean install of the same version: ${[f("F-crm-approval-rule")?.title, f("F-crm-renewal-field")?.title].filter(Boolean).join("; ")}.`,
    { size: insp.size, findings: insp.findings.map((x: any) => x.id) }, { important: true, ...tool("suitecrm inspect") });
  if (f("F-crm-usd-threshold")) {
    await logEvent(job.id, "assessment", "decision", `${f("F-crm-usd-threshold").title}. ${f("F-crm-usd-threshold").detail}`, undefined,
      { important: true, ...tool("suitecrm inspect") });
  }
  return { next: "plan" };
}

// ======================================================================== recording the original, freezing the checks

export async function baseline(job: Job, attempt: number): Promise<StageResult> {
  const base = mkdir(J(job, "baseline"));
  const copyDb = mysqlDb(job, "original");
  await workbench(job, "verification", "baseline", attempt, ["clone", "--src", mysqlDb(job, "snapshot"), "--dst", copyDb], "copy the snapshot for the original app");
  const port = await freePort();
  const app = J(job, "runtime", "original-suitecrm");
  await workbench(job, "verification", "baseline", attempt, ["prepare-copy", "--src", J(job, "source"), "--dest", app, "--db", copyDb, "--port", String(port)],
    "writable copy of the original code, pointed at the copy");
  const pwFile = path.join(base, "record-password");
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, `gs-rec-${Math.random().toString(36).slice(2, 12)}`, { mode: 0o600 });
  await pyEnv(job, "verification", "baseline", attempt, "goose_engine.suitecrm.recordpw", ["--db", copyDb, "--password-file", pwFile], sandbox(job, [base], [base]));
  const name = `gs-${job.id.toLowerCase()}-original`;
  const t0 = Date.now();
  await workbench(job, "verification", "baseline", attempt, ["runtime-start", "--name", name, "--app", app, "--port", String(port)],
    "start the original SuiteCRM on the copy (PHP 7.4 container)");
  let rec: any;
  try {
    rec = await pyEnv(job, "verification", "baseline", attempt, "goose_verify.crm_record", ["--url", `http://localhost:${port}`, "--copy-db", copyDb,
      "--snapshot-db", mysqlDb(job, "snapshot"), "--password-file", pwFile, "--out", path.join(base, "recording.json")], sandbox(job, [base], [base], true));
  } finally {
    await workbench(job, "verification", "baseline", attempt, ["runtime-stop", "--name", name], "stop the original copy");
    await recordCompute(job.id, "verification", "baseline", attempt, Date.now() - t0, "original SuiteCRM copy running (container)");
  }
  await artifact(job, "baseline", "Recorded behaviour of the original SuiteCRM", path.join(base, "recording.json"), { by: "verification", ...tool("crm_record") });
  const r = readJson(path.join(base, "recording.json"));
  const seen = new Map<string, any>();
  for (const o of r.observations ?? []) {
    const key = o.what.includes("repeats and skips") ? "paging" : o.what;
    if (!seen.has(key)) seen.set(key, o);
  }
  const quirks = [...seen.values()];
  const obs = quirks.length ? { what: quirks.map((o) => o.what.includes("repeats and skips")
    ? `repeats some records and skips others when it reads more than 200 at a time (seen for ${o.user})` : o.what).join("; and it "),
    count: quirks[0].count, listable: quirks[0].listable } : null;
  await logEvent(job.id, "verification", "decision", `Recorded the original SuiteCRM on a disposable copy of your data: who can sign in (${Object.keys(r.users).length} users), ` +
    `what each user can list in 6 modules, ${r.views.length} record openings, ${r.edits.length} edits, ${r.deletes.length} deletes, and ` +
    `${r.scenarios.length} approval-rule scenarios.` + (obs ? ` Also noticed in SuiteCRM's own API (not planted): it ${obs.what.replace(/^get_entries_count\('Accounts'\) ignores record visibility/,
      `counts all accounts for every user (${obs.count} for a user who can list ${obs.listable})`)}. The workspace does neither.` : ""),
    { scenarios: r.scenarios.map((s: any) => s.id), observations: r.observations }, { important: true, ...tool("crm_record") });
  return { next: "freeze" };
}

export async function freeze(job: Job, attempt: number): Promise<StageResult> {
  const vault = J(job, "vault");
  if (fs.existsSync(vault) && !job.checks_manifest_sha) { makeWritable(vault); fs.rmSync(vault, { recursive: true, force: true }); }
  mkdir(vault);
  const accepted = fs.existsSync(J(job, "work", "accepted-plan.json")) ? J(job, "work", "accepted-plan.json") : J(job, "work", "plan.json");
  await pyEnv(job, "verification", "freeze", attempt, "goose_verify.crm_checks", ["freeze", "--snapshot-db", mysqlDb(job, "snapshot"),
    "--recording", J(job, "baseline", "recording.json"), "--plan", accepted, "--vault", vault], sandbox(job, [J(job, "baseline"), J(job, "work")], [vault], true));
  const manifestSha = sha256(path.join(vault, "MANIFEST.json"));
  fs.chmodSync(vault, 0o555);
  await artifact(job, "frozen_checks", "Frozen acceptance checks (manifest)", path.join(vault, "MANIFEST.json"), { by: "verification", frozen: true, ...tool("crm_checks freeze") });
  const ex = readJson(path.join(vault, "expected.json"));
  await logEvent(job.id, "verification", "decision", `Froze the acceptance checks before anything was built (manifest SHA-256 ${manifestSha.slice(0, 16)}...): expected ` +
    `values for ${Object.values(ex.counts as Record<string, number>).reduce((a, b) => a + b, 0).toLocaleString("en-US")} records come from your snapshot, expected ` +
    "behaviour from the recording of the original. The implementation step cannot read or change them.", { counts: ex.counts }, { important: true, ...tool("crm_checks freeze") });
  return { next: "implement", patch: { checks_manifest_sha: manifestSha } };
}

// ======================================================================== implementation and data move

async function workspaceDb(job: Job, label: string, keep = false) {
  const name = dbName(job.id, label);
  return { name, url: await createDb(name, { keep, passwordFile: J(job, "work", `${label}.pgpass`) }) };
}

export async function migrateInto(job: Job, stage: string, attempt: number, deliveredDir: string, dsn: string, sourceDb: string, report: string) {
  const plan = readJson(J(job, "work", "plan.json"));
  const noAccess = (plan.answers_used?.["Q-crm-support"] ?? "stay") === "stay"
    ? (readJson(J(job, "work", "inspection.json")).facts.access.users as any[]).filter((u) => u.roles.join(",") === "Support").map((u) => u.user_name) : [];
  return pyEnv(job, "implementation", stage, attempt, "goose_engine.suitecrm.migrate", ["--source-db", sourceDb, "--schema",
    path.join(deliveredDir, "schema.sql"), "--config", path.join(deliveredDir, "config.json"), "--replace", "--no-access", noAccess.join(","),
    "--report", report], sandbox(job, [deliveredDir], [path.dirname(report)]), { TARGET_DSN: dsn });
}

export async function implement(job: Job, attempt: number): Promise<StageResult> {
  const build = mkdir(J(job, "build", `attempt-${attempt}`));
  const delivered = path.join(build, "delivered");
  const accepted = fs.existsSync(J(job, "work", "accepted-plan.json")) ? J(job, "work", "accepted-plan.json") : J(job, "work", "plan.json");
  const customer = job.kind === "demo" ? `${job.title} (made-up business, synthetic data)` : job.title;
  const snapAt = (await one<{ t: string }>("SELECT created_at::text AS t FROM job_inputs WHERE job_id = $1 AND kind = 'database' ORDER BY id DESC LIMIT 1", [job.id]))?.t ?? null;
  const cfg = await pyEnv(job, "implementation", "implement", attempt, "goose_engine.suitecrm.configure", ["--inspection", J(job, "work", "inspection.json"),
    "--plan", accepted, "--template", TEMPLATE, "--job", JSON.stringify({ id: job.id, customer, customer_short: job.title, synthetic: job.kind === "demo" }),
    "--source-url", ORIGINAL_URL, ...(snapAt ? ["--snapshot-taken-at", snapAt] : []), "--out-dir", delivered], sandbox(job, [TEMPLATE, J(job, "work")], [build]));
  const venv = path.join(build, "venv");
  const ms = await makeVenv(venv, path.join(delivered, "requirements.txt"), path.join(build, "install.log"));
  if (ms) await recordCompute(job.id, "implementation", "implement", attempt, ms, "install the workspace's pinned requirements");
  const db = await workspaceDb(job, "workspace");
  const mig = await migrateInto(job, "implement", attempt, delivered, db.url, mysqlDb(job, "snapshot"), path.join(build, "migration.json"));
  const c = readJson(path.join(delivered, "config.json"));
  await artifact(job, "upgraded_code", `Sales workspace (attempt ${attempt})`, delivered, { by: "implementation", attempt, ...tool("sales-workspace template + configure") });
  await artifact(job, "migration_report", `Data move report (attempt ${attempt})`, path.join(build, "migration.json"), { by: "implementation", attempt, visible: true, ...tool("suitecrm migrate") });
  await artifact(job, "config", "Workspace configuration generated from the inspection", path.join(delivered, "config.json"), { by: "implementation", attempt, visible: true, ...tool("configure") });
  const rows = Object.entries(mig.rows as Record<string, number>).filter(([k]) => ["accounts", "contacts", "deals", "leads", "notes", "tasks"].includes(k))
    .map(([k, v]) => `${v.toLocaleString("en-US")} ${k}`).join(", ");
  await logEvent(job.id, "implementation", "decision", `Configured Goose's sales-workspace template from the inspection (${cfg.stages} stages, ` +
    `approval rule from ${c.approval_rule?.source?.file ?? "-"}, custom fields: ${cfg.custom_fields.join(", ")}) and moved the snapshot into PostgreSQL in ` +
    `${mig.seconds} s: ${rows}. Left in SuiteCRM: ${Object.entries(mig.left as Record<string, number>).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ")}.`,
    { config: cfg, migration: mig }, { important: true, origin: "tool", originDetail: { tool: "sales-workspace template (written by Goose) + configure + migrate" } });
  return { next: "verify" };
}

// ======================================================================== verification

export async function startWorkspace(job: Job, attempt: number, dsn: string, port: number, note: string, logName: string) {
  const build = J(job, "build", `attempt-${attempt}`);
  const delivered = path.join(build, "delivered");
  const secretFile = path.join(build, "session-secret");
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, Math.random().toString(36).slice(2) + Date.now().toString(36), { mode: 0o600 });
  return startServer({ cmd: path.join(build, "venv", "bin", "python"), args: ["-E", "-s", "-m", "app"], cwd: delivered,
    env: cleanEnv({ DATABASE_URL: dsn, SESSION_SECRET: fs.readFileSync(secretFile, "utf8").trim(), PORT: String(port), HOST: "127.0.0.1",
      WORKSPACE_CONFIG: path.join(delivered, "config.json") }, build),
    sandbox: { readAllow: [build], writeAllow: [path.join(build, "logs")], readDeny: [J(job, "vault"), J(job, "baseline"), J(job, "inputs"), J(job, "source")] },
    port, healthPath: "/healthz", logFile: path.join(mkdir(path.join(build, "logs")), logName), timeoutMs: 60_000 });
}

export async function verify(job: Job, attempt: number): Promise<StageResult> {
  const vdir = mkdir(J(job, "verify", `attempt-${attempt}`));
  const vault = J(job, "vault");
  const manifestNow = sha256(path.join(vault, "MANIFEST.json"));
  if (manifestNow !== job.checks_manifest_sha) {
    await logEvent(job.id, "verification", "decision", "Integrity check FAILED: the frozen checks changed after they were frozen. Delivery blocked.",
      { expected: job.checks_manifest_sha, found: manifestNow }, { important: true, ...tool("verifier") });
    return { next: "verify", status: "waiting_founder", waiting: "Frozen checks failed their integrity check" };
  }
  const delivered = { name: dbName(job.id, "workspace"), url: await createDb(dbName(job.id, "workspace"), { keep: true, passwordFile: J(job, "work", "workspace.pgpass") }) };
  const ver = await workspaceDb(job, `verify${attempt}`);
  // the verification copy starts as an exact copy of the delivered database
  const dump = await run({ cmd: "/opt/homebrew/opt/postgresql@17/bin/pg_dump", args: ["--no-owner", "--no-acl", "-d", delivered.url, "-f", path.join(vdir, "delivered.sql")],
    cwd: vdir, env: cleanEnv({}, vdir), timeoutMs: 300_000 });
  if (dump.code !== 0) throw new Error(`pg_dump failed: ${dump.stderr.slice(-500)}`);
  const load = await run({ cmd: "/opt/homebrew/opt/postgresql@17/bin/psql", args: ["-q", "-v", "ON_ERROR_STOP=1", "-d", ver.url, "-f", path.join(vdir, "delivered.sql")],
    cwd: vdir, env: cleanEnv({}, vdir), timeoutMs: 300_000 });
  if (load.code !== 0) throw new Error(`loading the verification copy failed: ${load.stderr.slice(-500)}`);
  fs.rmSync(path.join(vdir, "delivered.sql"), { force: true });
  const pwFile = path.join(vdir, "verify-password");
  fs.writeFileSync(pwFile, `gs-ver-${Math.random().toString(36).slice(2, 12)}`, { mode: 0o600 });
  const port = await freePort();
  const t0 = Date.now();
  const server = await startWorkspace(job, attempt, ver.url, port, "workspace under test", `verify-${attempt}.log`);
  let out: any;
  try {
    out = await pyEnv(job, "verification", "verify", attempt, "goose_verify.crm_checks", ["run", "--vault", vault, "--app-url", server.url,
      "--password-file", pwFile, "--report", path.join(vdir, "report.json"), "--markdown", path.join(vdir, "report.md")],
      sandbox(job, [vdir, vault], [vdir], true), { DELIVERED_DSN: delivered.url, VERIFY_DSN: ver.url });
  } finally {
    await server.stop();
    await recordCompute(job.id, "verification", "verify", attempt, Date.now() - t0, "sales workspace under test (sandboxed)");
    await dropDb(ver.name);
  }
  return recordVerdict(job, attempt, path.join(vdir, "report"));
}

async function recordVerdict(job: Job, attempt: number, rep: string): Promise<StageResult> {
  const report = readJson(rep + ".json");
  await q(`INSERT INTO check_runs (job_id, attempt, integrity_ok, total, passed, failed, skipped, verdict, by_category, failed_checks, report_path)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (job_id, attempt) DO UPDATE SET integrity_ok = EXCLUDED.integrity_ok, total = EXCLUDED.total, passed = EXCLUDED.passed,
             failed = EXCLUDED.failed, skipped = EXCLUDED.skipped, verdict = EXCLUDED.verdict, by_category = EXCLUDED.by_category,
             failed_checks = EXCLUDED.failed_checks, report_path = EXCLUDED.report_path, created_at = now()`,
    [job.id, attempt, report.integrity.ok, report.summary.total, report.summary.passed, report.summary.failed, report.summary.skipped,
     report.summary.verdict, JSON.stringify(report.by_category), JSON.stringify(report.failed.slice(0, 60)), rep + ".json"]);
  await artifact(job, "verification_report", `Verification report (attempt ${attempt})`, rep + ".md", { by: "verification", attempt, visible: true, ...tool("crm_checks") });
  await artifact(job, "verification_data", `Verification results JSON (attempt ${attempt})`, rep + ".json", { by: "verification", attempt, visible: true, ...tool("crm_checks") });
  if (report.summary.verdict === "pass") {
    await logEvent(job.id, "verification", "check", `Verification attempt ${attempt} PASSED: ${report.summary.passed} of ${report.summary.total} checks, against the ` +
      "frozen expectations from your snapshot and the recording of the original SuiteCRM.", report.summary, { important: true, ...tool("crm_checks") });
    return { next: "package" };
  }
  await logEvent(job.id, "verification", "check", `Verification attempt ${attempt} FAILED: ${report.summary.failed} checks. Delivery is blocked. ` +
    report.failed.slice(0, 4).map((f: any) => f.title).join("; "), { summary: report.summary, failed: report.failed.slice(0, 10).map((f: any) => f.id) },
    { important: true, ...tool("crm_checks") });
  await logEvent(job.id, "coordinator", "decision", config.mode === "naive"
    ? "The repair loop for this recipe is not enabled yet; escalating to the founder with the evidence."
    : "No deterministic repair exists for this recipe and the live agents are not running (local mode): escalated to the founder with the evidence.",
    undefined, { important: true, ...tool("repair budget rule") });
  return { next: "verify", status: "waiting_founder", waiting: `Verification failed: ${report.failed.slice(0, 3).map((f: any) => f.id).join(", ")}` };
}

// ======================================================================== delivery

export async function packageStage(job: Job, attempt: number): Promise<StageResult> {
  const att = job.attempt;
  const del = mkdir(J(job, "delivery"));
  const staging = path.join(del, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  v1.copyFresh(J(job, "build", `attempt-${att}`, "delivered"), path.join(staging, "sales-workspace"));
  mkdir(path.join(staging, "evidence"));
  const vd = J(job, "verify", `attempt-${att}`);
  for (const [from, to] of [["report.md", "verification-report.md"], ["report.json", "verification-report.json"]]) fs.copyFileSync(path.join(vd, from), path.join(staging, "evidence", to));
  fs.copyFileSync(J(job, "vault", "MANIFEST.json"), path.join(staging, "evidence", "frozen-checks-manifest.json"));
  fs.copyFileSync(J(job, "build", `attempt-${att}`, "migration.json"), path.join(staging, "evidence", "data-move-report.json"));
  fs.copyFileSync(J(job, "baseline", "recording.json"), path.join(staging, "evidence", "original-behaviour-recording.json"));
  const p = (await one<{ plan: any }>("SELECT plan FROM plans WHERE job_id = $1 ORDER BY version DESC LIMIT 1", [job.id]))?.plan ?? readJson(J(job, "work", "plan.json"));
  const list = (xs: any[], f: (x: any) => string) => (xs ?? []).map((x) => `- ${f(x)}`).join("\n");
  fs.writeFileSync(path.join(staging, "CHANGES.md"), `# What changed\n\n${list(p.changes, (c) => `**${c.title}.** ${c.reason}`)}\n\n## Kept as it was\n\n` +
    `${list(p.preserve, (k) => `${k.what}. ${k.reason}`)}\n\n## Stays in SuiteCRM\n\n${list(p.stays_in_original, (s) => `${s.module} (${s.rows} records)`)}\n\n` +
    `## Links across the boundary\n\n${list(p.boundary, (b) => `${b.from} → ${b.to} (${b.rows}): ${b.handling}`)}\n\n## Intended differences\n\n` +
    `${list(p.intended_differences, (d) => `${d.what}. ${d.why}`)}\n\n## Architecture\n\n${p.target?.architecture}. ${(p.target?.why ?? []).join(" ")}\n\n` +
    `- Modernized: ${(p.target?.modernized ?? []).join("; ")}\n- Still used: ${(p.target?.still_used ?? []).join("; ")}\n`);
  fs.writeFileSync(path.join(staging, "RUNBOOK.md"), `# Switching over\n\n${(p.cutover?.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    `${p.cutover?.downtime}\n\nTo run the workspace: Python 3.13, \`pip install -r sales-workspace/requirements.txt\`, PostgreSQL 17 with \`schema.sql\`, then ` +
    "`DATABASE_URL=... SESSION_SECRET=... WORKSPACE_CONFIG=sales-workspace/config.json python -m app` in `sales-workspace/`.\n");
  fs.writeFileSync(path.join(staging, "ROLLBACK.md"), `# Rollback\n\n${p.cutover?.rollback}\n\nSuiteCRM and its database were never changed by this job until the switch; ` +
    "the switch only makes its sales roles read-only, and the previous role settings are saved in the switch record.\n");
  fs.writeFileSync(path.join(staging, "README-FIRST.md"), `# ${job.title} - delivery package (${job.id})\n\n${job.kind === "demo" ? "**DEMONSTRATION JOB - synthetic data.**\n\n" : ""}` +
    `${p.title}.\n\n- \`sales-workspace/\`: the application, its \`config.json\` (generated from the inspection) and \`schema.sql\`.\n- \`CHANGES.md\`, \`RUNBOOK.md\`, ` +
    "`ROLLBACK.md`.\n- `evidence/verification-report.md`: every check and what was not tested.\n- `evidence/frozen-checks-manifest.json`: hashes of the checks as " +
    "frozen before anything was built.\n- `evidence/data-move-report.json`: rows moved and rows left in SuiteCRM, with reasons.\n- `evidence/original-behaviour-recording.json`: " +
    "what the original SuiteCRM did on a copy of your data.\n");
  const zip = path.join(del, `${job.id}-delivery.zip`);
  fs.rmSync(zip, { force: true });
  const z = await run({ cmd: "/usr/bin/zip", args: ["-r", "-q", zip, ".", "-x", "*/__pycache__/*", "-x", "*.pyc"], cwd: staging, env: cleanEnv() });
  if (z.code !== 0) throw new Error(`zip failed: ${z.stderr}`);
  await artifact(job, "delivery_package", "Delivery package (.zip)", zip, { by: "coordinator", visible: true, ...tool("package") });
  await logEvent(job.id, "coordinator", "decision", `Delivery package ready (SHA-256 ${sha256(zip).slice(0, 16)}...). The workspace can be opened on the moved data; ` +
    "the switch-over (final snapshot) happens when the customer chooses.", { zip: path.basename(zip) }, { important: true, ...tool("package") });
  await q("INSERT INTO messages (job_id, sender, body, handled_by) VALUES ($1,'coordinator',$2,'template')", [job.id,
    "Your sales workspace is ready to try on a copy of your data. Read the verification report, try it, and accept when you are satisfied. " +
    "The switch-over takes a final snapshot and pauses sales edits in SuiteCRM for a few minutes; you choose when."]);
  return { next: "delivered", status: "waiting_customer", waiting: "Delivered; waiting for the customer to accept" };
}

// ======================================================================== switch-over (final snapshot) after delivery

/** Move a final snapshot into the delivered database and re-run the frozen data checks on it. Used by `npm run crm -- cutover`. */
export async function cutover(job: Job, dumpFile: string) {
  const attempt = job.attempt;
  const dir = mkdir(J(job, "cutover", new Date().toISOString().replace(/[:.]/g, "-")));
  const dest = path.join(dir, "final.mysql.sql.gz");
  fs.copyFileSync(dumpFile, dest);
  fs.chmodSync(dest, 0o444);
  const finalDb = mysqlDb(job, "final");
  const t0 = Date.now();
  const restored = await workbench(job, "commercial", "cutover", attempt, ["restore", "--dump", dest, "--db", finalDb], "restore the final snapshot");
  const delivered = J(job, "build", `attempt-${attempt}`, "delivered");
  const db = { name: dbName(job.id, "workspace"), url: await createDb(dbName(job.id, "workspace"), { keep: true, passwordFile: J(job, "work", "workspace.pgpass") }) };
  const mig = await migrateInto(job, "cutover", attempt, delivered, db.url, finalDb, path.join(dir, "migration.json"));
  // the same frozen check program, with expectations computed from the final snapshot
  const vault = mkdir(path.join(dir, "vault"));
  const accepted = fs.existsSync(J(job, "work", "accepted-plan.json")) ? J(job, "work", "accepted-plan.json") : J(job, "work", "plan.json");
  await pyEnv(job, "verification", "cutover", attempt, "goose_verify.crm_checks", ["freeze", "--snapshot-db", finalDb, "--recording",
    J(job, "baseline", "recording.json"), "--plan", accepted, "--vault", vault], sandbox(job, [J(job, "baseline"), J(job, "work")], [vault], true));
  const check = await pyEnv(job, "verification", "cutover", attempt, "goose_verify.crm_checks", ["run", "--data-only", "--vault", vault,
    "--report", path.join(dir, "data-checks.json"), "--markdown", path.join(dir, "data-checks.md")], sandbox(job, [dir], [dir], true), { DELIVERED_DSN: db.url });
  return { dir, restored, migration: mig, check, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}
