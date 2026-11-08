// Synthetic fixture for orchestration and delivery integrity. Live upstream validation is separate.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createJob,jobById,runCurrentStage} from '../../lib/jobs';
import {pool,q} from '../../lib/db';
import {jobDir} from '../../lib/config';
import {makeWritable} from '../../lib/stages';
import {ADAPTIVE_STAGES} from '../../lib/adaptive';
import {IMPL_ALL} from '../../lib/pipeline';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'goose-adaptive-test-'));const jobs:string[]=[];
after(async()=>{for(const id of jobs){makeWritable(jobDir(id));fs.rmSync(jobDir(id),{recursive:true,force:true});}fs.rmSync(temporary,{recursive:true,force:true});await pool.end();});

test('autonomous dispatch freezes checks, verifies in Docker and refuses changed delivery bytes',{skip:process.env.GOOSE_TEST_DOCKER!=='1'},async()=>{
 const archive=path.join(temporary,'input.zip');fs.writeFileSync(archive,'Fixture only; archive intake is tested separately');
 const created=await createJob({accountName:'Autonomous contract test',kind:'demo',title:'Generic execution fixture',slug:'autonomous-test',timezone:'UTC',repoZip:archive,workspaceRequest:true,adaptiveRequest:true});jobs.push(created.id);
 const source=jobDir(created.id,'source'),work=jobDir(created.id,'work'),candidate=jobDir(created.id,'build','attempt-1','upgraded');
 for(const dir of [source,work,candidate])fs.mkdirSync(dir,{recursive:true});
 const original='def add(a,b):\n    return a+b\n';const originalTest='from calc import add\nassert add(2,3)==5\n';
 fs.mkdirSync(path.join(source,'tests'));fs.writeFileSync(path.join(source,'calc.py'),original);fs.writeFileSync(path.join(source,'tests/test_calc.py'),originalTest);
 const plan={version:1,title:'Add subtraction',image:'python:3.12-slim',dependency_hosts:[],setup:'',prepare:'',
  checks:[{id:'existing',title:'Addition stays unchanged',kind:'preserve',script:'PYTHONPATH=. python tests/test_calc.py'},{id:'requested',title:'Subtraction works',kind:'requirement',script:`python -c "import calc; assert hasattr(calc, 'subtract'); assert calc.subtract(9,2)==7"`}],
  protected_paths:['tests'],mutations:[{path:'calc.py',find:'return a+b',replace:'return a-b',check_id:'existing'}],deliverables:['calc.py'],limitations:['Synthetic fixture'],missing_requirements:[]};
 fs.writeFileSync(path.join(work,'accepted-plan.json'),JSON.stringify({adaptive_plan:plan}));
 fs.writeFileSync(path.join(work,'adaptive-discovery.json'),JSON.stringify({review:{accepted:true,issues:[]},fixture:true}));
 await q("UPDATE jobs SET stage='baseline',status='running',repair_budget=0 WHERE id=$1",[created.id]);
 let job=(await jobById(created.id))!;await runCurrentStage(job,IMPL_ALL);job=(await jobById(job.id))!;assert.equal(job.stage,'freeze',job.waiting_reason??undefined);
 await runCurrentStage(job,IMPL_ALL);job=(await jobById(job.id))!;assert.equal(job.stage,'implement');assert.ok(job.checks_manifest_sha);
 fs.writeFileSync(path.join(candidate,'calc.py'),original+'def subtract(a,b):\n    return a-b\n');fs.mkdirSync(path.join(candidate,'tests'));fs.writeFileSync(path.join(candidate,'tests/test_calc.py'),originalTest);fs.writeFileSync(path.join(candidate,'tests/test_new.py'),'# A new test file may be added without modifying original tests.\n');
 fs.writeFileSync(jobDir(job.id,'build','attempt-1','change.diff'),'Synthetic fixture implementation\n');
 await q("UPDATE jobs SET stage='verify' WHERE id=$1",[job.id]);job=(await jobById(job.id))!;
 const implementationReport=jobDir(job.id,'build','attempt-1','implementation-report.json');
 fs.writeFileSync(implementationReport,JSON.stringify({not_done:['A requested behavior remains unfinished']}));
 const held=await ADAPTIVE_STAGES.verify(job,1);assert.equal(held.status,'waiting_founder');
 const heldReport=JSON.parse(fs.readFileSync(jobDir(job.id,'verify','attempt-1','report.json'),'utf8'));
 assert.ok(heldReport.failed.some((c:any)=>c.id==='reported_limitations'));assert.deepEqual(heldReport.implementation_notes,['A requested behavior remains unfinished']);
 fs.unlinkSync(implementationReport);
 await runCurrentStage(job,IMPL_ALL);job=(await jobById(job.id))!;assert.equal(job.stage,'package');
 await runCurrentStage(job,IMPL_ALL);job=(await jobById(job.id))!;assert.equal(job.stage,'delivered');assert.equal(job.status,'waiting_customer');
 const delivered=jobDir(job.id,'delivery','delivery.zip');assert.ok(fs.statSync(delivered).size>0);
 const contents=execFileSync('/usr/bin/unzip',['-Z1',delivered],{encoding:'utf8'});assert.match(contents,/source\/calc.py/);assert.match(contents,/adaptive-discovery.json/);assert.match(contents,/adaptive-context.json/);assert.match(contents,/autonomy\/run.py/);
 const report=JSON.parse(fs.readFileSync(jobDir(job.id,'verify','attempt-1','report.json'),'utf8'));assert.equal(report.summary.failed,0);
 fs.appendFileSync(path.join(candidate,'calc.py'),'# Changed after verification\n');await assert.rejects(ADAPTIVE_STAGES.package(job,1),/exact verified source/);
 fs.writeFileSync(path.join(candidate,'tests/test_calc.py'),'pass\n');const rejected=await ADAPTIVE_STAGES.verify(job,1);assert.equal(rejected.status,'waiting_founder');
 const bad=JSON.parse(fs.readFileSync(jobDir(job.id,'verify','attempt-1','report.json'),'utf8'));assert.ok(bad.failed.some((c:any)=>c.id==='original_tests'));
});
