// Export source-backed evidence, without customer workspace tokens or provider credentials.
import fs from "node:fs";
import path from "node:path";
import { pool, q } from "../lib/db";
import { jobById } from "../lib/jobs";
import { jobSpend } from "../lib/records";
import { J, readJson, sha256 } from "../lib/stages";

const id=process.argv[2],output=process.argv[3];
try {
  if(!/^GS-\d+$/.test(id??"")||!output)throw new Error("Usage: npm run workspace:evidence -- GS-id output.json");
  const job=await jobById(id);if(!job||job.recipe!=="workspace-change")throw new Error("No repository engineering job with this id");
  const reportFile=J(job,"verify",`attempt-${job.attempt}`,"report.json"),packageFile=J(job,"delivery","delivery.zip");
  const report=fs.existsSync(reportFile)?readJson(reportFile):null;
  const [attempts,sessions,stages,approvals,interventions,invoices,payments]=await Promise.all([
    q("SELECT attempt,total,passed,failed,skipped,integrity_ok,verdict,created_at FROM check_runs WHERE job_id=$1 ORDER BY attempt",[id]),
    q("SELECT session_id,role,purpose,model,status,stop_reason,consumed_micro_usd,created_at FROM naive_sessions WHERE job_id=$1 ORDER BY id",[id]),
    q("SELECT stage,attempt,status,runs,actor,started_at,finished_at,error FROM stage_runs WHERE job_id=$1 ORDER BY id",[id]),
    q("SELECT kind,decision,by_name,statement,at FROM approvals WHERE job_id=$1 ORDER BY id",[id]),
    q("SELECT kind,reason,minutes,at FROM interventions WHERE job_id=$1 ORDER BY id",[id]),
    q("SELECT number,status,is_test,amount_cents FROM invoices WHERE job_id=$1",[id]),
    q("SELECT p.method,p.is_test,p.amount_cents FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.job_id=$1",[id])]);
  const evidence={generated_at:new Date().toISOString(),job:{id,title:job.title,goal:job.goal,kind:job.kind,mode:job.mode,stage:job.stage,status:job.status},
    attempts,sessions,stages,approvals,interventions,invoices,payments,spend_micro_usd:await jobSpend(id),
    contract_manifest_sha256:job.checks_manifest_sha,verification:report,
    delivery:fs.existsSync(packageFile)?{sha256:sha256(packageFile),bytes:fs.statSync(packageFile).size}:null,
    claims:{synthetic_customer:job.kind==="demo",production_deployment:false,paid_real_customer:payments.some((p:any)=>!p.is_test),
      agent_work:"Live Naive assessment, implementation and coordinator sessions are listed above.",
      tool_work:"Source execution, stable baseline recording, independent comparisons, isolation, packaging and durable orchestration.",
      acceptance:job.kind==="demo"?"Synthetic fixture approvals, not real customer acceptance.":"See recorded customer approvals.",
      limitations:report?.not_tested??[]}};
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");
  console.log(`Exported actual workflow evidence for ${id} to ${output}`);
}finally{await pool.end();}
