// Explicit live proof, never a growth cycle or a real-customer approval.
// GOOSE_MODE=naive npm run migration:demo [-- GS-id] resumes the same durable job.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../lib/config";
import { one, pool, q } from "../lib/db";
import { createJob, jobById, releaseLease, runCurrentStage } from "../lib/jobs";
import { IMPL_ALL } from "../lib/pipeline";
import { acceptProposal } from "../lib/actions";
import { jobSpend } from "../lib/records";

try {
  if (config.mode !== "naive") throw new Error("This proof requires GOOSE_MODE=naive and a configured Naive key");
  const dir = path.join(config.varDir, "migration-demo"); fs.mkdirSync(dir, { recursive: true });
  let id = process.argv.find(x => /^GS-\d+$/.test(x));
  if (!id) {
    const db = path.join(dir, `source-${Date.now()}.sqlite`), zip = path.join(dir, `source-${Date.now()}.zip`);
    execFileSync(config.python.engine, ["demo/migration-ledger/seed.py", db], { stdio: "inherit" });
    execFileSync("/usr/bin/zip", ["-qr", zip, "."], { cwd: path.join(config.root, "demo/migration-ledger/repo") });
    const j = await createJob({ accountName: "Migration Ledger (synthetic proof)", contactName: "Automated demonstration harness", kind: "demo", acquiredVia: "Synthetic verification fixture",
      title: "Customer ledger to Rust with new customer tiers", slug: "migration-ledger", timezone: "UTC", repoZip: zip, dbFile: db, costLimitUsd: 25,
      goal: "Migrate the complete customer ledger service to Rust. Preserve all existing API responses and customer history. Add customer tier defaulting to standard for all existing and new customers. Add /v2/customer endpoints to create/read/update tiers (standard or vip), and a segments table seeded with standard and vip, exposed at /v2/segments. Verify invalid writes, new records and persistence after restart.",
      constraints: ["keep_api", "keep_database"], migrationRequest: { target: "rust", dataChanges: "Add tier TEXT NOT NULL DEFAULT 'standard' to customers. Add segments(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE), seed ids 1 standard and 2 vip. Preserve the old endpoints' exact shapes; expose tier using /v2/customers and /v2/customers/<id>." } });
    id = j.id; fs.writeFileSync(path.join(dir, "last-job.json"), JSON.stringify(j));
    console.log(`Created ${id}. Synthetic approvals only; $25 ceiling, at most two repairs.`);
  }
  let steps = 0;
  for (; steps < 30; steps++) {
    const job = (await jobById(id))!;
    if (!job || job.kind !== "demo" || job.app_slug !== "migration-ledger") throw new Error("Only the synthetic migration-ledger fixture can be auto-approved");
    console.log(`${new Date().toISOString()} ${id} ${job.stage} ${job.status} attempt=${job.attempt}`);
    if (job.stage === "awaiting_acceptance") {
      const p = (await one<{ version: number }>("SELECT version FROM proposals WHERE job_id=$1 AND status='sent' ORDER BY version DESC LIMIT 1", [id]))!;
      await acceptProposal(id, p.version, "Automated demonstration harness", null, "SYNTHETIC TEST APPROVAL: preauthorized fixture scope only. This is not customer acceptance or revenue.");
      continue;
    }
    if (job.status !== "running") { console.log(job.waiting_reason); break; }
    // Reserve only this job. Ordinary workers cannot race the explicit proof harness.
    const held = await q("UPDATE jobs SET lease_owner=$2,lease_expires_at=now()+interval '45 seconds' WHERE id=$1 AND (lease_owner IS NULL OR lease_expires_at<now()) RETURNING id", [id, `${(await import('node:os')).hostname()}:${process.pid}`]);
    if (!held.length) throw new Error("The job is already being processed by another worker");
    try { await runCurrentStage(job, IMPL_ALL); } finally { await releaseLease(id); }
  }
  const job = (await jobById(id))!;
  console.log(JSON.stringify({ job: id, stage: job.stage, status: job.status, spend: await jobSpend(id) }));
  if (job.stage !== "delivered") process.exitCode = 1;
} finally { await pool.end(); }
