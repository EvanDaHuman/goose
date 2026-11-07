// Plan-driven delivery (jobs with pipeline = 2). The customer's goal and the inspection decide the plan; the accepted plan
// decides which execution tools run. Steps that the first version already proved (the Flask-to-FastAPI conversion) are
// reused unchanged; behaviour-preserving upgrades are verified by replaying the same requests on separate copies.
import fs from "node:fs";
import path from "node:path";
import * as agents from "./agents";
import { config } from "./config";
import { one, q } from "./db";
import type { Job, StageResult } from "./jobs";
import { pilotOffer } from "./jobs";
import { naiveClient } from "./naive/client";
import { deleteJobFiles } from "./naive/files";
import { cleanEnv, freePort, run } from "./proc";
import { quoteFor } from "./quote";
import { jobSpend, logEvent, recordCompute, type Origin } from "./records";
import * as crm from "./crm";
import * as replatform from "./replatform";
import { isWorkspace, WORKSPACE_STAGES } from "./workspace";
import { syncCommerceForJob } from "./commerce";
import { contractProblems, repairEvidence } from "./migrationContract";
import * as v1 from "./stages";

const { J, readJson, mkdir, sha256, py, verifier, artifact, engineSandbox, customerSandbox, makeVenv, serverFor, copyFresh,
  makeReadOnly, makeWritable, ctxFor, originalPython } = v1;
const LATEST = path.join(config.engineDir, "data", "pypi_latest.json");
const KIND: Record<string, "flask" | "django" | null> = { "flask-inplace-upgrade": "flask", "django-lts-upgrade": "django", "agent-change": null };
const tool = (name: string) => ({ origin: "tool" as const, originDetail: { tool: name } });

export async function currentPlan(job: Job) {
  return await one<{ version: number; plan: any; author: string; author_kind: string; naive_session_id: string | null }>(
    "SELECT version, plan, author, author_kind, naive_session_id FROM plans WHERE job_id = $1 ORDER BY version DESC LIMIT 1", [job.id]);
}

const inspection = (job: Job) => readJson(J(job, "work", "inspection.json"));
const hasDb = (job: Job) => fs.existsSync(J(job, "snapshot", "database.sqlite"));
const recipeKind = (job: Job, insp: any) => KIND[job.recipe ?? ""] ?? (insp.stack.framework === "Django" ? "django" : "flask");

// ======================================================================== intake, inspection, plan

async function intake(job: Job, round: number): Promise<StageResult> {
  const r = await v1.intake(job, round);
  if (r.next !== "assess") return r;
  const docs = await q<{ filename: string; stored_path: string }>("SELECT filename, stored_path FROM job_inputs WHERE job_id = $1 AND kind = 'document'", [job.id]);
  for (const d of docs) await artifact(job, "document", `Customer document: ${d.filename}`, d.stored_path, { by: "coordinator", frozen: true, origin: "human" });
  if (job.kind === "demo") {
    await logEvent(job.id, "system", "status", "The inputs are a demonstration fixture: a made-up business with synthetic data.", undefined,
      { origin: "fixture", originDetail: { fixture: "demo inputs" } });
  }
  return { next: "inspect" };
}

async function inspect(job: Job, round: number): Promise<StageResult> {
  const out = path.join(J(job, "work"), "inspection.json");
  const db = hasDb(job) ? ["--db", J(job, "snapshot", "database.sqlite")] : [];
  await py(job, "assessment", "inspect", round, "goose_engine.inspect_app",
    ["--repo", J(job, "source"), ...db, "--timezone", job.timezone, "--latest", LATEST, "--out", out],
    engineSandbox(job, [J(job, "source"), J(job, "snapshot")], [J(job, "work")]));
  const insp = readJson(out);
  if (insp.stack.framework === "Flask") {   // the Flask tools also need the analyzer's full assessment
    // with no database copy, the analyzer still needs the table structure: read it from an empty database built from schema.sql
    const schemaDb = db.length ? db : fs.existsSync(path.join(J(job, "source"), "schema.sql"))
      ? ["--db", await fixtureDb(job, "flask", await originalPython(job, insp.stack.python))] : [];
    await py(job, "assessment", "inspect", round, "goose_engine.analyze",
      ["--repo", J(job, "source"), ...schemaDb, "--timezone", job.timezone, "--latest", LATEST, "--out", path.join(J(job, "work"), "assessment.json")],
      engineSandbox(job, [J(job, "source"), J(job, "snapshot"), J(job, "fixture")], [J(job, "work")]));
  }
  await artifact(job, "inspection", "Application map and findings", out, { by: "assessment", attempt: round, visible: true, ...tool("inspect_app") });
  await q("UPDATE jobs SET source_stack = $2 WHERE id = $1", [job.id, JSON.stringify(insp.stack)]);
  const n = (k: string) => insp.components.filter((c: any) => c.kind === k).length;
  const st = insp.stack;
  await logEvent(job.id, "assessment", "decision", st.framework
    ? `Inspected the application: ${st.framework} ${st.framework_version ?? ""} on Python ${st.python ?? "?"}, ${n("route")} entry points, ` +
      `${n("table")} tables, ${n("client") + n("script")} outside connections, ${insp.findings.length} findings, each tied to a file or to the data.`
    : `Inspected the files: ${Object.entries(st.languages).map(([k, v]: any) => `${k} ${v.files} files`).join(", ") || "no source files"}.`,
    { size: insp.size, stack: st }, { important: true, ...tool("inspect_app") });
  return { next: "plan" };
}

