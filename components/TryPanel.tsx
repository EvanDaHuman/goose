"use client";

import { useState } from "react";

type Route = { method: string; path: string };
type Cfg = {
  listProducts?: Route; getProduct?: Route; placeOrder?: Route; cancelOrder?: Route;
  customerKey: string; listKey: string; productKey: string; qtyKey: string; stockKey: string; customerId: number;
};

async function call(jobId: string, method: string, path: string, body?: unknown, idempotencyKey?: string) {
  const r = await fetch(`/api/try/${jobId}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, path, body, idempotencyKey }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "request failed");
  return j as { status: number; ms: number; body: any };
}

/** Complete a real business task in the running upgraded app: take stock with an order, cancel it twice. */
export function TryPanel({ jobId, cfg }: { jobId: string; cfg: Cfg }) {
  const [log, setLog] = useState<{ label: string; line: string; ok: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [product, setProduct] = useState<any>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const add = (label: string, line: string, ok = true) => setLog((l) => [...l, { label, line, ok }]);
  const fill = (p: string, id: number | string) => p.replace(/\{[^}]+\}/, String(id));
  const stock = async (pid: number) => (await call(jobId, "GET", fill(cfg.getProduct!.path, pid))).body?.[cfg.stockKey];
  async function step(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { add("Error", (e as Error).message, false); } finally { setBusy(false); }
  }
  return (
    <div className="stack-sm">
      <div className="row">
        <button className="btn" disabled={busy || !cfg.listProducts} onClick={() => step(async () => {
          const r = await call(jobId, "GET", cfg.listProducts!.path);
          const p = (r.body as any[]).find((x) => x[cfg.stockKey] >= 5 && (x.active === undefined || x.active === 1));
          setProduct(p);
          add(`GET ${cfg.listProducts!.path}`, `${r.status} · ${(r.body as any[]).length} products · picked #${p.id} "${p.name ?? p.title}" with ${p[cfg.stockKey]} in stock`);
        })}>1. Pick a product</button>
        <button className="btn" disabled={busy || !product || !cfg.placeOrder} onClick={() => step(async () => {
          const body = { [cfg.customerKey]: cfg.customerId, [cfg.listKey]: [{ [cfg.productKey]: product.id, [cfg.qtyKey]: 2 }] };
          const r = await call(jobId, "POST", cfg.placeOrder!.path, body, `try-${Date.now()}`);
          setOrderId(r.body?.id ?? null);
          add(`POST ${cfg.placeOrder!.path}`, `${r.status} · order #${r.body?.id} · total ${r.body?.total ?? r.body?.amount_due} · stock now ${await stock(product.id)}`, r.status === 201);
        })}>2. Order 2 of it</button>
        <button className="btn" disabled={busy || !orderId || !cfg.cancelOrder} onClick={() => step(async () => {
          const r = await call(jobId, "POST", fill(cfg.cancelOrder!.path, orderId!));
          add(`POST ${fill(cfg.cancelOrder!.path, orderId!)}`, `${r.status} · status ${r.body?.status ?? r.body?.state} · stock now ${await stock(product.id)}`, r.status === 200);
        })}>3. Cancel it</button>
        <button className="btn" disabled={busy || !orderId || !cfg.cancelOrder} onClick={() => step(async () => {
          const r = await call(jobId, "POST", fill(cfg.cancelOrder!.path, orderId!));
          add(`POST ${fill(cfg.cancelOrder!.path, orderId!)} again`, `${r.status} · stock still ${await stock(product.id)} (the old app added it back twice)`, r.status === 200);
        })}>4. Cancel it again</button>
      </div>
      {log.length > 0 && (
        <ul className="checklist">
          {log.map((l, i) => <li key={i}><span className={`mark ${l.ok ? "ok" : "bad"}`}>{l.ok ? "✓" : "!"}</span>
            <span><code>{l.label}</code> <span className="muted">{l.line}</span></span></li>)}
        </ul>
      )}
    </div>
  );
}
