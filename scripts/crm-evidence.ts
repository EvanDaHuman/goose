// Writes the evidence record of a SuiteCRM job from its own database rows and files (nothing typed by hand).
//   npm run crm:evidence -- JOB [docs/evidence/JOB.md]
import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config";
import { pool, q } from "../lib/db";
import { jobById } from "../lib/jobs";

const id = process.argv[2];
const out = process.argv[3] ?? `docs/evidence/${id}.md`;
const J = (...p: string[]) => path.join(config.varDir, "jobs", id, ...p);
const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const job = (await jobById(id))!;
const att = job.attempt;
const insp = read(J("work", "inspection.json"));
const rec = read(J("baseline", "recording.json"));
const rep = read(J("verify", `attempt-${att}`, "report.json"));
const mig = read(J("build", `attempt-${att}`, "migration.json"));
const cfg = read(J("build", `attempt-${att}`, "delivered", "config.json"));
const man = read(J("vault", "MANIFEST.json"));
const plans = await q<any>("SELECT version, author, changed_because, created_at, plan FROM plans WHERE job_id = $1 ORDER BY version", [id]);
const qs = await q<any>("SELECT key, prompt, answer, answered_by, answered_at FROM questions WHERE job_id = $1 ORDER BY id", [id]);
const prop = await q<any>("SELECT version, price_cents, status, decided_at FROM proposals WHERE job_id = $1 ORDER BY version", [id]);
const approvals = await q<any>("SELECT kind, decision, by_name, statement, at FROM approvals WHERE job_id = $1 ORDER BY id", [id]);
const ev = await q<any>("SELECT at, actor, origin, summary FROM events WHERE job_id = $1 AND important ORDER BY id", [id]);
const costs = await q<any>(`SELECT stage, basis, COUNT(*)::int AS n, SUM(quantity)::float AS seconds, SUM(micro_usd)::bigint AS micro
                            FROM cost_entries WHERE job_id = $1 GROUP BY stage, basis ORDER BY MIN(id)`, [id]);
const inter = await q<any>("SELECT kind, reason, minutes, at FROM interventions WHERE job_id = $1 ORDER BY id", [id]);
const sessions = await q<any>("SELECT session_id, role, status, consumed_micro_usd FROM naive_sessions WHERE job_id = $1", [id]);
const stageRuns = await q<any>("SELECT stage, attempt, status, started_at, finished_at FROM stage_runs WHERE job_id = $1 ORDER BY id", [id]).catch(() => []);
const pkg = (await q<any>("SELECT sha256, path FROM artifacts WHERE job_id = $1 AND kind = 'delivery_package' ORDER BY id DESC LIMIT 1", [id]))[0];
const total = costs.reduce((n: number, c: any) => n + Number(c.micro), 0);
const first = ev[0]?.at ? new Date(ev[0].at) : null;
const delivered = ev.find((e: any) => e.summary.startsWith("Delivery package ready"))?.at;
const mins = first && delivered ? Math.round((new Date(delivered).getTime() - first.getTime()) / 1000) : null;
const L: string[] = [];
const p = (s = "") => L.push(s);
p(`# SuiteCRM job: ${job.title} (${id})`);
p();
p(`Generated from the job's own records by \`scripts/crm-evidence.ts\` on ${new Date().toISOString().slice(0, 19)}Z.`);
p();
p((job.kind === "demo" ? `**Demonstration job**: ${job.title} is a made-up business and every record is synthetic. ` : "") + `**Mode: ${job.mode}** (` +
  (job.mode === "local" ? "deterministic tools on this machine; no AI model was called and no Naive session ran" : "live agents on Naive") + ").");
p();
p("## Outcome");
p(`- Verdict: **${rep.summary.verdict.toUpperCase()}**, ${rep.summary.passed} of ${rep.summary.total} checks (${rep.summary.mandatory_total} mandatory), frozen ${man.frozen_at}, integrity ${rep.integrity.ok ? "verified" : "BROKEN"}.`);
p(`- Fixed price quoted: $${((prop.at(-1)?.price_cents ?? 0) / 100).toLocaleString("en-US")} (pricing experiment); proposal ${prop.at(-1)?.status}.`);
p(`- From the first step to the delivery package: ${mins !== null ? `${Math.floor(mins / 60)} min ${mins % 60} s` : "n/a"}. Compute: ${(total / 1e6).toFixed(4)} USD ` +
  "(seconds of local compute priced at Naive's published computer rate; an estimate, nothing was billed).");
p(`- Naive sessions: ${sessions.length}. Founder interventions: ${inter.length}${inter.length ? ` (${inter.map((x: any) => `${x.kind}: ${x.reason}`).join("; ")}; ` +
  `${inter.reduce((n: number, x: any) => n + Number(x.minutes || 0), 0)} min in all)` : ""}.`);
