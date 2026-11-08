import { createInquiry } from "@/lib/commerce";
import { digest, verifySignature } from "@/lib/integrations/webhooks";
import { fail, json } from "@/lib/http";
import { one, q } from "@/lib/db";
export async function POST(req: Request) {
  if (!process.env.GOOSE_INQUIRY_WEBHOOK_SECRET) return fail("Inquiry webhook is not configured", 503);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 25_000) return fail("Inquiry is too large", 413);
  try { verifySignature(raw, req.headers.get("x-goose-signature"), process.env.GOOSE_INQUIRY_WEBHOOK_SECRET); }
  catch { return fail("Invalid webhook signature", 401); }
  try {
    const b = JSON.parse(raw);
    if (typeof b.event_id !== "string" || !/^[\w.:-]{1,150}$/.test(b.event_id)) return fail("A provider event_id is required");
    const old = await one<any>("SELECT payload_sha256 FROM commerce_webhook_events WHERE provider='inquiry' AND event_id=$1", [b.event_id]);
    if (old) return old.payload_sha256 === digest(raw) ? json({ received: true, duplicate: true }) : fail("Conflicting event replay");
    const inquiry = await createInquiry(b, "signed_inbound_webhook", { id: b.event_id, payloadHash: digest(raw) });
    await q("INSERT INTO commerce_webhook_events(provider,event_id,event_type,payload_sha256) VALUES('inquiry',$1,'inquiry.received',$2) ON CONFLICT DO NOTHING", [b.event_id, digest(raw)]);
    return json({ received: true, inquiry });
  } catch (e) { return fail(e instanceof Error ? e.message : "Invalid inquiry"); }
}