async function plan(job: Job, round: number): Promise<StageResult> {
  const work = J(job, "work");
  const answers: Record<string, unknown> = {};
  for (const r of await q<{ key: string; answer: any }>("SELECT key, answer FROM questions WHERE job_id = $1 AND status = 'answered'", [job.id])) {
    answers[r.key] = r.answer;
  }
  fs.writeFileSync(path.join(work, "goal.txt"), job.goal ?? "");
  fs.writeFileSync(path.join(work, "constraints.json"), JSON.stringify(job.constraints ?? []));
  fs.writeFileSync(path.join(work, "answers.json"), JSON.stringify(answers, null, 2));
  const toolOut = path.join(work, `plan-tool-r${round}.json`);
  const migration = replatform.requestedTarget(job) ? await replatform.assess(job, round, inspection(job)) : null;
  if (!migration) await py(job, "assessment", "plan", round, "goose_engine.plan",
    ["--inspection", path.join(work, "inspection.json"), "--goal-file", path.join(work, "goal.txt"), "--constraints", path.join(work, "constraints.json"),
     "--answers", path.join(work, "answers.json"), "--mode", config.mode, "--out", toolOut], engineSandbox(job, [work], [work]));
  const toolPlan = migration?.plan ?? readJson(toolOut);
  const prev = await currentPlan(job);
  const changedBecause = !prev ? null : Object.keys(answers).some((k) => !(prev.plan.answers_seen ?? []).includes(k))
    ? `The customer answered: ${Object.keys(answers).filter((k) => !(prev.plan.answers_seen ?? []).includes(k)).join(", ")}.`
    : round > (prev.plan.round ?? 1) ? "New files or information arrived." : "Planned again.";
  let final: any = toolPlan;
  let author = migration?.author ?? { kind: "tool", name: "deterministic planner (keyword rules + recipe preconditions)", sessionId: null as string | null };
  if (config.mode === "naive" && !migration) {
    const ctx = await ctxFor(job, round, "plan");
    let problems: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await agents.planWithAgent({ ...ctx, attempt: round * 10 + attempt }, { repoZip: J(job, "inputs", "repository.zip"), goal: job.goal ?? "",
        constraints: job.constraints ?? [], notes: job.constraint_notes, inspection: readJson(path.join(work, "inspection.json")), toolPlan, answers,
        previous: prev ? { plan: prev.plan, changedBecause: changedBecause ?? "" } : null, guardProblems: problems });
      if (!r.ok) {
        return { next: "plan", status: "waiting_founder", waiting: `The assessment agent could not plan the work (${r.reason}): ${r.message}` };
      }
      const merged = mergeAgentPlan(toolPlan, r.output);
      const check = path.join(work, `plan-agent-r${round}-${attempt}.json`);
      fs.writeFileSync(check, JSON.stringify(merged, null, 2));
      const vout = path.join(work, `plan-agent-r${round}-${attempt}.guard.json`);
      await py(job, "assessment", "plan", round, "goose_engine.plan", ["--inspection", path.join(work, "inspection.json"), "--validate", check,
        "--mode", config.mode, "--out", vout], engineSandbox(job, [work], [work]));
      problems = readJson(vout).guard_problems;
      await logEvent(job.id, "assessment", "decision", problems.length
        ? `The guard rejected the assessment agent's plan: ${problems.join("; ")}`
        : `The assessment agent read the repository and proposed: ${merged.title ?? merged.decision}.`,
        { problems, session_id: r.sessionId }, { important: true, origin: "agent", originDetail: { session_id: r.sessionId, model: r.model } });
      if (!problems.length) {
        final = { ...merged, guard_problems: [] };
        author = { kind: "agent", name: `assessment agent (Naive session ${r.sessionId}, model ${r.model ?? config.naive.model})`, sessionId: r.sessionId };
        break;
      }
    }
    if (author.kind !== "agent") {
      await savePlan(job, round, toolPlan, { kind: "tool", name: "deterministic planner (fallback for the founder to review)", sessionId: null }, changedBecause, answers, problems);
      return { next: "plan", status: "waiting_founder", waiting: `The assessment agent's plan failed the guard twice: ${problems.join("; ").slice(0, 300)}` };
    }
  }
  const version = await savePlan(job, round, final, author, changedBecause, answers, final.guard_problems ?? []);
  const origin: Origin = author.kind === "agent" ? "agent" : "tool";
  const detail = author.kind === "agent" ? { session_id: author.sessionId } : { tool: "plan" };
  await logEvent(job.id, "assessment", "decision", planSentence(final, version, changedBecause), { version, decision: final.decision, recommended: final.recommended },
    { important: true, origin, originDetail: detail });
  if (final.decision === "unsupported") {
    await q("INSERT INTO messages (job_id, sender, body, handled_by) VALUES ($1,'coordinator',$2,$3)", [job.id,
      `Thank you for sending your application. We can't take this job on yet: ${(final.reasons ?? []).join(" ")} We only accept work we can finish and prove.`,
      author.name]);
    return { next: "rejected", status: "rejected", waiting: null };
  }
  const blocking = (final.questions ?? []).filter((x: any) => x.blocking && !(x.id in answers));
  if (final.decision === "needs_information" || blocking.length) {
    for (const x of blocking) {
      const fields = x.fields ?? [{ type: "choice", key: "decision", label: "Decision", options: x.options ?? [] }];
      await q(`INSERT INTO questions (job_id, key, asked_by, audience, prompt, fields, options_help, recommended, blocking)
               VALUES ($1,$2,'assessment','customer',$3,$4,$5,$6,true) ON CONFLICT (job_id, key) DO NOTHING`,
        [job.id, x.id, x.prompt, JSON.stringify(fields), x.options_help ? JSON.stringify(x.options_help) : null, x.recommended ?? null]);
    }
    if (!blocking.length && (final.blocked_by ?? []).includes("needs a copy of your database")) {
      await q(`INSERT INTO questions (job_id, key, asked_by, audience, prompt, fields, blocking) VALUES ($1,'Q-db','assessment','customer',$2,$3,true)
               ON CONFLICT (job_id, key) DO NOTHING`, [job.id, `This plan moves your data, so we need a copy of the database. Please upload it.`,
        JSON.stringify([{ type: "upload", key: "database" }])]);
    }
    return { next: "awaiting_info", status: "waiting_customer", waiting: "Waiting for the customer to answer a question" };
  }
  if (final.decision === "needs_live_agents") {
    return { next: "plan", status: "waiting_founder",
      waiting: "This plan needs the live agent team on Naive (code changes no deterministic tool can make), and this run is in local mode." };
  }
  if (final.decision !== "supported") {
    return { next: "plan", status: "waiting_founder", waiting: `The recommended work cannot run yet: ${(final.blocked_by ?? []).join("; ")}` };
  }
  return { next: "propose", patch: { recipe: final.recommended, work_type: final.work_type } };
}

function mergeAgentPlan(toolPlan: any, a: any) {
  const opt = toolPlan.options.find((o: any) => o.recipe === a.recommended);
  return {
    ...toolPlan, ...a,
    recommended: a.recommended || null, title: opt?.title ?? toolPlan.title, work_type: opt?.work_type ?? null,
    requires_database: opt?.needs_database ?? false, blocked_by: opt?.blocked_by ?? [],
    database_use: opt?.changes_database ? "moves to PostgreSQL" : toolPlan.database_use,
    options: toolPlan.options, tool_plan_recommended: toolPlan.recommended,
  };
}

