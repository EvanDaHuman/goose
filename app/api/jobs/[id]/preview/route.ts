import { q, one } from "@/lib/db";
import { customerJob, fail, json, wrap } from "@/lib/http";
import { jobById } from "@/lib/jobs";
import { requireOperator } from "@/lib/operatorAuth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return wrap(async () => {
    const { id } = await params, url = new URL(req.url);
    if(url.searchParams.get("ops")==="1"){const denied=await requireOperator(req);if(denied)return denied;}
    const job = url.searchParams.get("ops") === "1" ? await jobById(id) : await customerJob(id, url.searchParams.get("t"));
    if (!job) return fail("Job not found", 404);
    if (job.recipe !== "agent-replatform" || !["delivered", "invoice", "follow_up", "closed"].includes(job.stage)) return fail("A verified migration delivery is required", 409);
    const check = await one<{ verdict: string }>("SELECT verdict FROM check_runs WHERE job_id=$1 AND attempt=$2", [id, job.attempt]);
    if (check?.verdict !== "pass") return fail("Delivery checks have not passed", 409);
    await q(`INSERT INTO showrooms(job_id,status) VALUES($1,'requested') ON CONFLICT(job_id) DO UPDATE SET
      status=CASE WHEN showrooms.status IN ('running','requested') THEN showrooms.status ELSE 'requested' END, detail=NULL, updated_at=now()`, [id]);
    return json({ requested: true });
  });
}
