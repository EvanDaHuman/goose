// Read-only public evidence retrieval. No credentials, cookies, repository execution or outbound contact.
import crypto from "node:crypto";
import { RECIPES, type Candidate, type Qualification } from "./growthRules";

export type PublicPage = { url:string; repositoryUrl:string; fetchedAt:string; sha256:string; bytes:number; excerpt:string };
export type PublicRepository = { url:string; fullName:string; description:string; branch:string };
export type PublicResearch = { repositories:PublicRepository[]; pages:PublicPage[]; errors:{url:string;reason:string}[]; requests:number; discovery:"recovery_urls"|"github_repository_search"|"github_code_search" };
const HOSTS=new Set(["github.com","api.github.com","raw.githubusercontent.com"]);
const MAX_BYTES=128*1024,MAX_FILES=10,MAX_REPOS=5;
function safeUrl(value:string){
  const url=new URL(value);
  if(url.protocol!=="https:"||!HOSTS.has(url.hostname)||url.username||url.password||url.port)throw new Error("Only credential-free public GitHub HTTPS URLs are allowed");
  return url;
}
export function repositoryUrl(value:string):string|null{
  try{
    const u=safeUrl(value),parts=u.pathname.split("/").filter(Boolean);
    if(u.hostname==="api.github.com"){if(parts.shift()!=="repos")return null;}
    if(parts.length<2||!parts.slice(0,2).every(s=>/^[a-zA-Z0-9_.-]+$/.test(s))||parts.slice(0,2).some(s=>s==="."||s===".."))return null;
    return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/,"")}`;
  }catch{return null;}
}
export async function fetchPublicPage(value:string,fetcher:typeof fetch=fetch):Promise<{url:string;text:string;sha256:string;bytes:number;fetchedAt:string}>{
  let url=safeUrl(value);const signal=AbortSignal.timeout(8000);
  for(let redirect=0;redirect<=2;redirect++){
    const res=await fetcher(url.toString(),{method:"GET",redirect:"manual",credentials:"omit",headers:{Accept:url.hostname==="api.github.com"?"application/vnd.github+json":"text/plain","User-Agent":"Goose-Public-Research",
      // a read-only token only raises GitHub's anonymous rate limit; it is sent to api.github.com and nowhere else
      ...(url.hostname==="api.github.com"&&process.env.GITHUB_TOKEN?{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`}:{})},signal});
    if([301,302,303,307,308].includes(res.status)){
      await res.body?.cancel();const location=res.headers.get("location");if(!location||redirect===2)throw new Error("Public source redirect limit exceeded");
      url=safeUrl(new URL(location,url).toString());continue;
    }
    if(!res.ok){await res.body?.cancel();throw new Error(`Public source returned HTTP ${res.status}`);}
    if(Number(res.headers.get("content-length")??0)>MAX_BYTES){await res.body?.cancel();throw new Error("Public source exceeds 128 KiB limit");}
    const reader=res.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
    if(reader){try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new Error("Public source exceeds 128 KiB limit");}chunks.push(part.value);}}finally{reader.releaseLock();}}
    const bytes=Buffer.concat(chunks);return{url:url.toString(),text:bytes.toString("utf8"),sha256:crypto.createHash("sha256").update(bytes).digest("hex"),bytes:size,fetchedAt:new Date().toISOString()};
  }
  throw new Error("Public source redirect limit exceeded");
}

