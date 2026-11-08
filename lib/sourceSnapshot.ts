import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { one } from "./db";
import { jobDir } from "./config";
import type { Job } from "./jobs";

/** Use the last source that actually passed intake, never a later unvalidated upload. */
export async function sourceSnapshot(job: Pick<Job, "id">): Promise<string> {
  const snapshot = await one<{ path: string; sha256: string | null }>(
    "SELECT path,sha256 FROM artifacts WHERE job_id=$1 AND kind='source_snapshot' AND frozen ORDER BY created_at DESC,id DESC LIMIT 1", [job.id]);
  if (!snapshot?.sha256 || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new Error("No validated source snapshot is available; run intake before assessment");
  const inputs = fs.realpathSync(jobDir(job.id, "inputs"));
  const real = fs.realpathSync(snapshot.path);
  if (!real.startsWith(inputs + path.sep) || !fs.statSync(real).isFile()) throw new Error("The validated source snapshot is outside the job inputs");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(real)).digest("hex");
  if (actual !== snapshot.sha256) throw new Error("The validated source snapshot changed after intake; source must be reassessed");
  return real;
}
