import { declineProposal } from "@/lib/actions";
import { customerJob, fail, json, wrap } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const b = await req.json();
    const job = await customerJob(id, b.t);
    if (!job) return fail("not found", 404);
    await declineProposal(id, Number(b.version), String(b.name ?? "Customer"), String(b.reason ?? ""));
    return json({ ok: true });
  });
}