export async function fetchPublicResearch(recoveryUrls:string[],knownUrls:string[],fetcher:typeof fetch=fetch):Promise<PublicResearch>{
  const known=new Set(knownUrls.map(repositoryUrl).filter(Boolean));
  const roots=[...new Set(recoveryUrls.map(repositoryUrl).filter((u):u is string=>Boolean(u)&&!known.has(u)))].slice(0,MAX_REPOS);
  const result:PublicResearch={repositories:[],pages:[],errors:[],requests:0,discovery:roots.length?"recovery_urls":"github_repository_search"};
  const get=async(url:string)=>{if(result.requests>=MAX_FILES)throw new Error("Public source request limit reached");result.requests++;return fetchPublicPage(url,fetcher);};
  // With a token, GitHub code search finds what the research agent is looking for directly: organisation-owned
  // applications whose requirements file pins an end-of-life framework. The matched file is supplied as evidence.
  const supplied:string[]=[];
  if(!roots.length&&process.env.GITHUB_TOKEN){
    const pins=["Django==1.11","Django==2.2","Django==3.2","Flask==1.1","Flask==0.12"],pin=pins[(new Date().getUTCHours()+new Date().getUTCDate())%pins.length];
    const url="https://api.github.com/search/code?"+new URLSearchParams({q:`"${pin}" filename:requirements.txt`,per_page:"30",page:String(1+new Date().getUTCHours()%3)});
    try{
      const data=JSON.parse((await get(url)).text);result.discovery="github_code_search";
      for(const item of data.items??[]){
        const repo=item.repository,root=repositoryUrl(repo?.html_url??"");
        if(!root||repo.private!==false||repo.fork||repo.owner?.type!=="Organization"||known.has(root)||roots.includes(root)||roots.length>=3)continue;
        const sha=new URL(item.html_url).pathname.split("/")[4];
        if(!/^[0-9a-f]{40}$/.test(sha??""))continue;
        roots.push(root);supplied.push(`https://raw.githubusercontent.com/${repo.full_name}/${sha}/${String(item.path).split("/").map(encodeURIComponent).join("/")}`);
      }
    }catch(e){result.errors.push({url,reason:(e as Error).message});}
  }
  if(!roots.length){
    // active applications on stacks Goose can upgrade, rotating by hour so successive cycles see different candidates
    const stacks=["django","flask"],stack=stacks[new Date().getUTCHours()%stacks.length];
    const since=new Date(Date.now()-365*86400_000).toISOString().slice(0,10);
    const url="https://api.github.com/search/repositories?"+new URLSearchParams({q:`${stack} in:readme,description language:Python archived:false fork:false stars:>=10 pushed:>${since}`,sort:"updated",order:"desc",per_page:"5",page:String(1+new Date().getUTCDate()%5)});
    try{const data=JSON.parse((await get(url)).text);for(const item of data.items??[]){const root=repositoryUrl(item.html_url);if(root&&item.private===false&&!known.has(root)&&!roots.includes(root)&&roots.length<MAX_REPOS)roots.push(root);}}
    catch(e){result.errors.push({url,reason:(e as Error).message});}
  }
  for(const root of roots){
    if(result.requests>=MAX_FILES)break;
    const fullName=new URL(root).pathname.slice(1),metadataUrl=`https://api.github.com/repos/${fullName}`;
    let repo:PublicRepository;
    try{
      const page=await get(metadataUrl),m=JSON.parse(page.text);
      if(m.private!==false||repositoryUrl(m.html_url)!==root||typeof m.default_branch!=="string")throw new Error("Source did not confirm a public repository");
      repo={url:root,fullName,description:String(m.description??"").slice(0,600),branch:m.default_branch};result.repositories.push(repo);
      const excerpt=JSON.stringify({full_name:fullName,html_url:root,description:repo.description,default_branch:repo.branch,language:m.language,archived:m.archived,private:false});
      result.pages.push({url:page.url,sha256:page.sha256,bytes:page.bytes,fetchedAt:page.fetchedAt,repositoryUrl:root,excerpt});
    }catch(e){result.errors.push({url:metadataUrl,reason:(e as Error).message});continue;}
    // Metadata and three small source documents per repository. All requests share the ten-file cap.
    const given=[...recoveryUrls,...supplied].filter(u=>repositoryUrl(u)===root&&new URL(u).hostname==="raw.githubusercontent.com");
    const files=[...new Set([...given,`https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(repo.branch)}/requirements.txt`,`https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(repo.branch)}/pyproject.toml`,`https://raw.githubusercontent.com/${fullName}/${encodeURIComponent(repo.branch)}/README.md`])].slice(0,3);
    for(const url of files){if(result.requests>=MAX_FILES)break;try{const page=await get(url);if(repositoryUrl(page.url)!==root)throw new Error("Source redirected to another repository");result.pages.push({url:page.url,sha256:page.sha256,bytes:page.bytes,fetchedAt:page.fetchedAt,repositoryUrl:root,excerpt:page.text.slice(0,6000)});}catch(e){result.errors.push({url,reason:(e as Error).message});}}
  }
  return result;
}
const normalize=(s:string)=>s.replace(/\s+/g," ").trim();
export function guardPublicResearch(raw:any,retrieved:PublicResearch):{kept:{candidate:Candidate;qualification:Qualification}[];rejected:string[]}{
  const kept:{candidate:Candidate;qualification:Qualification}[]=[],rejected:string[]=[];
  for(const item of Array.isArray(raw?.prospects)?raw.prospects.slice(0,MAX_REPOS):[]){
    const repo=retrieved.repositories.find(r=>r.url===item?.url),ev=Array.isArray(item?.evidence)?item.evidence:[];
    if(!repo||typeof item.recipe!=="string"||!Object.hasOwn(RECIPES,item.recipe)||!ev.length||ev.length>5){rejected.push("Candidate or recipe was not in the retrieved evidence set");continue;}
    if(!ev.every((e:any)=>typeof e.quote==="string"&&e.quote.trim().length>=10&&e.quote.length<=300&&retrieved.pages.some(p=>p.repositoryUrl===repo.url&&p.url===e.url&&normalize(p.excerpt).includes(normalize(e.quote))))){rejected.push(`${repo.fullName}: every evidence quote must occur in a fetched excerpt from that repository`);continue;}
    // Do not store generated empirical claims. Names/descriptions come from host-fetched metadata and evidence is exact source text.
    const evidence=ev.map((e:any)=>({text:e.quote.trim(),url:e.url}));
    const candidate:Candidate={name:repo.fullName,url:repo.url,category:"a",summary:`Public repository assessment opportunity. ${repo.description}`.slice(0,600),evidence,contact_channel:`Public project page: ${repo.url}`};
    const qualification:Qualification={fit_score:"Medium",recipe:item.recipe,scope_fit:`Potential ${item.recipe} assessment based on cited repository files. Implementation support and commercial demand are unverified.`,
      blockers:["No customer relationship or purchasing budget confirmed","Repository runtime, dependencies and acceptance contract require executable assessment",...Array.isArray(item.blockers)?item.blockers.filter((b:unknown)=>typeof b==="string").map((b:string)=>`Agent assessment, unverified: ${b.slice(0,240)}`).slice(0,4):[]],reasons:evidence};
    kept.push({candidate,qualification});
  }
  return {kept,rejected};
}
