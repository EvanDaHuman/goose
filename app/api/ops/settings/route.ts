import { q } from "@/lib/db";
import { fail, json, wrap } from "@/lib/http";
import { pilotOffer } from "@/lib/jobs";
import { addIntervention } from "@/lib/records";

// Change the pilot offer (applies to new proposals only).
export async function POST(req: Request) {
  return wrap(async () => {
    const b = await req.json();
    const offer = { ...(await pilotOffer()) } as Record<string, unknown>;
    for (const k of ["price_usd", "price_code_usd", "price_data_usd", "cost_limit_usd", "repair_budget", "delivery_days"]) {
      if (b[k] !== undefined) {
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v < 0) return fail(`bad ${k}`);
        offer[k] = v;
      }
    }
    await q("INSERT INTO settings (key, value) VALUES ('pilot_offer', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [JSON.stringify(offer)]);
    await addIntervention(null, "pilot_offer", `Founder changed the pilot offer: ${JSON.stringify(b)}`, offer, 1);
    return json({ ok: true, offer });
  });
}
