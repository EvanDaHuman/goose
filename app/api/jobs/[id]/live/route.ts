import { NextResponse } from "next/server";
import { jobByToken } from "@/lib/jobs";
import { liveCode } from "@/lib/liveCode";
import { requireOperator } from "@/lib/operatorAuth";

// The code the geese walk on in the job's live run: the latest real diff, or the customer's source while the agent works.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = new URL(req.url);
  const ops = u.searchParams.get("ops") === "1";
  if (ops) { const denied = await requireOperator(req); if (denied) return denied; }
  if (!ops && !(await jobByToken(id, u.searchParams.get("t") ?? ""))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const live = await liveCode(id);
  return live ? NextResponse.json(live, { headers: { "Cache-Control": "private, no-store" } }) : NextResponse.json({ error: "no code yet" }, { status: 404 });
}
