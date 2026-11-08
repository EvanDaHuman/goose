import { processStripeEvent } from "@/lib/commerce";
import { verifySignature } from "@/lib/integrations/webhooks";
import { fail, json } from "@/lib/http";
export async function POST(req: Request) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) return fail("Stripe webhook is not configured", 503);
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 1_000_000) return fail("Event is too large", 413);
  try { verifySignature(raw, req.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return fail("Invalid webhook signature", 401); }
  try { return json(await processStripeEvent(raw)); }
  catch (e) { return fail(e instanceof Error ? e.message : "Event rejected", 400); }
}
