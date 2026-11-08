// Live Naive company workflow against an upstream source URL. All approvals are synthetic.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "../lib/config";
import { one,pool,q } from "../lib/db";
import { sourceSnapshot } from "../lib/sourceSnapshot";
import { fetchRepoZip } from "../lib/github";
import { createJob,jobById,releaseDeadLeases,releaseLease,runCurrentStage } from "../lib/jobs";
import { IMPL_ALL } from "../lib/pipeline";
import { acceptProposal,acceptDelivery } from "../lib/actions";
import { jobSpend } from "../lib/records";
try {
 if(config.mode!=="naive")throw new Error("Live Naive is required");
 await releaseDeadLeases();let id=process.argv.find(x=>/^GS-\d+$/.test(x));
 if(!id){const file=process.argv[2];if(!file)throw new Error("Pass a JSON file with repository, revision, title and goal, or GS-id to resume");const input=JSON.parse(fs.readFileSync(file,"utf8"));const reuse=process.argv.find(x=>x.startsWith("--reuse-source="))?.split("=")[1];
 const previous=reuse?await jobById(reuse):null;if(reuse&&(!previous||previous.kind!=="demo"||previous.app_slug!=="autonomous-repository"))throw new Error("Source reuse requires a prior synthetic autonomous validation job");
 const source=reuse?{file:await sourceSnapshot(previous!),provenance:JSON.parse(fs.readFileSync(path.join(config.jobsDir,reuse,"inputs/github-source.json"),"utf8"))}:await (async()=>{const r=await fetchRepoZip(input.repository,input.revision??null,null);return {file:r.zipPath,provenance:r.source};})();
 if(source.provenance.url!==input.repository)throw new Error("Source provenance does not match requested repository");
  try{const created=await createJob({accountName:"Autonomous repository validation",contactName:"Synthetic harness",contactEmail:"autonomy@example.invalid",kind:"demo",acquiredVia:"Live autonomous validation on public upstream source",title:input.title,slug:"autonomous-repository",timezone:"UTC",repoZip:source.file,goal:input.goal,workspaceRequest:true,adaptiveRequest:true,...(source.provenance.provider==="github"?{repoSource:source.provenance}:{githubSource:source.provenance}),costLimitUsd:25});id=created.id;console.log(`Created ${id} from ${source.provenance.url}@${source.provenance.commit}; $25 cap; TEST approvals only.`);}finally{if(!reuse)fs.rmSync(path.dirname(source.file),{recursive:true,force:true});}}
 for(let step=0;step<40;step++){const job=(await jobById(id!))!;if(!job||job.kind!=="demo"||job.app_slug!=="autonomous-repository")throw new Error("Only this synthetic validation harness may auto-approve");console.log(`${new Date().toISOString()} ${job.id}: ${job.stage}/${job.status}, attempt ${job.attempt}`);
  if(job.stage==="awaiting_acceptance"){const p=await one<{version:number}>("SELECT version FROM proposals WHERE job_id=$1 AND status='sent' ORDER BY version DESC LIMIT 1",[id]);await acceptProposal(id!,p!.version,"Synthetic validation harness",null,"TEST approval after autonomous environment reproduction and independent acceptance review. No real customer agreement.");continue;}
  if(job.stage==="delivered"){await acceptDelivery(id!,"Synthetic validation harness",null,"TEST acceptance of verified upstream repository changes. No real customer or revenue.");continue;}
  if(job.status!=="running"){console.log(job.waiting_reason??"Completed");break;}
  const held=await q("UPDATE jobs SET lease_owner=$2,lease_expires_at=now()+interval '45 seconds' WHERE id=$1 AND (lease_owner IS NULL OR lease_expires_at<now()) RETURNING id",[id,`${os.hostname()}:${process.pid}`]);if(!held.length)throw new Error("Another worker owns this job");
  try{await runCurrentStage(job,IMPL_ALL);}finally{await releaseLease(id!);}
 }
 const job=(await jobById(id!))!;console.log(JSON.stringify({id,stage:job.stage,status:job.status,spend:await jobSpend(id!)}));if(job.stage!=="closed")process.exitCode=1;
}finally{await pool.end();}
