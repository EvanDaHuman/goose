// Repository-independent Naive discovery and acceptance. Existing jobs keep their original executor.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Job, StageResult } from "./jobs";
import { config } from "./config";
import { q, one } from "./db";
import { J, mkdir, readJson, sha256, makeReadOnly, makeWritable, artifact, ctxFor, py, engineSandbox } from "./stages";
import { sourceSnapshot } from "./sourceSnapshot";
import { naiveClient } from "./naive/client";
import { uploadFile } from "./naive/files";
import { runAgentTask } from "./naive/run";
import { changeWithAgent, afterFailedVerification } from "./agents";
import { run, cleanEnv } from "./proc";
import { logEvent, recordCompute } from "./records";

const write=(f:string,v:unknown)=>{mkdir(path.dirname(f));fs.writeFileSync(f,JSON.stringify(v,null,2));};
export const isAdaptive=(job:Job)=>fs.existsSync(J(job,"inputs","workspace-request.json"))&&readJson(J(job,"inputs","workspace-request.json")).adaptive===true;
const digest=(dir:string):string=>{const files:string[]=[];const visit=(d:string)=>{for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(d,e.name);if(e.isSymbolicLink())throw new Error("Source tree contains a symlink");if(e.isDirectory())visit(f);else files.push(path.relative(dir,f)+":"+sha256(f));}};visit(dir);return crypto.createHash("sha256").update(files.join("\n")).digest("hex");};
const safe=(p:unknown):p is string=>typeof p==="string"&&p.length>0&&!path.isAbsolute(p)&&!p.split("/").includes("..")&&!p.includes("\\")&&!p.includes("\0");
export function adaptiveProblems(p:any):string[]{
 const errors:string[]=[];
 if(!p||p.version!==1||typeof p.title!=="string")return ["Missing version/title"];
 if(!/^(ubuntu|debian|python|node|golang|rust|eclipse-temurin|ruby|php|mcr\.microsoft\.com\/dotnet\/sdk):[\w.-]+$/.test(p.image??""))errors.push("Use a tagged official runtime image");
 for(const key of ["setup","prepare"])if(typeof p[key]!=="string"||p[key].length>50000)errors.push("Invalid "+key);
 if(!Array.isArray(p.dependency_hosts)||p.dependency_hosts.length>40||p.dependency_hosts.some((h:any)=>typeof h!=="string"||!/^([a-z0-9][a-z0-9-]*\.)+[a-z][a-z0-9-]*$/.test(h)||/\.(local|internal|localhost)$/.test(h)))errors.push("Dependency hosts must be explicit public DNS names");
 if(!Array.isArray(p.checks)||p.checks.length<2||p.checks.length>30)errors.push("Need 2 to 30 checks");else{const ids=new Set();for(const c of p.checks){if(!c||!/^([a-z][a-z0-9_-]{0,59})$/.test(c.id)||ids.has(c.id)||!["preserve","requirement"].includes(c.kind)||typeof c.script!=="string"||!c.script.trim()||c.script.length>50000||typeof c.title!=="string")errors.push("Invalid check");ids.add(c?.id);if(c?.timeout_seconds!==undefined&&(!Number.isInteger(c.timeout_seconds)||c.timeout_seconds<1||c.timeout_seconds>900))errors.push("Check timeout must be 1 to 900 seconds");}if(!p.checks.some((c:any)=>c.kind==="preserve")||!p.checks.some((c:any)=>c.kind==="requirement"))errors.push("Need original behavior and new requirement checks");}
 for(const key of ["protected_paths","deliverables"])if(!Array.isArray(p[key])||!p[key].length||p[key].length>40||p[key].some((x:any)=>!safe(x)))errors.push("Invalid "+key);
 if(!Array.isArray(p.mutations)||!p.mutations.length||p.mutations.length>5)errors.push("Need 1 to 5 negative controls");else for(const m of p.mutations)if(!m||!safe(m.path)||typeof m.find!=="string"||!m.find||typeof m.replace!=="string"||m.find===m.replace||!p.checks?.some((c:any)=>c.id===m.check_id&&c.kind==="preserve"))errors.push("Negative control must alter original behavior and exercise a preservation check");
 if(!Array.isArray(p.limitations)||p.limitations.some((s:any)=>typeof s!=="string"))errors.push("State limitations");
 if(!Array.isArray(p.missing_requirements)||p.missing_requirements.some((s:any)=>typeof s!=="string"))errors.push("State missing requirements");
 return [...new Set(errors)];
}
function protectedHashes(source:string,paths:string[]){const values:Record<string,string>={};for(const f of paths){if(!safe(f))throw new Error("Unsafe protected path");const full=path.join(source,f);if(!fs.existsSync(full))throw new Error("Missing protected path: "+f);values[f]=fs.statSync(full).isDirectory()?digest(full):sha256(full);}return values;}
function intact(job:Job){try{const m=readJson(J(job,"vault","MANIFEST.json"));return sha256(J(job,"vault","MANIFEST.json"))===job.checks_manifest_sha&&Object.entries(m).every(([f,h])=>safe(f)&&sha256(J(job,"vault",f))===h);}catch{return false;}}
async function execute(job:Job,source:string,planFile:string,out:string,phase:"baseline"|"verify"){
 mkdir(out);const r=await run({cmd:config.python.engine,args:[path.join(config.root,"autonomy/run.py"),"--source",source,"--plan",planFile,"--out",out,"--phase",phase],cwd:config.root,env:cleanEnv({PATH:"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",...(process.env.DOCKER_HOST?{DOCKER_HOST:process.env.DOCKER_HOST}:{})},config.home),timeoutMs:55*60_000,logFile:path.join(out,"runner.log")});
 await recordCompute(job.id,"verification",job.stage,job.attempt,r.ms,"Generic isolated environment and acceptance execution");
 if(!fs.existsSync(path.join(out,"report.json")))throw new Error("Environment runner failed: "+r.stderr.slice(-3000));
 const report=readJson(path.join(out,"report.json"));if(r.timedOut)report.ok=false;return report;
}
const concise=(r:any)=>({ok:r.ok,error:r.error,setup:r.setup?{code:r.setup.code,output:r.setup.output.slice(-11000)}:null,checks:r.checks?.map((c:any)=>({id:c.id,code:c.code,expected:c.expected,accepted:c.accepted,output:c.output.slice(-9000)})),mutations:r.mutations?.map((m:any)=>({path:m.path,check_id:m.check_id,detected:m.detected,output:m.output.slice(-5000)}))});
const SHAPE=`{version:1,title:string,image:"official-runtime:tag",dependency_hosts:[exactPublicHostname],setup:"POSIX shell installs dependencies as root in /workspace; may use approved dependency proxy",prepare:"POSIX shell runs OFFLINE as uid1000 before EACH independent check, starts temporary services if needed",checks:[{id:"unique_id",title:string,kind:"preserve"|"requirement",script:"POSIX shell; substantive assertions; nonzero on failure",timeout_seconds:300}],protected_paths:["original tests directory or file", "CI directory if present"],mutations:[{path:"source file",find:"exact unique original substring",replace:"valid but behaviorally wrong code",check_id:"preservation check which must fail"}],deliverables:["required source file"],limitations:[string],missing_requirements:[string],rationale:string}`;
async function plan(job:Job,a:number):Promise<StageResult>{
 if(config.mode!=="naive")return {next:"plan",status:"waiting_founder",waiting:"Autonomous discovery requires live Naive"};
 const client=naiveClient(),source=await uploadFile(client,job.id,await sourceSnapshot(job),`${job.id}-unfamiliar-source.zip`,["source"]);
 let feedback:any=null;
 // Durable per-round files and SDK idempotency preserve actual failed attempts on retry.
 const base=J(job,"discovery",`round-${a}`);mkdir(base);
 for(let trial=1;trial<=4;trial++){
  const td=mkdir(path.join(base,`trial-${trial}`));
  await logEvent(job.id,"assessment","status",`Discovering environment and acceptance tests, attempt ${trial} of 4`,undefined,{origin:"tool"});
  const r=await runAgentTask(client,{...(await ctxFor(job,a*10+trial,"plan")),role:"assessment",purpose:"autonomous-environment",title:"Discover and reproduce an unfamiliar repository",timeoutMs:25*60_000,
   outputSchema:{type:"object",properties:{plan_json:{type:"string"}},required:["plan_json"],additionalProperties:false},
   message:`Fetch and inspect repository ${source.id}. No repo-specific Goose adapter or prewritten tests are supplied. Goal: ${job.goal}. Constraints: ${JSON.stringify(job.constraints)} ${job.constraint_notes??""}.
Read actual manifests, lockfiles, CI workflows, source interfaces, and tests. Infer dependencies and commands. Return plan_json with this exact shape: ${SHAPE}.
Host executes your scripts in disposable Linux Docker containers; you do NOT need Docker in your Naive computer. Supported official base repositories: ubuntu, debian, python, node, golang, rust, eclipse-temurin, ruby, php, mcr.microsoft.com/dotnet/sdk. Choose an appropriate pinned version. Setup has network ONLY through HTTP_PROXY/HTTPS_PROXY to exact dependency_hosts. Include package registries AND their artifact CDN hosts, no private addresses. APT/pip/npm work via the proxy. Setup should install build/test dependencies using actual project metadata; package installation scripts are untrusted and sandboxed. It may build/install the project. Never change original source or existing tests in setup/prepare. Every check starts from an independent copy of the same prepared image, OFFLINE, as UID1000 with writable /workspace and /home/goose. prepare can start local service processes; install services during setup. No Docker socket, no credentials, no host filesystem. Checks run from /workspace with scripts stored read-only at /acceptance. Project imports and test discovery must work from there (set PYTHONPATH if needed). Native tests that spawn other executables cannot invoke docker.
Run the substantial existing test suite as at least one preservation check. Protect its files in protected_paths. If existing failures block it, diagnose them; never quietly skip relevant tests. Additional focused preservation assertions should cover changed behavior. Requirement checks must PASS on correct new implementation and FAIL on original source with a clear assertion or missing-feature error. They must verify the actual requested behavior, not merely inspect source text. Do not implement the change yet. A negative control must make an exact unique replacement in ORIGINAL code, preserve syntax/imports and make a preservation check fail with an assertion. Never mutate tests or commands for the negative control. Use timeout_seconds up to 900. Normalize nondeterministic fields in assertions. Include no hardcoded output pretending to be a test. For data changes, build isolated copies, assert row relationships/value transformations/new writes/retry behavior. Missing private services, credentials, hardware or ambiguous requirements belong in missing_requirements; do not fabricate them. Explain all coverage limitations.
This is the feedback from prior actual execution (if any). Fix the plan based on it: ${JSON.stringify(feedback).slice(-55000)}`});
  if(!r.ok)return {next:"plan",status:"waiting_founder",waiting:`Discovery agent stopped: ${r.message}`};
  let p:any;try{p=JSON.parse(r.output.plan_json);}catch{feedback={error:"Invalid plan JSON"};continue;}
  write(path.join(td,"plan.json"),p);const problems=adaptiveProblems(p);
  if(problems.length){feedback={plan:p,problems};write(path.join(td,"feedback.json"),feedback);continue;}
  if(p.missing_requirements.length)return {next:"plan",status:"waiting_founder",waiting:`Discovery needs information or infrastructure: ${p.missing_requirements.join("; ")}`};
  try{protectedHashes(J(job,"source"),p.protected_paths);}catch(e){feedback={plan:p,error:String(e)};continue;}
  const before=digest(J(job,"source"));const first=await execute(job,J(job,"source"),path.join(td,"plan.json"),path.join(td,"execution"),"baseline");
  if(before!==digest(J(job,"source")))throw new Error("Discovery changed the original source");
  write(path.join(td,"summary.json"),concise(first));
  await artifact(job,"environment_attempt",`Environment discovery attempt ${trial}: ${first.ok?"validated":"needs repair"}`,path.join(td,"summary.json"),{by:"assessment",visible:true,origin:"tool",attempt:trial});
  if(!first.ok){feedback={plan:p,execution:concise(first)};continue;}
  // A separate role critiques the oracle, coverage and mutation evidence before scope is offered.
  const review=await runAgentTask(client,{...(await ctxFor(job,a*10+trial,"plan")),role:"verification",purpose:"review-discovered-tests",title:"Independently review the acceptance tests",timeoutMs:12*60_000,
   outputSchema:{type:"object",properties:{accepted:{type:"boolean"},issues:{type:"array",items:{type:"string"}},summary:{type:"string"}},required:["accepted","issues","summary"],additionalProperties:false},
   message:`Inspect original repository ${source.id} using fetch_file. Review this proposed contract for customer goal: ${job.goal}. Plan: ${JSON.stringify(p)}. Actual baseline and negative-control evidence: ${JSON.stringify(concise(first)).slice(-25000)}. Accept only if tests exercise actual behavior, cover all requested changes, retain a substantive existing suite, and the mutation is a meaningful semantic fault. A missing new API is an expected original failure; import/setup failure unrelated to the requested change is not. Reject fabricated metrics, constant-success scripts, deleted/skipped tests, setup/prepare modifying project source or tests, or omitted requirements. Identify specific improvements. Do not edit files or claim tests you did not run.`});
  if(!review.ok)return {next:"plan",status:"waiting_founder",waiting:`Independent test review stopped: ${review.message}`};
  write(path.join(td,"review.json"),review.output);if(!review.output.accepted){feedback={plan:p,review:review.output};continue;}
  p.base_image_digest=first.base_image;write(path.join(td,"plan.json"),p);
  const second=await execute(job,J(job,"source"),path.join(td,"plan.json"),path.join(td,"reproduction"),"baseline");
  if(!second.ok){feedback={plan:p,fresh_reproduction:concise(second)};continue;}
  write(J(job,"work","adaptive-plan.json"),p);write(J(job,"work","adaptive-discovery.json"),{trial,first:concise(first),reproduction:concise(second),review:review.output,session_id:r.sessionId});
  const publicContract={version:1,title:p.title,source_build:[],target_build:[],checks:p.checks.map((c:any)=>({id:c.id,title:c.title,kind:c.kind,target:{argv:["isolated-check",c.id]},compare:"exit"})),deliverables:p.deliverables,limitations:p.limitations};
  const proposal={decision:"supported",recommended:"workspace-change",title:p.title,work_type:"code",requires_database:false,database_use:"Isolated data fixtures and transformations only as explicitly verified",workspace_contract:publicContract,adaptive_plan:p,options:[{recipe:"workspace-change",title:p.title,work_type:"code",executor:"agent",executable_now:true,needs_database:false,blocked_by:[]}],changes:[{id:"engineering",title:job.goal,reason:p.rationale,kind:"code",by:"agent",files:p.deliverables,component_ids:[],finding_ids:[]}],preserve:p.checks.filter((c:any)=>c.kind==="preserve").map((c:any)=>({what:c.title,reason:"Existing behavior and negative-control validated",component_ids:[]})),intended_differences:p.checks.filter((c:any)=>c.kind==="requirement").map((c:any)=>({id:c.id,title:c.title,reason:"Requested behavior, absent on original"})),acceptance_checks:p.checks.map((c:any)=>({id:c.id,text:c.title,mandatory:true})),questions:[],follow_ups:[],blocked_by:[],limitations:p.limitations,author:{kind:"agent",name:"Naive environment discovery and independent test review"}};
  write(J(job,"work","plan.json"),proposal);const row=await one<{v:number}>("SELECT COALESCE(MAX(version),0)::int+1 AS v FROM plans WHERE job_id=$1",[job.id]);
  await q("INSERT INTO plans(job_id,version,author_kind,author,naive_session_id,plan,guard_problems) VALUES($1,$2,'agent','Naive environment discovery',$3,$4,'[]')",[job.id,row!.v,r.sessionId,JSON.stringify(proposal)]);
  await artifact(job,"plan","Discovered environment and independently reviewed acceptance",J(job,"work","plan.json"),{by:"assessment",visible:true,origin:"agent",originDetail:{session_id:r.sessionId}});
  await artifact(job,"environment_discovery","Reproduced environment, baseline and negative controls",J(job,"work","adaptive-discovery.json"),{by:"verification",visible:true,origin:"tool"});
  return {next:"propose"};
 }
 return {next:"plan",status:"waiting_founder",waiting:"Autonomous environment/test discovery exhausted four bounded attempts. See execution and review evidence."};
}
async function baseline(job:Job,a:number):Promise<StageResult>{
 const p=readJson(J(job,"work","accepted-plan.json")).adaptive_plan;const errors=adaptiveProblems(p);if(errors.length)throw new Error(errors.join("; "));
 write(J(job,"work","adaptive-plan.json"),p);const r=await execute(job,J(job,"source"),J(job,"work","adaptive-plan.json"),J(job,"baseline","autonomous"),"baseline");
 if(!r.ok)return {next:"baseline",status:"waiting_founder",waiting:"Accepted original environment or acceptance controls no longer reproduce; see baseline evidence."};
 write(J(job,"work","adaptive-baseline.json"),concise(r));write(J(job,"work","adaptive-protected.json"),protectedHashes(J(job,"source"),p.protected_paths));return {next:"freeze"};
}
async function freeze(job:Job):Promise<StageResult>{
 const vault=mkdir(J(job,"vault")),files=["adaptive-plan.json","adaptive-baseline.json","adaptive-protected.json"];
 for(const f of files)fs.copyFileSync(J(job,"work",f),path.join(vault,f));
 const runtime={"autonomy/run.py":sha256(path.join(config.root,"autonomy/run.py")),"autonomy/egress.py":sha256(path.join(config.root,"autonomy/egress.py"))};write(path.join(vault,"adaptive-runner.json"),runtime);files.push("adaptive-runner.json");
 write(path.join(vault,"MANIFEST.json"),Object.fromEntries(files.map(f=>[f,sha256(path.join(vault,f))])));const hash=sha256(path.join(vault,"MANIFEST.json"));makeReadOnly(vault);
 await artifact(job,"frozen_checks","Frozen autonomous environment and acceptance tests",path.join(vault,"MANIFEST.json"),{by:"verification",frozen:true,visible:true,origin:"tool"});return {next:"implement",patch:{checks_manifest_sha:hash}};
}
function runnerIntact(job:Job){return Object.entries(readJson(J(job,"vault","adaptive-runner.json"))).every(([p,h])=>sha256(path.join(config.root,p))===h);}
async function archive(source:string,out:string){const r=await run({cmd:"/usr/bin/zip",args:["-qr",out,".","-x",".git/*","node_modules/*","__pycache__/*",".env"],cwd:source,env:cleanEnv(),timeoutMs:120000});if(r.code!==0)throw new Error(r.stderr);}
async function implement(job:Job,a:number,evidence?:unknown):Promise<StageResult>{
 if(!intact(job)||!runnerIntact(job))throw new Error("Frozen environment or executor changed; explicit reassessment required");
 const p=readJson(J(job,"vault","adaptive-plan.json")),dir=mkdir(J(job,"build",`attempt-${a}`));
 const input=evidence?J(job,"build",`attempt-${a-1}`,"candidate.zip"):await sourceSnapshot(job);
 const r=await changeWithAgent(await ctxFor(job,a,evidence?"repair":"implement"),{candidateZip:input,outZip:path.join(dir,"result.zip"),items:[{title:job.goal,files:p.deliverables}],evidence,
 context:`Implement the customer objective in the actual repository. Goal: ${job.goal}. Preserve existing behavior except the requested change. Environment discovered from actual source and successfully reproduced: image ${p.image}, setup ${p.setup}, prepare ${p.prepare}. The HOST runs this environment for independent verification; you do not need Docker locally. Preserve ALL existing tests and CI files byte-for-byte in these protected paths: ${JSON.stringify(p.protected_paths)}. Add new tests under NEW paths if useful. Public acceptance descriptions: ${JSON.stringify(p.checks.map((c:any)=>({title:c.title,kind:c.kind})))}. Independent scripts and expected results are withheld. Never modify source to recognize checks, fake outputs, or weaken tests. Deliver required files ${JSON.stringify(p.deliverables)}. Include the complete source repository and relevant license files, no dependency caches, virtual environments, .git or node_modules. Investigate and make the smallest complete change, then run available own tests. Clearly report anything unfinished. Limits: ${JSON.stringify(p.limitations)}.`});
 if(!r.ok)return {next:evidence?"repair":"implement",status:"waiting_founder",waiting:`Implementation stopped: ${r.message}`};
 if(r.output.not_done?.length)return {next:evidence?"repair":"implement",status:"waiting_founder",waiting:`Implementation reports incomplete work: ${r.output.not_done.join("; ")}`};
 const candidate=path.join(dir,"upgraded"),extraction=path.join(dir,"archive.json");
 await py(job,"implementation","implement",a,"goose_engine.intake",["--repo",path.join(dir,"result.zip"),"--source-dir",candidate,"--out",extraction],engineSandbox(job,[dir],[dir]));
 if(readJson(extraction).repository.problems.length)throw new Error("Candidate archive rejected");
 await archive(candidate,path.join(dir,"candidate.zip"));const diff=await run({cmd:"/usr/bin/diff",args:["-ruN",J(job,"source"),candidate],cwd:dir,env:cleanEnv(),timeoutMs:60000});fs.writeFileSync(path.join(dir,"change.diff"),diff.stdout);
 await artifact(job,"change_diff",`Agent implementation attempt ${a}`,path.join(dir,"change.diff"),{by:"implementation",visible:true,attempt:a,origin:"agent",originDetail:{session_id:r.sessionId}});
 await logEvent(job.id,"implementation","decision",r.output.summary,{session_id:r.sessionId,changed_files:r.output.changed_files},{origin:"agent",important:true});
 return {next:"verify",...(evidence?{patch:{attempt:a,repairs_used:job.repairs_used+1}}:{})};
}
async function verify(job:Job,a:number):Promise<StageResult>{
 const dir=mkdir(J(job,"verify",`attempt-${a}`)),candidate=J(job,"build",`attempt-${a}`,"upgraded"),checks:any[]=[];let hash="",integrity=false,execution:any=null;
 const add=(id:string,title:string,ok:boolean,actual:unknown,category="behavior")=>checks.push({id,title,category,status:ok?"pass":"fail",mandatory:true,actual});
 try{
  integrity=intact(job)&&runnerIntact(job);add("frozen_evidence","Acceptance plan and runner are unchanged",integrity,integrity,"integrity");if(!integrity)throw new Error("Frozen evidence or runner changed");
  const p=readJson(J(job,"vault","adaptive-plan.json"));hash=digest(candidate);const expected=readJson(J(job,"vault","adaptive-protected.json"));
  const observed=protectedHashes(candidate,p.protected_paths);const preserved=JSON.stringify(observed)===JSON.stringify(expected);add("original_tests","Original tests and CI are unchanged",preserved,preserved,"integrity");
  for(const file of p.deliverables)add(`file:${file}`,`Required deliverable ${file}`,safe(file)&&fs.existsSync(path.join(candidate,file))&&fs.statSync(path.join(candidate,file)).isFile(),file,"delivery");
  if(!preserved)throw new Error("Candidate modified protected original tests or CI");
  execution=await execute(job,candidate,J(job,"vault","adaptive-plan.json"),path.join(dir,"execution"),"verify");
  add("fresh_environment","Candidate builds in a fresh environment",execution.setup?.code===0&&!execution.error,{code:execution.setup?.code,error:execution.error,output:execution.setup?.output?.slice(-7000)},"build");
  for(const c of p.checks){const r=execution.checks.find((x:any)=>x.id===c.id);add(c.id,c.title,!!r?.accepted,r?{code:r.code,output:r.output.slice(-14000),seconds:r.seconds}:"Check did not execute");}
  add("unchanged_candidate","Delivered source is the source that was verified",hash===digest(candidate),hash,"integrity");
  integrity=integrity&&intact(job)&&runnerIntact(job);add("unchanged_evidence","Acceptance evidence remains unchanged after execution",integrity,integrity,"integrity");
 }catch(e){add("execution","Complete independent execution",false,String(e),"execution");}
 const failed=checks.filter(c=>c.status==="fail"),categories:Record<string,any>={};for(const c of checks){const g=categories[c.category]??={total:0,passed:0,failed:0,skipped:0};g.total++;g[c.status==="pass"?"passed":"failed"]++;}
 const report={integrity:{ok:integrity},candidate_digest:hash,summary:{total:checks.length,passed:checks.length-failed.length,failed:failed.length,skipped:0,verdict:failed.length?"fail":"pass"},checks,results:checks,failed,by_category:categories,not_tested:readJson(J(job,"vault","adaptive-plan.json")).limitations};
 write(path.join(dir,"report.json"),report);fs.writeFileSync(path.join(dir,"report.md"),`# Autonomous repository verification\n\n${report.summary.verdict}: ${report.summary.passed}/${checks.length}\n\n`+checks.map(c=>`- ${c.status}: ${c.title}`).join("\n")+"\n\nLimitations:\n"+report.not_tested.map((s:string)=>`- ${s}`).join("\n"));
 await q(`INSERT INTO check_runs(job_id,attempt,integrity_ok,total,passed,failed,skipped,verdict,report_path,by_category,failed_checks) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10) ON CONFLICT(job_id,attempt) DO UPDATE SET integrity_ok=EXCLUDED.integrity_ok,total=EXCLUDED.total,passed=EXCLUDED.passed,failed=EXCLUDED.failed,verdict=EXCLUDED.verdict,report_path=EXCLUDED.report_path,by_category=EXCLUDED.by_category,failed_checks=EXCLUDED.failed_checks`,[job.id,a,integrity,checks.length,report.summary.passed,failed.length,report.summary.verdict,path.join(dir,"report.json"),JSON.stringify(categories),JSON.stringify(failed)]);
 for(const ext of ["json","md"])await artifact(job,ext==="json"?"verification_data":"verification_report",`Autonomous verification attempt ${a}`,path.join(dir,`report.${ext}`),{by:"verification",visible:true,attempt:a,origin:"tool"});
 await logEvent(job.id,"verification","check",`Autonomous verification: ${report.summary.passed}/${checks.length} checks passed`,report.summary,{origin:"tool",important:true});
 if(!failed.length)return {next:"package"};
 if(!integrity||job.repairs_used>=job.repair_budget)return {next:"verify",status:"waiting_founder",waiting:!integrity?"Frozen acceptance evidence changed":"Repair budget exhausted"};
 const decision=await afterFailedVerification(await ctxFor(job,a,"verify"),report,job.repairs_used,job.repair_budget,{explanation:JSON.stringify(failed).slice(-18000)});
 return decision.action==="repair"?{next:"repair"}:{next:"verify",status:"waiting_founder",waiting:decision.reason};
}
async function repair(job:Job,a:number):Promise<StageResult>{
 const report=readJson(J(job,"verify",`attempt-${a}`,"report.json"));if(!report.integrity.ok||job.repairs_used>=job.repair_budget)throw new Error("Repair gate closed");
 const evidence=report.failed.map((c:any)=>({id:c.id,title:c.title,actual:c.actual}));return implement(job,a+1,{failed:evidence});
}
async function packageStage(job:Job):Promise<StageResult>{
 const candidate=J(job,"build",`attempt-${job.attempt}`,"upgraded"),report=readJson(J(job,"verify",`attempt-${job.attempt}`,"report.json"));
 if(report.summary.verdict!=="pass"||!report.integrity.ok||report.candidate_digest!==digest(candidate)||!intact(job)||!runnerIntact(job))throw new Error("Delivery requires the exact verified source and unchanged acceptance evidence");
 const dir=mkdir(J(job,"delivery")),staging=path.join(dir,"staging");makeWritable(staging);fs.rmSync(staging,{recursive:true,force:true});mkdir(staging);fs.cpSync(candidate,path.join(staging,"source"),{recursive:true});
 for(const f of [...Object.keys(readJson(J(job,"vault","MANIFEST.json"))),"MANIFEST.json"])fs.copyFileSync(J(job,"vault",f),path.join(staging,f));
 for(const ext of ["json","md"])fs.copyFileSync(J(job,"verify",`attempt-${job.attempt}`,`report.${ext}`),path.join(staging,`report.${ext}`));
 fs.cpSync(J(job,"verify",`attempt-${job.attempt}`,"execution"),path.join(staging,"execution"),{recursive:true});fs.copyFileSync(J(job,"build",`attempt-${job.attempt}`,"change.diff"),path.join(staging,"change.diff"));
 for(const f of ["github-source.json"])if(fs.existsSync(J(job,"inputs",f)))fs.copyFileSync(J(job,"inputs",f),path.join(staging,f));
 mkdir(path.join(staging,"autonomy"));for(const f of ["run.py","egress.py"])fs.copyFileSync(path.join(config.root,"autonomy",f),path.join(staging,"autonomy",f));
 fs.writeFileSync(path.join(staging,"RUNBOOK.md"),`# ${job.title}\n\n${job.kind==="demo"?"Synthetic engagement. No paid customer is claimed.\n\n":""}Source is in source/. Environment and independent test scripts are in adaptive-plan.json. Original tests were preserved. With Docker running, reproduce using:\n\n\`python3 autonomy/run.py --source source --plan adaptive-plan.json --out reproduction --phase verify\`\n\nThe runner creates disposable, resource-capped Linux containers. Setup downloads from the listed public dependency hosts through a restricted proxy. Checks run offline. Reports include original failures, new-requirement controls, semantic mutation detection and independent review in the engagement history. Production deployment, unavailable credentials and hardware are outside this delivery. Read the plan limitations.\n`);
 const zip=path.join(dir,"delivery.zip");fs.rmSync(zip,{force:true});await archive(staging,zip);await artifact(job,"delivery_package","Autonomously reproduced engineering delivery",zip,{by:"coordinator",visible:true,origin:"tool"});return {next:"delivered",status:"waiting_customer",waiting:"Review the verified source, environment and acceptance evidence"};
}
export const ADAPTIVE_STAGES:Record<string,(job:Job,a:number)=>Promise<StageResult>>={plan,baseline,freeze,implement,verify,repair,package:packageStage};
