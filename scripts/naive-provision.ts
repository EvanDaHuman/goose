// Create (or find) the four Goose agents on Naive, give the coordinator its roster and board.
// Safe to run twice. Needs VETTA_API_KEY and an organization with an active plan.
import { pool } from "../lib/db";
import { naiveClient, naiveStatus, describeError } from "../lib/naive/client";
import { provisionTeam } from "../lib/naive/team";

try {
  const s = await naiveStatus();
  if (s.state !== "ready") {
    console.error(`Naive is not ready: ${s.state} - ${s.message}`);
    process.exitCode = 2;
  } else {
    const r = await provisionTeam(naiveClient());
    console.log("provisioned:", JSON.stringify(r, null, 2));
  }
} catch (e) {
  console.error("provisioning failed:", describeError(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
