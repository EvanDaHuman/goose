export function paymentStatus() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const mode = key.startsWith("sk_live_") ? "live" : "test";
  const missing = [!/^sk_(test|live)_/.test(key) ? "STRIPE_SECRET_KEY" : null, !process.env.STRIPE_WEBHOOK_SECRET ? "STRIPE_WEBHOOK_SECRET" : null, !process.env.GOOSE_PUBLIC_URL ? "GOOSE_PUBLIC_URL" : null].filter(Boolean);
  const issues:string[]=[];
  if(process.env.GOOSE_PUBLIC_URL) {
    try {
      const url = new URL(process.env.GOOSE_PUBLIC_URL);
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password) issues.push("GOOSE_PUBLIC_URL must be an HTTP(S) origin without credentials");
      else if(mode==="live"&&url.protocol!=="https:") issues.push("Live Stripe checkout requires an HTTPS GOOSE_PUBLIC_URL");
    } catch {issues.push("GOOSE_PUBLIC_URL is not a valid URL");}
  }
  const ready=missing.length===0&&issues.length===0;
  return { provider: "stripe", ready, missing, issues, mode,
    detail: ready ? "Checkout settlement is recorded only from a verified Stripe webhook."
      : issues.length ? issues.join(". ") : "Configure STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and GOOSE_PUBLIC_URL. Demonstration invoices support explicit local test settlement." };
}

export function publicBaseUrl() {
  const u = new URL(process.env.GOOSE_PUBLIC_URL ?? process.env.APP_BASE_URL ?? `http://localhost:${process.env.GOOSE_PORT ?? "3100"}`);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error("Invalid public application URL");
  return u.origin;
}
export async function createStripeCheckout(invoice: { id: number; job_id: string; number: string; is_test: boolean; amount_cents: number; currency: string }, token: string, generation = "first") {
  const config = paymentStatus();
  if (!config.ready) throw new Error(config.detail);
  if (invoice.is_test !== (config.mode === "test")) throw new Error("Invoice and Stripe key modes do not match; test and real money cannot mix");
  const base = publicBaseUrl();
  if (config.mode === "live" && !base.startsWith("https://")) throw new Error("Live checkout requires an HTTPS public URL");
  const back = `${base}/jobs/${encodeURIComponent(invoice.job_id)}?t=${encodeURIComponent(token)}`;
  const form = new URLSearchParams({ mode: "payment", success_url: back + "&payment=processing", cancel_url: back + "&payment=cancelled",
    client_reference_id: String(invoice.id), "metadata[invoice_id]": String(invoice.id), "metadata[job_id]": invoice.job_id,
    "line_items[0][price_data][currency]": invoice.currency.toLowerCase(), "line_items[0][price_data][unit_amount]": String(invoice.amount_cents),
    "line_items[0][price_data][product_data][name]": `Goose ${invoice.number}`, "line_items[0][quantity]": "1" });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `goose-invoice-${invoice.id}-${generation}` }, body: form, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Stripe checkout returned HTTP ${res.status}`);
  const session = await res.json() as any;
  if (typeof session.id !== "string" || typeof session.url !== "string" || session.livemode !== !invoice.is_test) throw new Error("Stripe returned an invalid checkout session");
  const url = new URL(session.url);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("Stripe returned an unexpected checkout URL");
  return { provider: "stripe", id: session.id, url: session.url, isTest: invoice.is_test };
}
