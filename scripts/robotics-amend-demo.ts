/**
 * Explicit synthetic-only verifier amendment. This is not a repair or a customer approval.
 *
 * Prepare/review this script first. Do not execute until the final robotics manifest is stable
 * and its exact SHA256 has been explicitly authorized by the operator.
 *
 * Usage after authorization:
 * node --env-file=.env --import tsx scripts/robotics-amend-demo.ts \
 *   --execute --job GS-1004 --expected-verifier-sha <authorized 64-character SHA256>
 *
 * GS-1004's old v3 witness trusted candidate progress too much. The replacement must retain
 * the same source algorithm verifier and workspace contract, and require the independent
 * Nav2 GetResult witness for successful goal UUIDs. Candidate code is copied unchanged.
 * Old vault bytes, attempt 1, stage runs, check results, and original approvals remain intact.
 * A TEST change approval and a five-minute founder intervention disclose the correction.
 *
 * Filesystem swaps are journaled and reversed if the database transaction rolls back.
 * A process/power loss cannot make both resources transactional: a pending journal is retained
 * and a repeated invocation refuses to overwrite it. Inspect database state and that journal
 * before manual recovery. No automatic recovery may erase earlier evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { config,jobDir } from "../lib/config";
import { one,pool } from "../lib/db";
import type { Job } from "../lib/jobs";
import { cleanEnv,run } from "../lib/proc";
import { recordCompute,spendGate } from "../lib/records";
import { makeReadOnly } from "../lib/stages";
import { observedOutput,workspaceProblems,type Command,type WorkspaceContract } from "../lib/workspaceContract";

const ID="GS-1004";
const OLD_VERIFIER="202484de1c698440a24b693c57b563f8174fca74d4090321d57568c7265658b6";
const OLD_CHECKS="46f4acbdccd77700a89c787ce10ebf4e86e4218beb4a1e78b4df84942c052e52";
const TEST_STATEMENT="TEST verifier correction for the synthetic ROS fixture only: retain the approved workspace contract and baseline, replace the v3 robotics witness with a stronger independent Nav2 GetResult success witness, and verify identical candidate code again. No real customer approval or repaired implementation is represented.";
type LockedJob=Job&{lease_owner:string|null;lease_expires_at:string|null};
const hashFile=(file:string)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson=(file:string)=>JSON.parse(fs.readFileSync(file,"utf8"));
function insist(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function relative(file:string){return file.length>0&&!path.isAbsolute(file)&&!file.includes("\\")&&!file.includes("\0")&&!file.split("/").some(s=>s===".."||s===".");}
function regularTree(dir:string):string[]{
  const stat=fs.lstatSync(dir);insist(stat.isDirectory()&&!stat.isSymbolicLink(),`Expected a real directory: ${dir}`);
  const files:string[]=[];
  for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),s=fs.lstatSync(file);insist(!s.isSymbolicLink(),`Symlinks are not allowed: ${file}`);if(s.isDirectory())files.push(...regularTree(file));else{insist(s.isFile(),`Special files are not allowed: ${file}`);files.push(file);}}
  return files.sort();
}
function treeDigest(dir:string){return crypto.createHash("sha256").update(JSON.stringify(regularTree(dir).map(f=>[path.relative(dir,f),hashFile(f)]))).digest("hex");}
function copyNew(source:string,dest:string){insist(!fs.existsSync(dest),`Refusing to overwrite ${dest}`);regularTree(source);fs.cpSync(source,dest,{recursive:true,errorOnExist:true,force:false});insist(treeDigest(source)===treeDigest(dest),`Copy integrity failed: ${dest}`);}
/** macOS requires owner-write on a directory being moved between parents. Touch no child mode or bytes. */
export function moveAmendmentDirectory(source:string,dest:string){
  const stat=fs.lstatSync(source);insist(stat.isDirectory()&&!stat.isSymbolicLink(),"Directory move requires a real source directory");
  insist(!fs.existsSync(dest),`Refusing to overwrite ${dest}`);
  const originalMode=stat.mode&0o7777;
  fs.chmodSync(source,originalMode|0o200);
  try{fs.renameSync(source,dest);}catch(error){fs.chmodSync(source,originalMode);throw error;}
  try{fs.chmodSync(dest,originalMode);}catch(error){
    // If restoring the mode fails, return the directory to its old location before reporting failure.
    try{fs.chmodSync(dest,originalMode|0o200);fs.renameSync(dest,source);fs.chmodSync(source,originalMode);}
    catch(restoreError){throw new AggregateError([error,restoreError],`Directory move needs manual recovery: ${source} -> ${dest}`);}
    throw error;
  }
}
function writable(dir:string){for(const f of regularTree(dir))fs.chmodSync(f,0o644);const visit=(d:string)=>{fs.chmodSync(d,0o755);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())visit(path.join(d,e.name));};visit(dir);}
function assertJob(job:LockedJob|null){
  insist(job&&job.id===ID&&job.kind==="demo"&&job.app_slug==="ros2-exploration"&&job.recipe==="workspace-change","Only the exact synthetic GS-1004 robotics fixture is eligible");
  insist(job.stage==="verify"&&job.status==="waiting_founder"&&job.attempt===1,"Expected blocked verification attempt 1, before delivery");
  insist(job.checks_manifest_sha===OLD_CHECKS,"Job no longer references the expected original acceptance manifest");
  insist(!job.lease_owner&&!job.lease_expires_at,"A worker lease must be fully released before amendment");
  return job;
}
function validateVault(vault:string){
  insist(hashFile(path.join(vault,"MANIFEST.json"))===OLD_CHECKS,"Original vault manifest hash changed");
  const manifest=readJson(path.join(vault,"MANIFEST.json"));
  insist(isDeepStrictEqual(Object.keys(manifest).sort(),["robotics-verifier.json","workspace-baseline.json","workspace-contract.json"]),"Unexpected frozen vault members");
  insist(regularTree(vault).length===4,"Unexpected extra files in original vault");
  for(const [file,digest]of Object.entries(manifest)){insist(relative(file),"Unsafe vault member");insist(hashFile(path.join(vault,file))===digest,`Original frozen evidence is corrupt: ${file}`);}
  insist(manifest["robotics-verifier.json"]===OLD_VERIFIER&&readJson(path.join(vault,"robotics-verifier.json")).version===3,"Unexpected original robotics verifier");
  return manifest as Record<string,string>;
}
function validateReplacement(file:string,expected:string,old:any,adapterHash:string){
  insist(hashFile(file)===expected,"Final robotics verifier manifest changed or differs from the authorized hash");
  insist(hashFile(path.join(config.root,"robotics","run.py"))===adapterHash,"Trusted robotics adapter changed during amendment");
  const next=readJson(file);insist(Number.isInteger(next.version)&&next.version>3&&next.files&&typeof next.files==="object","Replacement must be a later versioned robotics verifier");
  for(const [name,hash]of Object.entries(next.files)){insist(relative(name)&&typeof hash==="string"&&/^[a-f0-9]{64}$/.test(hash),"Invalid trusted verifier manifest member");const target=path.join(config.root,"robotics",name);insist(fs.lstatSync(target).isFile()&&!fs.lstatSync(target).isSymbolicLink(),"Verifier members must be regular files");insist(hashFile(target)===hash,`Trusted verifier member is not frozen: ${name}`);}
  for(const name of ["runner/baseline.py","runner/verify_core.py","runner/candidate_rpc.py","source/rrt_exploration/scripts/functions.py"])insist(next.files[name]===old.files[name],`Amendment cannot change original algorithm verification: ${name}`);
  insist(next.files["runner/nav_status.py"]&&next.files["runner/simulate.py"]!==old.files["runner/simulate.py"],"Expected the stronger independent Nav2 witness");
  insist(fs.readFileSync(path.join(config.root,"robotics","runner","simulate.py"),"utf8").includes("GetResultService"),"Replacement does not contain the agreed Nav2 GetResult witness");
  return next;
}
function commandIsBaseline(command:Command){insist(isDeepStrictEqual(command.argv,["goose-ros2","baseline"])&&command.stdin===undefined,"This amendment may execute only the trusted baseline adapter");}

