// The work of each stage. Each function is safe to run again after an interruption.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as agents from "./agents";
import { config, jobDir, type Role } from "./config";
import { one, q } from "./db";
import type { Job, StageResult } from "./jobs";
import { pilotOffer, STAGES } from "./jobs";
import { createDb, dbName, dropDb } from "./pgadmin";
import { cleanEnv, freePort, run, startServer, type SandboxSpec } from "./proc";
import { jobSpend, logEvent, recordCompute } from "./records";

export const J = (job: Job, ...p: string[]) => jobDir(job.id, ...p);
export const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
export const sha256 = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
export const mkdir = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p; };

export function engineSandbox(job: Job, read: string[], write: string[], opts: { vault?: boolean } = {}): SandboxSpec {
  return { readAllow: [config.engineDir, ...read], writeAllow: write, readDeny: opts.vault ? [] : [J(job, "vault")] };
}

export function customerSandbox(job: Job, dir: string): SandboxSpec {
  return { readAllow: [dir], writeAllow: [dir], readDeny: [J(job, "vault"), J(job, "baseline"), J(job, "work"), J(job, "inputs")] };
}

export async function py(job: Job, actor: Role, stage: string, attempt: number, module: string, args: string[],
  sandbox: SandboxSpec, opts: { allowFail?: boolean; timeoutMs?: number; log?: string } = {}) {
  const res = await run({
    cmd: config.python.engine, args: ["-E", "-s", "-m", module, ...args], cwd: config.engineDir,
    env: cleanEnv({}, J(job, "work")), sandbox, timeoutMs: opts.timeoutMs ?? 10 * 60_000, logFile: opts.log,
    profileFile: path.join(J(job, "work"), `.sb-${module.replace(/\W/g, "_")}.sb`),
  });
  await recordCompute(job.id, actor, stage, attempt, res.ms, `${module} ${args[0] ?? ""}`.trim());
  if (res.code !== 0 && !opts.allowFail) {
    throw new Error(`${module} exited ${res.code}${res.timedOut ? " (timeout)" : ""}: ${(res.stderr || res.stdout).slice(-1200)}`);
  }
  return res;
}

export const verifier = (job: Job, stage: string, attempt: number, args: string[], sandbox: SandboxSpec, opts = {}) =>
  py(job, "verification", stage, attempt, "goose_verify.cli", args, sandbox, opts);

export async function artifact(job: Job, kind: string, label: string, p: string, opts: { attempt?: number; by: Role; frozen?: boolean; visible?: boolean;
  origin?: "agent" | "tool" | "human" | "fixture" | "system"; originDetail?: Record<string, unknown> }) {
  const isFile = fs.existsSync(p) && fs.statSync(p).isFile();
  await q(
    `INSERT INTO artifacts (job_id, kind, label, path, sha256, size_bytes, attempt, created_by, frozen, customer_visible, origin, origin_detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (job_id, kind, attempt, label) DO UPDATE SET path = EXCLUDED.path, sha256 = EXCLUDED.sha256,
       size_bytes = EXCLUDED.size_bytes, origin = EXCLUDED.origin, origin_detail = EXCLUDED.origin_detail, created_at = now()`,
    [job.id, kind, label, p, isFile ? sha256(p) : null, isFile ? fs.statSync(p).size : null, opts.attempt ?? 1, opts.by,
     opts.frozen ?? false, opts.visible ?? false, opts.origin ?? "tool", opts.originDetail ? JSON.stringify(opts.originDetail) : null]);
}

export async function makeVenv(dir: string, requirements: string, log: string) {
  if (fs.existsSync(path.join(dir, ".installed"))) return 0;
  fs.rmSync(dir, { recursive: true, force: true });
  const env = { PATH: "/usr/bin:/bin", HOME: config.home, LANG: "en_US.UTF-8" };
  const a = await run({ cmd: config.python.uv, args: ["venv", "--python", config.python.modern, dir, "-q"], cwd: path.dirname(dir), env, logFile: log, timeoutMs: 180_000 });
  if (a.code !== 0) throw new Error(`venv creation failed: ${a.stderr.slice(-800)}`);
  const b = await run({ cmd: config.python.uv, args: ["pip", "install", "--python", path.join(dir, "bin", "python"), "-q", "-r", requirements],
    cwd: path.dirname(requirements), env, logFile: log, timeoutMs: 300_000 });
  if (b.code !== 0) throw new Error(`dependency install failed: ${b.stderr.slice(-800)}`);
  fs.appendFileSync(log, `\nINSTALL OK ${new Date().toISOString()} from ${requirements}\n`);
  fs.writeFileSync(path.join(dir, ".installed"), new Date().toISOString());
  return a.ms + b.ms;
}

export async function pkgPython(job: Job, actor: Role, stage: string, attempt: number, pkgDir: string, venv: string, args: string[],
  env: Record<string, string>, log: string, opts: { allowFail?: boolean } = {}) {
  const res = await run({ cmd: path.join(venv, "bin", "python"), args: ["-E", "-s", ...args], cwd: pkgDir,
    env: cleanEnv(env, pkgDir), sandbox: customerSandbox(job, path.dirname(pkgDir)), timeoutMs: 15 * 60_000, logFile: log,
    profileFile: path.join(path.dirname(pkgDir), `.sb-pkg.sb`) });
  await recordCompute(job.id, actor, stage, attempt, res.ms, args.join(" ").slice(0, 80));
  if (res.code !== 0 && !opts.allowFail) throw new Error(`${args.join(" ")} exited ${res.code}: ${(res.stderr || res.stdout).slice(-1200)}`);
  return res;
}

