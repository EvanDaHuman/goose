import { NextResponse } from "next/server";
import { jobByToken } from "@/lib/jobs";
import { sourceLines } from "@/lib/views";
import { requireOperator } from "@/lib/operatorAuth";

// A few lines of the customer's own source snapshot (read-only), for the links on findings and the application map.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = new URL(req.url);
  const ops = u.searchParams.get("ops") === "1";
  if(ops){const denied=await requireOperator(req);if(denied)return denied;}
  if (!ops && !(await jobByToken(id, u.searchParams.get("t") ?? ""))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const r = sourceLines(id, u.searchParams.get("path") ?? "", Number(u.searchParams.get("line")) || null);
  return r ? NextResponse.json(r,{headers:{"Cache-Control":"private, no-store"}}) : NextResponse.json({ error: "no such file" }, { status: 404 });
}
