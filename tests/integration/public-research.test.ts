import assert from "node:assert/strict";
import { test } from "node:test";
import { draftByTemplate,guardDraft } from "../../lib/growthRules";
import { fetchPublicPage,fetchPublicResearch,guardPublicResearch,repositoryUrl,type PublicResearch } from "../../lib/publicResearch";

test("public retrieval permits only unauthenticated HTTPS GitHub sources and checks redirects before following them",async()=>{
  let calls=0;
  const forbidden=(async()=>{calls++;throw new Error("Must not connect");}) as typeof fetch;
  for(const url of ["http://github.com/org/repo","https://github.com.evil.example/org/repo","https://user:password@github.com/org/repo","https://127.0.0.1/","https://raw.githubusercontent.com:444/org/repo/main/x"]){await assert.rejects(fetchPublicPage(url,forbidden),/public GitHub/);}
  assert.equal(calls,0);assert.equal(repositoryUrl("https://raw.githubusercontent.com/org/repo/main/requirements.txt"),"https://github.com/org/repo");
  const redirect=(async(_url:any,init:any)=>{calls++;assert.equal(init.method,"GET");assert.equal(init.redirect,"manual");assert.equal(init.credentials,"omit");assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Cookie,undefined);return new Response(null,{status:302,headers:{location:"https://169.254.169.254/latest/meta-data/"}});}) as typeof fetch;
  await assert.rejects(fetchPublicPage("https://github.com/org/repo",redirect),/public GitHub/);assert.equal(calls,1);
});

test("public retrieval bounds both announced and streamed response sizes and records exact hash provenance",async()=>{
  await assert.rejects(fetchPublicPage("https://raw.githubusercontent.com/org/repo/main/file",(async()=>new Response("x",{headers:{"content-length":String(128*1024+1)}})) as typeof fetch),/128 KiB/);
  await assert.rejects(fetchPublicPage("https://raw.githubusercontent.com/org/repo/main/file",(async()=>new Response("x".repeat(128*1024+1))) as typeof fetch),/128 KiB/);
  const page=await fetchPublicPage("https://raw.githubusercontent.com/org/repo/main/file",(async()=>new Response("Django>=3.2.5\n")) as typeof fetch);
  assert.equal(page.bytes,14);assert.match(page.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isFinite(Date.parse(page.fetchedAt)));
});

test("repository collection caps work at five repositories and ten documents and ignores private metadata",async()=>{
  let calls=0;
  const fetcher=(async(url:any)=>{calls++;const u=new URL(url);if(u.hostname==="api.github.com"){const full=u.pathname.replace("/repos/","");return Response.json({private:false,html_url:`https://github.com/${full}`,default_branch:"main",description:"A public repository"});}return new Response("Django>=3.2.5\n"+"x".repeat(7000));}) as typeof fetch;
  const data=await fetchPublicResearch(Array.from({length:7},(_,i)=>`https://github.com/org/repo${i}`),[],fetcher);
  assert.equal(data.requests,10);assert.equal(calls,10);assert.ok(data.repositories.length<=5);assert.ok(data.pages.length<=10);assert.ok(data.pages.every(p=>p.excerpt.length<=6000&&!("text" in p)));
  const privateData=await fetchPublicResearch(["https://github.com/org/private"],[],(async()=>Response.json({private:true,html_url:"https://github.com/org/private",default_branch:"main"})) as typeof fetch);
  assert.equal(privateData.pages.length,0);assert.match(privateData.errors[0].reason,/public repository/);
});

test("fresh discovery uses only unauthenticated public repository search and skips known or private results",async()=>{
  const urls:string[]=[];
  const data=await fetchPublicResearch([], ["https://github.com/org/known"],(async(url:any)=>{urls.push(String(url));if(String(url).includes("/search/repositories"))return Response.json({items:[{private:false,html_url:"https://github.com/org/known"},{private:true,html_url:"https://github.com/org/private"},{private:false,html_url:"https://github.com/org/new"}]});if(String(url).includes("api.github.com/repos/"))return Response.json({private:false,html_url:"https://github.com/org/new",default_branch:"main",description:"Upgradeable public tool"});return new Response("Django>=3.2.5\n");}) as typeof fetch);
  assert.equal(data.discovery,"github_repository_search");assert.deepEqual(data.repositories.map(r=>r.url),["https://github.com/org/new"]);assert.equal(urls.filter(u=>u.includes("search/repositories")).length,1);
});