/** Start a sandboxed app server; time spent on a server that never comes up is still recorded as cost. */
export async function serverFor(job: Job, actor: Role, stage: string, attempt: number, note: string, opts: Parameters<typeof startServer>[0]) {
  const t0 = Date.now();
  try { return await startServer(opts); } catch (e) {
    await recordCompute(job.id, actor, stage, attempt, Date.now() - t0, `${note} - did not start`);
    throw e;
  }
}

export function copyFresh(src: string, dest: string) {
  if (fs.existsSync(dest)) makeWritable(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const p of walk(dest)) {
    try { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); } catch { /* ignore */ }
  }
}

export function walk(dir: string): string[] {
  const out: string[] = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

export function makeReadOnly(dir: string) {
  for (const p of walk(dir).reverse()) {
    try { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o555 : 0o444); } catch { /* ignore */ }
  }
}

export function makeWritable(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const p of walk(dir)) {
    try { fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); } catch { /* ignore */ }
  }
}

export async function budgetLeft(job: Job) {
  const s = await jobSpend(job.id);
  return Math.max(0, job.cost_limit_micro_usd - s.total);
}

export async function ctxFor(job: Job, attempt: number, stage: string = job.stage) {
  return { jobId: job.id, stage, attempt, budgetMicroUsd: await budgetLeft(job) };
}

// ======================================================================== commercial stages

export async function intake(job: Job, round: number): Promise<StageResult> {
  const inputs = await q<{ kind: string; stored_path: string; sha256: string }>(
    "SELECT DISTINCT ON (kind) kind, stored_path, sha256 FROM job_inputs WHERE job_id = $1 ORDER BY kind, id DESC", [job.id]);
  const repo = inputs.find((i) => i.kind === "repository");
  const db = inputs.find((i) => i.kind === "database");
  if (!repo) throw new Error("no repository upload");
  mkdir(J(job, "work"));
  const source = J(job, "source");
  makeWritable(source);
  fs.rmSync(source, { recursive: true, force: true });
  const out = path.join(J(job, "work"), `intake-${round}.json`);
  await py(job, "commercial", "intake", round, "goose_engine.intake",
    ["--repo", repo.stored_path, "--source-dir", source, ...(db ? ["--db", db.stored_path] : []), "--out", out],
    engineSandbox(job, [J(job, "inputs")], [source, J(job, "work")]));
  const res = readJson(out);
  await q("UPDATE job_inputs SET validation = $2 WHERE stored_path = $1", [repo.stored_path, JSON.stringify(res.repository)]);
  if (db) await q("UPDATE job_inputs SET validation = $2 WHERE stored_path = $1", [db.stored_path, JSON.stringify(res.database)]);
  const problems: string[] = [...res.repository.problems, ...(res.database?.problems ?? [])];
  if (problems.length) {
    await q(`INSERT INTO questions (job_id, key, asked_by, audience, prompt, fields, blocking)
             VALUES ($1, $2, 'commercial', 'customer', $3, $4, true) ON CONFLICT (job_id, key) DO NOTHING`,
      [job.id, `upload-${round}`, `We could not use the files you sent: ${problems.join(" ")} Please upload them again.`,
       JSON.stringify([{ type: "upload", key: "repository" }, { type: "upload", key: "database" }])]);
    await logEvent(job.id, "commercial", "decision", `Asked the customer to re-upload: ${problems.join(" ")}`, { problems }, { important: true });
    return { next: "awaiting_info", status: "waiting_customer", waiting: "New files needed from the customer" };
  }
  makeReadOnly(source);
  await artifact(job, "source_snapshot", "Unchanged source snapshot", repo.stored_path, { by: "commercial", frozen: true });
  if (db) {
    const snap = mkdir(J(job, "snapshot"));
    const dest = path.join(snap, "database.sqlite");
    if (fs.existsSync(dest)) fs.chmodSync(dest, 0o644);
    fs.copyFileSync(db.stored_path, dest);
    fs.chmodSync(dest, 0o444);
    await artifact(job, "database_snapshot", "Unchanged database copy", dest, { by: "commercial", frozen: true });
  }
  await logEvent(job.id, "commercial", "decision",
    `Files accepted: ${res.repository.files} source files${db ? `, SQLite database (${(res.database.bytes / 1024).toFixed(0)} KB, integrity ok)` : ", no database yet"}.`,
    res);
  return { next: "assess" };
}

