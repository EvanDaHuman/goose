import { checkout, createTicket, customerCommerce, settleTestInvoice, subscribeMaintenance } from "@/lib/commerce";
import { customerJob, fail, json, wrap } from "@/lib/http";
import { assertSameOrigin } from "@/lib/operatorAuth";
import { q } from "@/lib/db";
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    if (!(await customerJob(id, new URL(req.url).searchParams.get("t")))) return fail("Not found", 404);
    const res = json(await customerCommerce(id)); res.headers.set("Cache-Control","private, no-store"); return res;
  });
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = assertSameOrigin(req); if (denied) return denied;
  return wrap(async () => {
    const { id } = await params;
    const raw = await req.text(); if (Buffer.byteLength(raw) > 25_000) return fail("Request is too large", 413);
    const b = JSON.parse(raw);
    if (!(await customerJob(id, b.t))) return fail("Not found", 404);
    switch (b.action) {
      case "checkout": return json(await checkout(id));
      case "test_checkout": return json(await settleTestInvoice(id));
      case "support": return json(await createTicket(id, b), 201);
      case "maintenance": return json(await subscribeMaintenance(id, b), 201);
      case "maintenance_pause": await q("UPDATE commerce_maintenance SET status='paused' WHERE job_id=$1", [id]); return json({ ok: true });
      case "maintenance_cancel": await q("UPDATE commerce_maintenance SET status='cancelled' WHERE job_id=$1", [id]); return json({ ok: true });
      default: return fail("Unknown customer operation");
    }
  });
}
