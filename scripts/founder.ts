// Founder actions from the terminal. Each one is recorded as a founder intervention.
//   npm run founder -- rebuild GS-1004 "reason"     re-run a job from code generation after a playbook fix
//   npm run founder -- limit GS-1004 30 "reason"    set a job's spending limit (USD)
//   npm run founder -- retry GS-1004 "reason"       retry the step a job stopped at
//   npm run founder -- replan GS-1004 "reason"      inspect and plan a job again (after a tool fix, before acceptance)
//   npm run founder -- note GS-1004 5 "what"        record founder time spent on a job
import * as act from "../lib/actions";
import { pool } from "../lib/db";

const [cmd, id, a, b] = process.argv.slice(2);
try {
  if (cmd === "rebuild") await act.rebuildFromGeneration(id, a ?? "");
  else if (cmd === "limit") await act.raiseCostLimit(id, Number(a), b ?? "");
  else if (cmd === "retry") await act.retryStage(id, a ?? "");
  else if (cmd === "replan") await act.replan(id, a ?? "");
  else if (cmd === "note") await act.logFounderTime(id, Number(a), b ?? "");
  else throw new Error("usage: founder rebuild|limit|retry|replan|note JOB ...");
  console.log(`${cmd} ${id}: done`);
} finally {
  await pool.end();
}
