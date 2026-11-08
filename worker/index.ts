// The Goose worker: claims runnable jobs from PostgreSQL and runs their current stage.
// Run several and they share the queue (FOR UPDATE SKIP LOCKED). Kill one mid-stage and the
// job is resumed by the next worker; finished stages are never repeated.
import { config } from "../lib/config";
import { pool } from "../lib/db";
import { claimJob, releaseDeadLeases, releaseLease, runCurrentStage } from "../lib/jobs";
import { naiveStatus } from "../lib/naive/client";
import { logEvent } from "../lib/records";
import { serviceShowrooms, stopAllShowrooms } from "../lib/showroom";
import { IMPL_ALL as IMPL } from "../lib/pipeline";
import { serviceGrowth } from "../lib/growth";
import { runMaintenanceChecks, serviceCommerce } from "../lib/commerce";

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stopping = true; console.log(`[worker] ${sig}: finishing the current step, then stopping`); });
}

async function main() {
  const once = process.argv.includes("--once");
  console.log(`[worker] pid ${process.pid}, mode ${config.mode}`);
  if (config.mode === "naive") {
    const s = await naiveStatus();
    console.log(`[worker] Naive: ${s.state} - ${s.message}`);
    if (s.state !== "ready") {
      await logEvent(null, "system", "status", `Worker started in naive mode but Naive is not ready: ${s.message}`, s, { important: true });
    }
  }
  await releaseDeadLeases();
  let idle = 0;
  let lastMaintenance = 0;
  while (!stopping) {
    if (Date.now() - lastMaintenance > 60_000) {
      lastMaintenance = Date.now();
      await serviceCommerce().catch(e => console.error("[worker] commerce", e.message));
      await runMaintenanceChecks().catch(e => console.error("[worker] maintenance", e.message));
    }
    await serviceShowrooms().catch((e) => console.error("[worker] showroom", e.message));
    await serviceGrowth().catch((e) => console.error("[worker] growth", e.message));   // runs in the background; never blocks jobs
    const job = await claimJob();
    if (!job) {
      if (once && ++idle > 3) break;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    idle = 0;
    console.log(`[worker] ${job.id}: ${job.stage} (attempt ${job.attempt})`);
    try {
      await runCurrentStage(job, IMPL);
    } finally {
      await releaseLease(job.id);
    }
  }
  await stopAllShowrooms();
  await pool.end();
}

main().catch((e) => {
  console.error("[worker] fatal", e);
  process.exit(1);
});
