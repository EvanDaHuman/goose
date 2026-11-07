// A running copy of a delivered application, on its own freshly migrated database, so people can
// complete a real business task with it. Started and stopped by the worker; runs sandboxed.
import fs from "node:fs";
import path from "node:path";
import { config, jobDir } from "./config";
import { one, q } from "./db";
import { jobById } from "./jobs";
import { createDb, dbName, dropDb } from "./pgadmin";
import { cleanEnv, freePort, run, startServer } from "./proc";
import { isReplatform, startPreview } from "./replatform";

const running = new Map<string, () => Promise<void>>();

export async function serviceShowrooms() {
  for (const r of await q<{ job_id: string; status: string; pid: number | null }>("SELECT job_id, status, pid FROM showrooms WHERE status IN ('requested','stop_requested','running')")) {
    if (r.status === "stop_requested") await stop(r.job_id, r.pid);
    else if (r.status === "requested") await start(r.job_id).catch(async (e) => {
      await q("UPDATE showrooms SET status = 'failed', detail = $2, updated_at = now() WHERE job_id = $1", [r.job_id, String(e.message).slice(0, 500)]);
    });
    else if (r.status === "running" && !running.has(r.job_id)) {
      let alive = false;
      try { if (r.pid) { process.kill(-r.pid, 0); alive = true; } } catch { alive = false; }
      if (!alive) await q("UPDATE showrooms SET status = 'stopped', detail = 'worker restarted', updated_at = now() WHERE job_id = $1", [r.job_id]);
    }
  }
}

async function start(jobId: string) {
  const job = await jobById(jobId);
  if (!job) throw new Error("no job");
  if (running.has(jobId)) return;
  if (isReplatform(job)) {
    const server = await startPreview(job);
    running.set(jobId, server.stop);
    await q("UPDATE showrooms SET status='running', port=$2, pid=$3, detail=NULL, updated_at=now() WHERE job_id=$1", [jobId, server.port, server.pid]);
    return;
  }
  const dir = jobDir(jobId, "showroom");
  fs.rmSync(dir, { recursive: true, force: true });
  const app = path.join(dir, "app");
  fs.mkdirSync(app, { recursive: true });
  const pkg = path.join(app, "pkg");
  fs.cpSync(jobDir(jobId, "build", `attempt-${job.attempt}`, "upgraded"), pkg, { recursive: true });
  const venv = jobDir(jobId, "verify", `attempt-${job.attempt}`, "app", "venv");
  const localVenv = path.join(app, "venv");
  fs.cpSync(venv, localVenv, { recursive: true, verbatimSymlinks: true });
  const dsn = await createDb(dbName(jobId, "showroom"));
  const copy = path.join(app, "source.sqlite");
  fs.copyFileSync(jobDir(jobId, "snapshot", "database.sqlite"), copy);
  fs.chmodSync(copy, 0o644);
  const env = cleanEnv({ DATABASE_URL: dsn, BUSINESS_TIMEZONE: job.timezone }, pkg);
  const sandbox = { readAllow: [app], writeAllow: [app], readDeny: [jobDir(jobId, "vault"), jobDir(jobId, "work")] };
  for (const args of [["migrate/apply_schema.py"], ["migrate/migrate_data.py", "--sqlite", copy]]) {
    const r = await run({ cmd: path.join(localVenv, "bin", "python"), args: ["-E", "-s", ...args], cwd: pkg, env, sandbox,
      timeoutMs: 120_000, logFile: path.join(app, "setup.log"), profileFile: path.join(app, ".sb-setup.sb") });
    if (r.code !== 0) throw new Error(`${args[0]} failed: ${r.stderr.slice(-400)}`);
  }
  const port = await freePort();
  const server = await startServer({ cmd: path.join(localVenv, "bin", "python"), args: ["-E", "-s", "-m", "uvicorn", "app.main:app",
    "--host", "127.0.0.1", "--port", String(port)], cwd: pkg, env, sandbox, port, healthPath: "/healthz", logFile: path.join(app, "server.log") });
  running.set(jobId, server.stop);
  await q("UPDATE showrooms SET status = 'running', port = $2, pid = $3, detail = NULL, updated_at = now() WHERE job_id = $1", [jobId, port, server.pid]);
}

async function stop(jobId: string, pid: number | null) {
  const s = running.get(jobId);
  if (s) await s();
  else if (pid) { try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ } }
  running.delete(jobId);
  await dropDb(dbName(jobId, "showroom")).catch(() => undefined);
  await q("UPDATE showrooms SET status = 'stopped', updated_at = now() WHERE job_id = $1", [jobId]);
}

export async function stopAllShowrooms() {
  for (const [jobId, s] of running) {
    await s();
    await q("UPDATE showrooms SET status = 'stopped', updated_at = now() WHERE job_id = $1", [jobId]);
  }
  running.clear();
}

export { one };
