// SuiteCRM jobs, after delivery: run the delivered workspace, reset it after a rehearsal, and switch over.
// Goose never connects to the customer's live SuiteCRM. For the switch-over the CUSTOMER pauses sales edits in SuiteCRM
// (sales roles read-only) and sends a final database dump; Goose restores it in its own workbench, moves it and re-runs
// the data checks.
//
//   npm run crm -- serve JOB [port]            run the delivered workspace on the moved data (default port 8090)
//   npm run crm -- remigrate JOB               after a rehearsal: put the workspace's data back to what the move produced
//   npm run crm -- cutover JOB FINAL.sql.gz    switch over: move the customer's final dump and re-run the data checks
import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config";
import * as crm from "../lib/crm";
import { pool, q } from "../lib/db";
import { jobById } from "../lib/jobs";
import { createDb, dbName } from "../lib/pgadmin";
import { logEvent } from "../lib/records";

async function serve(jobId: string, port: number) {
  const job = (await jobById(jobId))!;
  const url = await createDb(dbName(job.id, "workspace"), { keep: true, passwordFile: path.join(config.varDir, "jobs", job.id, "work", "workspace.pgpass") });
  const s = await crm.startWorkspace(job, job.attempt, url, port, "delivered workspace (customer's copy)", "serve.log");
  console.log(`Delivered sales workspace for ${job.id} at ${s.url} (Ctrl-C to stop). Original SuiteCRM: ${crm.ORIGINAL_URL}`);
  fs.mkdirSync(path.join(config.varDir, "suitecrm"), { recursive: true });
  fs.writeFileSync(path.join(config.varDir, "suitecrm", "workspace-url"), s.url);
  await new Promise<void>((resolve) => { process.on("SIGINT", () => { s.stop().then(resolve); }); process.on("SIGTERM", () => { s.stop().then(resolve); }); });
}

const [cmd, a1, a2] = process.argv.slice(2);
try {
  if (cmd === "serve") await serve(a1, Number(a2 ?? 8090));
  else if (cmd === "remigrate") {
    // put the delivered workspace's data back to exactly what the move produced (after a rehearsal changed it)
    const job = (await jobById(a1))!;
    const url = await createDb(dbName(job.id, "workspace"), { keep: true, passwordFile: path.join(config.varDir, "jobs", job.id, "work", "workspace.pgpass") });
    const finals = fs.existsSync(path.join(config.varDir, "jobs", job.id, "cutover"));
    const src = `gs_${job.id.toLowerCase().replace(/[^a-z0-9]/g, "")}_${finals ? "final" : "snapshot"}`;
    const r = await crm.migrateInto(job, "rehearsal-reset", job.attempt, path.join(config.varDir, "jobs", job.id, "build", `attempt-${job.attempt}`, "delivered"),
      url, src, path.join(config.varDir, "jobs", job.id, "work", `remigrate-${Date.now()}.json`));
    console.log(`Workspace data for ${job.id} reset from ${src} in ${r.seconds} s (restart serve if it is running).`);
  }
  else if (cmd === "cutover") {
    const job = (await jobById(a1))!;
    if (!a2 || !fs.existsSync(a2)) throw new Error("usage: npm run crm -- cutover JOB FINAL.sql.gz (the customer's final dump, taken after they paused sales edits)");
    const t0 = new Date();
    await logEvent(job.id, "customer", "decision", "Switch-over started: the customer paused sales edits in SuiteCRM and sent a final database dump.",
      { dump: path.basename(a2) }, { important: true, origin: "human", originDetail: { who: "customer" } });
    const final = a2;
    const r = await crm.cutover(job, final);
    const t1 = new Date();
    const s = r.check.verdict === "pass" ? "passed" : "FAILED";
    await logEvent(job.id, "verification", "check", `Switch-over: final snapshot moved (${Object.entries(r.migration.rows as Record<string, number>)
      .filter(([k]) => ["accounts", "contacts", "deals", "leads", "notes", "tasks"].includes(k)).map(([k, v]) => `${v} ${k}`).join(", ")}); data checks ${s} ` +
      `(${r.check.passed} of ${r.check.total}) in ${((t1.getTime() - t0.getTime()) / 1000).toFixed(0)} s. SuiteCRM's sales screens should stay read-only.`,
      { ...r, paused_from: t0, paused_until: t1 }, { important: true, origin: "tool", originDetail: { tool: "cutover" } });
    await q("UPDATE jobs SET updated_at = now() WHERE id = $1", [job.id]);
    console.log(`Final snapshot moved in ${r.seconds} s; data checks ${s} (${r.check.passed}/${r.check.total}).`);
    console.log("Restart `npm run crm -- serve " + job.id + "` to open the workspace on the final data.");
  } else {
    console.log("usage: npm run crm -- serve JOB [PORT] | remigrate JOB | cutover JOB FINAL.sql.gz");
  }
} finally {
  await pool.end();
}
