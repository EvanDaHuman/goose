// Real Naive execution on a synthetic repository. Never impersonates customer approval or payment.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { config } from "../lib/config";
import { one, pool, q } from "../lib/db";
import { createJob, jobById, releaseLease, runCurrentStage } from "../lib/jobs";
import { IMPL_ALL } from "../lib/pipeline";
import { acceptProposal, acceptDelivery } from "../lib/actions";
import { jobSpend } from "../lib/records";

try {
  if(config.mode!=="naive")throw new Error("This demonstration requires live Naive agents");
  const dir=path.join(config.varDir,"workspace-demo");fs.mkdirSync(dir,{recursive:true});
  let id=process.argv.find(x=>/^GS-\d+$/.test(x));
  if(!id) {
    const zip=path.join(dir,`routing-${Date.now()}.zip`);
    execFileSync("/usr/bin/zip",["-qr",zip,"."],{cwd:path.join(config.root,"demo/workspace-routing/repo")});
    const created=await createJob({accountName:"Routing engineering demonstration",contactName:"Synthetic test harness",contactEmail:"routing@example.invalid",kind:"demo",acquiredVia:"Synthetic full-workflow proof",title:"Route planning engine to Node.js with blocked-link support",slug:"workspace-routing",timezone:"UTC",repoZip:zip,costLimitUsd:20,workspaceRequest:true,
      goal:"Migrate planner.py to a Node.js command-line program planner.mjs, using only built-in modules. Preserve shortest-route behavior, validation, ties, unreachable routes, Unicode and fractional distances. Add optional blocked_edges containing undirected pairs that must not be traversed. Include a README explaining execution and the new field. Verify both preserved behavior and blocked-edge scenarios."});
    id=created.id;fs.writeFileSync(path.join(dir,"last-job.json"),JSON.stringify(created));
    console.log(`Created ${id}: live Naive, synthetic customer, $20 limit.`);
  }
  for(let step=0;step<32;step++) {
    const job=await jobById(id);
    if(!job||job.kind!=="demo"||job.app_slug!=="workspace-routing")throw new Error("Only the synthetic routing fixture can be auto-approved");
    console.log(`${new Date().toISOString()} ${id}: ${job.stage} / ${job.status} / attempt ${job.attempt}`);
    if(job.stage==="awaiting_acceptance") {
      const proposal=await one<{version:number}>("SELECT version FROM proposals WHERE job_id=$1 AND status='sent' ORDER BY version DESC LIMIT 1",[id]);
      await acceptProposal(id,proposal!.version,"Synthetic test harness",null,"TEST approval of this synthetic engineering fixture; no real customer agreement.");continue;
    }
    if(job.stage==="delivered") {await acceptDelivery(id,"Synthetic test harness",null,"TEST acceptance of verified synthetic output; no real revenue.");continue;}
    if(job.status!=="running"){console.log(job.waiting_reason??"Finished");break;}
    const held=await q("UPDATE jobs SET lease_owner=$2,lease_expires_at=now()+interval '45 seconds' WHERE id=$1 AND (lease_owner IS NULL OR lease_expires_at<now()) RETURNING id",[id,`${os.hostname()}:${process.pid}`]);
    if(!held.length)throw new Error("Another worker owns this job");
    try{await runCurrentStage(job,IMPL_ALL);}finally{await releaseLease(id);}
  }
  const job=(await jobById(id))!;
  console.log(JSON.stringify({job:id,stage:job.stage,status:job.status,spend:await jobSpend(id)}));
  if(job.stage!=="closed")process.exitCode=1;
}finally{await pool.end();}
