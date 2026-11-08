import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fetchGitHubSource, parseGitHubSource } from "../../lib/githubSource";

test("GitHub import accepts a separate revision and rejects credential/SSRF/path ambiguity",()=>{
 assert.deepEqual(parseGitHubSource("https://github.com/acme/project.git","release/2"),{owner:"acme",repository:"project",url:"https://github.com/acme/project",ref:"release/2"});
 for(const u of ["http://github.com/a/b","https://github.com.evil.test/a/b","https://user:secret@github.com/a/b","https://github.com:8443/a/b","https://github.com/a/b/tree/main","https://github.com/a/b?q=x","https://127.0.0.1/a/b","file:///tmp/source.zip"]){assert.throws(()=>parseGitHubSource(u));}
});
test("GitHub import freezes a commit, bounds downloads and sends no account credentials",async()=>{
 const calls:{url:string,init:any}[]=[];const sha="a".repeat(40),zip=Buffer.from([0x50,0x4b,0x03,0x04,1,2,3]);
 const fake=(async(url:any,init:any)=>{calls.push({url:String(url),init});if(String(url).includes("codeload"))return new Response(zip);return Response.json(String(url).includes("/commits/")?{sha}:{private:false,full_name:"acme/project"});}) as typeof fetch;
 const result=await fetchGitHubSource("https://github.com/acme/project","release/2",fake);
 try{assert.equal(result.provenance.commit,sha);assert.equal(result.provenance.requested_ref,"release/2");assert.deepEqual(fs.readFileSync(result.file),zip);assert.equal(calls[1].url,"https://api.github.com/repos/acme/project/commits/release%2F2");assert.equal(calls[2].url,`https://codeload.github.com/acme/project/zip/${sha}`);assert.ok(calls.every(c=>c.init.redirect==="manual"&&!new Headers(c.init.headers).has("authorization")));}finally{fs.rmSync(path.dirname(result.file),{recursive:true,force:true});}
 for(const response of [Response.json({private:true,full_name:"acme/project"}),new Response(null,{status:302,headers:{location:"http://127.0.0.1"}}),new Response("oversized",{headers:{"content-length":String(2*1024*1024)}})])await assert.rejects(()=>fetchGitHubSource("https://github.com/acme/project","",(async()=>response) as typeof fetch));
});
