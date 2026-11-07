import { one } from "@/lib/db";
import { customerJob, fail, json, wrap } from "@/lib/http";

// A live business task against the running copy of the delivered app ("showroom"). Requests are
// proxied to 127.0.0.1 only; the app itself runs sandboxed, started by the worker.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const job = await one<{ recipe: string }>("SELECT recipe FROM jobs WHERE id=$1", [id]);
    const query = new URL(req.url).searchParams;
    if (job?.recipe === "agent-replatform" && query.get("ops") !== "1" && !await customerJob(id, query.get("t"))) return fail("Job not found", 404);
    const room = await one<{ status: string; port: number }>("SELECT status, port FROM showrooms WHERE job_id = $1", [id]);
    if (!room || room.status !== "running") return fail("The upgraded app is not running. Start it from the operator view.", 409);
    const b = await req.json();
    const method = String(b.method ?? "GET").toUpperCase();
    const p = String(b.path ?? "/");
    if (!p.startsWith("/") || p.startsWith("//") || /[\\\r\n]/.test(p) || p.includes("..")) return fail("bad path");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return fail("unsupported method");
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${room.port}${p}`, {
      method, headers: { "content-type": "application/json", ...(b.idempotencyKey ? { "Idempotency-Key": String(b.idempotencyKey) } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(b.body ?? {}), redirect: "error", signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return json({ status: r.status, ms: Date.now() - t0, body });
  });
}
