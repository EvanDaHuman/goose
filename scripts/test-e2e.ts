// Browser regressions run a local-only company with a disposable database and job files.
// Never point these tests at a live company's queue or configured email/payment providers.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";

const root = process.cwd(), port = Number(process.env.GOOSE_E2E_PORT || 3101);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("GOOSE_E2E_PORT must be an unprivileged TCP port");
const adminUrl = process.env.PG_ADMIN_URL;
if (!adminUrl) throw new Error("PG_ADMIN_URL is required for disposable browser tests; run npm run setup");
const database = `goose_e2e_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
const artifacts = fs.mkdtempSync(path.join(root, "var", "e2e-run-"));
const jobs = path.join(artifacts, "jobs");fs.mkdirSync(jobs);
const url = new URL(adminUrl);url.pathname = "/" + database;
const base = `http://localhost:${port}`, dist = ".next-e2e-production";
const env = { ...process.env, DATABASE_URL: url.toString(), GOOSE_JOBS_DIR: jobs, GOOSE_MODE: "local",
  GOOSE_NEXT_DIST_DIR: dist, GOOSE_URL: base, APP_BASE_URL: base, GOOSE_PUBLIC_URL: base,
  GOOSE_OPERATOR_TOKEN: crypto.randomBytes(32).toString("hex"), VETTA_API_KEY: "", GOOSE_EMAIL_PROVIDER: "disabled",
  AGENTMAIL_API_KEY: "", AGENTMAIL_INBOX_ID: "", AGENTMAIL_WEBHOOK_SECRET: "", AGENTMAIL_INBOUND_MODE: "test",
  GOOSE_EMAIL_WEBHOOK_URL: "", GOOSE_EMAIL_WEBHOOK_TOKEN: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
const processes: ChildProcess[] = [];
function launch(args: string[], log?: string) {
  const fd = log ? fs.openSync(path.join(artifacts, log), "a", 0o600) : undefined;
  const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: fd === undefined ? "inherit" : ["ignore", fd, fd] });
  if (fd !== undefined) fs.closeSync(fd);
  child.on("error", () => {});processes.push(child);return child;
}
function finished(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => { child.once("error", reject);child.once("exit", code => resolve(code ?? 1)); });
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 30_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } }
}
function writable(dir: string) {
  if (!fs.existsSync(dir)) return;
  const stat = fs.lstatSync(dir);if (stat.isSymbolicLink()) return;
  fs.chmodSync(dir, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of fs.readdirSync(dir)) writable(path.join(dir, name));
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  for (const child of processes) if (child.pid && child.exitCode === null) { try { process.kill(-child.pid, signal); } catch { /* exited */ } }
});
await new Promise<void>((resolve, reject) => {
  const probe = net.createServer();probe.once("error", () => reject(new Error(`Port ${port} is occupied. The existing server was not touched.`)));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
});
const admin = new pg.Client({ connectionString: adminUrl });await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE ${database}`);created = true;
  const client = new pg.Client({ connectionString: url.toString() });await client.connect();
  try {
    for (const file of fs.readdirSync("db/migrations").filter(f => f.endsWith(".sql")).sort()) await client.query(fs.readFileSync(path.join("db/migrations", file), "utf8"));
    await client.query("INSERT INTO settings(key,value) VALUES('growth',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({enabled:false})]);
  } finally { await client.end(); }
  console.log(`Browser test company is isolated on ${base}. Provider credentials and live agents are disabled.`);
  const build = launch(["node_modules/next/dist/bin/next", "build"]);
  if (await finished(build) !== 0) throw new Error("The isolated production build failed");
  const web = launch(["node_modules/next/dist/bin/next", "start", "--port", String(port)], "web.log");
  const worker = launch(["--import", "tsx", "worker/index.ts"], "worker.log");
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (web.exitCode !== null || worker.exitCode !== null) throw new Error(`Test services exited. See ${artifacts}`);
    try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) { ready = true;break; } } catch { /* booting */ }
    await delay(500);
  }
  if (!ready) throw new Error(`Test web server did not become ready. See ${artifacts}`);
  process.exitCode = await finished(launch(["node_modules/@playwright/test/cli.js", "test", "--workers=1", ...process.argv.slice(2)]));
} finally {
  for (const child of [...processes].reverse()) await stop(child);
  if (created) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();writable(jobs);fs.rmSync(jobs, { recursive: true, force: true });
  console.log(`Test services stopped and disposable data removed. Logs: ${artifacts}`);
}
