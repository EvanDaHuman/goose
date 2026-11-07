import { one, q } from "@/lib/db";
import { fail, json, wrap } from "@/lib/http";
import { pilotOffer } from "@/lib/jobs";
import { draftByTemplate } from "@/lib/growthRules";
import { logEvent } from "@/lib/records";

// The operator asks for an outreach draft from the fixed template (the growth cycle uses the outreach agent when live).
// It is stored as a draft. Nothing is sent: sending needs the founder, outside this system.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const p = await one<any>("SELECT * FROM prospects WHERE id = $1", [Number(id)]);
    if (!p) return fail("not found", 404);
    const offer = await pilotOffer();
    const d = draftByTemplate(p, p.qualification ?? null, offer.price_usd);
    const draft = `Subject: ${d.subject}\n\n${d.body}`;
    await q("UPDATE prospects SET outreach_draft = $2, status = 'draft_ready', drafted_by = 'template (operator)', drafted_at = now(), updated_at = now() WHERE id = $1", [p.id, draft]);
    await logEvent(null, "outreach", "decision", `Drafted outreach for ${p.name} (not sent).`, { prospect: p.url });
    return json({ ok: true });
  });
}
