// Write every job's outcome (including failed attempts, repairs and founder time) to a Markdown file, so the
// record survives a reset. Usage: npm run history -- docs/evidence/build-history.md "why this export was made"
import fs from "node:fs";
import { pool, q } from "../lib/db";

const out = process.argv[2] ?? "docs/evidence/history.md";
const why = process.argv[3] ?? "";
const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

const jobs = await q<any>(`SELECT j.id, j.title, j.kind, j.stage, j.status, j.waiting_reason, j.test_fault, j.created_at, a.acquired_via
  FROM jobs j JOIN accounts a ON a.id = j.account_id ORDER BY j.id`);
const runs = await q<any>("SELECT job_id, attempt, verdict, passed, failed, skipped, total FROM check_runs ORDER BY job_id, attempt");
const repairs = await q<any>("SELECT job_id, attempt, diagnoses, outcome FROM repairs ORDER BY job_id, attempt");
const interventions = await q<any>("SELECT job_id, kind, minutes FROM interventions ORDER BY at");
const costs = await q<any>("SELECT job_id, SUM(micro_usd)::bigint micro FROM cost_entries GROUP BY job_id");
const resumed = await q<any>("SELECT job_id, stage, runs FROM stage_runs WHERE runs > 1");

const lines = [`# Job history export`, "", `Exported ${new Date().toISOString()} from the company database.${why ? ` ${why}` : ""}`, "",
  "Every job is a demonstration job with synthetic data unless marked real. Costs are estimates at Naive's published computer rate (local mode).", "",
  "| Job | What | Final state | Check runs (attempt: verdict passed/total) | Repairs | Founder | Cost |", "| --- | --- | --- | --- | --- | --- | --- |"];
for (const j of jobs) {
  const cr = runs.filter((r) => r.job_id === j.id).map((r) => `${r.attempt}: ${r.verdict} ${r.passed}/${r.total}${r.skipped ? ` (${r.skipped} skipped)` : ""}`).join("; ") || "-";
  const rp = repairs.filter((r) => r.job_id === j.id).map((r) => `${(r.diagnoses ?? []).map((d: any) => d.signature).join(", ") || "no known signature"} -> ${r.outcome}`).join("; ") || "-";
  const iv = interventions.filter((i) => i.job_id === j.id);
  const rs = resumed.filter((r) => r.job_id === j.id).map((r) => `${r.stage} resumed (${r.runs} runs)`);
  const state = `${j.stage} / ${j.status}${j.waiting_reason ? `: ${String(j.waiting_reason).slice(0, 90)}` : ""}${rs.length ? `; ${rs.join(", ")}` : ""}`;
  const what = `${j.title}${j.kind === "real" ? " (REAL)" : ""}${j.test_fault ? ` - TEST FAULT ${j.test_fault}` : ""} (via ${j.acquired_via ?? "?"})`;
  lines.push(`| ${j.id} | ${what} | ${state} | ${cr} | ${rp} | ${iv.length ? `${iv.map((i) => i.kind).join(", ")} (${iv.reduce((n, i) => n + i.minutes, 0)} min)` : "-"} | ${usd(Number(costs.find((c) => c.job_id === j.id)?.micro ?? 0))} |`.replaceAll("\n", " "));
}
const total = costs.reduce((n, c) => n + Number(c.micro), 0);
lines.push("", `Totals: ${jobs.length} jobs, ${runs.length} check runs (${runs.filter((r) => r.verdict !== "pass").length} failed), ` +
  `${repairs.length} repairs, ${interventions.length} founder interventions (${interventions.reduce((n, i) => n + i.minutes, 0)} min), ` +
  `recorded cost ${usd(total)} including failed attempts.`);
fs.writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${out} (${jobs.length} jobs)`);
await pool.end();
