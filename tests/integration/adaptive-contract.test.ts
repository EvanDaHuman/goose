import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveProblems, acceptanceReviewApproved, agentExecutionEvidence, executionExcerpt } from "../../lib/adaptive";
const plan=()=>({version:1,title:"Add subtraction",image:"python:3.12-slim",dependency_hosts:["pypi.org","files.pythonhosted.org"],setup:"pip install pytest==8.3.5",prepare:"",checks:[{id:"existing",title:"Existing suite",kind:"preserve",script:"python -m pytest tests"},{id:"new_behavior",title:"Requested behavior",kind:"requirement",script:"python /acceptance/feature.py"}],protected_paths:["tests"],deliverables:["src/calc.py"],mutations:[{path:"src/calc.py",find:"return a+b",replace:"return a-b",check_id:"existing"}],limitations:["No production deployment"],missing_requirements:[]});
test("autonomous contracts require preserved behavior, requested behavior and a semantic negative control",()=>{
 assert.deepEqual(adaptiveProblems(plan()),[]);
 const p=plan();p.checks=p.checks.map(c=>({...c,kind:'preserve'}));assert.match(adaptiveProblems(p).join(),/new requirement/);
 const m=plan();m.mutations[0].check_id='new_behavior';assert.match(adaptiveProblems(m).join(),/Negative control/);
 const tests=plan();tests.mutations[0].path="tests/test_calc.py";assert.match(adaptiveProblems(tests).join(),/must not mutate protected/);
 const missing=plan();missing.protected_paths=[];assert.match(adaptiveProblems(missing).join(),/protected/);
});
test("autonomous plans reject escaping paths, injected images, private hosts and unbounded checks",()=>{
 for(const image of ['evil.example/root:latest','python:3.12;id','python','../../source:tag']){const p=plan();p.image=image;assert.ok(adaptiveProblems(p).length);}
 for(const h of ['127.0.0.1','metadata.google.internal','*.example.org','localhost','pypi.org:443']){const p=plan();p.dependency_hosts=[h];assert.ok(adaptiveProblems(p).length,h);}
 for(const f of ['../vault/plan.json','/etc/passwd','a/../../secret']){const p=plan();p.protected_paths=[f];assert.ok(adaptiveProblems(p).length);}
 const p:any=plan();p.checks[0].timeout_seconds=100000;assert.match(adaptiveProblems(p).join(),/timeout/);
});

test("a reviewer cannot approve unresolved findings with a contradictory accepted flag",()=>{
 assert.equal(acceptanceReviewApproved({accepted:true,issues:["Missing read-only subclass coverage"]}),false);
 assert.equal(acceptanceReviewApproved({accepted:true}),false);
 assert.equal(acceptanceReviewApproved({accepted:false,issues:[]}),false);
 assert.equal(acceptanceReviewApproved({accepted:true,issues:[]}),true);
});

// Malformed model output is feedback for discovery, not an orchestration crash.
test("invalid agent-produced check collections are rejected without throwing",()=>{
 for(const checks of [null,{},[null,null],[{},null],"invalid"]){
  const p:any=plan();p.checks=checks;assert.ok(adaptiveProblems(p).length);
 }
});

test("private data diagnostics never reach agents when a customer forbids data sharing",()=>{
 const report={ok:false,error:"private row",setup:{code:0,output:"private name"},checks:[{id:"writes",code:1,actual:{row:"private record"},output:"private email"}]};
 const safe=agentExecutionEvidence({constraints:["no_data"]},report);
 assert.ok(!JSON.stringify(safe).includes("private"));assert.equal(safe.checks[0].id,"writes");assert.equal(safe.checks[0].code,1);
 assert.equal(agentExecutionEvidence({constraints:[]},report),report);assert.equal(report.error,"private row");
});

test("long compiler diagnostics retain the first cause and the final summary",()=>{
 const output="Missing required logger property\n"+"verbose overload detail\n".repeat(1000)+"4 errors, compilation failed";
 const excerpt=executionExcerpt(output,1000);assert.match(excerpt,/Missing required logger property/);assert.match(excerpt,/4 errors, compilation failed/);assert.ok(excerpt.length<1200);
});

test("a plan cannot require editing files that it freezes as immutable",()=>{
 for(const root of ["src", "src/", "src/./", "."]){const p=plan();p.protected_paths=[root];assert.match(adaptiveProblems(p).join(),/deliverables overlap protected/);}
 const p=plan();p.protected_paths=["tests/"];p.mutations[0].path="tests/example.py";assert.match(adaptiveProblems(p).join(),/must not mutate protected/);
});
