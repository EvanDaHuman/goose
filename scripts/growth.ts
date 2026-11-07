// Run one growth cycle now (research, qualification, outreach drafts) and print what it did. Nothing is sent.
//   npm run growth
import { pool } from "../lib/db";
import { runGrowthCycle } from "../lib/growth";

try {
  const r = await runGrowthCycle("started from the command line");
  console.log(r.ran ? `Growth cycle: ${r.found} new prospect(s), ${r.qualified} qualified, ${r.drafted} draft(s), $${(r.spent_micro_usd / 1e6).toFixed(4)} spent, ${r.seconds} s.`
    : `Not run: ${r.why}.`);
} finally {
  await pool.end();
}
