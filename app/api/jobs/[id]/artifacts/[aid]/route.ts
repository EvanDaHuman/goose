import fs from "node:fs";
import path from "node:path";
import { one } from "@/lib/db";
import { customerJob, fail } from "@/lib/http";
import { requireOperator } from "@/lib/operatorAuth";

// Download an artifact. Customers (with their link) get customer-visible files; the operator view uses ops=1.
export async function GET(req: Request, { params }: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await params;
  const url = new URL(req.url);
  const ops = url.searchParams.get("ops") === "1";
  if(ops){const denied=await requireOperator(req);if(denied)return denied;}
  if (!ops && !(await customerJob(id, url.searchParams.get("t")))) return fail("not found", 404);
  if(!/^[1-9]\d*$/.test(aid))return fail("not found",404);
  const a = await one<{ path: string; customer_visible: boolean; label: string }>(
    "SELECT path, customer_visible, label FROM artifacts WHERE id = $1 AND job_id = $2", [Number(aid), id]);
  if (!a || (!ops && !a.customer_visible)) return fail("not found", 404);
  if (!fs.existsSync(a.path) || fs.statSync(a.path).isDirectory()) return fail("not a file", 404);
  const name = path.basename(a.path);
  const type = name.endsWith(".zip") ? "application/zip" : name.endsWith(".json") ? "application/json" : name.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8";
  return new Response(fs.readFileSync(a.path), { headers: { "content-type": type,
    "cache-control":"private, no-store","x-content-type-options":"nosniff","content-security-policy":"sandbox",
    "content-disposition": `${url.searchParams.get("inline") ? "inline" : "attachment"}; filename="${id}-${name}"` } });
}
