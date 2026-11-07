// The price of a job comes from its plan: a fixed pilot price per kind of work, plus size. Every line says why.
// The numbers are a pricing experiment (settings: pilot_offer), not a validated market rate.
export type Offer = { price_usd: number; price_code_usd?: number; price_data_usd?: number; cost_limit_usd: number; repair_budget: number; delivery_days: number };

export function quoteFor(plan: any, insp: any, offer: Offer) {
  const kind = plan.work_type as "code" | "data" | "combined";
  if (Array.isArray(plan.price_lines) && plan.price_lines.length) {   // recipes that price themselves (SuiteCRM sales workspace)
    const lines: { label: string; usd: number }[] = plan.price_lines.map((l: any) => ({ label: String(l.label), usd: Number(l.usd) }));
    const totalUsd = lines.reduce((n: number, l: { usd: number }) => n + l.usd, 0);
    return { lines, totalUsd, days: offer.delivery_days + 5, kind,
      note: "Pilot pricing experiment: a fixed price for a bounded sales-workflow move plus each customization carried over. Not a validated market rate." };
  }
  const base = kind === "code" ? offer.price_code_usd ?? 900 : kind === "data" ? offer.price_data_usd ?? 1200 : offer.price_usd ?? 1500;
  const lines: { label: string; usd: number }[] = [{ label: `${plan.title} (${kind === "code" ? "code only" : kind === "data" ? "data move" : "code and data"})`, usd: base }];
  const loc = insp?.size?.lines ?? 0;
  if (loc > 1000) lines.push({ label: `Size: ${loc.toLocaleString("en-US")} lines (over 1,000)`, usd: 150 * Math.ceil((loc - 1000) / 1000) });
  const tables = (insp?.components ?? []).filter((c: any) => c.kind === "table").length;
  if (kind !== "code" && tables > 6) lines.push({ label: `${tables} tables to move (over 6)`, usd: 100 * (tables - 6) });
  const agentChanges = (plan.changes ?? []).filter((c: any) => c.by === "agent").length;
  if (agentChanges) lines.push({ label: `${agentChanges} code change(s) made by the implementation agent`, usd: 200 * agentChanges });
  const totalUsd = lines.reduce((n, l) => n + l.usd, 0);
  return { lines, totalUsd, days: offer.delivery_days + (totalUsd > 2000 ? 3 : 0), kind,
    note: "Pilot pricing experiment: a fixed price per kind of work, adjusted for size. Not a validated market rate." };
}
