import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createJob, jobById } from "../../lib/jobs";
import { addUpload, answerQuestion } from "../../lib/actions";
import { pool, q } from "../../lib/db";
import { jobDir } from "../../lib/config";
import { artifact, makeWritable } from "../../lib/stages";
import { verifyWorkspace, WORKSPACE_STAGES } from "../../lib/workspace";
import { sourceSnapshot } from "../../lib/sourceSnapshot";
import { cleanEnv, run } from "../../lib/proc";
import { observedOutput } from "../../lib/workspaceContract";

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"goose-workspace-test-"));
const jobs:string[]=[];
after(async()=>{for(const id of jobs){makeWritable(jobDir(id));fs.rmSync(jobDir(id),{recursive:true,force:true});}fs.rmSync(temporary,{recursive:true,force:true});await pool.end();});

test("oversized subprocess output cannot produce a passing comparison of only its tail",async()=>{
  const result=await run({cmd:process.execPath,args:["-e","process.stdout.write('uncompared-prefix'+ 'x'.repeat(2_100_000))"],cwd:temporary,env:cleanEnv(),timeoutMs:10000});
  assert.equal(result.code,0);assert.equal(result.stdoutTruncated,true);
  assert.throws(()=>observedOutput(result,"text"),/partial output/);
  assert.throws(()=>observedOutput(result,"json"),/partial output/);
});

test("agents use the source that passed intake, not an obsolete initial ZIP or a later unvalidated upload", async()=>{
  const first=path.join(temporary,"first.zip"),second=path.join(temporary,"second.zip");
  fs.writeFileSync(first,"initial source");fs.writeFileSync(second,"corrected source");
  const created=await createJob({accountName:"Source linkage test",kind:"demo",title:"Corrected upload",slug:"source-linkage",timezone:"UTC",repoZip:first,workspaceRequest:true});jobs.push(created.id);
  const job=(await jobById(created.id))!;
  await assert.rejects(sourceSnapshot(job),/No validated source snapshot/);
  const original=jobDir(job.id,"inputs","repository.zip");
  await artifact(job,"source_snapshot","Unchanged source snapshot",original,{by:"commercial",frozen:true});
  await addUpload(job.id,"repository",second,"corrected.zip");
  assert.equal(await sourceSnapshot(job),fs.realpathSync(original));
  const latest=(await q<{stored_path:string}>("SELECT stored_path FROM job_inputs WHERE job_id=$1 AND kind='repository' ORDER BY id DESC LIMIT 1",[job.id]))[0].stored_path;
  await artifact(job,"source_snapshot","Unchanged source snapshot",latest,{by:"commercial",frozen:true});
  assert.equal(await sourceSnapshot(job),fs.realpathSync(latest));
  fs.chmodSync(latest,0o644);fs.writeFileSync(latest,"tampered after intake");
  await assert.rejects(sourceSnapshot(job),/changed after intake/);
});