async function savePlan(job: Job, round: number, p: any, author: { kind: string; name: string; sessionId: string | null },
  changedBecause: string | null, answers: Record<string, unknown>, problems: string[]) {
  const v = ((await one<{ v: number }>("SELECT COALESCE(MAX(version),0)::int AS v FROM plans WHERE job_id = $1", [job.id]))?.v ?? 0) + 1;
  const stored = { ...p, round, answers_seen: Object.keys(answers), author: { kind: author.kind, name: author.name } };
  fs.writeFileSync(J(job, "work", "plan.json"), JSON.stringify(stored, null, 2));
  await q(`INSERT INTO plans (job_id, version, author_kind, author, naive_session_id, plan, guard_problems, changed_because)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [job.id, v, author.kind, author.name, author.sessionId, JSON.stringify(stored),
    JSON.stringify(problems), changedBecause]);
  await artifact(job, "plan", `Plan v${v}`, J(job, "work", "plan.json"), { by: "assessment", attempt: v, visible: true,
    origin: author.kind === "agent" ? "agent" : "tool", originDetail: author.sessionId ? { session_id: author.sessionId } : { tool: "plan" } });
  return v;
}

function planSentence(p: any, version: number, changedBecause: string | null) {
  const lead = `Plan v${version}${changedBecause ? ` (${changedBecause})` : ""}: `;
  if (p.decision === "unsupported") return lead + `not something we can do yet. ${(p.reasons ?? []).join(" ")}`;
  const keep = (p.preserve ?? []).length;
  return lead + `${p.title}. ${p.changes?.length ?? 0} changes, ${keep} things kept as they are, ${(p.intended_differences ?? []).length} ` +
    `intended differences, ${(p.questions ?? []).filter((x: any) => x.blocking).length} questions. Database: ${p.database_use}.`;
}

// ======================================================================== proposal

async function propose(job: Job, round: number): Promise<StageResult> {
  const cur = (await currentPlan(job))!;
  const p = cur.plan;
  const insp = inspection(job);
  const offer = await pilotOffer();
  const quote = quoteFor(p, insp, offer);
  let detail: any = null;
  if (insp.stack.framework === "Flask") {    // the Flask tools read the scope file (roles, data decisions, intended differences)
    const draft = path.join(J(job, "work"), `scope-draft-${round}.json`);
    await py(job, "coordinator", "propose", round, "goose_engine.scope", ["--assessment", path.join(J(job, "work"), "assessment.json"),
      "--answers", path.join(J(job, "work"), "answers.json"), "--slug", job.app_slug, "--title", job.title, "--out", draft],
      engineSandbox(job, [J(job, "work")], [J(job, "work")]));
    detail = readJson(draft);
    if (job.recipe !== "flask-fastapi-postgres") detail = { ...detail, intentional_differences: p.intended_differences ?? [], changes: p.changes };
    const scopeFile = path.join(J(job, "work"), "scope.json");
    if (fs.existsSync(scopeFile)) fs.chmodSync(scopeFile, 0o644);
    fs.writeFileSync(scopeFile, JSON.stringify(detail, null, 2));
  }
  const wording = await agents.proposalWording(await ctxFor(job, round, "propose"), p, quote);
  const version = ((await one<{ v: number }>("SELECT COALESCE(MAX(version),0)::int AS v FROM proposals WHERE job_id = $1", [job.id]))?.v ?? 0) + 1;
  const scope = { plan_version: cur.version, plan: p, quote, detail };
  const scopeFile = path.join(J(job, "work"), `proposal-v${version}.json`);
  fs.writeFileSync(scopeFile, JSON.stringify(scope, null, 2));
  await q("UPDATE proposals SET status = 'superseded' WHERE job_id = $1 AND status = 'sent'", [job.id]);
  await q(`INSERT INTO proposals (job_id, version, scope, summary, price_cents, cost_limit_micro_usd, delivery_days, status, scope_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'sent',$8) ON CONFLICT (job_id, version) DO NOTHING`,
    [job.id, version, JSON.stringify(scope), JSON.stringify({ ...wording, findings: insp.findings, size: insp.size }),
     Math.round(quote.totalUsd * 100), job.cost_limit_micro_usd, quote.days, sha256(scopeFile)]);
  await q("UPDATE jobs SET price_cents = $2 WHERE id = $1", [job.id, Math.round(quote.totalUsd * 100)]);
  const checks = detail && job.recipe === "flask-fastapi-postgres" ? detail.acceptance_checklist.length : (p.acceptance_checks ?? []).length;
  await logEvent(job.id, "coordinator", "decision", `Proposal v${version} sent: ${p.title}, fixed price $${quote.totalUsd.toLocaleString("en-US")} ` +
    `(${quote.lines.map((l) => l.label.split(" (")[0]).join(" + ")}), ${checks} acceptance items.`, { version, quote, wording_by: wording.by },
    { important: true, origin: wording.origin, originDetail: "sessionId" in wording ? { session_id: (wording as any).sessionId } : { tool: "quote" } });
  return { next: "awaiting_acceptance", status: "waiting_customer", waiting: "Proposal sent; waiting for the customer to accept" };
}

// ======================================================================== behaviour-preserving recipes: runtimes and recording

function dbEnv(insp: any, kind: "flask" | "django", dbPath: string, assessment: any | null) {
  const env: Record<string, string> = {};
  const vars = insp.components.filter((c: any) => c.kind === "setting" &&
    insp.edges.some((e: any) => e.from === c.id && e.to === "db:main")).map((c: any) => c.name);
  for (const v of [...vars, ...(assessment?.app?.database_location?.env_vars ?? [])]) env[v] = dbPath;
  for (const c of insp.components.filter((x: any) => x.kind === "setting" && /DEBUG/.test(x.name))) env[c.name] = "0";
  if (kind === "django") env.DJANGO_SETTINGS_MODULE = env.DJANGO_SETTINGS_MODULE ?? "";
  if (!env.DJANGO_SETTINGS_MODULE) delete env.DJANGO_SETTINGS_MODULE;
  return env;
}

function runtimeFor(job: Job, label: string, codeDir: string, dbSource: string | null, kind: "flask" | "django") {
  const insp = inspection(job);
  const a = kind === "flask" && fs.existsSync(J(job, "work", "assessment.json")) ? readJson(J(job, "work", "assessment.json")) : null;
  const dir = J(job, "runtime", label);
  const app = path.join(dir, "app");
  copyFresh(codeDir, app);
  fs.copyFileSync(path.join(config.engineDir, "goose_engine", "launch_flask.py"), path.join(dir, "launch_flask.py"));
  const loc = a?.app?.database_location ?? {};
  const dbPath = loc.default_path && !path.isAbsolute(loc.default_path) ? path.join(app, loc.default_path) : path.join(dir, "data.sqlite");
  if (dbSource) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(dbSource, dbPath);
    fs.chmodSync(dbPath, 0o644);
  }
  const env = { TZ: job.timezone, APP_ROOT: app, ...dbEnv(insp, kind, dbPath, a) };
  return { dir, app, dbPath, env, entry: a ? path.join(app, a.app.entry_module) : null };
}

/** The customer-code sandbox for one runtime, plus read access to the Python environment it runs on. */
function appSandbox(job: Job, rt: { dir: string }, python: string) {
  const sb = customerSandbox(job, rt.dir);
  const venv = path.dirname(path.dirname(python));
  if (!venv.startsWith(path.join(config.varDir, "venvs"))) sb.readAllow = [...sb.readAllow, venv];
  return sb;
}

async function startApp(job: Job, stage: string, attempt: number, note: string, python: string, rt: ReturnType<typeof runtimeFor>, kind: "flask" | "django", health = "/") {
  const port = await freePort();
  const args = kind === "django" ? ["-E", "-s", "manage.py", "runserver", `127.0.0.1:${port}`, "--noreload"]
    : ["-E", "-s", path.join(rt.dir, "launch_flask.py"), rt.entry!, String(port)];
  return serverFor(job, "verification", stage, attempt, note, { cmd: python, args, cwd: rt.app, env: cleanEnv(rt.env, rt.dir),
    sandbox: appSandbox(job, rt, python), port, healthPath: health, logFile: path.join(rt.dir, `${note.replace(/\W+/g, "-")}.log`) });
}

async function runIn(job: Job, stage: string, attempt: number, python: string, rt: ReturnType<typeof runtimeFor>, args: string[], note: string, timeoutMs = 300_000) {
  const res = await run({ cmd: python, args: ["-E", "-s", ...args], cwd: rt.app, env: cleanEnv(rt.env, rt.dir), sandbox: appSandbox(job, rt, python),
    timeoutMs, logFile: path.join(rt.dir, `${note.replace(/\W+/g, "-")}.log`), profileFile: path.join(rt.dir, `.sb-${note.replace(/\W+/g, "-")}.sb`) });
  await recordCompute(job.id, "verification", stage, attempt, res.ms, note);
  const tail = (res.stdout + "\n" + res.stderr).trim().split("\n").slice(-25).join("\n");
  return { exit: res.code, tail, summary: tail.split("\n").filter((l) => /passed|failed|error|OK|FAILED|Ran \d+/.test(l)).slice(-2).join(" ") };
}

async function addTestTools(python: string, log: string) {
  const r = await run({ cmd: config.python.uv, args: ["pip", "install", "--python", python, "-q", "pytest==8.4.2"], cwd: path.dirname(log),
    env: { PATH: "/usr/bin:/bin", HOME: config.home, LANG: "en_US.UTF-8" }, logFile: log, timeoutMs: 180_000 });
  return r.code === 0;
}

async function ownTests(job: Job, stage: string, attempt: number, python: string, rt: ReturnType<typeof runtimeFor>, kind: "flask" | "django", insp: any) {
  if (!insp.components.some((c: any) => c.kind === "test")) return null;
  if (kind === "django") return runIn(job, stage, attempt, python, rt, ["manage.py", "test", "-v", "1"], "own tests (manage.py test)");
  await addTestTools(python, path.join(rt.dir, "test-tools.log"));
  return runIn(job, stage, attempt, python, rt, ["-m", "pytest", "-q", "-p", "no:cacheprovider"], "own tests (pytest)");
}

async function outsideScripts(job: Job, stage: string, attempt: number, python: string, label: string, codeDir: string, dbSource: string | null,
  kind: "flask" | "django", migrate: boolean) {
  const insp = inspection(job);
  const out: Record<string, any> = {};
  for (const s of insp.components.filter((c: any) => c.kind === "script")) {
    if (!dbSource) continue;
    const rt = runtimeFor(job, `${label}-${path.basename(s.file, ".py")}`, codeDir, dbSource, kind);
    if (migrate) await runIn(job, stage, attempt, python, rt, ["manage.py", "migrate", "-v", "0"], "migrations before the script");
    const src = fs.readFileSync(path.join(rt.app, s.file), "utf8");
    for (const v of src.matchAll(/os\.environ\.get\(\s*["']([A-Z0-9_]+)["']/g)) rt.env[v[1] as keyof typeof rt.env] = rt.dbPath;
    const r = await runIn(job, stage, attempt, python, rt, [s.file], `outside script ${s.file}`);
    const dump = path.join(rt.dir, "after-script.json");
    await verifier(job, stage, attempt, ["dump", "--db", rt.dbPath, "--out", dump], engineSandbox(job, [rt.dir], [rt.dir], { vault: true }));
    out[s.file] = { exit: r.exit, tail: r.tail, dump: readJson(dump) };
  }
  return out;
}

async function fixtureDb(job: Job, kind: "flask" | "django", python: string) {
  const dest = J(job, "fixture", "database.sqlite");
  if (fs.existsSync(dest)) return dest;
  mkdir(path.dirname(dest));
  const rt = runtimeFor(job, "fixture", J(job, "source"), null, kind);
  if (kind === "django") {
    await runIn(job, "baseline", 1, python, rt, ["manage.py", "migrate", "-v", "0"], "test database from the app's migrations");
  } else if (fs.existsSync(path.join(rt.app, "schema.sql"))) {
    await runIn(job, "baseline", 1, python, rt, ["-c", `import sqlite3,sys; c=sqlite3.connect(${JSON.stringify(rt.dbPath)}); c.executescript(open('schema.sql').read()); c.commit()`],
      "test database from schema.sql");
  }
  if (!fs.existsSync(rt.dbPath)) throw new Error("no database copy, and no schema or migrations to build a test database from");
  fs.copyFileSync(rt.dbPath, dest);
  fs.chmodSync(dest, 0o444);
  await logEvent(job.id, "verification", "decision", "No database copy was supplied, which this plan does not need. The checks run on a test database built " +
    "from the app's own " + (kind === "django" ? "migrations" : "schema.sql") + "; it has no customer rows.", undefined,
    { important: true, origin: "fixture", originDetail: { fixture: "test database built from the app's schema" } });
  return dest;
}

async function baselinePreserve(job: Job, attempt: number, kind: "flask" | "django"): Promise<StageResult> {
  const base = mkdir(J(job, "baseline"));
  const work = J(job, "work");
  const insp = inspection(job);
  const python = await originalPython(job, insp.stack.python);
  const dbSource = hasDb(job) ? J(job, "snapshot", "database.sqlite") : await fixtureDb(job, kind, python);
  const scenario = path.join(base, "scenario.json");
  const assessment = path.join(work, "assessment.json");
  const orderDomain = kind === "flask" && fs.existsSync(assessment) && Object.keys(readJson(assessment).roles ?? {}).length > 0;
  if (orderDomain) {
    await verifier(job, "baseline", attempt, ["scenario", "--assessment", assessment, "--scope", path.join(work, "scope.json"), "--source-db", dbSource,
      "--out", scenario], engineSandbox(job, [work, path.dirname(dbSource)], [base], { vault: true }));
  } else {
    await verifier(job, "baseline", attempt, ["web-scenario", "--inspection", path.join(work, "inspection.json"), "--repo", J(job, "source"),
      "--source-db", dbSource, "--out", scenario], engineSandbox(job, [work, J(job, "source"), path.dirname(dbSource)], [base], { vault: true }));
  }
  const rt = runtimeFor(job, "original-A", J(job, "source"), dbSource, kind);
  const recording = path.join(base, "baseline.json");
  const server = await startApp(job, "baseline", attempt, `original app (${insp.stack.framework}, sandboxed)`, python, rt, kind);
  try {
    await verifier(job, "baseline", attempt, [orderDomain ? "record" : "web-record", "--scenario", scenario, "--url", server.url, "--timezone", job.timezone,
      "--out", recording], engineSandbox(job, [base], [base], { vault: true }));
  } finally {
    await server.stop();
    await recordCompute(job.id, "verification", "baseline", attempt, Date.now() - server.startedMs, `original app (${insp.stack.framework}, sandboxed)`);
  }
  await verifier(job, "baseline", attempt, ["dump", "--db", rt.dbPath, "--out", path.join(base, "dump-A.json")],
    engineSandbox(job, [rt.dir], [base], { vault: true }));
  const tests = await ownTests(job, "baseline", attempt, python, runtimeFor(job, "original-tests", J(job, "source"), dbSource, kind), kind, insp);
  if (tests) fs.writeFileSync(path.join(base, "tests-A.json"), JSON.stringify(tests, null, 2));
  const scripts = await outsideScripts(job, "baseline", attempt, python, "original-script", J(job, "source"), dbSource, kind, false);
  fs.writeFileSync(path.join(base, "scripts-A.json"), JSON.stringify(scripts));
  const sc = readJson(scenario);
  await artifact(job, "scenario", "Representative scenario", scenario, { by: "verification", ...tool("scenario") });
  await artifact(job, "baseline", "Recorded behaviour of the original app", recording, { by: "verification", ...tool("record") });
  const cov = sc.coverage ?? {};
  await logEvent(job.id, "verification", "decision", `Recorded the original app on its own data copy: ${sc.steps.length} requests covering ` +
    `${cov.routes_covered ?? "?"} of ${cov.routes_total ?? "?"} entry points` + (tests ? `; its own tests ${tests.exit === 0 ? "pass" : "fail"} today` : "") +
    (Object.keys(scripts).length ? `; ran ${Object.keys(scripts).join(", ")} on a copy` : "") + ".", { coverage: cov }, { important: true, ...tool("verifier") });
  return { next: "freeze" };
}

async function freezePreserve(job: Job, attempt: number, kind: "flask" | "django"): Promise<StageResult> {
  const vault = J(job, "vault");
  if (fs.existsSync(vault) && !job.checks_manifest_sha) { makeWritable(vault); fs.rmSync(vault, { recursive: true, force: true }); }
  mkdir(vault);
  const base = J(job, "baseline");
  const opt = (f: string) => (fs.existsSync(path.join(base, f)) ? [`--${f.split("-")[0]}`, path.join(base, f)] : []);
  const accepted = fs.existsSync(J(job, "work", "accepted-plan.json")) ? J(job, "work", "accepted-plan.json") : J(job, "work", "plan.json");
  const res = await verifier(job, "freeze", attempt, ["freeze-preserve", "--vault", vault, "--plan", accepted,
    "--scenario", path.join(base, "scenario.json"), "--baseline", path.join(base, "baseline.json"), "--baseline-dump", path.join(base, "dump-A.json"),
    ...opt("tests-A.json"), ...opt("scripts-A.json"), ...(hasDb(job) ? ["--source-db", J(job, "snapshot", "database.sqlite")] : []),
    "--job", job.id, "--kind", kind], engineSandbox(job, [J(job, "work"), base, J(job, "snapshot")], [vault], { vault: true }));
  const ev = res.events.find((e) => e.event === "freeze.done");
  if (!ev?.manifest_sha256) throw new Error("freeze produced no manifest");
  fs.chmodSync(vault, 0o555);
  await artifact(job, "frozen_checks", "Frozen acceptance checks (manifest)", path.join(vault, "MANIFEST.json"), { by: "verification", frozen: true, ...tool("freeze") });
  await logEvent(job.id, "verification", "decision", `Froze ${ev.checks} acceptance checks before any code change (manifest SHA-256 ` +
    `${ev.manifest_sha256.slice(0, 16)}...). Every one is mandatory; the implementation step cannot read or change them.`, ev,
    { important: true, ...tool("freeze") });
  return { next: "implement", patch: { checks_manifest_sha: ev.manifest_sha256 } };
}

// ======================================================================== implementation

async function implement(job: Job, attempt: number): Promise<StageResult> {
  if (replatform.isReplatform(job)) return replatform.implement(job, attempt);
  if (job.recipe === "flask-fastapi-postgres") {
    const r = await v1.modernize(job, attempt);
    return r;
  }
  const build = mkdir(J(job, "build", `attempt-${attempt}`));
  const pkg = path.join(build, "upgraded");
  const p = (await currentPlan(job))!.plan;
  const kind = KIND[job.recipe ?? ""];
  if (attempt > 1) {
    if (!fs.existsSync(pkg)) throw new Error(`repair output missing for attempt ${attempt}`);
    await logEvent(job.id, "implementation", "decision", `Attempt ${attempt}: using the repaired code from the repair step.`, undefined, tool("repair"));
    return { next: "verify" };
  }
  if (fs.existsSync(pkg)) { makeWritable(pkg); fs.rmSync(pkg, { recursive: true, force: true }); }
  let manual: any[] = [];
  let origin: Origin = "tool";
  let detail: Record<string, unknown> = { tool: `inplace ${kind}` };
  if (kind) {
    const rep = path.join(build, "tool-report.json");
    await py(job, "implementation", "implement", attempt, "goose_engine.inplace", ["--kind", kind, "--repo", J(job, "source"), "--out", pkg,
      "--latest", LATEST, "--report", rep], engineSandbox(job, [J(job, "source")], [build]));
    const r = readJson(rep);
    manual = r.manual ?? [];
    if (kind === "django") {
      const venv = path.join(build, "venv");
      const ms = await makeVenv(venv, path.join(pkg, "requirements.txt"), path.join(build, "install.log"));
      if (ms) await recordCompute(job.id, "implementation", "implement", attempt, ms, "install the upgraded requirements");
      const scratch = path.join(build, "scratch.sqlite");
      if (hasDb(job)) { fs.copyFileSync(J(job, "snapshot", "database.sqlite"), scratch); fs.chmodSync(scratch, 0o644); }
      const insp = inspection(job);
      const env = cleanEnv({ TZ: job.timezone, ...dbEnv(insp, "django", scratch, null) }, build);
      const mk = await run({ cmd: path.join(venv, "bin", "python"), args: ["-E", "-s", "manage.py", "makemigrations"], cwd: pkg, env,
        sandbox: customerSandbox(job, build), timeoutMs: 120_000, logFile: path.join(build, "makemigrations.log"), profileFile: path.join(build, ".sb-mk.sb") });
      await recordCompute(job.id, "implementation", "implement", attempt, mk.ms, "manage.py makemigrations (Django 5.2)");
      if (mk.code !== 0) throw new Error(`makemigrations failed: ${(mk.stderr || mk.stdout).slice(-600)}`);
      const made = [...mk.stdout.matchAll(/^\s+(\S+\/migrations\/\S+\.py)/gm)].map((m) => m[1]);
      r.actions.push({ tool: "manage.py makemigrations (Django 5.2.19)", files: made });
      fs.rmSync(scratch, { force: true });
      fs.writeFileSync(rep, JSON.stringify(r, null, 2));
    }
    fs.writeFileSync(path.join(build, "change.diff"), await diffDirs(J(job, "source"), pkg));
    await logEvent(job.id, "implementation", "decision", `Changed ${r.files_changed.length} files with deterministic tools: ` +
      r.actions.map((x: any) => `${x.tool} (${(x.files ?? []).length} files)`).join("; ") + "." +
      (manual.length ? ` ${manual.length} place(s) need a hand-written change: ${[...new Set(manual.map((m: any) => m.api))].join(", ")}.` : ""),
      { actions: r.actions, manual }, { important: true, ...tool(`inplace ${kind}`) });
  }
  const agentItems = (p.changes ?? []).filter((c: any) => c.by === "agent");
  if (config.mode === "naive" && (agentItems.length || manual.length || !kind)) {
    if (!kind) copyFresh(J(job, "source"), pkg);
    const zip = await zipDir(pkg, path.join(build, "candidate.zip"));
    const res = await agents.changeWithAgent(await ctxFor(job, attempt, "implement"), { candidateZip: zip, outZip: path.join(build, "agent-result.zip"),
      items: [...agentItems, ...manual.map((m: any) => ({ title: `Replace ${m.api}`, file: m.file, line: m.line }))],
      context: `Inspection summary: ${JSON.stringify(inspection(job).stack)}. Keep everything else exactly as it is.` });
    if (!res.ok) return { next: "implement", status: "waiting_founder", waiting: `The implementation agent could not finish (${res.reason}): ${res.message}` };
    const unpacked = path.join(build, "agent-unpacked");
    fs.rmSync(unpacked, { recursive: true, force: true });
    const u = await run({ cmd: "/usr/bin/unzip", args: ["-q", path.join(build, "agent-result.zip"), "-d", unpacked], cwd: build, env: cleanEnv() });
    if (u.code !== 0) throw new Error(`the agent's result is not a valid zip: ${u.stderr}`);
    const guard = guardAgentChange(J(job, "source"), pkg, unpacked, p);
    if (guard.length) {
      await logEvent(job.id, "implementation", "decision", `The guard rejected the implementation agent's change: ${guard.join("; ")}`, { guard },
        { important: true, origin: "agent", originDetail: { session_id: res.sessionId } });
      return { next: "implement", status: "waiting_founder", waiting: `The implementation agent's change failed the guard: ${guard.join("; ").slice(0, 300)}` };
    }
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.renameSync(unpacked, pkg);
    fs.writeFileSync(path.join(build, "change.diff"), await diffDirs(J(job, "source"), pkg));
    origin = "agent";
    detail = { session_id: res.sessionId, model: res.model };
    await logEvent(job.id, "implementation", "decision", `The implementation agent edited the repository: ${res.output.summary} ` +
      `Files: ${(res.output.changed_files ?? []).map((f: any) => f.file).join(", ")}. Its own test run: ${res.output.tests?.passed ? "passed" : "did not pass or did not run"}.`,
      res.output, { important: true, origin: "agent", originDetail: detail });
  } else if (!kind) {
    return { next: "implement", status: "waiting_founder", waiting: "This change needs the live implementation agent, which is not running in local mode." };
  }
  await artifact(job, "upgraded_code", `Upgraded application (attempt ${attempt})`, pkg, { by: "implementation", attempt, origin, originDetail: detail });
  await artifact(job, "change_diff", `Code change (attempt ${attempt})`, path.join(build, "change.diff"), { by: "implementation", attempt, visible: true, origin, originDetail: detail });
  return { next: "verify" };
}

