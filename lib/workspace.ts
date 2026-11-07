// Repository engineering jobs share the company's approvals, budgets, ledger and delivery lifecycle.
// Executable contracts are frozen outside the implementation workspace. Source and target run on copies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { config } from "./config";
import { one, q } from "./db";
import type { Job, StageResult } from "./jobs";
import { changeWithAgent, afterFailedVerification } from "./agents";
import { naiveClient } from "./naive/client";
import { uploadFile } from "./naive/files";
import { runAgentTask } from "./naive/run";
import { cleanEnv, run } from "./proc";
import { logEvent, recordCompute } from "./records";
import { J, artifact, copyFresh, ctxFor, engineSandbox, intake as sourceIntake, makeReadOnly, makeWritable, mkdir, py, readJson, sha256, walk } from "./stages";
import { availablePrograms, commandProblems, CONTRACT_SHAPE, observedOutput, workspaceProblems, type Command, type WorkspaceContract } from "./workspaceContract";

const recipe = "workspace-change";
const provenance = { origin: "tool" as const, originDetail: { tool: "independent workspace verifier" } };
const save = (file:string,value:unknown) => { mkdir(path.dirname(file));fs.writeFileSync(file,JSON.stringify(value,null,2)); };
export const isWorkspace = (job: Job) => job.recipe === recipe || fs.existsSync(J(job,"inputs","workspace-request.json"));
const contract = (job:Job) => readJson(J(job,"vault","workspace-contract.json")) as WorkspaceContract;
function treeDigest(dir:string) {
  return crypto.createHash("sha256").update(JSON.stringify(walk(dir).filter(f=>fs.statSync(f).isFile()).sort().map(f=>[path.relative(dir,f),sha256(f)]))).digest("hex");
}