test("workspace verification executes independently, refuses broken behavior and binds delivery to exact files",async()=>{
  const archive=path.join(temporary,"input.zip");fs.writeFileSync(archive,"Fixture only; intake tested separately");
  const created=await createJob({accountName:"Contract execution test",contactName:"Synthetic fixture",contactEmail:"fixture@example.invalid",kind:"demo",title:"Executable contract security",slug:"contract-security",timezone:"UTC",repoZip:archive,workspaceRequest:true});jobs.push(created.id);
  const job=(await jobById(created.id))!;job.repair_budget=0;
  const source=jobDir(job.id,"source"),work=jobDir(job.id,"work"),candidate=jobDir(job.id,"build","attempt-1","upgraded");
  for(const dir of [source,work,candidate])fs.mkdirSync(dir,{recursive:true});
  const original='const input=JSON.parse(process.argv[2]);console.log(JSON.stringify({sum:input.a+input.b}));';
  fs.writeFileSync(path.join(source,"calc.mjs"),original);
  const outsideSecret=path.join(temporary,"other-customer-upload.txt"),outsideWrite=path.join(temporary,"outside-write.txt");
  fs.writeFileSync(outsideSecret,"Another customer's confidential upload");
  const contract={version:1,title:"Preserve calculator and keep the verifier private",source_build:[],target_build:[],
    checks:[{id:"sum",title:"Addition is preserved",kind:"preserve",source:{argv:["node","calc.mjs",'{"a":2,"b":3}']},target:{argv:["node","calc.mjs",'{"a":2,"b":3}']},compare:"json"},
      {id:"isolation",title:"Candidate cannot read private evidence, shared temporary uploads, or parent process information, or write outside its workspace",kind:"requirement",target:{argv:["node","private.mjs"]},compare:"json",expected:{denied:true,writeDenied:true,parentInfoDenied:true,localWrite:true}}],deliverables:["calc.mjs","private.mjs","README.md"],limitations:["Synthetic isolation fixture"]};
  fs.writeFileSync(path.join(work,"accepted-plan.json"),JSON.stringify({workspace_contract:contract}));
  assert.equal((await WORKSPACE_STAGES.baseline(job,1)).next,"freeze");
  const frozen=await WORKSPACE_STAGES.freeze(job,1);job.checks_manifest_sha=frozen.patch!.checks_manifest_sha!;
  fs.writeFileSync(path.join(candidate,"calc.mjs"),original);
  fs.writeFileSync(path.join(candidate,"README.md"),"Run node calc.mjs with a JSON argument.");
  fs.writeFileSync(path.join(candidate,"private.mjs"),`import fs from 'node:fs';import {spawnSync} from 'node:child_process';const files=${JSON.stringify([jobDir(job.id,"vault","workspace-baseline.json"),jobDir(job.id,"inputs","repository.zip"),outsideSecret])};let denied=true;for(const f of files){try{fs.readFileSync(f);denied=false;}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e;}}let writeDenied=false;try{fs.writeFileSync(${JSON.stringify(outsideWrite)},'host toolchain poisoned');}catch(e){if(e.code==='EPERM'||e.code==='EACCES')writeDenied=true;else throw e;}const parent=spawnSync('/bin/ps',['eww','-p',${JSON.stringify(String(process.pid))}],{encoding:'utf8'});const parentInfoDenied=parent.status!==0||!parent.stdout.includes(${JSON.stringify(String(process.pid))});fs.writeFileSync('local-proof.txt','allowed');console.log(JSON.stringify({denied,writeDenied,parentInfoDenied,localWrite:fs.existsSync('local-proof.txt')}));`);
  fs.writeFileSync(jobDir(job.id,"build","attempt-1","change.diff"),"Fixture diff\n");
  assert.equal((await verifyWorkspace(job,1)).next,"package");
  assert.equal(fs.existsSync(outsideWrite),false);
  assert.equal(fs.readFileSync(outsideSecret,"utf8"),"Another customer's confidential upload");
  const report=JSON.parse(fs.readFileSync(jobDir(job.id,"verify","attempt-1","report.json"),"utf8"));assert.equal(report.summary.failed,0);assert.equal(report.by_category.behavior.passed,2);
  assert.equal((await WORKSPACE_STAGES.package(job,1)).next,"delivered");
  fs.rmSync(path.join(candidate,"README.md"));fs.mkdirSync(path.join(candidate,"README.md"));
  assert.equal((await verifyWorkspace(job,1)).status,"waiting_founder");
  const missingFile=JSON.parse(fs.readFileSync(jobDir(job.id,"verify","attempt-1","report.json"),"utf8"));
  assert.equal(missingFile.checks.find((c:any)=>c.id==="deliverable:README.md").status,"fail");
  fs.rmSync(path.join(candidate,"README.md"),{recursive:true});fs.writeFileSync(path.join(candidate,"README.md"),"Run node calc.mjs with a JSON argument.");
  assert.equal((await verifyWorkspace(job,1)).next,"package");
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

test("a changed robotics verifier stops before running a build or asking agents to repair customer code",async()=>{
  const archive=path.join(temporary,"verifier-input.zip");fs.writeFileSync(archive,"Synthetic fixture");
  const created=await createJob({accountName:"Verifier amendment test",kind:"demo",title:"Verifier drift",slug:"verifier-drift",timezone:"UTC",repoZip:archive,workspaceRequest:true});jobs.push(created.id);
  const job=(await jobById(created.id))!;
  const vault=jobDir(job.id,"vault");fs.mkdirSync(vault,{recursive:true});
  fs.writeFileSync(path.join(vault,"robotics-verifier.json"),JSON.stringify({version:-1,files:{}}));
  const digest=(file:string)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(path.join(vault,"MANIFEST.json"),JSON.stringify({"robotics-verifier.json":digest(path.join(vault,"robotics-verifier.json"))}));
  job.checks_manifest_sha=digest(path.join(vault,"MANIFEST.json"));
  const result=await verifyWorkspace(job,1);
  assert.equal(result.status,"waiting_founder");
  const report=JSON.parse(fs.readFileSync(jobDir(job.id,"verify","attempt-1","report.json"),"utf8"));
  assert.equal(report.integrity.ok,false);
  assert.equal(report.checks.find((c:any)=>c.id==="verifier_version").status,"fail");
  assert.equal(report.checks.some((c:any)=>c.id==="target_build"),false);
  assert.equal(fs.existsSync(jobDir(job.id,"runtime","workspace-verify-1")),false);
});