export async function assess(job: Job, round: number): Promise<StageResult> {
  const snapshot = J(job, "snapshot", "database.sqlite");
  const out = path.join(J(job, "work"), "assessment.json");
  await py(job, "commercial", "assess", round, "goose_engine.analyze",
    ["--repo", J(job, "source"), ...(fs.existsSync(snapshot) ? ["--db", snapshot] : []), "--timezone", job.timezone,
     "--latest", path.join(config.engineDir, "data", "pypi_latest.json"), "--out", out],
    engineSandbox(job, [J(job, "source"), J(job, "snapshot")], [J(job, "work")]));
  const a = readJson(out);
  await artifact(job, "assessment", "Assessment", out, { by: "commercial", attempt: round });
  const answered = new Set((await q<{ key: string }>("SELECT key FROM questions WHERE job_id = $1 AND status = 'answered'", [job.id])).map((r) => r.key));
  const openQs = a.questions.filter((x: any) => x.blocking && !answered.has(x.id));
  if (a.fit.decision === "needs_info" && openQs.length === 0) a.fit.decision = "supported";
  const review = await agents.reviewAssessment(await ctxFor(job, round), a);
  await logEvent(job.id, "commercial", "decision",
    review.decision === "supported" ? `Fits the supported upgrade: ${a.size.routes} endpoints, ${a.size.tables} tables, ${a.size.rows.toLocaleString("en-US")} rows, ${a.findings.length} findings.`
      : review.decision === "unsupported" ? `Rejected: ${a.fit.blockers.join(" ")}`
        : `Needs information before quoting: ${openQs.map((x: any) => x.prompt).join(" ")}`,
    { decision: review.decision, reasons: review.reasons, risks: review.risks, by: review.by }, { important: true, source: review.by === "naive" ? "naive" : "local" });
  await q("INSERT INTO messages (job_id, sender, body, handled_by) VALUES ($1, 'commercial', $2, $3)",
    [job.id, review.customer_message, review.by]);
  if (review.decision === "unsupported") {
    return { next: "rejected", status: "rejected", waiting: null };
  }
  if (review.decision === "needs_info" || openQs.length) {
    for (const x of openQs) {
      await q(`INSERT INTO questions (job_id, key, asked_by, audience, prompt, fields, options_help, recommended, blocking)
               VALUES ($1,$2,'commercial',$3,$4,$5,$6,$7,true) ON CONFLICT (job_id, key) DO NOTHING`,
        [job.id, x.id, x.to === "founder" ? "founder" : "customer", x.prompt, JSON.stringify(x.fields ?? []),
         x.options_help ? JSON.stringify(x.options_help) : null, x.recommended ?? null]);
    }
    const toFounder = openQs.some((x: any) => x.to === "founder");
    return { next: "awaiting_info", status: toFounder ? "waiting_founder" : "waiting_customer",
      waiting: toFounder ? "A data decision needs the founder" : "Waiting for the customer to answer a question" };
  }
  return { next: "propose" };
}

export async function propose(job: Job, round: number): Promise<StageResult> {
  const answers: Record<string, unknown> = {};
  for (const r of await q<{ key: string; answer: any }>("SELECT key, answer FROM questions WHERE job_id = $1 AND status = 'answered'", [job.id])) {
    answers[r.key] = r.answer;
  }
  const ansFile = path.join(J(job, "work"), "answers.json");
  fs.writeFileSync(ansFile, JSON.stringify(answers, null, 2));
  const draft = path.join(J(job, "work"), `scope-draft-${round}.json`);
  await py(job, "commercial", "propose", round, "goose_engine.scope",
    ["--assessment", path.join(J(job, "work"), "assessment.json"), "--answers", ansFile, "--slug", job.app_slug,
     "--title", job.title, "--out", draft], engineSandbox(job, [J(job, "work")], [J(job, "work")]));
  const scope = readJson(draft);
  const offer = await pilotOffer();
  const summary = await agents.proposalSummary(await ctxFor(job, round), scope, offer.price_usd, offer.delivery_days);
  const a = readJson(path.join(J(job, "work"), "assessment.json"));
  const version = ((await one<{ v: number }>("SELECT COALESCE(MAX(version),0)::int AS v FROM proposals WHERE job_id = $1", [job.id]))?.v ?? 0) + 1;
  await q("UPDATE proposals SET status = 'superseded' WHERE job_id = $1 AND status = 'sent'", [job.id]);
  await q(`INSERT INTO proposals (job_id, version, scope, summary, price_cents, cost_limit_micro_usd, delivery_days, status, scope_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'sent',$8) ON CONFLICT (job_id, version) DO NOTHING`,
    [job.id, version, JSON.stringify(scope), JSON.stringify({ ...summary, findings: a.findings, size: a.size }),
     Math.round(offer.price_usd * 100), job.cost_limit_micro_usd, offer.delivery_days, sha256(draft)]);
  await q("UPDATE jobs SET price_cents = $2 WHERE id = $1", [job.id, Math.round(offer.price_usd * 100)]);
  await logEvent(job.id, "commercial", "decision",
    `Proposal v${version} sent: fixed price $${offer.price_usd.toLocaleString("en-US")}, ${scope.changes.length} agreed changes, ` +
    `${scope.acceptance_checklist.length} acceptance items, ${scope.intentional_differences.length} intentional differences.`,
    { version, by: summary.by }, { important: true });
  return { next: "awaiting_acceptance", status: "waiting_customer", waiting: "Proposal sent; waiting for the customer to accept" };
}

// ======================================================================== delivery stages

