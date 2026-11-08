import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { POST } from "../../app/api/jobs/route";
import { createInquiry } from "../../lib/commerce";
import { pool, q } from "../../lib/db";
import { jobByToken } from "../../lib/jobs";
import { jobDir } from "../../lib/config";
import { makeWritable } from "../../lib/stages";

const created:string[]=[];
after(async()=>{for(const id of created){makeWritable(jobDir(id));fs.rmSync(jobDir(id),{recursive:true,force:true});}await pool.end();});
function request(email:string,inquiry:string,goal="Preserve this source and assess the requested engineering change.",origin="http://localhost") {
  const form=new FormData();
  for(const [k,v] of Object.entries({business:"Synthetic inquiry company",contact:"Synthetic customer",title:"Repository assessment",email,goal,authorized:"on",demo:"on",job_type:"workspace",inquiry_id:inquiry,timezone:"UTC"}))form.set(k,v);
  form.set("repository",new File(["Source ZIP; execution validation belongs to intake"],"source.zip"));
  return new Request("http://localhost/api/jobs",{method:"POST",headers:{origin},body:form});
}
async function countJobs(email:string) {return (await q<{n:number}>("SELECT count(*)::int AS n FROM jobs j JOIN accounts a ON a.id=j.account_id WHERE a.contact_email=$1",[email]))[0].n;}

test("invalid inquiry linkage cannot create an inaccessible running job",async()=>{
  const inquiry=await createInquiry({name:"Synthetic customer",email:"owner-intake@example.test",organization:"Synthetic company",goal:"A sufficiently detailed repository engineering change",isTest:true});
  const denied=await POST(request("different-intake@example.test",inquiry.id));
  assert.equal(denied.status,400);assert.equal(await countJobs("different-intake@example.test"),0);
  const crossOrigin=await POST(request("owner-intake@example.test",inquiry.id,undefined,"https://unrelated.example"));
  assert.equal(crossOrigin.status,403);assert.equal(await countJobs("owner-intake@example.test"),0);
});

test("concurrent intake submissions link exactly one job and retain the entire customer goal",async()=>{
  const email="concurrent-intake@example.test";
  const inquiry=await createInquiry({name:"Synthetic customer",email,organization:"Synthetic company",goal:"A sufficiently detailed repository engineering change",isTest:true});
  const goal="Preserve customer requirements. ".repeat(100)+"The final requirement must remain in the accepted scope.";
  const responses=await Promise.all([POST(request(email,inquiry.id,goal)),POST(request(email,inquiry.id,goal))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  const result=await responses.find(r=>r.status===200)!.json();created.push(result.id);
  assert.equal(await countJobs(email),1);
  const job=await jobByToken(result.id,result.t);assert.ok(job);assert.equal(job.goal,goal);
  const linked=(await q<{job_id:string}>("SELECT job_id FROM commerce_inquiries WHERE public_id=$1",[inquiry.id]))[0];assert.equal(linked.job_id,result.id);
  const retry=await POST(request(email,inquiry.id,goal));assert.equal(retry.status,400);assert.equal(await countJobs(email),1);
});

test("public GitHub customer intake records the commit and selects autonomous discovery",async()=>{
  const original=globalThis.fetch,sha="d".repeat(40);
  globalThis.fetch=(async(input:any)=>{
    const url=String(input);
    if(url.endsWith('/repos/acme/complex'))return Response.json({full_name:"acme/complex",private:false,default_branch:"main",html_url:"https://github.com/acme/complex"});
    if(url.includes('/commits/main'))return Response.json({sha});
    if(url.includes('/zipball/'+sha))return new Response(Buffer.from('PK\x03\x04test-source'));
    return Response.json({}, {status:404});
  }) as typeof fetch;
  try{
    const form=new FormData();for(const [k,v] of Object.entries({business:"GitHub intake test",contact:"Synthetic customer",title:"Complex repository",email:"github-intake@example.test",goal:"Discover this repository and implement the requested feature.",authorized:"on",demo:"on",job_type:"workspace",github_repo:"https://github.com/acme/complex",timezone:"UTC"}))form.set(k,v);
    const r=await POST(new Request("http://localhost/api/jobs",{method:"POST",headers:{origin:"http://localhost"},body:form}));assert.equal(r.status,200);const body=await r.json();created.push(body.id);
    const job=await jobByToken(body.id,body.t);assert.ok(job);assert.equal(job.recipe,"workspace-change");
    assert.equal(JSON.parse(fs.readFileSync(jobDir(body.id,"inputs","workspace-request.json"),"utf8")).adaptive,true);
    const source=(await q<{source:any}>("SELECT source FROM job_inputs WHERE job_id=$1 AND kind='repository'",[body.id]))[0].source;assert.equal(source.commit,sha);assert.equal(source.access,"public");
    assert.equal(JSON.parse(fs.readFileSync(jobDir(body.id,"inputs","github-source.json"),"utf8")).commit,sha);
  }finally{globalThis.fetch=original;}
});
