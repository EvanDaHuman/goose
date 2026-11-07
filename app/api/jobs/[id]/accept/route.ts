import { acceptProposal } from "@/lib/actions";
import { customerJob, fail, json, wrap } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const b = await req.json();
    const job = await customerJob(id, b.t);
    if (!job) return fail("not found", 404);
    const name = String(b.name ?? "").trim();
    if (name.length < 2) return fail("Please type your name to accept.");
    await acceptProposal(id, Number(b.version), job.kind === "demo" ? `${name} (demonstration visitor)` : name, b.email || null, String(b.statement));
    return json({ ok: true });
  });
}