test("agent assessment accepts only exact quotes from fetched pages and never stores invented factual summaries",()=>{
  const url="https://github.com/org/repo",source="https://raw.githubusercontent.com/org/repo/main/requirements.txt";
  const fetched:PublicResearch={repositories:[{url,fullName:"org/repo",description:"Official source description",branch:"main"}],pages:[{url:source,repositoryUrl:url,excerpt:"django>=3.2.5\nwagtail>=2.9,<3",sha256:"a".repeat(64),bytes:29,fetchedAt:new Date().toISOString()}],errors:[],requests:2,discovery:"recovery_urls"};
  const item={url,recipe:"django-lts-upgrade",summary:"Invented paid customer with old production version",evidence:[{url:source,quote:"django>=3.2.5"}],blockers:["Installed Django version is unknown"]};
  assert.equal(guardPublicResearch({prospects:[null,{...item,recipe:"toString"}]},fetched).kept.length,0);
  const valid=guardPublicResearch({prospects:[item]},fetched);assert.equal(valid.kept.length,1);assert.ok(!valid.kept[0].candidate.summary.includes("Invented"));assert.equal(valid.kept[0].qualification.fit_score,"Medium");assert.match(valid.kept[0].qualification.blockers[0],/No customer relationship/);
  for(const evidence of [[{url:source,quote:"django==3.2.5"}],[{url:"https://example.com/claim",quote:"django>=3.2.5"}]])assert.equal(guardPublicResearch({prospects:[{...item,evidence}]},fetched).kept.length,0);
});


test("host evidence outreach remains conditional and never claims a declared minimum is the deployed version",()=>{
  const p={name:"org/repo",url:"https://github.com/org/repo",found_by:"Naive assessment of host-fetched evidence",evidence:[{text:"django>=3.2.5",url:"https://raw.githubusercontent.com/org/repo/main/requirements.txt"}]};
  const draft=draftByTemplate(p,{fit_score:"Medium",recipe:"django-lts-upgrade",scope_fit:"Potential Django assessment. Runtime fit is unverified.",blockers:["No purchasing intent confirmed"],reasons:p.evidence},1100);
  assert.match(draft.body,/current deployed version is unknown/);assert.match(draft.body,/depend on that assessment/);assert.equal(guardDraft(draft,p,null).ok,true);
});

test("with a token, discovery uses code search for end-of-life pins, keeps organisation repos and supplies the matched file",async()=>{
  const before=process.env.GITHUB_TOKEN;process.env.GITHUB_TOKEN="ghp_fixture";
  const sha="a".repeat(40),seen:{url:string;auth:unknown}[]=[];
  try{
    const data=await fetchPublicResearch([],["https://github.com/known/app"],(async(url:any,init:any)=>{const u=String(url);seen.push({url:u,auth:init.headers.Authorization});
      if(u.includes("/search/code"))return Response.json({items:[
        {html_url:`https://github.com/acme/app/blob/${sha}/requirements.txt`,path:"requirements.txt",repository:{html_url:"https://github.com/acme/app",full_name:"acme/app",private:false,fork:false,owner:{type:"Organization"}}},
        {html_url:`https://github.com/jane/toy/blob/${sha}/requirements.txt`,path:"requirements.txt",repository:{html_url:"https://github.com/jane/toy",full_name:"jane/toy",private:false,fork:false,owner:{type:"User"}}},
        {html_url:`https://github.com/known/app/blob/${sha}/requirements.txt`,path:"requirements.txt",repository:{html_url:"https://github.com/known/app",full_name:"known/app",private:false,fork:false,owner:{type:"Organization"}}}]});
      if(u.includes("api.github.com/repos/"))return Response.json({private:false,html_url:"https://github.com/acme/app",default_branch:"main",description:"Acme orders"});
      return new Response("Django==2.2.28\n");}) as typeof fetch);
    assert.equal(data.discovery,"github_code_search");
    assert.deepEqual(data.repositories.map(r=>r.url),["https://github.com/acme/app"]);
    assert.ok(data.pages.some(p=>p.url===`https://raw.githubusercontent.com/acme/app/${sha}/requirements.txt`&&p.excerpt.includes("Django==2.2.28")));
    assert.ok(seen.filter(s=>s.url.includes("api.github.com")).every(s=>s.auth==="Bearer ghp_fixture"));
    assert.ok(seen.filter(s=>!s.url.includes("api.github.com")).every(s=>s.auth===undefined),"the token is sent only to api.github.com");
  }finally{if(before===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=before;}
});