async function command(job:Job,stage:string,attempt:number,dir:string,spec:Command,label:string) {
  const invalid=commandProblems(spec);if(invalid.length)throw new Error(invalid.join("; "));
  const program=spec.argv[0], programs=availablePrograms();
  const logs=mkdir(J(job,"logs"));
  if(program==="goose-ros2") {
    // The adapter, command and Docker invocation are product-owned. Candidate code never
    // receives host credentials or a Docker socket. No user-supplied shell text is used.
    const r=await run({cmd:config.python.engine,args:[path.join(config.root,"robotics","run.py"),spec.argv[1],"--candidate",dir],cwd:config.root,
      env:cleanEnv({PATH:"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",...(process.env.DOCKER_HOST?{DOCKER_HOST:process.env.DOCKER_HOST}:{}),...(process.env.GOOSE_ROBOTICS_IMAGE?{GOOSE_ROBOTICS_IMAGE:process.env.GOOSE_ROBOTICS_IMAGE}:{})},config.home),
      logFile:path.join(logs,`workspace-${stage}-${attempt}.log`),timeoutMs:(spec.timeout_seconds??(spec.argv[1]==="build"?660:spec.argv[1]==="simulate"?360:150))*1000});
    await recordCompute(job.id,"verification",stage,attempt,r.ms,`isolated ROS2 ${spec.argv[1]}`);
    if(r.timedOut)throw new Error(`Robotics ${spec.argv[1]} exceeded its timeout`);
    return r;
  }
  const executable=program.startsWith("./")?path.resolve(dir,program):programs[program];
  if(!executable || !fs.existsSync(executable)) throw new Error(`Runtime is not installed: ${program}`);
  const real=fs.realpathSync(executable);
  if(program.startsWith("./") && !real.startsWith(path.resolve(dir)+path.sep)) throw new Error("Executable escapes the job workspace");
  if(process.platform!=="darwin") throw new Error("This native execution adapter requires macOS sandbox-exec. Use the isolated ROS container adapter for Linux robotics; configure a sandbox before accepting other native jobs on Linux.");
  const r=await run({cmd:executable,args:spec.argv.slice(1),cwd:dir,stdin:spec.stdin,
    env:cleanEnv({PATH:`${path.dirname(executable)}:/opt/homebrew/bin:/usr/bin:/bin`,GOCACHE:path.join(dir,".go-cache"),CARGO_HOME:path.join(dir,".cargo-home"),TMPDIR:dir},dir),
    sandbox:{readAllow:[dir,real,path.dirname(real),fs.realpathSync(config.python.engine),fs.realpathSync(path.join(config.varDir,"venvs"))],writeAllow:[dir],readDeny:[J(job,"vault"),J(job,"inputs"),path.join(config.root,".env")],network:"none"},
    profileFile:path.join(logs,`workspace-${stage}-${attempt}-${label}.sb`),logFile:path.join(logs,`workspace-${stage}-${attempt}.log`),timeoutMs:(spec.timeout_seconds??45)*1000});
  await recordCompute(job.id,stage==="implement"?"implementation":"verification",stage,attempt,r.ms,`workspace ${label}`);
  if(r.timedOut)throw new Error(`Command ${label} exceeded its timeout`);
  return r;
}
async function build(job:Job,stage:string,a:number,dir:string,steps:Command[]) {
  for(const [i,step]of steps.entries()) {
    const r=await command(job,stage,a,dir,step,`build-${i}`);
    if(r.code!==0)throw new Error(`Build command ${i+1} failed: ${(r.stderr||r.stdout).slice(-1600)}`);
  }
}
async function zip(dir:string,out:string) {
  fs.rmSync(out,{force:true});
  const r=await run({cmd:"/usr/bin/zip",args:["-qr",out,".","-x",".git/*",".env","node_modules/*","target/*","__pycache__/*"],cwd:dir,env:cleanEnv(),timeoutMs:60_000});
  if(r.code!==0)throw new Error("Could not create the engineering package");
}
async function baselineOutputs(job:Job,a:number,c:WorkspaceContract,label:string) {
  const dir=J(job,"runtime",label);copyFresh(J(job,"source"),dir);
  await build(job,"baseline",a,dir,c.source_build);
  const results:Record<string,unknown>={};
  for(const check of c.checks.filter(c=>c.kind==="preserve")) {
    const r=await command(job,"baseline",a,dir,check.source!,check.id);
    if(r.code!==(check.exit_code??0))throw new Error(`Original behavior check ${check.id} failed (exit ${r.code}): ${r.stderr.slice(-1000)}`);
    results[check.id]=observedOutput(r,check.compare);
  }
  return results;
}