function guardAgentChange(source: string, before: string, after: string, plan: any) {
  const problems: string[] = [];
  const tests = (dir: string) => v1.walk(dir).filter((f) => /(^|\/)(tests?\.py|test_[^/]+\.py|[^/]+_test\.py)$/.test(f) || f.includes("/tests/"));
  const rel = (dir: string, f: string) => path.relative(dir, f);
  const beforeTests = new Map(tests(before).map((f) => [rel(before, f), fs.readFileSync(f, "utf8")]));
  for (const [name, text] of beforeTests) {
    const p = path.join(after, name);
    if (!fs.existsSync(p)) problems.push(`removed the test file ${name}`);
    else if ((fs.readFileSync(p, "utf8").match(/def test/g) ?? []).length < (text.match(/def test/g) ?? []).length) problems.push(`removed tests from ${name}`);
  }
  if (!fs.existsSync(path.join(after, "requirements.txt")) && fs.existsSync(path.join(source, "requirements.txt"))) problems.push("deleted requirements.txt");
  return problems;
}

async function zipDir(dir: string, out: string) {
  fs.rmSync(out, { force: true });
  const z = await run({ cmd: "/usr/bin/zip", args: ["-r", "-q", out, ".", "-x", "*.pyc", "-x", "__pycache__/*"], cwd: dir, env: cleanEnv() });
  if (z.code !== 0) throw new Error(`zip failed: ${z.stderr}`);
  return out;
}

