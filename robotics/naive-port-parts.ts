// Small independent Naive tasks keep the source and generated output within provider context limits.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { naiveClient } from "../lib/naive/client";
import { config } from "../lib/config";
const client=naiveClient();const root=path.join(config.root,"robotics");const stateDir=path.join(config.varDir,"robotics","parts");
fs.mkdirSync(stateDir,{recursive:true});fs.mkdirSync(path.join(root,"generated"),{recursive:true});
const schema={type:"object",additionalProperties:false,properties:{summary:{type:"string"},files:{type:"array",items:{type:"object",additionalProperties:false,properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"]}}},required:["summary","files"]};
const spec=fs.readFileSync(path.join(root,"source/rrt_exploration/MIGRATION_REQUIREMENTS.md"),"utf8");
const tasks=[
 {name:"core",source:["scripts/functions.py"],outputs:["scripts/core.py"]},
 {name:"detector",source:["src/functions.cpp","src/global_rrt_detector.cpp"],outputs:["src/rrt_detector.cpp"]},
 {name:"filter",source:["scripts/filter.py"],outputs:["scripts/filter.py"]},
 {name:"assigner",source:["scripts/assigner.py","scripts/functions.py"],outputs:["scripts/assigner.py"]},
 {name:"package",source:["CMakeLists.txt","package.xml","msg/PointArray.msg"],outputs:["CMakeLists.txt","package.xml","msg/PointArray.msg","launch/exploration.launch.py","README.md"]},
];
let agentId:string;
const agentState=path.join(stateDir,"agent.json");
if(fs.existsSync(agentState)) agentId=JSON.parse(fs.readFileSync(agentState,"utf8")).id;
else {
 const agent=await client.agents.create({name:`goose-autonomous-robotics-parts-${Date.now()}`,model:config.naive.model,harness:"pi",window:"immediate",handoffs:false,
   system:"You are Goose's robotics migration engineer. Implement only the requested files, translating the real supplied source to ROS2. Be concise in reasoning and produce complete compilable files in the exact JSON schema. Never claim tests passed. Do not call tools; all needed code is supplied.",
   tools:{default_config:{permission:"deny"},configs:{}},budget:{cap_micro_usd:16_000_000,max_task_micro_usd:2_000_000,period:"month"},metadata:{company:"goose-autonomous",role:"robotics-implementation"}} as any);
 agentId=agent.id;fs.writeFileSync(agentState,JSON.stringify({id:agentId},null,2));
}
for(const task of tasks) {
 const stateFile=path.join(stateDir,`${task.name}.json`);let state:any=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,"utf8")):{};
 if(state.finishedAt)continue;
 if(!state.sessionId) {
  const source=task.source.map(p=>`FILE ${p}\n${fs.readFileSync(path.join(root,"source/rrt_exploration",p),"utf8")}`).join("\n\n");
  const previous=tasks.filter(x=>x.name!==task.name).flatMap(x=>x.outputs).filter(p=>fs.existsSync(path.join(root,"generated",p))).map(p=>`${p}: already generated; respect the required interfaces.`).join("\n");
  const message=`This is the ${task.name} task in a split migration. Return ONLY ${JSON.stringify(task.outputs)} in files. Do not create other files. Use the following complete interface requirements; other tasks implement the other files.\n${spec}\nCOMMON CROSS-FILE CONTRACT: detector publishes /detected_points as PointStamped and consumes /map; filter consumes these topics and publishes /filtered_points as goose_rrt_exploration/PointArray; assigner consumes /filtered_points and /map, TF map->base_link, and navigate_to_pose action. core.py is beside scripts, import core. Python scripts have python3 shebang. No blocking waits in callbacks. The C++ executable is rrt_detector; Python executables are filter.py and assigner.py. Default map_topic /map, points_topic /detected_points, frontiers_topic /filtered_points, global_frame map, robot_frame base_link; use_sim_time true in launch.\n${previous}\nLEGACY SOURCE:\n${source}`;
  const session=await client.sessions.create({agent_id:agentId,message,output_schema:schema,structured_output_required:true,budget_micro_usd:2_000_000,metadata:{company:"goose-autonomous",task:`robotics-${task.name}`,synthetic:"true"}} as any);
  state={sessionId:session.id,startedAt:new Date().toISOString()};fs.writeFileSync(stateFile,JSON.stringify(state,null,2));
 }
 console.log(`${task.name}: ${state.sessionId}`);const deadline=Date.now()+12*60_000;
 for(;;){
  const s:any=await client.sessions.get(state.sessionId);state.status=s.status;state.stopReason=s.stop_reason;state.consumedMicroUsd=Number(s.consumed_micro_usd??0);fs.writeFileSync(stateFile,JSON.stringify(state,null,2));
  if(["completed","idle","failed","cancelled"].includes(s.status)) {
   const events:any[]=[];let after:number|undefined;
   for(let i=0;i<30;i++){const e:any=await client.sessions.events(s.id,{limit:100,...(after===undefined?{}:{after_seq:after})});events.push(...e.data);after=e.data.at(-1)?.seq;if(!e.has_more)break;}
   fs.writeFileSync(path.join(stateDir,`${s.id}.jsonl`),events.map(e=>JSON.stringify(e)).join("\n")+"\n");
   const output=s.structured_output??[...events].reverse().find(e=>e.type==="session.idle"&&e.data?.structured_output)?.data.structured_output;
   if(!output?.files)throw new Error(`${task.name}: no result (${s.status}/${s.stop_reason})`);
   const provided=new Set(output.files.map((x:any)=>x.path));
   if(task.outputs.some(p=>!provided.has(p)) || output.files.some((x:any)=>!task.outputs.includes(x.path)))throw new Error("Agent returned unexpected or missing file names");
   const manifest:Record<string,string>={};
   for(const file of output.files){const p=path.join(root,"generated",file.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,file.content);if(file.path.endsWith(".py"))fs.chmodSync(p,0o755);manifest[file.path]=crypto.createHash("sha256").update(file.content).digest("hex");}
   state.finishedAt=new Date().toISOString();state.summary=output.summary;state.files=manifest;fs.writeFileSync(stateFile,JSON.stringify(state,null,2));console.log(`${task.name} complete $${state.consumedMicroUsd/1e6}`);break;
  }
  if(Date.now()>deadline){await client.sessions.cancel(s.id);throw new Error("Part exceeded deadline");}
  await new Promise(r=>setTimeout(r,3000));
 }
}
const parts=tasks.map(t=>JSON.parse(fs.readFileSync(path.join(stateDir,`${t.name}.json`),"utf8")));
const report={agentId,parts,consumedMicroUsd:parts.reduce((sum,p)=>sum+p.consumedMicroUsd,0),verification:"pending",realCustomer:false,sourceRevision:JSON.parse(fs.readFileSync(path.join(root,"source/manifest.json"),"utf8")).revision};
fs.writeFileSync(path.join(root,"evidence/naive-generation.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({parts:parts.length,costUsd:report.consumedMicroUsd/1e6}));