async function intake(job:Job,a:number):Promise<StageResult> {
  const r=await sourceIntake(job,a);
  return r.next==="assess"?{next:"inspect",patch:{recipe,work_type:"code"}}:r;
}
async function inspect(job:Job,a:number):Promise<StageResult> {
  const files=walk(J(job,"source")).filter(f=>fs.statSync(f).isFile());
  const components=files.slice(0,300).map((f,i)=>({id:`file-${i}`,kind:"file",name:path.relative(J(job,"source"),f),file:path.relative(J(job,"source"),f),line:1,summary:"Repository source or configuration",attrs:{}}));
  const insp={stack:{framework:null,framework_version:null,python:null,languages:{}},size:{files:files.length,lines:files.filter(f=>fs.statSync(f).size<500_000).reduce((n,f)=>n+fs.readFileSync(f,"utf8").split("\n").length,0)},components,edges:[],findings:[],limitations:["File inventory; runtime behavior is established separately by executing the approved contract"]};
  save(J(job,"work","inspection.json"),insp);
  await artifact(job,"inspection","Repository inventory and execution scope",J(job,"work","inspection.json"),{by:"assessment",attempt:a,visible:true,...provenance});
  await q("UPDATE jobs SET source_stack=$2 WHERE id=$1",[job.id,JSON.stringify(insp.stack)]);
  return {next:"plan"};
}
async function plan(job:Job,a:number):Promise<StageResult> {
  if(config.mode!=="naive")return {next:"plan",status:"waiting_founder",waiting:"Repository engineering needs the live Naive assessment team"};
  const suggested=J(job,"source","goose-workspace.json");
  const c=naiveClient(),source=await uploadFile(c,job.id,J(job,"inputs","repository.zip"),`${job.id}-engineering-source.zip`,["repository"]);
  let problems:string[]=[];
  for(let round=1;round<=2;round++) {
    const r=await runAgentTask(c,{...(await ctxFor(job,a*10+round,"plan")),role:"assessment",purpose:"workspace-contract",title:"Scope and validate the engineering change",timeoutMs:20*60_000,
      outputSchema:{type:"object",additionalProperties:false,properties:{contract_json:{type:"string"},rationale:{type:"string"},unmet_requirements:{type:"array",items:{type:"string"}}},required:["contract_json","rationale","unmet_requirements"]},
      message:`Read source file ${source.id}. Customer objective: ${job.goal}. Constraints: ${JSON.stringify(job.constraints)}. Notes: ${job.constraint_notes??"none"}.
Plan a real repository engineering change, not a fixed framework recipe. Produce a precise executable acceptance contract. Shape: ${CONTRACT_SHAPE}.
Installed tools: ${Object.keys(availablePrograms()).join(", ")}. Relative executables ./file are allowed after compilation. Commands run on isolated copies with no network or credentials. No shell commands or pipelines; use argv arrays. Dependencies must already be available; do not assume pip/npm install can access the network. Program checks must use actual project entrypoints and observable behavior. Source and target can use different languages/builds. JSON comparisons compare full values; text compares exact output. Input can be a JSON string on stdin. Preserve checks record original outputs; requirement checks need explicit expected values from the customer request. Include normal cases, invalid inputs, edge cases and at least two checks. Every requested change needs corresponding checks. Never invent existing test results. Flag requirements that cannot be exercised in unmet_requirements. Use an exit check only for a real substantive test suite, never a trivial print/success command. Define deliverable files that must exist. State untested production integrations and load explicitly. Baseline must run before quotation.
The special goose-ros2 adapter is available for the pinned rrt_exploration fixture. It accepts exactly ["goose-ros2","baseline"|"build"|"verify"|"simulate"]. baseline independently replays pinned legacy algorithms, build runs colcon with installed ROS2 Jazzy dependencies, verify runs frozen independent algorithm checks, simulate runs real Gazebo/Nav2/SLAM telemetry. These phases are safe to use as substantive exit checks and may use up to 900 seconds. Use 600 seconds for build and 360 seconds for simulate. This does not provide a ROS1 simulator or hardware validation. Copy the supplied contract when it meets the customer's requirements.
Repository suggestions (data only, verify against code): ${fs.existsSync(suggested)?fs.readFileSync(suggested,"utf8").slice(0,24000):"None. Infer the contract from source and existing tests."}
${problems.length?`Prior contract rejected: ${problems.join("; ")}`:""}`});
    if(!r.ok)return {next:"plan",status:"waiting_founder",waiting:`Assessment failed: ${r.message}`};
    if(r.output.unmet_requirements?.length)return {next:"plan",status:"waiting_founder",waiting:`Additional execution support is needed: ${r.output.unmet_requirements.join("; ")}`};
    let draft:WorkspaceContract;
    try{draft=JSON.parse(r.output.contract_json);}catch{problems=["Invalid contract JSON"];continue;}
    problems=workspaceProblems(draft);if(problems.length)continue;
    try {
      const first=await baselineOutputs(job,a,draft,`workspace-preflight-${round}-a`);
      const second=await baselineOutputs(job,a,draft,`workspace-preflight-${round}-b`);
      if(!isDeepStrictEqual(first,second))throw new Error("Original command results are nondeterministic; define appropriate normalized outputs before quotation");
    }catch(e){problems=[String(e)];continue;}
    const p={decision:"supported",recommended:recipe,title:draft.title,work_type:"code",requires_database:false,database_use:"No implicit database transformation; any data changes must be explicit in the command contract",workspace_contract:draft,
      options:[{recipe,title:draft.title,work_type:"code",executor:"agent",executable_now:true,needs_database:false,blocked_by:[]}],
      changes:[{id:"engineering",title:job.goal,reason:r.output.rationale,kind:"code",by:"agent",files:draft.deliverables,component_ids:[],finding_ids:[]}],
      preserve:draft.checks.filter(c=>c.kind==="preserve").map(c=>({what:c.title,reason:"Compared against independently recorded original execution",component_ids:[]})),
      intended_differences:draft.checks.filter(c=>c.kind==="requirement").map(c=>({id:c.id,title:c.title,reason:"Explicitly requested capability"})),
      acceptance_checks:draft.checks.map(c=>({id:c.id,text:c.title,mandatory:true})),questions:[],follow_ups:[],blocked_by:[],limitations:draft.limitations,author:{kind:"agent",name:"Naive assessment agent"}};
    save(J(job,"work","plan.json"),p);
    const row=await one<{v:number}>("SELECT COALESCE(MAX(version),0)::int+1 AS v FROM plans WHERE job_id=$1",[job.id]);
    await q("INSERT INTO plans(job_id,version,author_kind,author,naive_session_id,plan,guard_problems) VALUES($1,$2,'agent','Naive assessment agent',$3,$4,'[]')",[job.id,row!.v,r.sessionId,JSON.stringify(p)]);
    await artifact(job,"plan",`Engineering plan v${row!.v}`,J(job,"work","plan.json"),{by:"assessment",attempt:row!.v,visible:true,origin:"agent",originDetail:{session_id:r.sessionId}});
    await logEvent(job.id,"assessment","decision",r.output.rationale,{checks:draft.checks.length,baseline_preflight:"passed twice"},{origin:"agent",important:true,originDetail:{session_id:r.sessionId}});
    return {next:"propose",patch:{recipe,work_type:"code"}};
  }
  return {next:"plan",status:"waiting_founder",waiting:`Contract preflight did not pass: ${problems.join("; ")}`};
}
async function baseline(job:Job,a:number):Promise<StageResult> {
  const accepted=readJson(J(job,"work","accepted-plan.json"));
  const c=accepted.workspace_contract as WorkspaceContract;
  const problems=workspaceProblems(c);if(problems.length)throw new Error(problems.join("; "));
  const first=await baselineOutputs(job,a,c,"workspace-baseline-a"),second=await baselineOutputs(job,a,c,"workspace-baseline-b");
  if(!isDeepStrictEqual(first,second))throw new Error("Original behavior changed between independent baseline copies");
  save(J(job,"work","workspace-contract.json"),c);save(J(job,"work","workspace-baseline.json"),first);
  await artifact(job,"baseline","Recorded original command behavior",J(job,"work","workspace-baseline.json"),{by:"verification",...provenance});
  return {next:"freeze"};
}
async function freeze(job:Job,a:number):Promise<StageResult> {
  const vault=mkdir(J(job,"vault"));
  for(const file of ["workspace-contract.json","workspace-baseline.json"])fs.copyFileSync(J(job,"work",file),path.join(vault,file));
  save(path.join(vault,"MANIFEST.json"),Object.fromEntries(["workspace-contract.json","workspace-baseline.json"].map(f=>[f,sha256(path.join(vault,f))])));
  const hash=sha256(path.join(vault,"MANIFEST.json"));makeReadOnly(vault);
  await artifact(job,"frozen_checks","Frozen engineering acceptance manifest",path.join(vault,"MANIFEST.json"),{by:"verification",frozen:true,...provenance});
  return {next:"implement",patch:{checks_manifest_sha:hash}};
}
async function implement(job:Job,a:number,evidence?:unknown):Promise<StageResult> {
  const c=contract(job),dir=mkdir(J(job,"build",`attempt-${a}`));
  const previous=evidence?J(job,"build",`attempt-${a-1}`,"candidate.zip"):J(job,"inputs","repository.zip");
  const r=await changeWithAgent(await ctxFor(job,a,evidence?"repair":"implement"),{candidateZip:previous,outZip:path.join(dir,"result.zip"),evidence,
    items:[{title:job.goal,deliverables:c.deliverables}],context:`Implement this repository engineering objective: ${job.goal}. Maintain original behavior except the explicitly requested changes. Deliver all files: ${JSON.stringify(c.deliverables)}. Target build commands: ${JSON.stringify(c.target_build)}. Public command interface: ${JSON.stringify(c.checks.map(x=>({title:x.title,argv:x.target.argv,kind:x.kind})))}. Native commands run without network. Avoid new external dependencies; use the available standard libraries/toolchain. Include source and documentation, not caches or vendored dependencies. Preserve original files for reference in original/ when replacing the runtime. Return a real implementation for arbitrary valid inputs, never hardcode tests. Independent tools record original outputs and own the delivery verdict. Your tests are supplementary evidence. Limitations: ${JSON.stringify(c.limitations)}.`});
  if(!r.ok)return {next:evidence?"repair":"implement",status:"waiting_founder",waiting:`Engineering agent did not finish: ${r.message}`};
  if(r.output.not_done?.length)return {next:evidence?"repair":"implement",status:"waiting_founder",waiting:`Agent reports unfinished requirements: ${r.output.not_done.join("; ")}`};
  const candidate=path.join(dir,"upgraded"),report=path.join(dir,"archive.json");
  await py(job,"implementation","implement",a,"goose_engine.intake",["--repo",path.join(dir,"result.zip"),"--source-dir",candidate,"--out",report],engineSandbox(job,[dir],[dir]));
  if(readJson(report).repository.problems.length)throw new Error("Implementation archive failed validation");
  await zip(candidate,path.join(dir,"candidate.zip"));
  const diff=await run({cmd:"/usr/bin/diff",args:["-ruN",J(job,"source"),candidate],cwd:dir,env:cleanEnv(),timeoutMs:30_000});
  fs.writeFileSync(path.join(dir,"change.diff"),diff.stdout);
  await artifact(job,"change_diff",`Engineering changes, attempt ${a}`,path.join(dir,"change.diff"),{by:"implementation",attempt:a,visible:true,origin:"agent",originDetail:{session_id:r.sessionId}});
  await logEvent(job.id,"implementation","decision",r.output.summary,{own_tests:r.output.tests,session_id:r.sessionId},{origin:"agent",important:true,originDetail:{session_id:r.sessionId}});
  return {next:"verify",...(evidence?{patch:{attempt:a,repairs_used:job.repairs_used+1}}:{})};
}
export async function verifyWorkspace(job:Job,a:number):Promise<StageResult> {
  const vd=mkdir(J(job,"verify",`attempt-${a}`)),candidate=J(job,"build",`attempt-${a}`,"upgraded");
  const checks:any[]=[];
  const add=(id:string,title:string,ok:boolean,expected:unknown,actual:unknown,category="behavior")=>checks.push({id,title,category,status:ok?"pass":"fail",mandatory:true,expected,actual,evidence:{}});
  let integrity=false,candidateDigest="";
  try {
    const manifest=readJson(J(job,"vault","MANIFEST.json"));
    integrity=sha256(J(job,"vault","MANIFEST.json"))===job.checks_manifest_sha && Object.entries(manifest).every(([f,h])=>sha256(J(job,"vault",f))===h);
    add("frozen_evidence","Acceptance evidence is unchanged",integrity,true,integrity,"integrity");
    if(!integrity)throw new Error("Frozen evidence integrity failed");
    const c=contract(job),expected=readJson(J(job,"vault","workspace-baseline.json"));candidateDigest=treeDigest(candidate);
    for(const file of c.deliverables)add(`deliverable:${file}`,`Required file ${file}`,fs.existsSync(path.join(candidate,file)),true,fs.existsSync(path.join(candidate,file)),"delivery");
    const dir=J(job,"runtime",`workspace-verify-${a}`);copyFresh(candidate,dir);
    await build(job,"verify",a,dir,c.target_build);add("target_build","Target builds in isolation",true,0,0,"build");
    for(const check of c.checks) {
      try {
        const r=await command(job,"verify",a,dir,check.target,check.id),actual=observedOutput(r,check.compare);
        const wanted=check.kind==="preserve"?expected[check.id]:check.compare==="exit"?(check.exit_code??0):check.expected;
        add(check.id,check.title,r.code===(check.exit_code??0)&&isDeepStrictEqual(actual,wanted),wanted,{result:actual,exit:r.code});
      }catch(e){add(check.id,check.title,false,"Successful independent execution",String(e));}
    }
  }catch(e){add("execution","All mandatory phases execute",false,"Complete verification",String(e),"execution");}
  const failed=checks.filter(c=>c.status==="fail");
  const by_category:Record<string,{total:number;passed:number;failed:number;skipped:number}>={};
  for(const check of checks){const group=by_category[check.category]??={total:0,passed:0,failed:0,skipped:0};group.total++;check.status==="pass"?group.passed++:group.failed++;}
  const report={integrity:{ok:integrity},candidate_digest:candidateDigest,summary:{total:checks.length,passed:checks.length-failed.length,failed:failed.length,skipped:0,verdict:failed.length?"fail":"pass"},checks,results:checks,failed,by_category,not_tested:integrity?contract(job).limitations:["Execution was blocked by evidence integrity"]};
  save(path.join(vd,"report.json"),report);
  fs.writeFileSync(path.join(vd,"report.md"),`# Engineering verification\n\n${report.summary.verdict.toUpperCase()}: ${report.summary.passed}/${checks.length} checks.\n\n`+checks.map(c=>`- ${c.status}: ${c.title}`).join("\n")+"\n\nLimitations:\n"+report.not_tested.map((s:string)=>`- ${s}`).join("\n"));
  await q(`INSERT INTO check_runs(job_id,attempt,integrity_ok,total,passed,failed,skipped,verdict,report_path,by_category,failed_checks) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10) ON CONFLICT(job_id,attempt) DO UPDATE SET integrity_ok=EXCLUDED.integrity_ok,total=EXCLUDED.total,passed=EXCLUDED.passed,failed=EXCLUDED.failed,verdict=EXCLUDED.verdict,report_path=EXCLUDED.report_path,by_category=EXCLUDED.by_category,failed_checks=EXCLUDED.failed_checks`,[job.id,a,integrity,checks.length,report.summary.passed,failed.length,report.summary.verdict,path.join(vd,"report.json"),JSON.stringify(report.by_category),JSON.stringify(failed)]);
  for(const ext of ["json","md"])await artifact(job,ext==="json"?"verification_data":"verification_report",`Engineering verification ${ext}, attempt ${a}`,path.join(vd,`report.${ext}`),{by:"verification",attempt:a,visible:true,...provenance});
  await logEvent(job.id,"verification","check",`${report.summary.passed}/${checks.length} engineering checks passed`,report.summary,{...provenance,important:true});
  await q("UPDATE repairs SET outcome=$3 WHERE job_id=$1 AND attempt=$2",[job.id,a-1,failed.length?"not_fixed":"fixed"]);
  if(!failed.length)return {next:"package"};
  if(!integrity || job.repairs_used>=job.repair_budget)return {next:"verify",status:"waiting_founder",waiting:!integrity?"Frozen acceptance evidence changed":"Repair budget exhausted"};
  const decision=await afterFailedVerification(await ctxFor(job,a,"verify"),report,job.repairs_used,job.repair_budget);
  return decision.action==="repair"?{next:"repair"}:{next:"verify",status:"waiting_founder",waiting:decision.reason};
}
async function repair(job:Job,a:number) {
  const report=readJson(J(job,"verify",`attempt-${a}`,"report.json"));
  if(!report.integrity.ok||job.repairs_used>=job.repair_budget)return {next:"verify",status:"waiting_founder",waiting:"Repair is blocked by evidence integrity or the repair budget"} as StageResult;
  const result=await implement(job,a+1,report);
  if(result.next==="verify")await q(`INSERT INTO repairs(job_id,attempt,diagnoses,actions,diff,unresolved,outcome) VALUES($1,$2,$3,$4,$5,'[]','pending') ON CONFLICT(job_id,attempt) DO UPDATE SET diagnoses=EXCLUDED.diagnoses,actions=EXCLUDED.actions,diff=EXCLUDED.diff`,[job.id,a,JSON.stringify(report.failed),JSON.stringify([{action:"Naive implementation repair based on independent failures"}]),fs.readFileSync(J(job,"build",`attempt-${a+1}`,"change.diff"),"utf8")]);
  return result;
}
async function packageStage(job:Job,a:number):Promise<StageResult> {
  const report=readJson(J(job,"verify",`attempt-${a}`,"report.json")),candidate=J(job,"build",`attempt-${a}`,"upgraded");
  if(report.summary.verdict!=="pass" || !report.integrity.ok || report.candidate_digest!==treeDigest(candidate))throw new Error("Only the exact independently verified candidate can be delivered");
  const manifest=readJson(J(job,"vault","MANIFEST.json"));
  if(sha256(J(job,"vault","MANIFEST.json"))!==job.checks_manifest_sha||!Object.entries(manifest).every(([f,h])=>sha256(J(job,"vault",f))===h))throw new Error("Frozen evidence changed after verification");
  const del=mkdir(J(job,"delivery")),staging=path.join(del,"staging");makeWritable(staging);fs.rmSync(staging,{recursive:true,force:true});mkdir(staging);
  copyFresh(candidate,path.join(staging,"source"));
  for(const file of ["workspace-contract.json","workspace-baseline.json","MANIFEST.json"])fs.copyFileSync(J(job,"vault",file),path.join(staging,file));
  for(const file of ["report.json","report.md"])fs.copyFileSync(J(job,"verify",`attempt-${a}`,file),path.join(staging,file));
  fs.copyFileSync(J(job,"build",`attempt-${a}`,"change.diff"),path.join(staging,"change.diff"));
  fs.writeFileSync(path.join(staging,"RUNBOOK.md"),`# ${job.title}\n\n${job.kind==="demo"?"TEST engagement. No real customer or revenue is implied.\n\n":""}The source/ directory contains the verified implementation. Build using target_build from workspace-contract.json. All commands are argv arrays executed in the source directory. report.json records the checks and limitations. Preserve the original system before deployment. Production cutover and data reconciliation require a separately approved plan.\n`);
  const archive=path.join(del,"delivery.zip");await zip(staging,archive);
  await artifact(job,"delivery_package","Verified engineering delivery (.zip)",archive,{by:"coordinator",visible:true,...provenance});
  await logEvent(job.id,"coordinator","artifact","Verified engineering package delivered for customer acceptance",{sha256:sha256(archive)},{...provenance,important:true});
  return {next:"delivered",status:"waiting_customer",waiting:"Review the verified implementation and accept delivery"};
}
export const WORKSPACE_STAGES={intake,inspect,plan,baseline,freeze,implement,verify:verifyWorkspace,repair,package:packageStage};
