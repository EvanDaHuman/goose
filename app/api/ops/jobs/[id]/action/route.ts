import * as act from "@/lib/actions";
import { q } from "@/lib/db";
import { fail, json, wrap } from "@/lib/http";
import { addIntervention } from "@/lib/records";

// Founder interventions. Every one is recorded in the interventions table with its reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const b = await req.json();
    switch (b.action) {
      case "raise_limit": await act.raiseCostLimit(id, Number(b.usd), String(b.reason ?? "Founder approved more spend for this job.")); break;
      case "grant_repair": await act.grantRepairAttempt(id, String(b.reason ?? "")); break;
      case "inject_fault": await act.injectTestFault(id, String(b.fault)); break;
      case "retry": await act.retryStage(id, String(b.reason ?? "")); break;
      case "test_payment": await act.recordTestPayment(id); break;
      case "founder_time": await act.logFounderTime(id, Number(b.minutes ?? 0), String(b.note ?? "Founder time")); break;
      case "answer_founder_question": await act.answerQuestion(id, String(b.key), b.answer ?? {}, "Founder", "founder"); break;
      case "showroom_start":
        await q(`INSERT INTO showrooms (job_id, status) VALUES ($1, 'requested')
                 ON CONFLICT (job_id) DO UPDATE SET status = 'requested', detail = NULL, updated_at = now()`, [id]);
        await addIntervention(id, "showroom", "Founder asked for a running copy of the delivered app (for a demonstration).", undefined, 0);
        break;
      case "showroom_stop": await q("UPDATE showrooms SET status = 'stop_requested', updated_at = now() WHERE job_id = $1", [id]); break;
      default: return fail("unknown action");
    }
    return json({ ok: true });
  });
}
