import { answerQuestion } from "@/lib/actions";
import { customerJob, fail, json, wrap } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const b = await req.json();
    const job = await customerJob(id, b.t);
    if (!job) return fail("not found", 404);
    const acc = job.kind === "demo" ? "Demonstration visitor (acting as the customer)" : "Customer";
    await answerQuestion(id, String(b.key), b.answer ?? {}, acc, "customer");
    return json({ ok: true });
  });
}