async function diffDirs(a: string, b: string) {
  const r = await run({ cmd: "/usr/bin/diff", args: ["-ruN", "-x", "__pycache__", "-x", "*.pyc", "-x", "*.sqlite", "-x", "*.db", a, b], cwd: path.dirname(a), env: cleanEnv() });
  return r.stdout.split(a + "/").join("a/").split(b + "/").join("b/");
}

// ======================================================================== verification

async function verify(job: Job, attempt: number): Promise<StageResult> {
  if (replatform.isReplatform(job)) return recordVerdict(job, attempt, await replatform.verify(job, attempt), null);
  if (job.recipe === "flask-fastapi-postgres") return v1.verify(job, attempt);
  const kind = KIND[job.recipe ?? ""] ?? (inspection(job).stack.framework === "Django" ? "django" : "flask");
  const vdir = mkdir(J(job, "verify", `attempt-${attempt}`));
  const vault = J(job, "vault");
  const vsb = (write: string[] = [vdir]) => engineSandbox(job, [vault, J(job, "work"), J(job, "build"), vdir], write, { vault: true });
  const integ = await verifier(job, "verify", attempt, ["integrity", "--vault", vault, "--manifest-sha", job.checks_manifest_sha ?? ""], vsb(), { allowFail: true });
  const ie = integ.events.find((e) => e.event === "integrity");
  if (!ie?.ok) {
    await logEvent(job.id, "verification", "decision", `Integrity check FAILED: ${JSON.stringify(ie?.problems)}. Delivery blocked.`, ie, { important: true, ...tool("verifier") });
    return { next: "verify", status: "waiting_founder", waiting: "Frozen checks failed their integrity check" };
  }
  const insp = inspection(job);
  const pkg = J(job, "build", `attempt-${attempt}`, "upgraded");
  const appDir = mkdir(path.join(vdir, "app"));
  const venv = path.join(appDir, "venv");
  fs.rmSync(venv, { recursive: true, force: true });
  const app: Record<string, any> = {};
  const fw: Record<string, any> = {};
  let python = path.join(venv, "bin", "python");
  try {
    const ms = await makeVenv(venv, path.join(pkg, "requirements.txt"), path.join(appDir, "install.log"));
    await recordCompute(job.id, "verification", "verify", attempt, ms, "clean install from the delivered requirements");
    app["app.clean_install"] = { ok: true, detail: `installed from requirements.txt in ${(ms / 1000).toFixed(1)} s` };
  } catch (e) {
    app["app.clean_install"] = { ok: false, detail: String((e as Error).message).slice(0, 500) };
  }
  const dbSource = hasDb(job) ? J(job, "snapshot", "database.sqlite") : J(job, "fixture", "database.sqlite");
  const recording = path.join(vdir, "recording.json");
  const dumpB = path.join(vdir, "dump-B.json");
  let testsB: any = null;
  let scriptsB: Record<string, any> = {};
  if (app["app.clean_install"].ok) {
    const rt = runtimeFor(job, `upgraded-B-a${attempt}`, pkg, dbSource, kind);
    if (kind === "django") {
      fw["django.migrate_copy"] = await runIn(job, "verify", attempt, python, rt, ["manage.py", "migrate", "-v", "1"], "migrations on a copy of the data");
      fw["django.check"] = await runIn(job, "verify", attempt, python, rt, ["manage.py", "check"], "Django system check");
      fw["django.migrations"] = await runIn(job, "verify", attempt, python, rt, ["manage.py", "makemigrations", "--check", "--dry-run"], "no model change without a migration");
    }
    const scenarioKind = readJson(path.join(vault, "scenario.json")).kind === "web" ? "web-record" : "record";
    const server = await startApp(job, "verify", attempt, "upgraded app under test (sandboxed)", python, rt, kind);
    try {
      await verifier(job, "verify", attempt, [scenarioKind, "--scenario", path.join(vault, "scenario.json"), "--url", server.url, "--timezone", job.timezone,
        "--out", recording], vsb());
    } finally {
      await server.stop();
      await recordCompute(job.id, "verification", "verify", attempt, Date.now() - server.startedMs, "upgraded app under test (sandboxed)");
    }
    await verifier(job, "verify", attempt, ["dump", "--db", rt.dbPath, "--out", dumpB], engineSandbox(job, [rt.dir], [vdir], { vault: true }));
    testsB = await ownTests(job, "verify", attempt, python, runtimeFor(job, `upgraded-tests-a${attempt}`, pkg, dbSource, kind), kind, insp);
    scriptsB = await outsideScripts(job, "verify", attempt, python, `upgraded-script-a${attempt}`, pkg, dbSource, kind, kind === "django");
    const empty = runtimeFor(job, `upgraded-empty-a${attempt}`, pkg, null, kind);
    try {
      if (kind === "django") await runIn(job, "verify", attempt, python, empty, ["manage.py", "migrate", "-v", "0"], "migrations on an empty database");
      else if (fs.existsSync(path.join(empty.app, "schema.sql"))) {
        await runIn(job, "verify", attempt, python, empty, ["-c", `import sqlite3; c=sqlite3.connect(${JSON.stringify(empty.dbPath)}); c.executescript(open('schema.sql').read()); c.commit()`], "empty database from schema.sql");
      }
      const s = await startApp(job, "verify", attempt, "upgraded app on an empty database (sandboxed)", python, empty, kind);
      const r = await fetch(s.url + "/").then((x) => x.status).catch(() => null);
      await s.stop();
      await recordCompute(job.id, "verification", "verify", attempt, Date.now() - s.startedMs, "upgraded app on an empty database (sandboxed)");
      app["app.empty_start"] = { ok: r !== null && r < 500, detail: `GET / answered ${r}` };
    } catch (e) {
      app["app.empty_start"] = { ok: false, detail: String((e as Error).message).slice(0, 400) };
    }
  }
  const files: Record<string, string> = {};
  const put = (name: string, v: unknown) => { if (v === null || v === undefined) return []; const p = path.join(vdir, name); fs.writeFileSync(p, JSON.stringify(v)); files[name] = p; return [p]; };
  put("app.json", app);
  put("framework.json", fw);
  put("tests-B.json", testsB);
  put("scripts-B.json", scriptsB);
  if (!fs.existsSync(recording)) fs.writeFileSync(recording, JSON.stringify({ started: new Date().toISOString(), finished: new Date().toISOString(), results: [] }));
  if (!fs.existsSync(dumpB)) fs.writeFileSync(dumpB, "{}");
  const cmp = path.join(vdir, "compare.json");
  await verifier(job, "verify", attempt, ["compare", "--vault", vault, "--recording", recording, "--dump", dumpB, "--timezone", job.timezone, "--out", cmp,
    ...(files["tests-B.json"] ? ["--tests", files["tests-B.json"]] : []), ...(files["scripts-B.json"] ? ["--scripts", files["scripts-B.json"]] : []),
    "--framework", files["framework.json"], "--app", files["app.json"]], vsb());
  const rep = path.join(vdir, "report");
  await verifier(job, "verify", attempt, ["report-preserve", "--vault", vault, "--attempt", String(attempt), "--manifest-sha", job.checks_manifest_sha ?? "",
    "--inputs", cmp, "--out", rep], vsb());
  return recordVerdict(job, attempt, rep, kind);
}

