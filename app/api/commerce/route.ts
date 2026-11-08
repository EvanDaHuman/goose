import { requireOperator } from "@/lib/operatorAuth";
import { json, wrap, fail } from "@/lib/http";
import { checkout, commerceDashboard, draftEmail, linkInquiry, positiveId, reconcileEmail, resolveTicket, runMaintenanceChecks, sendEmail, serviceCommerce, setTransactionalPolicy, settleTestInvoice } from "@/lib/commerce";

export async function GET(req: Request) {
  const denied = await requireOperator(req); if (denied) return denied;
  return wrap(async () => { const res = json(await commerceDashboard()); res.headers.set("Cache-Control","private, no-store"); return res; });
}
export async function POST(req: Request) {
  const denied = await requireOperator(req); if (denied) return denied;
  return wrap(async () => {
    const b = await req.json();
    switch (b.action) {
      case "transactional_policy": return json(await setTransactionalPolicy(b));
      case "service_run": return json(await serviceCommerce());
      case "link_inquiry": return json(await linkInquiry(positiveId(b.inquiryId), String(b.jobId)));
      case "draft_email": return json(await draftEmail(b));
      case "send_email": return json(await sendEmail(positiveId(b.id), b.authorization));
      case "reconcile_email": return json(await reconcileEmail(positiveId(b.id), b.outcome, b.reason, b.providerReference));
      case "checkout": return json(await checkout(String(b.jobId)));
      case "test_payment": return json(await settleTestInvoice(String(b.jobId)));
      case "resolve_ticket": return json(await resolveTicket(positiveId(b.id), b.resolution));
      case "maintenance_run": return json({ checks: await runMaintenanceChecks(b.planId ? positiveId(b.planId) : undefined) });
      default: return fail("Unknown business operation");
    }
  });
}