export function legacyRuntime(job: Job, label: string, dbSource: string) {
  const a = readJson(path.join(J(job, "work"), "assessment.json"));
  const dir = J(job, "runtime", label);
  const app = path.join(dir, "app");
  copyFresh(J(job, "source"), app);
  fs.copyFileSync(path.join(config.engineDir, "goose_engine", "launch_flask.py"), path.join(dir, "launch_flask.py"));
  const loc = a.app.database_location ?? {};
  const dbPath = loc.default_path && !path.isAbsolute(loc.default_path) ? path.join(app, loc.default_path) : path.join(dir, "data.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(dbSource, dbPath);
  fs.chmodSync(dbPath, 0o644);
  const env: Record<string, string> = { TZ: job.timezone, APP_ROOT: app };
  for (const v of loc.env_vars ?? []) env[v] = dbPath;
  return { dir, app, dbPath, env, entry: path.join(app, a.app.entry_module), pythonVersion: a.app.python_version as string | null };
}

/** The original app runs on its own pinned libraries. Wheels only: installing never runs a package's build script. */
export async function originalPython(job: Job, version: string | null) {
  const req = J(job, "source", "requirements.txt");
  if (!fs.existsSync(req)) {
    await logEvent(job.id, "verification", "decision", "No requirements.txt; running the original app on the default Flask 1.1 runtime.");
    return config.python.legacy;
  }
  const want = version ?? "3.9";
  const key = crypto.createHash("sha256").update(fs.readFileSync(req)).update(want).digest("hex").slice(0, 12);
  const venv = path.join(config.varDir, "venvs", `original-${key}`);
  const log = path.join(J(job, "work"), "original-runtime.log");
  if (!fs.existsSync(path.join(venv, ".installed"))) {
    const env = { PATH: "/usr/bin:/bin", HOME: config.home, LANG: "en_US.UTF-8" };
    fs.rmSync(venv, { recursive: true, force: true });
    const a = await run({ cmd: config.python.uv, args: ["venv", "--python", want, venv, "-q"], cwd: config.varDir, env, logFile: log, timeoutMs: 300_000 });
    if (a.code !== 0) throw new Error(`could not create a Python ${want} runtime for the original app: ${a.stderr.slice(-500)}`);
    const b = await run({ cmd: config.python.uv, args: ["pip", "install", "--python", path.join(venv, "bin", "python"), "-q",
      "--only-binary", ":all:", "-r", req], cwd: config.varDir, env, logFile: log, timeoutMs: 300_000 });
    if (b.code !== 0) throw new Error(`could not install the original app's pinned requirements (wheels only): ${b.stderr.slice(-600)}`);
    fs.writeFileSync(path.join(venv, ".installed"), new Date().toISOString());
    await recordCompute(job.id, "verification", "baseline", 1, a.ms + b.ms, "build the original app's runtime");
    await logEvent(job.id, "verification", "decision", `Built the original app's own runtime: Python ${want} with its pinned requirements.`);
  }
  return path.join(venv, "bin", "python");
}

export async function baseline(job: Job, attempt: number): Promise<StageResult> {
  const base = mkdir(J(job, "baseline"));
  const work = J(job, "work");
  const scenario = path.join(base, "scenario.json");
  await verifier(job, "baseline", attempt, ["scenario", "--assessment", path.join(work, "assessment.json"),
    "--scope", path.join(work, "scope.json"), "--source-db", J(job, "snapshot", "database.sqlite"), "--out", scenario],
    engineSandbox(job, [work, J(job, "snapshot")], [base], { vault: true }));
  const rt = legacyRuntime(job, "original-A", J(job, "snapshot", "database.sqlite"));
  const python = await originalPython(job, rt.pythonVersion);
  const port = await freePort();
  const health = readJson(scenario).steps.find((s: any) => s.method === "GET" && !s.path.includes("?"))?.path ?? "/";
  const server = await serverFor(job, "verification", "baseline", attempt, "original app (Flask, sandboxed)", { cmd: python, args: ["-E", "-s", path.join(rt.dir, "launch_flask.py"), rt.entry, String(port)],
    cwd: rt.app, env: cleanEnv(rt.env, rt.dir), sandbox: customerSandbox(job, rt.dir), port, healthPath: health,
    logFile: path.join(rt.dir, "original-app.log") });
  const recording = path.join(base, "baseline.json");
  try {
    await verifier(job, "baseline", attempt, ["record", "--scenario", scenario, "--url", server.url, "--timezone", job.timezone,
      "--out", recording], engineSandbox(job, [base], [base], { vault: true }));
  } finally {
    await server.stop();
    await recordCompute(job.id, "verification", "baseline", attempt, Date.now() - server.startedMs, "original app (Flask, sandboxed)");
  }
  const sc = readJson(scenario);
  await artifact(job, "scenario", "Representative scenario", scenario, { by: "verification" });
  await artifact(job, "baseline", "Recorded behaviour of the original app", recording, { by: "verification" });
  await logEvent(job.id, "verification", "decision",
    `Recorded the original app on its own data copy: ${sc.steps.length} requests covering ${sc.coverage.routes_covered} of ${sc.coverage.routes_total} endpoints.`,
    sc.coverage, { important: true });
  return { next: "freeze" };
}

export async function freeze(job: Job, attempt: number): Promise<StageResult> {
  const vault = J(job, "vault");
  if (fs.existsSync(vault) && !job.checks_manifest_sha) { makeWritable(vault); fs.rmSync(vault, { recursive: true, force: true }); }
  mkdir(vault);
  const work = J(job, "work");
  const res = await verifier(job, "freeze", attempt, ["freeze", "--vault", vault, "--assessment", path.join(work, "assessment.json"),
    "--scope", path.join(work, "scope.json"), "--scenario", J(job, "baseline", "scenario.json"),
    "--baseline", J(job, "baseline", "baseline.json"), "--source-db", J(job, "snapshot", "database.sqlite"), "--job", job.id],
    engineSandbox(job, [work, J(job, "baseline"), J(job, "snapshot")], [vault], { vault: true }));
  const ev = res.events.find((e) => e.event === "freeze.done");
  if (!ev?.manifest_sha256) throw new Error("freeze produced no manifest");
  fs.chmodSync(vault, 0o555);
  await artifact(job, "frozen_checks", "Frozen acceptance checks (manifest)", path.join(vault, "MANIFEST.json"), { by: "verification", frozen: true });
  await logEvent(job.id, "verification", "decision",
    `Acceptance checks frozen before any code change. Manifest SHA-256 ${ev.manifest_sha256.slice(0, 16)}... covers ${ev.files.length} files ` +
    "and the verifier's own source. The modernization agent's sandbox cannot read them.", ev, { important: true });
  return { next: "modernize", patch: { checks_manifest_sha: ev.manifest_sha256 } };
}

export async function modernize(job: Job, attempt: number): Promise<StageResult> {
  const build = mkdir(J(job, "build", `attempt-${attempt}`));
  const pkg = path.join(build, "upgraded");
  const work = J(job, "work");
  if (attempt === 1) {
    if (fs.existsSync(pkg)) fs.rmSync(pkg, { recursive: true, force: true });
    await py(job, "modernization", "modernize", attempt, "goose_engine.generate",
      ["--repo", J(job, "source"), "--assessment", path.join(work, "assessment.json"), "--scope", path.join(work, "scope.json"),
       "--out", pkg, "--report", path.join(build, "generation.json")],
      engineSandbox(job, [J(job, "source"), work], [build]));
    const gen = readJson(path.join(build, "generation.json"));
    await logEvent(job.id, "modernization", "decision",
      `Generated the FastAPI + PostgreSQL application: ${gen.files.length} files, ${gen.changes.length} recorded code edits, ` +
      `${gen.warnings.length} warnings.`, { warnings: gen.warnings, route_modules: gen.route_modules }, { important: true });
    if (job.test_fault) {
      const r = await py(job, "modernization", "modernize", attempt, "goose_engine.faults", ["--package", pkg, "--fault", job.test_fault],
        engineSandbox(job, [], [build]));
      const ev = r.events.find((e) => e.event === "fault.injected");
      await logEvent(job.id, "founder", "intervention", `TEST FAULT injected (founder): ${ev?.title ?? job.test_fault}. ` +
        "Labelled in the code; verification and repair are not told about it.", ev, { important: true, origin: "fixture",
        originDetail: { fixture: "test fault", fault: job.test_fault } });
    }
  } else {
    if (!fs.existsSync(pkg)) throw new Error(`repair output missing for attempt ${attempt}`);
    await logEvent(job.id, "modernization", "decision", `Attempt ${attempt}: using the repaired code from the repair step.`);
  }
  await artifact(job, "upgraded_code", `Upgraded application (attempt ${attempt})`, pkg, { by: "modernization", attempt });
  return { next: "migrate" };
}

export async function migrate(job: Job, attempt: number): Promise<StageResult> {
  const rt = mkdir(J(job, "runtime", `attempt-${attempt}`));
  const pkg = path.join(rt, "pkg");
  if (!fs.existsSync(path.join(pkg, "app"))) copyFresh(J(job, "build", `attempt-${attempt}`, "upgraded"), pkg);
  const log = path.join(rt, "migrate.log");
  const venv = path.join(rt, "venv");
  const ms = await makeVenv(venv, path.join(pkg, "requirements.txt"), path.join(rt, "install.log"));
  if (ms) await recordCompute(job.id, "modernization", "migrate", attempt, ms, "install dependencies");
  const name = dbName(job.id, `a${attempt}_rehearsal`);
  const dsn = await createDb(name, { keep: true, passwordFile: path.join(rt, ".dbpass") });
  const src = path.join(rt, "source-copy.sqlite");
  if (!fs.existsSync(src)) { fs.copyFileSync(J(job, "snapshot", "database.sqlite"), src); fs.chmodSync(src, 0o644); }
  const env: Record<string, string> = { DATABASE_URL: dsn, BUSINESS_TIMEZONE: job.timezone };
  if (process.env.GOOSE_TEST_THROTTLE_MS) env.GOOSE_TEST_THROTTLE_MS = process.env.GOOSE_TEST_THROTTLE_MS;
  await pkgPython(job, "modernization", "migrate", attempt, pkg, venv, ["migrate/apply_schema.py"], env, log);
  const res = await pkgPython(job, "modernization", "migrate", attempt, pkg, venv, ["migrate/migrate_data.py", "--sqlite", src, "--batch-size", "100"], env, log);
  const done = res.events.find((e) => e.event === "migration.complete");
  if (!done) throw new Error("data move did not report completion");
  const t = Object.entries(done.tables as Record<string, any>);
  const resumed = t.reduce((n, [, v]) => n + (v.batches_already_done ? 1 : 0), 0);
  await logEvent(job.id, "modernization", "decision",
    `Data move rehearsed into PostgreSQL: ${t.map(([k, v]) => `${k} ${v.target_rows}`).join(", ")}` +
    (resumed ? ` (resumed: ${resumed} table(s) had batches already saved, none copied twice)` : "") + ".", done, { important: true });
  await artifact(job, "migration_log", `Data move log (attempt ${attempt})`, log, { by: "modernization", attempt });
  return { next: "verify" };
}

export async function verify(job: Job, attempt: number): Promise<StageResult> {
  const vdir = mkdir(J(job, "verify", `attempt-${attempt}`));
  const vault = J(job, "vault");
  const vsb = (write: string[] = [vdir]) => engineSandbox(job, [vault, J(job, "work"), J(job, "build"), vdir], write, { vault: true });
  const integ = await verifier(job, "verify", attempt, ["integrity", "--vault", vault, "--manifest-sha", job.checks_manifest_sha ?? ""],
    vsb(), { allowFail: true });
  const ie = integ.events.find((e) => e.event === "integrity");
  if (!ie?.ok) {
    await logEvent(job.id, "verification", "decision", `Integrity check FAILED - the frozen checks do not match their manifest: ${JSON.stringify(ie?.problems)}. Delivery blocked.`,
      ie, { important: true });
    return { next: "verify", status: "waiting_founder", waiting: "Frozen checks failed their integrity check" };
  }
  // the app under test lives in its own folder; its sandbox cannot read the results next to it
  const appDir = mkdir(path.join(vdir, "app"));
  const pkg = path.join(appDir, "pkg");
  copyFresh(J(job, "build", `attempt-${attempt}`, "upgraded"), pkg);
  const venv = path.join(appDir, "venv");
  const installLog = path.join(appDir, "install.log");
  fs.rmSync(venv, { recursive: true, force: true });
  fs.rmSync(installLog, { force: true });
  const ms = await makeVenv(venv, path.join(pkg, "requirements-dev.txt"), installLog);
  await recordCompute(job.id, "verification", "verify", attempt, ms, "clean install from the delivered requirements");
  const dsn = await createDb(dbName(job.id, `a${attempt}_verify`));
  const copyB = path.join(appDir, "copy-B.sqlite");
  fs.copyFileSync(J(job, "snapshot", "database.sqlite"), copyB);
  fs.chmodSync(copyB, 0o644);
  const env = { DATABASE_URL: dsn, BUSINESS_TIMEZONE: job.timezone };
  const log = path.join(appDir, "migrate.log");
  await pkgPython(job, "verification", "verify", attempt, pkg, venv, ["migrate/apply_schema.py"], env, log);
  await pkgPython(job, "verification", "verify", attempt, pkg, venv, ["migrate/migrate_data.py", "--sqlite", copyB], env, log);
  const results: string[] = [];
  const out = (n: string) => { const p = path.join(vdir, `${n}.json`); results.push(p); return p; };
  await verifier(job, "verify", attempt, ["data", "--vault", vault, "--dsn", dsn, "--out", out("data"), "--digests", path.join(vdir, "digests.json")], vsb());
  const rerun = await pkgPython(job, "verification", "verify", attempt, pkg, venv, ["migrate/migrate_data.py", "--sqlite", copyB], env,
    path.join(appDir, "migrate-rerun.log"), { allowFail: true });
  fs.writeFileSync(path.join(vdir, "rerun.jsonl"), rerun.stdout);
  await verifier(job, "verify", attempt, ["retry", "--vault", vault, "--dsn", dsn, "--digests", path.join(vdir, "digests.json"),
    "--rerun-log", path.join(vdir, "rerun.jsonl"), "--out", out("retry")], vsb());
  let port = await freePort();
  let server = await serverFor(job, "verification", "verify", attempt, "upgraded app under test (sandboxed)", { cmd: path.join(venv, "bin", "python"), args: ["-E", "-s", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
    cwd: pkg, env: cleanEnv(env, pkg), sandbox: customerSandbox(job, appDir), port, healthPath: "/healthz", logFile: path.join(appDir, "upgraded-app.log") });
  try {
    await verifier(job, "verify", attempt, ["behavior", "--vault", vault, "--url", server.url, "--dsn", dsn, "--out", out("behavior"),
      "--recording", path.join(vdir, "upgraded-recording.json")], vsb());
  } finally {
    await server.stop();
    await recordCompute(job.id, "verification", "verify", attempt, Date.now() - server.startedMs, "upgraded app under test (sandboxed)");
  }
  const freshDsn = await createDb(dbName(job.id, `a${attempt}_fresh`));
  const fenv = { DATABASE_URL: freshDsn, BUSINESS_TIMEZONE: job.timezone };
  await pkgPython(job, "verification", "verify", attempt, pkg, venv, ["migrate/apply_schema.py"], fenv, path.join(appDir, "fresh.log"));
  await pkgPython(job, "verification", "verify", attempt, pkg, venv, ["-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml",
    path.join(appDir, "unit-tests.xml"), "tests"], { ...fenv }, path.join(appDir, "unit-tests.log"), { allowFail: true });
  port = await freePort();
  server = await serverFor(job, "verification", "verify", attempt, "upgraded app on an empty database (sandboxed)", { cmd: path.join(venv, "bin", "python"), args: ["-E", "-s", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
    cwd: pkg, env: cleanEnv(fenv, pkg), sandbox: customerSandbox(job, appDir), port, healthPath: "/healthz", logFile: path.join(appDir, "fresh-app.log") });
  try {
    await verifier(job, "verify", attempt, ["fresh", "--vault", vault, "--package", pkg, "--url", server.url, "--install-log", installLog,
      "--junit", path.join(appDir, "unit-tests.xml"), "--dsn", freshDsn, "--out", out("fresh")], vsb());
  } finally {
    await server.stop();
    await recordCompute(job.id, "verification", "verify", attempt, Date.now() - server.startedMs, "upgraded app on an empty database (sandboxed)");
  }
  await dropDb(dbName(job.id, `a${attempt}_fresh`));
  const rep = path.join(vdir, "report");
  await verifier(job, "verify", attempt, ["report", "--vault", vault, "--attempt", String(attempt), "--manifest-sha", job.checks_manifest_sha ?? "",
    "--inputs", ...results, "--out", rep], vsb());
  const report = readJson(rep + ".json");
  await q(`INSERT INTO check_runs (job_id, attempt, integrity_ok, total, passed, failed, skipped, verdict, by_category, failed_checks, report_path)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (job_id, attempt) DO UPDATE SET integrity_ok = EXCLUDED.integrity_ok, total = EXCLUDED.total, passed = EXCLUDED.passed,
             failed = EXCLUDED.failed, skipped = EXCLUDED.skipped, verdict = EXCLUDED.verdict, by_category = EXCLUDED.by_category,
             failed_checks = EXCLUDED.failed_checks, report_path = EXCLUDED.report_path, created_at = now()`,
    [job.id, attempt, report.integrity.ok, report.summary.total, report.summary.passed, report.summary.failed, report.summary.skipped,
     report.summary.verdict, JSON.stringify(report.by_category), JSON.stringify(report.failed.slice(0, 60)), rep + ".json"]);
  await artifact(job, "verification_report", `Verification report (attempt ${attempt})`, rep + ".md", { by: "verification", attempt, visible: true });
  await artifact(job, "verification_data", `Verification results JSON (attempt ${attempt})`, rep + ".json", { by: "verification", attempt, visible: true });
  if (report.summary.verdict === "pass") {
    await logEvent(job.id, "verification", "check", `Verification attempt ${attempt} PASSED: ${report.summary.passed} of ${report.summary.total} checks.`,
      report.summary, { important: true });
    const prior = await one<{ id: number }>("SELECT id FROM repairs WHERE job_id = $1 AND attempt = $2", [job.id, attempt - 1]);
    if (prior) await q("UPDATE repairs SET outcome = 'fixed' WHERE id = $1", [prior.id]);
    return { next: "package" };
  }
  await logEvent(job.id, "verification", "check",
    `Verification attempt ${attempt} FAILED: ${report.summary.failed} of ${report.summary.total} checks failed. Delivery is blocked.`,
    { summary: report.summary, failed: report.failed.slice(0, 10).map((f: any) => f.id) }, { important: true });
  const prior = await one<{ id: number }>("SELECT id FROM repairs WHERE job_id = $1 AND attempt = $2", [job.id, attempt - 1]);
  if (prior) await q("UPDATE repairs SET outcome = 'not_fixed' WHERE id = $1", [prior.id]);
  const decision = await agents.afterFailedVerification(await ctxFor(job, attempt), report, job.repairs_used, job.repair_budget);
  await logEvent(job.id, "coordinator", "decision", decision.reason, { ...decision }, { important: true });
  if (decision.action === "repair") return { next: "repair" };
  return { next: "verify", status: "waiting_founder", waiting: decision.reason };
}

export async function repair(job: Job, attempt: number): Promise<StageResult> {
  const next = attempt + 1;
  const from = J(job, "build", `attempt-${attempt}`, "upgraded");
  const build = mkdir(J(job, "build", `attempt-${next}`));
  const pkg = path.join(build, "upgraded");
  copyFresh(from, pkg);
  const out = path.join(build, "repair.json");
  await py(job, "modernization", "repair", attempt, "goose_engine.repair",
    ["--package", pkg, "--report", J(job, "verify", `attempt-${attempt}`, "report.json"), "--assessment", J(job, "work", "assessment.json"),
     "--scope", J(job, "work", "scope.json"), "--out", out],
    engineSandbox(job, [J(job, "verify", `attempt-${attempt}`), J(job, "work")], [build]));
  const r = readJson(out);
  await q(`INSERT INTO repairs (job_id, attempt, diagnoses, actions, diff, unresolved, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (job_id, attempt) DO UPDATE SET diagnoses = EXCLUDED.diagnoses, actions = EXCLUDED.actions, diff = EXCLUDED.diff,
             unresolved = EXCLUDED.unresolved, outcome = EXCLUDED.outcome`,
    [job.id, attempt, JSON.stringify(r.diagnoses), JSON.stringify(r.actions), r.diff, JSON.stringify(r.unresolved),
     r.needs_founder ? "escalated" : "pending"]);
  await artifact(job, "repair", `Repair after attempt ${attempt}`, out, { by: "modernization", attempt });
  if (r.needs_founder) {
    await logEvent(job.id, "modernization", "decision", "No repair in the playbook explains these failures. Escalating to the founder.",
      r, { important: true });
    return { next: "repair", status: "waiting_founder", waiting: "Failed checks need the founder: no known repair applies" };
  }
  await logEvent(job.id, "modernization", "decision",
    `Repair ${job.repairs_used + 1}: ${r.diagnoses.map((d: any) => d.explanation).join(" ")} Changed: ${r.actions.map((x: any) => `${x.file} (${x.action})`).join("; ")}.`,
    { diagnoses: r.diagnoses, actions: r.actions }, { important: true });
  return { next: "modernize", patch: { attempt: next, repairs_used: job.repairs_used + 1 } };
}

export async function packageStage(job: Job, attempt: number): Promise<StageResult> {
  const del = mkdir(J(job, "delivery"));
  const att = job.attempt;
  const staging = path.join(del, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  copyFresh(J(job, "build", `attempt-${att}`, "upgraded"), path.join(staging, "upgraded-app"));
  for (const d of ["__pycache__", ".pytest_cache"]) fs.rmSync(path.join(staging, "upgraded-app", d), { recursive: true, force: true });
  mkdir(path.join(staging, "evidence"));
  fs.copyFileSync(J(job, "verify", `attempt-${att}`, "report.md"), path.join(staging, "evidence", "verification-report.md"));
  fs.copyFileSync(J(job, "verify", `attempt-${att}`, "report.json"), path.join(staging, "evidence", "verification-report.json"));
  fs.copyFileSync(J(job, "verify", `attempt-${att}`, "app", "migrate.log"), path.join(staging, "evidence", "data-move-log.jsonl"));
  fs.copyFileSync(J(job, "vault", "MANIFEST.json"), path.join(staging, "evidence", "frozen-checks-manifest.json"));
  if (fs.existsSync(J(job, "verify", `attempt-${att}`, "app", "unit-tests.xml"))) {
    fs.copyFileSync(J(job, "verify", `attempt-${att}`, "app", "unit-tests.xml"), path.join(staging, "evidence", "unit-tests.xml"));
  }
  const repairs = await q<{ attempt: number; diff: string; diagnoses: any }>("SELECT attempt, diff, diagnoses FROM repairs WHERE job_id = $1 ORDER BY attempt", [job.id]);
  for (const r of repairs) fs.writeFileSync(path.join(staging, "evidence", `repair-after-attempt-${r.attempt}.diff`), r.diff);
  fs.writeFileSync(path.join(staging, "README-FIRST.md"), `# ${job.title} - delivery package (${job.id})

${job.kind === "demo" ? "**DEMONSTRATION JOB - synthetic data.**\n\n" : ""}This package contains:

- \`upgraded-app/\` - the FastAPI + PostgreSQL application, with \`README.md\`, \`CHANGES.md\`, \`RUNBOOK.md\` and \`ROLLBACK.md\`.
- \`upgraded-app/migrations/\` and \`upgraded-app/migrate/\` - the schema and the re-runnable data move.
- \`evidence/verification-report.md\` - every check that ran, what passed, and what was not tested.
- \`evidence/frozen-checks-manifest.json\` - hashes of the checks as they were frozen before any code changed.
- \`evidence/repair-*.diff\` - code changes made after a failed check, if any.

Verification attempt ${att} passed. Passing these checks does not prove every possible behaviour is correct; the report lists what was tested.
`);
  const zip = path.join(del, `${job.id}-delivery.zip`);
  fs.rmSync(zip, { force: true });
  const z = await run({ cmd: "/usr/bin/zip", args: ["-r", "-q", zip, "."], cwd: staging, env: cleanEnv() });
  if (z.code !== 0) throw new Error(`zip failed: ${z.stderr}`);
  await artifact(job, "delivery_package", "Delivery package (.zip)", zip, { by: "coordinator", visible: true });
  await logEvent(job.id, "coordinator", "decision", `Delivery package ready (SHA-256 ${sha256(zip).slice(0, 16)}...). ` +
    "Sent to the customer for acceptance.", { zip: path.basename(zip) }, { important: true });
  await q("INSERT INTO messages (job_id, sender, body, handled_by) VALUES ($1,'commercial',$2,'local worker')", [job.id,
    "Your upgraded application is ready. Download the package, read the verification report, and accept the delivery when you are satisfied. " +
    "You are invoiced only after you accept."]);
  return { next: "delivered", status: "waiting_customer", waiting: "Delivered; waiting for the customer to accept" };
}

export async function invoice(job: Job): Promise<StageResult> {
  const existing = await one<{ id: number }>("SELECT id FROM invoices WHERE job_id = $1", [job.id]);
  if (!existing) {
    const n = (await one<{ n: number }>("SELECT COUNT(*)::int + 1 AS n FROM invoices"))!.n;
    const number = `${job.kind === "demo" ? "TEST-" : ""}GS-INV-${String(n).padStart(4, "0")}`;
    const price = job.price_cents ?? 0;
    await q(`INSERT INTO invoices (job_id, number, status, is_test, amount_cents, line_items, notes, issued_at, due_at)
             VALUES ($1,$2,'issued',$3,$4,$5,$6, now(), now() + interval '14 days')`,
      [job.id, number, job.kind === "demo", price, JSON.stringify(agents.invoiceLines(job, price)),
       job.kind === "demo" ? "TEST INVOICE for a demonstration job. Not sent. No money is owed or collected." : "Prepared; not sent automatically."]);
    await logEvent(job.id, "coordinator", "decision", `Invoice ${number} prepared for $${(price / 100).toLocaleString("en-US")}` +
      (job.kind === "demo" ? " (TEST - demonstration job, not sent)." : " (ready for the founder to send)."), undefined, { important: true });
  }
  return { next: "follow_up" };
}

export async function followUp(job: Job): Promise<StageResult> {
  const acc = await one<{ contact_name: string | null }>("SELECT contact_name FROM accounts WHERE id = $1", [job.account_id]);
  for (const f of agents.followupDrafts(job, acc?.contact_name ?? "")) {
    await q(`INSERT INTO followups (job_id, kind, due_at, status, draft) VALUES ($1,$2, now() + ($3 || ' days')::interval, 'drafted', $4)
             ON CONFLICT (job_id, kind) DO NOTHING`, [job.id, f.kind, String(f.days), f.draft]);
  }
  await logEvent(job.id, "coordinator", "decision", "Follow-ups scheduled: day-3 check-in and day-25 rollback-window reminder (drafts, not sent).");
  return { next: "closed", status: "done", waiting: null };
}

export const IMPL: Record<string, (job: Job, attempt: number) => Promise<StageResult>> = {
  intake, assess, propose, baseline, freeze, modernize, migrate, verify, repair,
  package: packageStage, invoice, follow_up: followUp,
};

export { STAGES };