p(`- Customer approvals (kept apart from founder interventions): ${approvals.map((a: any) => `${a.kind} ${a.decision} by ${a.by_name}`).join("; ") || "none yet"}; ` +
  `customer answers: ${qs.filter((x: any) => x.answered_by).length}.`);
p(`- Delivery package SHA-256: \`${pkg?.sha256 ?? "n/a"}\`.`);
p();
p("## What was inspected");
p(`SuiteCRM ${insp.stack.framework_version}; ${insp.size.files.toLocaleString("en-US")} PHP files (vendor excluded), ${insp.size.tables} tables, ` +
  `${insp.size.sales_rows.toLocaleString("en-US")} sales records. Findings:`);
for (const f of insp.findings) p(`- **[${f.severity}] ${f.title}.** ${f.detail}`);
p();
p("## The plan and the customer's decisions");
for (const pl of plans) p(`- Plan v${pl.version} (${pl.author})${pl.changed_because ? `: ${pl.changed_because}` : ""}`);
for (const x of qs) p(`- Question \`${x.key}\`: ${x.prompt} Answer: **${JSON.stringify(x.answer?.decision ?? x.answer)}** by ${x.answered_by ?? "-"}.`);
const last = plans.at(-1)?.plan;
if (last) {
  p(`- Recommended: ${last.title}.`);
  p(`- Stays in SuiteCRM: ${(last.stays_in_original ?? []).filter((s: any) => s.rows).map((s: any) => `${s.module} (${s.rows})`).join(", ")}.`);
  p(`- Across the boundary: ${(last.boundary ?? []).map((b: any) => `${b.from} → ${b.to} (${b.rows})`).join("; ")}.`);
  p(`- Architecture: ${last.target?.architecture}.`);
}
p();
p("## The original's behaviour, recorded on a disposable copy");
p(`${Object.keys(rec.users).length} users (sign-in: ${Object.entries(rec.users).map(([n, u]: any) => `${n} ${u.can_sign_in ? "yes" : "no"}`).join(", ")}); ` +
  `${rec.views.length} record openings, ${rec.edits.length} edits, ${rec.deletes.length} deletes; ${rec.scenarios.length} approval scenarios: ` +
  rec.scenarios.map((s: any) => s.id).join(", ") + ".");
const quirks = new Set((rec.observations ?? []).map((o: any) => o.what.replace(/(contacts|notes|tasks|accounts|leads|opportunities)/, "records")));
p(`Observed SuiteCRM behaviour nobody planted: ${[...quirks].join("; ")}.`);
p();
p("## Implementation and data move");
p(`Template configured from the inspection: ${cfg.stages.length} stages, approval rule (threshold $${cfg.approval_rule.threshold_usd?.toLocaleString("en-US")}, ` +
  `${cfg.approval_rule.compares}, role '${cfg.approval_rule.manager_role}', from ${cfg.approval_rule.source?.file}), custom fields ${cfg.custom_fields.map((c: any) => c.column).join(", ")}.`);
p(`Moved in ${mig.seconds} s: ${Object.entries(mig.rows).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
p(`Left in SuiteCRM: ${Object.entries(mig.left_in_suitecrm).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
p();
p("## Verification by area");
p("| Area | Passed | Failed | Skipped |");
p("| --- | --- | --- | --- |");
for (const c of Object.values(rep.by_category) as any[]) p(`| ${c.title} | ${c.pass} | ${c.fail} | ${c.skip} |`);
if (rep.failed.length) { p(); p("Failed:"); for (const f of rep.failed) p(`- \`${f.id}\` ${f.title}`); }
p();
p("Not tested:");
for (const x of rep.not_tested) p(`- ${x}`);
p();
p("## Cost by step");
p("| Step | Basis | Entries | Seconds | USD |");
p("| --- | --- | --- | --- | --- |");
for (const c of costs) p(`| ${c.stage} | ${c.basis} | ${c.n} | ${Number(c.seconds).toFixed(1)} | ${(Number(c.micro) / 1e6).toFixed(5)} |`);
p();
p("## Timeline (important events, with where each came from)");
for (const e of ev) p(`- ${new Date(e.at).toISOString().slice(11, 19)} · ${e.actor} · ${e.origin ?? "-"} · ${e.summary}`);
if (stageRuns.length) { p(); p(`Stage runs: ${stageRuns.map((s: any) => `${s.stage}#${s.attempt} ${s.status}`).join(", ")}.`); }
const notes = process.env.EVIDENCE_NOTES ? fs.readFileSync(process.env.EVIDENCE_NOTES, "utf8") : "";
fs.writeFileSync(out, L.join("\n") + "\n" + (notes ? `\n## Notes\n\n${notes}` : ""));
console.log(`wrote ${out}`);
await pool.end();
