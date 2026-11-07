import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJob, jobById } from "../../lib/jobs";
import { answerQuestion } from "../../lib/actions";
import { pool, q } from "../../lib/db";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";
import { verifyWorkspace, WORKSPACE_STAGES } from "../../lib/workspace";

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"goose-workspace-test-"));
const jobs:string[]=[];
after(async()=>{for(const id of jobs){makeWritable(jobDir(id));fs.rmSync(jobDir(id),{recursive:true,force:true});}fs.rmSync(temporary,{recursive:true,force:true});await pool.end();});

test("workspace verification executes independently, refuses broken behavior and binds delivery to exact files",async()=>{
  const archive=path.join(temporary,"input.zip");fs.writeFileSync(archive,"Fixture only; intake tested separately");
  const created=await createJob({accountName:"Contract execution test",contactName:"Synthetic fixture",contactEmail:"fixture@example.invalid",kind:"demo",title:"Executable contract security",slug:"contract-security",timezone:"UTC",repoZip:archive,workspaceRequest:true});jobs.push(created.id);
  const job=(await jobById(created.id))!;job.repair_budget=0;
  const source=jobDir(job.id,"source"),work=jobDir(job.id,"work"),candidate=jobDir(job.id,"build","attempt-1","upgraded");
  for(const dir of [source,work,candidate])fs.mkdirSync(dir,{recursive:true});
  const original='const input=JSON.parse(process.argv[2]);console.log(JSON.stringify({sum:input.a+input.b}));';
  fs.writeFileSync(path.join(source,"calc.mjs"),original);
  const contract={version:1,title:"Preserve calculator and keep the verifier private",source_build:[],target_build:[],
    checks:[{id:"sum",title:"Addition is preserved",kind:"preserve",source:{argv:["node","calc.mjs",'{"a":2,"b":3}']},target:{argv:["node","calc.mjs",'{"a":2,"b":3}']},compare:"json"},
      {id:"isolation",title:"Candidate cannot read the original inputs or frozen expectations",kind:"requirement",target:{argv:["node","private.mjs"]},compare:"json",expected:{denied:true}}],deliverables:["calc.mjs","private.mjs"],limitations:["Synthetic isolation fixture"]};
  fs.writeFileSync(path.join(work,"accepted-plan.json"),JSON.stringify({workspace_contract:contract}));
  assert.equal((await WORKSPACE_STAGES.baseline(job,1)).next,"freeze");
  const frozen=await WORKSPACE_STAGES.freeze(job,1);job.checks_manifest_sha=frozen.patch!.checks_manifest_sha!;
  fs.writeFileSync(path.join(candidate,"calc.mjs"),original);
  fs.writeFileSync(path.join(candidate,"private.mjs"),`import fs from 'node:fs';const files=${JSON.stringify([jobDir(job.id,"vault","workspace-baseline.json"),jobDir(job.id,"inputs","repository.zip")])};let denied=true;for(const f of files){try{fs.readFileSync(f);denied=false;}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;}}console.log(JSON.stringify({denied}));`);
  fs.writeFileSync(jobDir(job.id,"build","attempt-1","change.diff"),"Fixture diff\n");
  assert.equal((await verifyWorkspace(job,1)).next,"package");
  const report=JSON.parse(fs.readFileSync(jobDir(job.id,"verify","attempt-1","report.json"),"utf8"));assert.equal(report.summary.failed,0);assert.equal(report.by_category.behavior.passed,2);
  assert.equal((await WORKSPACE_STAGES.package(job,1)).next,"delivered");
  fs.writeFileSync(path.join(candidate,"calc.mjs"),'console.log(JSON.stringify({sum:999}));');
  await assert.rejects(WORKSPACE_STAGES.package(job,1),/exact independently verified candidate/);
  const broken=await verifyWorkspace(job,1);assert.equal(broken.status,"waiting_founder");assert.match(broken.waiting!,/Repair budget/);
  fs.writeFileSync(path.join(candidate,"calc.mjs"),original);
  assert.equal((await verifyWorkspace(job,1)).next,"package");
  const evidence=jobDir(job.id,"vault","workspace-baseline.json");fs.chmodSync(evidence,0o644);fs.writeFileSync(evidence,JSON.stringify({sum:{sum:999}}));
  await assert.rejects(WORKSPACE_STAGES.package(job,1),/Frozen evidence changed/);
  const tampered=await verifyWorkspace(job,1);assert.equal(tampered.status,"waiting_founder");assert.match(tampered.waiting!,/Frozen acceptance/);
  await q("INSERT INTO questions(job_id,key,asked_by,audience,prompt,blocking,status) VALUES($1,'founder-only','verification','founder','Resolve verifier integrity',true,'open')",[job.id]);
  await assert.rejects(answerQuestion(job.id,"founder-only",{ok:true},"Synthetic customer","customer"),/designated audience/);
});