async function recordVerdict(job: Job, attempt: number, rep: string, kind: string | null): Promise<StageResult> {
  const report = readJson(rep + ".json");
  await q(`INSERT INTO check_runs (job_id, attempt, integrity_ok, total, passed, failed, skipped, verdict, by_category, failed_checks, report_path)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (job_id, attempt) DO UPDATE SET integrity_ok = EXCLUDED.integrity_ok, total = EXCLUDED.total, passed = EXCLUDED.passed,
             failed = EXCLUDED.failed, skipped = EXCLUDED.skipped, verdict = EXCLUDED.verdict, by_category = EXCLUDED.by_category,
             failed_checks = EXCLUDED.failed_checks, report_path = EXCLUDED.report_path, created_at = now()`,
    [job.id, attempt, report.integrity.ok, report.summary.total, report.summary.passed, report.summary.failed, report.summary.skipped,
     report.summary.verdict, JSON.stringify(report.by_category), JSON.stringify(report.failed.slice(0, 60)), rep + ".json"]);
  await artifact(job, "verification_report", `Verification report (attempt ${attempt})`, rep + ".md", { by: "verification", attempt, visible: true, ...tool("verifier") });
  await artifact(job, "verification_data", `Verification results JSON (attempt ${attempt})`, rep + ".json", { by: "verification", attempt, visible: true, ...tool("verifier") });
  if (report.summary.verdict === "pass") {
    await logEvent(job.id, "verification", "check", `Verification attempt ${attempt} PASSED: ${report.summary.passed} of ${report.summary.total} checks, ` +
      `all mandatory checks passed.`, report.summary, { important: true, ...tool("verifier") });
    const prior = await one<{ id: number }>("SELECT id FROM repairs WHERE job_id = $1 AND attempt = $2", [job.id, attempt - 1]);
    if (prior) await q("UPDATE repairs SET outcome = 'fixed' WHERE id = $1", [prior.id]);
    return { next: "package" };
  }
  await logEvent(job.id, "verification", "check", `Verification attempt ${attempt} FAILED: ${report.summary.failed} mandatory checks failed or were not run. ` +
    "Delivery is blocked.", { summary: report.summary, failed: report.failed.slice(0, 10).map((f: any) => f.id) }, { important: true, ...tool("verifier") });
  const prior = await one<{ id: number }>("SELECT id FROM repairs WHERE job_id = $1 AND attempt = $2", [job.id, attempt - 1]);
  if (prior) await q("UPDATE repairs SET outcome = 'not_fixed' WHERE id = $1", [prior.id]);
  const repairable = config.mode === "naive";
  const decision = await agents.afterFailedVerification(await ctxFor(job, attempt, "verify"), report, job.repairs_used, job.repair_budget, { repairable });
  await logEvent(job.id, "coordinator", "decision", decision.reason, { ...decision }, { important: true, origin: decision.origin,
    originDetail: "sessionId" in decision ? { session_id: (decision as any).sessionId } : { tool: "repair budget rule" } });
  if (decision.action === "repair") return { next: "repair" };
  return { next: "verify", status: "waiting_founder", waiting: decision.reason };
}

