import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pool, one, q } from "../../lib/db";
import { createJob, jobById } from "../../lib/jobs";
import { acceptProposal, declineProposal, acceptDelivery, replan } from "../../lib/actions";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";

const temp=fs.mkdtempSync(path.join(os.tmpdir(),"goose-approval-"));
const source=path.join(temp,"source.zip");fs.writeFileSync(source,"synthetic approval fixture, never executed");
const made:string[]=[];
after(async()=>{for(const id of made){makeWritable(jobDir(id));fs.rmSync(jobDir(id),{recursive:true,force:true});}fs.rmSync(temp,{recursive:true,force:true});await pool.end();});
async function fixture(){
  const created=await createJob({accountName:"Approval fixture",kind:"demo",title:"Approval concurrency",slug:"approval",timezone:"UTC",repoZip:source});
  made.push(created.id);await q("UPDATE jobs SET stage='awaiting_acceptance',status='waiting_customer' WHERE id=$1",[created.id]);return created;
}
async function proposal(id:string,version=1,status="sent"){
  const scope={detail:{version},plan:{decision:"proceed",title:`Frozen version ${version}`}};
  const sha=crypto.createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  await q(`INSERT INTO proposals(job_id,version,scope,summary,price_cents,cost_limit_micro_usd,delivery_days,status,scope_sha256)
    VALUES($1,$2,$3,'{}',110000,3000000,3,$4,$5)`,[id,version,JSON.stringify(scope),status,sha]);return scope;
}
async function countApprovals(id:string,kind="proposal"){return (await one<{n:number}>("SELECT count(*)::int AS n FROM approvals WHERE job_id=$1 AND kind=$2",[id,kind]))!.n;}

test("proposal acceptance freezes only the current open version and concurrent acceptance records one decision",async()=>{
  const job=await fixture();await proposal(job.id,1);const current=await proposal(job.id,2);
  await assert.rejects(acceptProposal(job.id,1,"Fixture",null,"Accept stale"),/version is not open/);
  await assert.rejects(declineProposal(job.id,1,"Fixture","Decline stale"),/version is not open/);
  assert.equal(await countApprovals(job.id),0);
  const decisions=await Promise.allSettled([acceptProposal(job.id,2,"Fixture",null,"Accept current"),acceptProposal(job.id,2,"Fixture",null,"Duplicate")]);
  assert.equal(decisions.filter(r=>r.status==="fulfilled").length,1);assert.equal(await countApprovals(job.id),1);
  assert.equal((await jobById(job.id))!.stage,"baseline");
  assert.deepEqual(JSON.parse(fs.readFileSync(jobDir(job.id,"work","accepted-plan.json"),"utf8")),current.plan);
  assert.deepEqual(JSON.parse(fs.readFileSync(jobDir(job.id,"work","scope.json"),"utf8")),current.detail);
  await assert.rejects(declineProposal(job.id,2,"Fixture","Stale open browser"),/waiting for acceptance/);
  await q("UPDATE jobs SET stage='verify',status='waiting_founder' WHERE id=$1",[job.id]);
  await assert.rejects(replan(job.id,"Cannot erase accepted work",0),/before its proposal/);
  assert.equal((await one<any>("SELECT status FROM proposals WHERE job_id=$1 AND version=2",[job.id]))!.status,"accepted");
});

test("replanning preserves historical runs, revalidates source and refuses an accepted audit or active worker",async()=>{
  const job=await fixture();await proposal(job.id);
  await q("INSERT INTO stage_runs(job_id,stage,attempt,status,actor,mode,output) VALUES($1,'inspect',1,'succeeded','assessment','local','{\"evidence\":\"retained\"}'),($1,'baseline',1,'failed','verification','local','{}')",[job.id]);
  const before=await q("SELECT * FROM stage_runs WHERE job_id=$1 ORDER BY id",[job.id]);
  await replan(job.id,"Inspect a corrected request",0);
  assert.equal((await jobById(job.id))!.stage,"intake");assert.equal((await jobById(job.id))!.round,2);
  assert.deepEqual(await q("SELECT * FROM stage_runs WHERE job_id=$1 ORDER BY id",[job.id]),before);
  assert.equal((await one<any>("SELECT status FROM proposals WHERE job_id=$1",[job.id]))!.status,"superseded");
  await q("UPDATE jobs SET lease_owner='fixture:worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1",[job.id]);
  await assert.rejects(replan(job.id,"Worker in flight",0),/active worker/);
  await q("UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]);
  await q("INSERT INTO approvals(job_id,kind,decision,by_name,statement) VALUES($1,'proposal','accepted','Fixture','Accepted audit survives stale state')",[job.id]);
  await assert.rejects(replan(job.id,"Stale stage cannot override approval",0),/before its proposal/);
  assert.deepEqual(await q("SELECT * FROM stage_runs WHERE job_id=$1 ORDER BY id",[job.id]),before);
});

test("simultaneous acceptance versus replan or decline has one durable winner",async()=>{
  for(const other of ["replan","decline"]){
    const job=await fixture();await proposal(job.id);
    const results=await Promise.allSettled([acceptProposal(job.id,1,"Fixture",null,"Acceptance race"),other==="replan"?replan(job.id,"Replan race",0):declineProposal(job.id,1,"Fixture","Decline race")]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    const row=(await one<any>("SELECT status FROM proposals WHERE job_id=$1",[job.id]))!;
    const current=(await jobById(job.id))!;
    if(row.status==="accepted"){assert.equal(current.stage,"baseline");assert.equal(await countApprovals(job.id),1);}
    else if(other==="replan"){assert.equal(row.status,"superseded");assert.equal(current.stage,"intake");assert.equal(await countApprovals(job.id),0);}
    else{assert.equal(row.status,"declined");assert.equal(current.stage,"declined");assert.equal(await countApprovals(job.id),1);}
  }
});

test("delivery acceptance requires unchanged package bytes and concurrent requests cannot duplicate approval",async()=>{
  const job=await fixture();await q("UPDATE jobs SET stage='delivered' WHERE id=$1",[job.id]);
  await assert.rejects(acceptDelivery(job.id,"Fixture",null,"Missing package"),/missing/);
  const file=jobDir(job.id,"package.zip"),content="verified synthetic delivery";fs.writeFileSync(file,content);
  const sha=crypto.createHash("sha256").update(content).digest("hex");
  await q("INSERT INTO artifacts(job_id,kind,label,path,sha256,created_by,frozen) VALUES($1,'delivery_package','Verified fixture',$2,$3,'coordinator',true)",[job.id,file,sha]);
  fs.writeFileSync(file,"changed after verification");
  await assert.rejects(acceptDelivery(job.id,"Fixture",null,"Tampered package"),/integrity check failed/);
  assert.equal(await countApprovals(job.id,"delivery"),0);assert.equal((await jobById(job.id))!.stage,"delivered");
  fs.writeFileSync(file,content);
  const results=await Promise.allSettled([acceptDelivery(job.id,"Fixture",null,"Accept delivery"),acceptDelivery(job.id,"Fixture",null,"Duplicate delivery")]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(await countApprovals(job.id,"delivery"),1);assert.equal((await jobById(job.id))!.stage,"invoice");
});
