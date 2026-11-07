import { customerMessage } from "@/lib/actions";
import { customerJob, fail, json, wrap } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const b = await req.json();
    const job = await customerJob(id, b.t);
    if (!job) return fail("not found", 404);
    const body = String(b.body ?? "").trim().slice(0, 2000);
    if (!body) return fail("empty message");
    return json(await customerMessage(id, body));
  });
}
