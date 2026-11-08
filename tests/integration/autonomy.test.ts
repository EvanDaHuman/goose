// Autonomous recovery (lib/autonomy.ts): every job that stops for the founder is resolved without a person.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { one, pool, q } from "../../lib/db";
import { createJob } from "../../lib/jobs";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";
import { classify, serviceAutonomy } from "../../lib/autonomy";
import { DOCKER_WAIT } from "../../lib/infraWait";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "goose-autonomy-"));
const source = path.join(temp, "source.zip"); fs.writeFileSync(source, "synthetic autonomy fixture, never executed");
const made: string[] = [];
after(async () => { for (const id of made) { makeWritable(jobDir(id)); fs.rmSync(jobDir(id), { recursive: true, force: true }); } fs.rmSync(temp, { recursive: true, force: true }); await pool.end(); });

const base = { auto_recoveries: 0, auto_extra_repairs: 0, cost_limit_micro_usd: 25_000_000, mode: "naive" };

test("classification: retry transient failures, raise limits and repairs within bounds, end what cannot be done safely", () => {
  assert.equal(classify(`${DOCKER_WAIT} No agent task was started.`, base).action, "infra");
  assert.equal(classify("Discovery agent stopped: the service is at capacity", base).action, "retry");
  assert.equal(classify('"Planning the work" failed: ECONNRESET', base).action, "retry");
  assert.equal(classify("Spending limit reached: $25 of $25 used", base).action, "raise_limit");
  assert.equal(classify("Spending limit reached: $50 of $50 used", { ...base, cost_limit_micro_usd: 50_000_000 }).action, "end");
  assert.equal(classify("Repair budget exhausted", base).action, "extra_repair");
  assert.equal(classify("Repair budget exhausted", { ...base, auto_extra_repairs: 2 }).action, "end");
  assert.equal(classify("Frozen acceptance evidence changed", base).action, "end");
  assert.equal(classify("Autonomous environment/test discovery exhausted eight bounded attempts. See evidence.", base).action, "end");
  assert.equal(classify("A data decision needs the founder", base).action, "route_question");
  assert.equal(classify("Autonomous discovery requires live Naive", { ...base, mode: "local" }).action, "end");
  assert.equal(classify("Autonomous discovery requires live Naive", base).action, "retry");
  assert.equal(classify("Implementation stopped: timeout", { ...base, auto_recoveries: 6 }).action, "end", "retries are bounded");
  const now = Date.now();
  assert.equal(classify("Implementation stopped: timeout", { ...base, auto_recoveries: 2 }, now, now - 60_000).action, "backoff", "retries back off");
  assert.equal(classify("Implementation stopped: timeout", { ...base, auto_recoveries: 2 }, now, now - 9 * 60_000).action, "retry");
});

test("the worker resolves waiting jobs: retries resume, impossible ones end with a customer message, none need the founder", async () => {
  const retry = (await createJob({ accountName: "Autonomy retry", kind: "demo", title: "Retry", slug: "auto-retry", timezone: "UTC", repoZip: source })).id;
  const stop = (await createJob({ accountName: "Autonomy end", kind: "demo", title: "End", slug: "auto-end", timezone: "UTC", repoZip: source })).id;
  const limit = (await createJob({ accountName: "Autonomy limit", kind: "demo", title: "Limit", slug: "auto-limit", timezone: "UTC", repoZip: source, costLimitUsd: 10 })).id;
  made.push(retry, stop, limit);
  await q("UPDATE jobs SET status='waiting_founder', waiting_reason='Discovery agent stopped: the service is at capacity' WHERE id=$1", [retry]);
  await q("UPDATE jobs SET status='waiting_founder', waiting_reason='Frozen acceptance evidence changed' WHERE id=$1", [stop]);
  await q("UPDATE jobs SET status='waiting_founder', waiting_reason='Spending limit reached: $10 of $10 used; next step needs $2' WHERE id=$1", [limit]);
  const done = await serviceAutonomy();
  const by = Object.fromEntries(done.map((d) => [d.id, d.action]));
  assert.equal(by[retry], "retry"); assert.equal(by[stop], "end"); assert.equal(by[limit], "raise_limit");
  const r = (await one<any>("SELECT status,auto_recoveries FROM jobs WHERE id=$1", [retry]))!;
  assert.equal(r.status, "running"); assert.equal(r.auto_recoveries, 1);
  const s = (await one<any>("SELECT stage,status FROM jobs WHERE id=$1", [stop]))!;
  assert.deepEqual([s.stage, s.status], ["rejected", "rejected"]);
  assert.match((await one<any>("SELECT body FROM messages WHERE job_id=$1 ORDER BY id DESC LIMIT 1", [stop]))!.body, /Nothing has been invoiced/);
  const l = (await one<any>("SELECT status,cost_limit_micro_usd FROM jobs WHERE id=$1", [limit]))!;
  assert.equal(l.status, "running"); assert.equal(Number(l.cost_limit_micro_usd), 15_000_000);
  assert.equal(Number((await one<any>("SELECT count(*)::int AS n FROM interventions WHERE job_id = ANY($1)", [[retry, stop, limit]]))!.n), 0, "no founder interventions recorded");
  // the retried job, failing again right away, waits out its backoff rather than looping
  await q("UPDATE jobs SET status='waiting_founder', waiting_reason='Discovery agent stopped again' WHERE id=$1", [retry]);
  assert.ok(!(await serviceAutonomy()).some((d) => d.id === retry));
  assert.equal((await one<any>("SELECT status FROM jobs WHERE id=$1", [retry]))!.status, "waiting_founder");
});
