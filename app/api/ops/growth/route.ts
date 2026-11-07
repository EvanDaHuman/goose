import { requestGrowthCycle } from "@/lib/growth";
import { json, wrap } from "@/lib/http";
import { logEvent } from "@/lib/records";

// The operator asks for a growth cycle now. The worker runs it (the web app never does the work itself).
export async function POST() {
  return wrap(async () => {
    await requestGrowthCycle();
    await logEvent(null, "founder", "decision", "Asked for a growth cycle now (research, qualification, outreach drafts).", undefined, { origin: "human" });
    return json({ ok: true });
  });
}
