// Diagnostic companion to the production pipeline adapter in migration.ts.
// Every candidate edit below must come from a recorded Naive response.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { naiveClient } from "../lib/naive/client";
import { config } from "../lib/config";

const client=naiveClient();
const root=path.join(config.root,"robotics");
const dir=path.join(config.varDir,"robotics","parts");
const label=process.argv[2]??"startup";
if(!/^[a-z0-9-]+$/.test(label))throw new Error("Invalid repair label");
const request=JSON.parse(fs.readFileSync(path.join(dir,`repair-${label}-request.json`),"utf8"));
const allowed:string[]=request.files;
const stateFile=path.join(dir,`repair-${label}.json`);
let state:any=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,"utf8")):{};
if(state.finishedAt){console.log(`Repair ${label} already recorded`);process.exit(0);}
const schema={type:"object",additionalProperties:false,properties:{summary:{type:"string"},patches:{type:"array",items:{type:"object",additionalProperties:false,properties:{path:{type:"string"},old:{type:"string"},replacement:{type:"string"}},required:["path","old","replacement"]}}},required:["summary","patches"]};
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+"\n");
const sha=(s:string)=>crypto.createHash("sha256").update(s).digest("hex");
if(!state.sessionId){
  const source=allowed.map(p=>`FILE ${p}\n${fs.readFileSync(path.join(root,"generated",p),"utf8")}`).join("\n\n");
  const agentId=JSON.parse(fs.readFileSync(path.join(dir,"agent.json"),"utf8")).id;
  const session=await client.sessions.create({agent_id:agentId,budget_micro_usd:2_000_000,output_schema:schema,structured_output_required:true,
    message:`Repair these real ROS2 runtime failures with minimal exact-match replacements. Return patches, each old string must occur exactly once in the indicated file; no other files. Preserve working algorithm semantics. Do not claim checks passed.\nDIAGNOSTICS:\n${request.diagnostics}\nCURRENT SOURCE:\n${source}`,
    metadata:{company:"goose-autonomous",task:`robotics-repair-${label}`,synthetic:"true"}} as any);
  state={sessionId:session.id,startedAt:new Date().toISOString(),before:Object.fromEntries(allowed.map(p=>[p,sha(fs.readFileSync(path.join(root,"generated",p),"utf8"))]))};save();
}
console.log(`Repair ${label}: ${state.sessionId}`);
const deadline=Date.now()+12*60_000;
for(;;){
  const s:any=await client.sessions.get(state.sessionId);state.status=s.status;state.stopReason=s.stop_reason;state.consumedMicroUsd=Number(s.consumed_micro_usd??0);save();
  if(["completed","idle","failed","cancelled"].includes(s.status)){
    const events:any[]=[];let after:number|undefined;
    for(let i=0;i<30;i++){const e:any=await client.sessions.events(s.id,{limit:100,...(after===undefined?{}:{after_seq:after})});events.push(...e.data);after=e.data.at(-1)?.seq;if(!e.has_more)break;}
    fs.writeFileSync(path.join(dir,`${s.id}.jsonl`),events.map(e=>JSON.stringify(e)).join("\n")+"\n");
    const out=s.structured_output??[...events].reverse().find(e=>e.type==="session.idle"&&e.data?.structured_output)?.data.structured_output;
    if(!out?.patches?.length)throw new Error(`No repair patches (${s.status}/${s.stop_reason})`);
    const contents=new Map(allowed.map(p=>[p,fs.readFileSync(path.join(root,"generated",p),"utf8")]));
    for(const patch of out.patches){
      if(!allowed.includes(patch.path)||!patch.old)throw new Error("Unexpected repair path or empty match");
      const content=contents.get(patch.path)!;
      if(content.split(patch.old).length!==2)throw new Error(`Repair match must occur once: ${patch.path}`);
      contents.set(patch.path,content.replace(patch.old,()=>patch.replacement));
    }
    for(const [p,c] of contents)fs.writeFileSync(path.join(root,"generated",p),c);
    state.finishedAt=new Date().toISOString();state.summary=out.summary;state.patches=out.patches;state.after=Object.fromEntries([...contents].map(([p,c])=>[p,sha(c)]));save();
    fs.writeFileSync(path.join(root,"evidence",`naive-repair-${label}.json`),JSON.stringify(state,null,2)+"\n");
    console.log(JSON.stringify({patches:out.patches.length,costUsd:state.consumedMicroUsd/1e6,summary:out.summary}));break;
  }
  if(Date.now()>deadline){await client.sessions.cancel(s.id);throw new Error("Repair deadline exceeded");}
  await new Promise(resolve=>setTimeout(resolve,3000));
}
