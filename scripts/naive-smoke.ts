// First live check of the agent team on Naive. Needs VETTA_API_KEY (and an active plan with credits). It:
//   1. checks readiness (key, scopes, plan, balance, model),
//   2. provisions the four agents and the coordinator's board (safe to run twice),
//   3. runs ONE small typed session with the coordinator (budget 0.20 USD) and prints its result, cost and session id.
// Writes docs/evidence/naive-smoke.md either way, so the result (or the exact missing requirement) is on record.
//   npm run naive:smoke
import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config";
import { pool, q } from "../lib/db";
import { naiveClient, naiveStatus, NEEDED_SCOPES } from "../lib/naive/client";
import { runAgentTask } from "../lib/naive/run";
import { provisionTeam } from "../lib/naive/team";

const out = path.join(config.root, "docs", "evidence", "naive-smoke.md");
const lines = ["# Naive live check", "", `Run ${new Date().toISOString()} by \`npm run naive:smoke\`. Model: ${config.naive.model}.`, ""];
try {
  const s = await naiveStatus();
  lines.push(`Readiness: **${s.state}** - ${s.message}`);
  if (s.state !== "ready") {
    lines.push("", "No session was started. To run this check:", "",
      "1. Create a Naive organization, start a plan and add credits (a person with a card has to do this).",
      `2. Create a key: \`vetta keys create --name goose --scopes ${NEEDED_SCOPES.join(",")}\`.`,
      "3. Put it in `.env` as `VETTA_API_KEY=...` and set `GOOSE_MODE=naive`.", "4. Run `npm run naive:smoke` again.");
  } else {
    const c = naiveClient();
    const team = await provisionTeam(c);
    lines.push("", "Provisioning:", ...team.report.map((r) => `- ${r}`), `- board ${team.boardId}`);
    await q("INSERT INTO accounts (id, name, kind) OVERRIDING SYSTEM VALUE VALUES (999998, 'Naive smoke test', 'demo') ON CONFLICT DO NOTHING");
    await q(`INSERT INTO jobs (id, account_id, title, kind, app_slug, timezone, mode, stage, status, responsible, repair_budget, cost_limit_micro_usd, customer_token, pipeline, goal)
             VALUES ('SMOKE', 999998, 'Naive smoke test', 'demo', 'smoke', 'UTC', 'naive', 'closed', 'done', 'coordinator', 0, 1000000, 'smoke', 2, 'smoke test')
             ON CONFLICT (id) DO NOTHING`);
    const r = await runAgentTask(c, { jobId: "SMOKE", stage: "smoke", attempt: Math.floor(Date.now() / 1000), role: "coordinator", purpose: "smoke",
      title: "Live smoke test", message: "This is a connectivity check. Submit ok=true and one sentence saying who you are.",
      outputSchema: { type: "object", additionalProperties: false, required: ["ok", "who"], properties: { ok: { type: "boolean" }, who: { type: "string" } } },
      budgetMicroUsd: 200_000, timeoutMs: 5 * 60_000 });
    lines.push("", r.ok ? `Session **${r.sessionId}** completed on model ${r.model}: ${JSON.stringify(r.output)}. Metered cost ${(r.consumedMicroUsd / 1e6).toFixed(4)} USD.`
      : `Session ${r.sessionId ?? "(not started)"} did not complete: ${r.reason} - ${r.message}`);
  }
} catch (e) {
  lines.push("", `Error: ${(e as Error).message}`);
} finally {
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  await pool.end();
}