// ======================================================================== repair

async function repair(job: Job, attempt: number): Promise<StageResult> {
  if (replatform.isReplatform(job)) {
    const report = readJson(J(job, "verify", `attempt-${attempt}`, "report.json"));
    if (!report.integrity.ok || job.repairs_used >= job.repair_budget) return { next: "verify", status: "waiting_founder", waiting: "Repair is blocked by evidence integrity or the repair budget." };
    const contract = readJson(J(job, "vault", "contract.json"));
    const problems = contractProblems(contract, contract.target);
    if (problems.length) return { next: "verify", status: "waiting_founder", waiting: `The approved contract needs review before repair: ${problems.join("; ")}` };
    const failed = repairEvidence(report.failed);
    const explanation = await agents.explainWithAgent(await ctxFor(job, attempt, "repair"), { failed, diffFile: J(job, "build", `attempt-${attempt}`, "change.diff") });
    if (explanation.ok) await logEvent(job.id, "verification", "decision", explanation.output.plain_summary, explanation.output,
      { important: true, origin: "agent", originDetail: { session_id: explanation.sessionId } });
    const result = await replatform.implement(job, attempt + 1, { failed, explanation: explanation.ok ? explanation.output : null });
    if (result.next === "verify") await q(`INSERT INTO repairs (job_id, attempt, diagnoses, actions, diff, unresolved, outcome) VALUES ($1,$2,$3,$4,$5,'[]','pending')
      ON CONFLICT (job_id, attempt) DO UPDATE SET diagnoses=EXCLUDED.diagnoses, actions=EXCLUDED.actions, diff=EXCLUDED.diff`, [job.id, attempt,
      JSON.stringify(explanation.ok ? [explanation.output] : report.failed), JSON.stringify([{ action: "Agent-produced repair of failed migration checks" }]),
      fs.readFileSync(J(job, "build", `attempt-${attempt + 1}`, "change.diff"), "utf8")]);
    return result;
  }
  if (job.recipe === "flask-fastapi-postgres" && config.mode !== "naive") {
    const r = await v1.repair(job, attempt);
    return r.next === "modernize" ? { ...r, next: "implement" } : r;
  }
  if (config.mode !== "naive") {
    return { next: "repair", status: "waiting_founder", waiting: "No repair is available: this recipe has no deterministic repair rules and the live agents are not running." };
  }
  const next = attempt + 1;
  const ctx = await ctxFor(job, attempt, "repair");
  const report = readJson(job.recipe === "flask-fastapi-postgres" ? J(job, "verify", `attempt-${attempt}`, "report.json")
    : J(job, "verify", `attempt-${attempt}`, "report.json"));
  const fromPkg = J(job, "build", `attempt-${attempt}`, "upgraded");
  const diffFile = J(job, "build", `attempt-${attempt}`, "change.diff");
  if (!fs.existsSync(diffFile)) fs.writeFileSync(diffFile, await diffDirs(J(job, "source"), fromPkg));
  const explanation = await agents.explainWithAgent(ctx, { failed: report.failed, diffFile });
  if (explanation.ok) {
    await logEvent(job.id, "verification", "decision", `Why the checks failed: ${explanation.output.plain_summary}`, explanation.output,
      { important: true, origin: "agent", originDetail: { session_id: explanation.sessionId } });
  }
  const build = mkdir(J(job, "build", `attempt-${next}`));
  const zip = await zipDir(fromPkg, path.join(build, "candidate.zip"));
  const p = (await currentPlan(job))!.plan;
  const res = await agents.changeWithAgent({ ...ctx, attempt: next }, { candidateZip: zip, outZip: path.join(build, "agent-result.zip"), items: p.changes ?? [],
    context: "Repair only what the evidence shows is wrong. Keep every approved change.",
    evidence: { failed: report.failed.slice(0, 25), explanation: explanation.ok ? explanation.output : null } });
  if (!res.ok) return { next: "repair", status: "waiting_founder", waiting: `The implementation agent could not repair (${res.reason}): ${res.message}` };
  const pkg = path.join(build, "upgraded");
  fs.rmSync(pkg, { recursive: true, force: true });
  const u = await run({ cmd: "/usr/bin/unzip", args: ["-q", path.join(build, "agent-result.zip"), "-d", pkg], cwd: build, env: cleanEnv() });
  if (u.code !== 0) throw new Error(`the agent's repair is not a valid zip: ${u.stderr}`);
  const guard = guardAgentChange(J(job, "source"), fromPkg, pkg, p);
  if (guard.length) return { next: "repair", status: "waiting_founder", waiting: `The repair failed the guard: ${guard.join("; ")}` };
  const diff = await diffDirs(fromPkg, pkg);
  fs.writeFileSync(path.join(build, "change.diff"), await diffDirs(J(job, "source"), pkg));
  await q(`INSERT INTO repairs (job_id, attempt, diagnoses, actions, diff, unresolved, outcome) VALUES ($1,$2,$3,$4,$5,$6,'pending')
           ON CONFLICT (job_id, attempt) DO UPDATE SET diagnoses = EXCLUDED.diagnoses, actions = EXCLUDED.actions, diff = EXCLUDED.diff`,
    [job.id, attempt, JSON.stringify(explanation.ok ? [{ signature: "agent explanation", explanation: explanation.output.explanation }] : []),
     JSON.stringify(res.output.changed_files ?? []), diff, JSON.stringify(res.output.not_done ?? [])]);
  await logEvent(job.id, "implementation", "decision", `Repair ${job.repairs_used + 1} by the implementation agent: ${res.output.summary}`, res.output,
    { important: true, origin: "agent", originDetail: { session_id: res.sessionId } });
  return { next: "implement", patch: { attempt: next, repairs_used: job.repairs_used + 1 } };
}

// ======================================================================== delivery

