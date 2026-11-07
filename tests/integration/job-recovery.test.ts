import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pool, one, q } from "../../lib/db";
import { createJob, jobById, runCurrentStage } from "../../lib/jobs";
import { retryStage } from "../../lib/actions";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";

after(async () => { await pool.end(); });

test("explicit recovery resumes a blocked cached result using the correct round or implementation attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-recovery-"));
  const source = path.join(dir, "fixture.zip"); fs.writeFileSync(source, "synthetic stage fixture");
  try {
    for (const stage of ["plan", "implement"]) {
      const created = await createJob({ accountName: "Recovery fixture", kind: "demo", title: "Recovery", slug: "recovery", timezone: "UTC", repoZip: source });
      try {
        await q("UPDATE jobs SET stage=$2,round=3,attempt=2 WHERE id=$1", [created.id, stage]);
        let calls = 0;
        const impl = { [stage]: async () => (++calls === 1
          ? { next: stage, status: "waiting_founder" as const, waiting: "Synthetic recoverable failure" }
          : { next: "verify" }) };
        const original = (await jobById(created.id))!;
        await runCurrentStage(original, impl);
        assert.equal((await jobById(created.id))!.status, "waiting_founder");
        await retryStage(created.id, "Retry fixture", 0);
        await runCurrentStage((await jobById(created.id))!, impl);
        assert.equal((await jobById(created.id))!.stage, "verify");
        assert.equal(calls, 2);
        const row = await one<any>("SELECT runs,status FROM stage_runs WHERE job_id=$1 AND stage=$2 AND attempt=$3", [created.id, stage, stage === "plan" ? 3 : 2]);
        assert.equal(row.runs, 2); assert.equal(row.status, "succeeded");
        await runCurrentStage(original, impl); // A crash after completion must still reuse the result.
        assert.equal(calls, 2);
        await assert.rejects(retryStage(created.id, "Cannot retry active work"), /waiting for founder/);
      } finally { makeWritable(jobDir(created.id)); fs.rmSync(jobDir(created.id), { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
