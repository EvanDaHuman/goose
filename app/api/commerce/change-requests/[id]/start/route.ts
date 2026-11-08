import fs from "node:fs";
import path from "node:path";
import { one } from "@/lib/db";
import { positiveId, startChangeRequest } from "@/lib/commerce";
import { customerJob, fail, json, saveUpload, wrap } from "@/lib/http";
import { assertSameOrigin } from "@/lib/operatorAuth";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = assertSameOrigin(req); if (denied) return denied;
  return wrap(async () => {
    const { id } = await params;
    const request = await one<any>("SELECT * FROM commerce_change_requests WHERE id=$1", [positiveId(id)]);
    const form = await req.formData();
    if (!request || !(await customerJob(request.parent_job_id, String(form.get("t") ?? "")))) return fail("Not found", 404);
    const repository = form.get("repository"), database = form.get("database");
    if (!(repository instanceof File) || !repository.name.toLowerCase().endsWith(".zip")) return fail("Upload a fresh source ZIP for the follow-up job");
    const files: string[] = [];
    try {
      const repoZip = await saveUpload(repository, 30 * 1024 * 1024); files.push(repoZip);
      const dbFile = database instanceof File && database.size ? await saveUpload(database, 50 * 1024 * 1024) : undefined;
      if (dbFile) files.push(dbFile);
      return json(await startChangeRequest(positiveId(id), { repoZip, dbFile, target: String(form.get("target") ?? "") || undefined }), 201);
    } finally { for (const file of files) fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });
}
