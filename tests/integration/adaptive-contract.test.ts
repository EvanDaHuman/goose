import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveProblems } from "../../lib/adaptive";
const plan=()=>({version:1,title:"Add subtraction",image:"python:3.12-slim",dependency_hosts:["pypi.org","files.pythonhosted.org"],setup:"pip install pytest==8.3.5",prepare:"",checks:[{id:"existing",title:"Existing suite",kind:"preserve",script:"python -m pytest tests"},{id:"new_behavior",title:"Requested behavior",kind:"requirement",script:"python /acceptance/feature.py"}],protected_paths:["tests"],deliverables:["src/calc.py"],mutations:[{path:"src/calc.py",find:"return a+b",replace:"return a-b",check_id:"existing"}],limitations:["No production deployment"],missing_requirements:[]});
test("autonomous contracts require preserved behavior, requested behavior and a semantic negative control",()=>{
 assert.deepEqual(adaptiveProblems(plan()),[]);
 const p=plan();p.checks=p.checks.map(c=>({...c,kind:'preserve'}));assert.match(adaptiveProblems(p).join(),/new requirement/);
 const m=plan();m.mutations[0].check_id='new_behavior';assert.match(adaptiveProblems(m).join(),/Negative control/);
 const missing=plan();missing.protected_paths=[];assert.match(adaptiveProblems(missing).join(),/protected/);
});
test("autonomous plans reject escaping paths, injected images, private hosts and unbounded checks",()=>{
 for(const image of ['evil.example/root:latest','python:3.12;id','python','../../source:tag']){const p=plan();p.image=image;assert.ok(adaptiveProblems(p).length);}
 for(const h of ['127.0.0.1','metadata.google.internal','*.example.org','localhost','pypi.org:443']){const p=plan();p.dependency_hosts=[h];assert.ok(adaptiveProblems(p).length,h);}
 for(const f of ['../vault/plan.json','/etc/passwd','a/../../secret']){const p=plan();p.protected_paths=[f];assert.ok(adaptiveProblems(p).length);}
 const p:any=plan();p.checks[0].timeout_seconds=100000;assert.match(adaptiveProblems(p).join(),/timeout/);
});