async function packageStage(job: Job, attempt: number): Promise<StageResult> {
  if (replatform.isReplatform(job)) return replatform.packageStage(job, attempt);
  if (job.recipe === "flask-fastapi-postgres") return v1.packageStage(job, attempt);
  const del = mkdir(J(job, "delivery"));
  const att = job.attempt;
  const staging = path.join(del, "staging");
  fs.rmSync(staging, { recursive: true, force: true });
  copyFresh(J(job, "build", `attempt-${att}`, "upgraded"), path.join(staging, "upgraded-app"));
  mkdir(path.join(staging, "evidence"));
  const vd = J(job, "verify", `attempt-${att}`);
  for (const [from, to] of [["report.md", "verification-report.md"], ["report.json", "verification-report.json"]]) fs.copyFileSync(path.join(vd, from), path.join(staging, "evidence", to));
  fs.copyFileSync(J(job, "vault", "MANIFEST.json"), path.join(staging, "evidence", "frozen-checks-manifest.json"));
  fs.copyFileSync(J(job, "build", `attempt-${att}`, "change.diff"), path.join(staging, "evidence", "code-change.diff"));
  const p = (await currentPlan(job))!.plan;
  const insp = inspection(job);
  const st = insp.stack;
  const migrations = v1.walk(path.join(staging, "upgraded-app")).filter((f) => f.includes("/migrations/") && /\d{4}_.*\.py$/.test(f))
    .map((f) => path.relative(path.join(staging, "upgraded-app"), f)).filter((f) => !fs.existsSync(path.join(J(job, "source"), f)));
  fs.writeFileSync(path.join(staging, "CHANGES.md"), `# What changed\n\n${(p.changes ?? []).map((c: any) => `- **${c.title}** - ${c.reason}`).join("\n")}\n\n` +
    `## Kept as it was\n\n${(p.preserve ?? []).map((k: any) => `- ${k.what} - ${k.reason}`).join("\n")}\n\n## Intended differences\n\n` +
    `${(p.intended_differences ?? []).map((d: any) => `- ${d.title} - ${d.reason}`).join("\n") || "- None. Every recorded request answered exactly as before."}\n`);
  fs.writeFileSync(path.join(staging, "RUNBOOK.md"), `# Run book\n\n1. Install Python 3.13 and run \`pip install -r requirements.txt\` in \`upgraded-app/\`.\n` +
    (st.framework === "Django" ? `2. Back up your database file, then run \`python manage.py migrate\`${migrations.length ? ` (applies ${migrations.join(", ")})` : ""}.\n` +
      "3. Start the app the way you start it today (for example `python manage.py runserver` or your WSGI server).\n"
      : "2. Start the app the way you start it today; the database file and its location are unchanged.\n") +
    `4. Outside connections found during inspection keep working unchanged: ${insp.components.filter((c: any) => c.kind === "client" || c.kind === "script")
      .map((c: any) => c.file ?? c.name).join(", ") || "none found"}.\n`);
  fs.writeFileSync(path.join(staging, "ROLLBACK.md"), `# Rollback\n\nYour current code and data are not touched by this delivery.\n\n` +
    `- Code: redeploy your previous version (the repository you sent us) with its old requirements and Python ${st.python ?? ""}.\n` +
    (migrations.length ? `- Data: the delivery adds ${migrations.join(", ")}. To undo it on a database that already ran it: ` +
      `\`python manage.py migrate ${migrations[0].split("/")[0]} ${String(migrations[0].split("/").pop()).split("_")[0].replace(/\d+/, (n) => String(Number(n) - 1).padStart(4, "0"))}\` ` +
      "with the upgraded code, before switching the old code back. Or restore the backup you made before migrating.\n" : "- Data: nothing to undo; no data was changed.\n"));
  fs.writeFileSync(path.join(staging, "README-FIRST.md"), `# ${job.title} - delivery package (${job.id})\n\n${job.kind === "demo" ? "**DEMONSTRATION JOB - synthetic data.**\n\n" : ""}` +
    `${p.title}.\n\n- \`upgraded-app/\` - the upgraded application.\n- \`CHANGES.md\`, \`RUNBOOK.md\`, \`ROLLBACK.md\`.\n- \`evidence/verification-report.md\` - every check, ` +
    "what passed, and what was not tested.\n- `evidence/frozen-checks-manifest.json` - hashes of the checks as frozen before any code changed.\n" +
    "- `evidence/code-change.diff` - every line that changed.\n\nPassing these checks does not prove every possible behaviour is correct; the report lists what was tested.\n");
  const zip = path.join(del, `${job.id}-delivery.zip`);
  fs.rmSync(zip, { force: true });
  const z = await run({ cmd: "/usr/bin/zip", args: ["-r", "-q", zip, "."], cwd: staging, env: cleanEnv() });
  if (z.code !== 0) throw new Error(`zip failed: ${z.stderr}`);
  await artifact(job, "delivery_package", "Delivery package (.zip)", zip, { by: "coordinator", visible: true, ...tool("package") });
  await logEvent(job.id, "coordinator", "decision", `Delivery package ready (SHA-256 ${sha256(zip).slice(0, 16)}...). Sent to the customer for acceptance.`,
    { zip: path.basename(zip) }, { important: true, ...tool("package") });
  await q("INSERT INTO messages (job_id, sender, body, handled_by) VALUES ($1,'coordinator',$2,'template')", [job.id,
    "Your upgraded application is ready. Download the package, read the verification report, and accept the delivery when you are satisfied. " +
    "You are invoiced only after you accept."]);
  return { next: "delivered", status: "waiting_customer", waiting: "Delivered; waiting for the customer to accept" };
}

async function invoice(job: Job): Promise<StageResult> {
  const r = await v1.invoice(job);
  const p = (await currentPlan(job))?.plan;
  if (p?.title) await q("UPDATE invoices SET line_items = $2 WHERE job_id = $1", [job.id, JSON.stringify(agents.invoiceLines(job, job.price_cents ?? 0, p.title))]);
  await syncCommerceForJob(job.id);
  return r;
}

async function followUp(job: Job): Promise<StageResult> {
  const r = await v1.followUp(job);
  if (config.mode === "naive") {
    const n = await deleteJobFiles(naiveClient(), job.id).catch(() => 0);
    if (n) await logEvent(job.id, "coordinator", "decision", `Removed ${n} of this job's files from the Naive file library.`, undefined, tool("naive files"));
  }
  return r;
}

/** SuiteCRM jobs are recognised from the upload (a MySQL dump next to a SuiteCRM tree) or, later, from the snapshot and the recipe. */
async function crmJob(job: Job) {
  if (crm.isCrm(job)) return true;
  const r = await one<{ stored_path: string }>("SELECT stored_path FROM job_inputs WHERE job_id = $1 AND kind = 'database' ORDER BY id DESC LIMIT 1", [job.id]);
  if (!r || !fs.existsSync(r.stored_path)) return false;
  const head = Buffer.alloc(4);
  const fd = fs.openSync(r.stored_path, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return (head[0] === 0x1f && head[1] === 0x8b) || head.toString("latin1").startsWith("-- M");
}
const either = (crmStage: (job: Job, a: number) => Promise<StageResult>, other: (job: Job, a: number) => Promise<StageResult>) =>
  async (job: Job, a: number) => ((await crmJob(job)) ? crmStage(job, a) : other(job, a));

const V2: Record<string, (job: Job, attempt: number) => Promise<StageResult>> = {
  intake: either(crm.intake, intake), inspect: either(crm.inspect, inspect), plan, propose,
  baseline: either(crm.baseline, (job, a) => replatform.isReplatform(job) ? replatform.baseline(job, a) : (job.recipe === "flask-fastapi-postgres" ? v1.baseline(job, a) : baselinePreserve(job, a, recipeKind(job, inspection(job))!))),
  freeze: either(crm.freeze, async (job, a) => {
    if (replatform.isReplatform(job)) return replatform.freeze(job, a);
    if (job.recipe !== "flask-fastapi-postgres") return freezePreserve(job, a, recipeKind(job, inspection(job))!);
    const r = await v1.freeze(job, a);
    return r.next === "modernize" ? { ...r, next: "implement" } : r;
  }),
  implement: either(crm.implement, implement), verify: either(crm.verify, verify), repair, package: either(crm.packageStage, packageStage),
  invoice, follow_up: followUp,
  migrate: async (job, a) => v1.migrate(job, a),
};

export const IMPL_ALL: Record<string, (job: Job, attempt: number) => Promise<StageResult>> = Object.fromEntries(
  [...new Set([...Object.keys(v1.IMPL), ...Object.keys(V2)])].map((stage) => [stage, (job: Job, a: number) =>
    isWorkspace(job) && stage in WORKSPACE_STAGES ? WORKSPACE_STAGES[stage as keyof typeof WORKSPACE_STAGES](job,a) :
      job.pipeline >= 2 && V2[stage] ? V2[stage](job, a) : v1.IMPL[stage](job, a)]));

export async function spendSoFar(job: Job) {
  return jobSpend(job.id);
}