async function main(){
  const args=process.argv.slice(2);
  if(!args.includes("--execute")){console.log("Prepared only. After explicit authorization, use --execute --job GS-1004 --expected-verifier-sha <final SHA256>. No job changed.");return;}
  insist(args.length===5&&args[0]==="--execute"&&args[1]==="--job"&&args[2]===ID&&args[3]==="--expected-verifier-sha","Use the exact documented synthetic-only invocation");
  const authorized=args[4];insist(/^[a-f0-9]{64}$/.test(authorized)&&authorized!==OLD_VERIFIER,"An explicit new verifier SHA256 is required");
  const job=assertJob(await one<LockedJob>("SELECT * FROM jobs WHERE id=$1",[ID]));
  const root=fs.realpathSync(jobDir(ID));insist(path.dirname(root)===fs.realpathSync(config.jobsDir)&&path.basename(root)===ID,"Job root escapes the configured jobs directory");
  const vault=path.join(root,"vault"),attempt1=path.join(root,"build","attempt-1"),attempt2=path.join(root,"build","attempt-2"),source=path.join(root,"source");
  insist(fs.realpathSync(path.join(root,"build"))===path.join(root,"build"),"Build directory cannot be a symlink or escape the job root");
  const originalManifest=validateVault(vault),oldVerifier=readJson(path.join(vault,"robotics-verifier.json"));
  const c=readJson(path.join(vault,"workspace-contract.json")) as WorkspaceContract,baseline=readJson(path.join(vault,"workspace-baseline.json"));
  insist(workspaceProblems(c).length===0,"Original workspace contract is invalid");
  insist(isDeepStrictEqual(readJson(path.join(root,"work","accepted-plan.json")).workspace_contract,c),"Accepted proposal and frozen workspace contract differ");
  for(const command of [...c.source_build,...c.checks.filter(check=>check.kind==="preserve").map(check=>check.source!)])commandIsBaseline(command);
  const productManifest=path.join(config.root,"robotics","verification-manifest.json"),adapterHash=hashFile(path.join(config.root,"robotics","run.py"));
  const replacement=validateReplacement(productManifest,authorized,oldVerifier,adapterHash);
  const historyRoot=path.join(root,"vault-history"),history=path.join(historyRoot,OLD_VERIFIER),amendments=path.join(root,"amendments"),finalEvidence=path.join(amendments,`robotics-${authorized}`);
  for(const dest of [attempt2,history,finalEvidence])insist(!fs.existsSync(dest),`Destination already exists; inspect prior evidence or a pending journal before recovery: ${dest}`);
  if(fs.existsSync(amendments))insist(!fs.readdirSync(amendments).some(n=>n.startsWith(".robotics-amend-")),"A prior amendment staging journal exists; inspect it before recovery");
  const candidateHash=treeDigest(path.join(attempt1,"upgraded")),attemptHash=treeDigest(attempt1),sourceHash=treeDigest(source);
  const quoteSeconds=2*[...c.source_build,...c.checks.filter(check=>check.kind==="preserve").map(check=>check.source!)].reduce((sum,cmd)=>sum+(cmd.timeout_seconds??150),0);
  const gate=await spendGate(ID,job.cost_limit_micro_usd,Math.ceil(quoteSeconds*config.computerMicroUsdPerSecond));insist(gate.ok,"Existing job budget cannot cover the bounded baseline replay");
  fs.mkdirSync(amendments,{recursive:true});fs.mkdirSync(historyRoot,{recursive:true});
  insist(!fs.lstatSync(amendments).isSymbolicLink()&&!fs.lstatSync(historyRoot).isSymbolicLink(),"Evidence parent paths cannot be symlinks");
  const stage=path.join(amendments,`.robotics-amend-${crypto.randomUUID()}`);fs.mkdirSync(stage,{mode:0o700});let evidenceDir=stage;
  const newVault=path.join(stage,"new-vault"),newAttempt=path.join(stage,"new-attempt");
  const journal:any={job:ID,status:"preparing",oldVerifierSha256:OLD_VERIFIER,oldChecksManifestSha256:OLD_CHECKS,newVerifierSha256:authorized,candidateSha256:candidateHash,attemptTreeSha256:attemptHash,sourceTreeSha256:sourceHash,trustedAdapterSha256:adapterHash,createdAt:new Date().toISOString(),moves:[]};
  const saveJournal=()=>{const temporary=path.join(evidenceDir,`.journal-${crypto.randomUUID()}.tmp`);fs.writeFileSync(temporary,JSON.stringify(journal,null,2),{mode:0o600,flag:"wx"});fs.renameSync(temporary,path.join(evidenceDir,"journal.json"));};saveJournal();
  try{
    const observations:Record<string,unknown>[]=[],reports:any[][]=[];
    for(const label of ["a","b"]){
      const runRoot=path.join(stage,`baseline-${label}`),copy=path.join(runRoot,"source");fs.mkdirSync(runRoot);copyNew(source,copy);
      const results:Record<string,unknown>={},runReports:any[]=[];let count=0;
      const execute=async(spec:Command)=>{
        validateReplacement(productManifest,authorized,oldVerifier,adapterHash);
        const n=++count,result=await run({cmd:config.python.engine,args:[path.join(config.root,"robotics","run.py"),"baseline","--candidate",copy],cwd:config.root,
          env:cleanEnv({PATH:"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",...(process.env.DOCKER_HOST?{DOCKER_HOST:process.env.DOCKER_HOST}:{}),...(process.env.GOOSE_ROBOTICS_IMAGE?{GOOSE_ROBOTICS_IMAGE:process.env.GOOSE_ROBOTICS_IMAGE}:{})},config.home),
          timeoutMs:(spec.timeout_seconds??150)*1000,logFile:path.join(runRoot,`baseline-${n}.log`)});
        await recordCompute(ID,"verification","verifier_amendment",2,result.ms,`TEST original baseline replay ${label}/${n}; candidate unchanged`);
        insist(!result.timedOut&&result.code===0,`Baseline replay ${label}/${n} failed; no verifier amendment applied`);
        const state=path.join(config.varDir,"robotics","jobs",crypto.createHash("sha256").update(fs.realpathSync(copy)).digest("hex").slice(0,20),"baseline.json");
        const report=readJson(state);insist(report.verdict==="pass"&&report.passed===report.total&&report.ros1RuntimeExecuted===false,"Trusted baseline report is incomplete");
        fs.copyFileSync(state,path.join(runRoot,`baseline-${n}.json`),fs.constants.COPYFILE_EXCL);runReports.push(report);return result;
      };
      for(const spec of c.source_build)await execute(spec);
      for(const check of c.checks.filter(check=>check.kind==="preserve")){const result=await execute(check.source!);insist(result.code===(check.exit_code??0),"Original check exit changed");results[check.id]=observedOutput(result,check.compare);}
      insist(treeDigest(copy)===sourceHash&&treeDigest(source)===sourceHash,"Baseline replay changed original source");
      insist(isDeepStrictEqual(results,baseline),"Replayed original outputs differ from the frozen baseline");observations.push(results);reports.push(runReports);
    }
    insist(isDeepStrictEqual(observations[0],observations[1])&&isDeepStrictEqual(reports[0],reports[1]),"Independent original baseline replays disagree");
    fs.writeFileSync(path.join(stage,"baseline-replay.json"),JSON.stringify({observations,reports,unchanged:true},null,2),{flag:"wx"});
    copyNew(vault,newVault);writable(newVault);fs.copyFileSync(productManifest,path.join(newVault,"robotics-verifier.json"));
    const nextManifest={...originalManifest,"robotics-verifier.json":authorized};fs.writeFileSync(path.join(newVault,"MANIFEST.json"),JSON.stringify(nextManifest,null,2));makeReadOnly(newVault);
    const nextChecks=hashFile(path.join(newVault,"MANIFEST.json"));journal.newChecksManifestSha256=nextChecks;
    copyNew(attempt1,newAttempt);insist(treeDigest(newAttempt)===attemptHash&&treeDigest(path.join(newAttempt,"upgraded"))===candidateHash,"Candidate changed while staging attempt 2");
    journal.status="prepared";saveJournal();
    const client=await pool.connect();let committed=false,rollbackConfirmed=false;
    try{
      await client.query("BEGIN");
      const locked=assertJob((await client.query<LockedJob>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE",[ID])).rows[0]??null);
      insist(locked.repairs_used===job.repairs_used&&locked.repair_budget===job.repair_budget,"Repair accounting changed during preparation");
      const priorDelivery=await client.query("SELECT 1 FROM approvals WHERE job_id=$1 AND kind='delivery' UNION ALL SELECT 1 FROM invoices WHERE job_id=$1",[ID]);insist(!priorDelivery.rowCount,"A delivered or invoiced job cannot be amended");
      const priorAttempt=await client.query("SELECT 1 FROM stage_runs WHERE job_id=$1 AND stage IN ('verify','implement','repair') AND attempt=2 UNION ALL SELECT 1 FROM check_runs WHERE job_id=$1 AND attempt=2",[ID]);insist(!priorAttempt.rowCount,"Attempt 2 already has execution history");
      validateVault(vault);validateReplacement(productManifest,authorized,oldVerifier,adapterHash);
      insist(treeDigest(attempt1)===attemptHash&&treeDigest(source)===sourceHash,"Original candidate or source changed before commit");
      const frozen=(await client.query<any>("SELECT * FROM artifacts WHERE job_id=$1 AND frozen FOR UPDATE",[ID])).rows.filter(a=>a.path.startsWith(vault+path.sep));
      insist(frozen.some(a=>a.kind==="frozen_checks"&&a.path===path.join(vault,"MANIFEST.json")&&a.sha256===OLD_CHECKS),"Original frozen manifest artifact is missing");
      for(const art of frozen){const name=path.relative(vault,art.path);insist(relative(name)&&hashFile(art.path)===art.sha256,"Frozen artifact does not match the original vault");await client.query("UPDATE artifacts SET path=$2 WHERE id=$1",[art.id,path.join(history,name)]);}
      // Only new paths are populated; the original vault itself moves into immutable history.
      for(const dest of [attempt2,history,finalEvidence])insist(!fs.existsSync(dest),`Refusing to overwrite a destination created during preparation: ${dest}`);
      moveAmendmentDirectory(vault,history);journal.moves.push("old-vault-to-history");saveJournal();
      moveAmendmentDirectory(newVault,vault);journal.moves.push("new-vault-installed");saveJournal();
      moveAmendmentDirectory(newAttempt,attempt2);journal.moves.push("attempt-2-installed");saveJournal();
      moveAmendmentDirectory(stage,finalEvidence);evidenceDir=finalEvidence;journal.moves.push("evidence-published");saveJournal();
      const detail={old_verifier_sha256:OLD_VERIFIER,new_verifier_sha256:authorized,old_checks_manifest_sha256:OLD_CHECKS,new_checks_manifest_sha256:nextChecks,candidate_sha256:candidateHash,attempt_tree_sha256:attemptHash,baseline_outputs_unchanged:true,original_attempt:1,new_verification_attempt:2,repairs_used:job.repairs_used,evidence_path:finalEvidence};
      await client.query("INSERT INTO approvals(job_id,kind,decision,by_name,statement,reference) VALUES($1,'change','accepted','Synthetic test harness',$2,$3)",[ID,TEST_STATEMENT,`TEST verifier ${OLD_VERIFIER} -> ${authorized}; unchanged candidate ${candidateHash}`]);
      await client.query("INSERT INTO interventions(job_id,kind,reason,detail,minutes) VALUES($1,'test_verifier_correction',$2,$3,5)",[ID,TEST_STATEMENT,JSON.stringify(detail)]);
      await client.query("INSERT INTO artifacts(job_id,kind,label,path,sha256,size_bytes,attempt,created_by,frozen,customer_visible,origin,origin_detail) VALUES($1,'frozen_checks',$2,$3,$4,$5,2,'verification',true,true,'tool',$6)",
        [ID,`Frozen engineering acceptance manifest, TEST verifier correction v${replacement.version}`,path.join(vault,"MANIFEST.json"),nextChecks,fs.statSync(path.join(vault,"MANIFEST.json")).size,JSON.stringify(detail)]);
      await client.query("INSERT INTO artifacts(job_id,kind,label,path,sha256,size_bytes,attempt,created_by,frozen,customer_visible,origin,origin_detail) VALUES($1,'verifier_amendment_baseline','Original baseline replayed twice for TEST correction',$2,$3,$4,2,'verification',true,true,'tool',$5)",
        [ID,path.join(finalEvidence,"baseline-replay.json"),hashFile(path.join(finalEvidence,"baseline-replay.json")),fs.statSync(path.join(finalEvidence,"baseline-replay.json")).size,JSON.stringify(detail)]);
      fs.chmodSync(path.join(finalEvidence,"baseline-replay.json"),0o444);
      await client.query("INSERT INTO events(job_id,actor,kind,important,summary,detail,origin) VALUES($1,'founder','intervention',true,$2,$3,'fixture')",[ID,"TEST verifier correction approved: stronger independent Nav2 GetResult witness; identical candidate moves from verification attempt 1 to attempt 2. Earlier evidence remains preserved.",JSON.stringify(detail)]);
      await client.query("UPDATE jobs SET attempt=2,checks_manifest_sha=$2,stage='verify',status='running',waiting_reason=NULL,next_run_at=now(),updated_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[ID,nextChecks]);
      await client.query("COMMIT");committed=true;journal.status="committed";saveJournal();
      console.log(JSON.stringify({job:ID,amended:true,...detail,repairsConsumed:0,testOnly:true},null,2));
    }catch(error){
      if(!committed){
        try{
          await client.query("ROLLBACK");
          const state=(await client.query("SELECT attempt,checks_manifest_sha FROM jobs WHERE id=$1",[ID])).rows[0];
          // A lost COMMIT response is not proof of rollback. Never undo files for a committed job.
          if(state?.attempt===2&&state.checks_manifest_sha===nextChecks){committed=true;journal.status="committed_response_reconciled";saveJournal();}
          else rollbackConfirmed=state?.attempt===1&&state.checks_manifest_sha===OLD_CHECKS;
        }catch{}
        if(rollbackConfirmed){
          try{
            if(evidenceDir===finalEvidence){moveAmendmentDirectory(finalEvidence,stage);evidenceDir=stage;}
            if(journal.moves.includes("attempt-2-installed")){insist(treeDigest(attempt2)===attemptHash,"Attempt 2 changed before rollback");moveAmendmentDirectory(attempt2,newAttempt);}
            if(journal.moves.includes("new-vault-installed")){insist(hashFile(path.join(vault,"MANIFEST.json"))===nextChecks,"New vault changed before rollback");moveAmendmentDirectory(vault,newVault);}
            if(journal.moves.includes("old-vault-to-history")){insist(hashFile(path.join(history,"MANIFEST.json"))===OLD_CHECKS,"Historical vault changed before rollback");moveAmendmentDirectory(history,vault);}
            journal.status="rolled_back";saveJournal();
          }catch(restoreError){journal.status="manual_recovery_required";journal.restoreError=String(restoreError);saveJournal();throw new Error(`Filesystem recovery needs operator review at ${evidenceDir}: ${String(restoreError)}`);}
        }else if(!committed){journal.status="database_commit_unknown_review_required";saveJournal();}
      }
      throw error;
    }finally{client.release();}
  }catch(error){journal.error=String(error);saveJournal();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await main();}catch(error){console.error((error as Error).message);process.exitCode=1;}finally{await pool.end();}
}
