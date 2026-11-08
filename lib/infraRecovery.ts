// Autonomous recovery from infrastructure waits. A job that stopped only because the Docker Linux backend was down is
// resumed by the worker as soon as the backend answers; on macOS the worker also tries to start Docker Desktop.
// This is recorded as a system recovery, not a founder intervention.
import fs from "node:fs";
import { config } from "./config";
import { q } from "./db";
import { stageAttempt, type Job } from "./jobs";
import { DOCKER_WAIT } from "./infraWait";
import { cleanEnv, run } from "./proc";
import { logEvent } from "./records";

export async function dockerLinuxReady() {
  const r = await run({ cmd: "docker", args: ["version", "--format", "{{.Server.Os}}"], cwd: config.root,
    env: cleanEnv({ PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) }, config.home), timeoutMs: 10000 }).catch(() => null);
  return !!r && r.code === 0 && r.stdout.trim() === "linux";
}

let lastStartAttempt = 0;
export async function serviceInfraRecovery() {
  const waiting = await q<Job>("SELECT * FROM jobs WHERE status='waiting_founder' AND waiting_reason LIKE $1 || '%' ORDER BY id", [DOCKER_WAIT]);
  if (!waiting.length) return { resumed: 0 };
  if (!(await dockerLinuxReady())) {
    // macOS with Docker Desktop installed and no remote DOCKER_HOST: try to start it (at most every 10 minutes)
    if (process.platform === "darwin" && !process.env.DOCKER_HOST && fs.existsSync("/Applications/Docker.app") && Date.now() - lastStartAttempt > 10 * 60_000) {
      lastStartAttempt = Date.now();
      await run({ cmd: "/usr/bin/open", args: ["-a", "Docker"], cwd: config.root, env: cleanEnv({ PATH: "/usr/bin:/bin" }, config.home), timeoutMs: 15000 }).catch(() => null);
      await logEvent(null, "system", "status", `Docker backend is down with ${waiting.length} job(s) waiting; asked Docker Desktop to start.`, { jobs: waiting.map((j) => j.id) }, { origin: "system" });
    }
    return { resumed: 0 };
  }
  for (const job of waiting) {
    const attempt = stageAttempt(job, job.stage);
    await q("UPDATE stage_runs SET status='failed', error=COALESCE(error,output->>'waiting'), output=NULL WHERE job_id=$1 AND stage=$2 AND attempt=$3", [job.id, job.stage, attempt]);
    const r = await q("UPDATE jobs SET status='running', waiting_reason=NULL, next_run_at=now(), updated_at=now() WHERE id=$1 AND status='waiting_founder' RETURNING id", [job.id]);
    if (r.length) await logEvent(job.id, "system", "status", "Docker execution backend is available again; resumed automatically.", undefined, { origin: "system", important: true });
  }
  return { resumed: waiting.length };
}
