import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type GitHubSource = { url:string; owner:string; repository:string; requested_ref:string; commit:string; archive_sha256:string; retrieved_at:string };
export function parseGitHubSource(input:string, ref="") {
  let url:URL;try { url=new URL(input); } catch { throw new Error("Enter an HTTPS GitHub repository URL."); }
  if(url.protocol!=="https:"||url.hostname!=="github.com"||url.port||url.username||url.password||url.search||url.hash)throw new Error("Use a github.com HTTPS repository URL without credentials, query parameters or fragments.");
  const parts=url.pathname.replace(/\/$/,"").split("/").slice(1);
  if(parts.length!==2 || !parts.every(p=>/^[A-Za-z0-9_.-]+$/.test(p)) || parts.some(p=>p==="."||p===".."))throw new Error("Use https://github.com/owner/repository. Enter a branch, tag or commit in the separate revision field.");
  const repository=parts[1].replace(/\.git$/,"");
  if(!repository)throw new Error("Repository name is missing.");
  if(ref.length>200||/[\x00-\x20\x7f?#]/.test(ref)||ref.startsWith("-")||ref.includes(".."))throw new Error("Enter a valid branch, tag or full commit SHA.");
  return {owner:parts[0],repository,url:`https://github.com/${parts[0]}/${repository}`,ref:ref||"HEAD"};
}
async function bounded(url:string,max:number,fetcher:typeof fetch) {
  const response=await fetcher(url,{redirect:"manual",signal:AbortSignal.timeout(120000),headers:{Accept:"application/vnd.github+json","User-Agent":"Goose-repository-intake"}});
  if(!response.ok)throw new Error(response.status===404?"Repository or revision is unavailable. Use a public repository, or upload a ZIP for private source.":`GitHub source fetch failed (${response.status}). Try again or upload a ZIP.`);
  if(Number(response.headers.get("content-length"))>max)throw new Error("GitHub response exceeds the intake size limit.");
  if(!response.body)throw new Error("GitHub returned no source content.");
  const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error("GitHub response exceeds the intake size limit.");chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
export async function fetchGitHubSource(input:string,ref="",fetcher:typeof fetch=fetch) {
  const repo=parseGitHubSource(input,ref),api=`https://api.github.com/repos/${repo.owner}/${repo.repository}`;
  const metadata=JSON.parse((await bounded(api,1024*1024,fetcher)).toString());
  if(metadata.private!==false||metadata.full_name?.toLowerCase()!==`${repo.owner}/${repo.repository}`.toLowerCase())throw new Error("Only matching public GitHub repositories can be imported by link. Upload private source as a ZIP.");
  const revision=JSON.parse((await bounded(`${api}/commits/${encodeURIComponent(repo.ref)}`,2*1024*1024,fetcher)).toString());
  if(!/^[a-f0-9]{40}$/.test(revision.sha))throw new Error("GitHub did not resolve an immutable commit.");
  const bytes=await bounded(`https://codeload.github.com/${repo.owner}/${repo.repository}/zip/${revision.sha}`,150*1024*1024,fetcher);
  if(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)throw new Error("GitHub did not return a ZIP source archive.");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"goose-github-")),file=path.join(dir,"repository.zip");fs.writeFileSync(file,bytes,{mode:0o600});
  const provenance:GitHubSource={url:repo.url,owner:repo.owner,repository:repo.repository,requested_ref:repo.ref,commit:revision.sha,archive_sha256:crypto.createHash("sha256").update(bytes).digest("hex"),retrieved_at:new Date().toISOString()};
  return {file,provenance};
}
