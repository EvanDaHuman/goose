import { addUpload, answerQuestion } from "@/lib/actions";
import { q } from "@/lib/db";
import { customerJob, fail, json, saveUpload, wrap } from "@/lib/http";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params;
    const form = await req.formData();
    const job = await customerJob(id, String(form.get("t")));
    if (!job) return fail("not found", 404);
    const file = form.get("file");
    const kind = form.get("kind") === "repository" ? "repository" : "database";
    if (!(file instanceof File) || !file.size) return fail("no file");
    const p = await saveUpload(file, kind === "repository" ? 50 * 1024 * 1024 : 500 * 1024 * 1024);
    await addUpload(id, kind, p, file.name);
    const open = await q<{ key: string }>("SELECT key FROM questions WHERE job_id = $1 AND status = 'open' AND (key = 'Q-db' OR key LIKE 'upload-%')", [id]);
    for (const x of open) await answerQuestion(id, x.key, { uploaded: file.name }, "Customer", "customer");
    return json({ ok: true });
  });
}
