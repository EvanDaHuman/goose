// ROS implementation adapter inside Goose's normal job ledger and spending/repair limits.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Ctx } from "../lib/agents";
import { config, jobDir } from "../lib/config";
import { naiveClient } from "../lib/naive/client";
import { uploadFile } from "../lib/naive/files";
import { runAgentTask } from "../lib/naive/run";
import { jobSpend, logEvent } from "../lib/records";

const TASKS=[
 {name:"core",source:["scripts/functions.py"],outputs:["scripts/core.py"]},
 {name:"detector",source:["src/functions.cpp","src/global_rrt_detector.cpp"],outputs:["src/rrt_detector.cpp"]},
 {name:"filter",source:["scripts/filter.py"],outputs:["scripts/filter.py"]},
 {name:"assigner",source:["scripts/assigner.py","scripts/functions.py"],outputs:["scripts/assigner.py"]},
 {name:"package",source:["CMakeLists.txt","package.xml","msg/PointArray.msg"],outputs:["CMakeLists.txt","package.xml","msg/PointArray.msg","launch/exploration.launch.py","README.md"]},
];
const SCHEMA={type:"object",additionalProperties:false,properties:{summary:{type:"string"},files:{type:"array",items:{type:"object",additionalProperties:false,properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"]}}},required:["summary","files"]};
const REPAIR_SCHEMA={type:"object",additionalProperties:false,properties:{decision:{type:"string",enum:["repair","blocked"]},summary:{type:"string"},tasks:{type:"array",items:{type:"string",enum:TASKS.map(t=>t.name)}},reasons:{type:"array",items:{type:"string"}}},required:["decision","summary","tasks","reasons"]};
const SHARED=`COMMON CROSS-FILE CONTRACT: detector publishes /detected_points as PointStamped and consumes /map; filter consumes these topics and publishes /filtered_points as goose_rrt_exploration/PointArray. PointArray.msg contains exactly geometry_msgs/Point[] points, with no header field. Filtered points are already in the configured map frame; do not assign a nonexistent message header. The assigner consumes /filtered_points and /map, TF map->base_link, and navigate_to_pose action. core.py is beside scripts, import core. Python scripts have python3 shebang. No blocking waits in callbacks. The C++ executable is rrt_detector; Python executables are filter.py and assigner.py. Default map_topic /map, points_topic /detected_points, frontiers_topic /filtered_points, global_frame map, robot_frame base_link; use_sim_time true in launch. Publish /goose/exploration_status as std_msgs/String with JSON fields completed_goals and failed_goals. Wait for active Nav2 lifecycle /bt_navigator/get_state state 3 before dispatching; merely finding the action server is insufficient. Handle rejected goals by retrying after a delay. For source baseline functions preserve Python2 integer division and unknown-cell discount semantics. All files must compile on ROS2 Jazzy. ROS2 Node already declares use_sim_time: do not declare it again in rclpy or rclcpp; use has_parameter guard only if needed. On ARM64 plain char may be unsigned: frontier status -1/0/1 must use int or explicit signed type, including the receiving local variable; never rely on plain char being signed.`;

export async function migrateRobotWithAgent(ctx:Ctx,input:{candidateZip:string;items:any[];context:string;evidence?:any;outZip:string}) {
  const client=naiveClient(), startedSpend=(await jobSpend(ctx.jobId)).total;
  const root=path.join(config.root,"robotics"), original=path.join(root,"source/rrt_exploration");
  const requirements=fs.readFileSync(path.join(original,"MIGRATION_REQUIREMENTS.md"),"utf8");
  const destination=jobDir(ctx.jobId,"work",`robotics-parts-${ctx.attempt}`);
  // The authoritative input archive plus cached agent outputs make retries deterministic.
  // Never mix leftovers from an interrupted attempt into the next packaged candidate.
  fs.rmSync(destination,{recursive:true,force:true});fs.mkdirSync(destination,{recursive:true});
  // The original archive is already admitted by the pinned-source baseline. Extract safely anyway.
  execFileSync(config.python.engine,["-c",`import pathlib,zipfile,sys,stat
z=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2]); entries=z.infolist()
if len(entries)>500 or sum(e.file_size for e in entries)>20*1024*1024:raise ValueError('Oversized candidate')
for entry in entries:
 p=pathlib.PurePosixPath(entry.filename)
 if p.is_absolute() or '..' in p.parts or stat.S_ISLNK(entry.external_attr>>16):raise ValueError('Unsafe candidate archive')
 if entry.is_dir():continue
 target=root.joinpath(*p.parts);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(entry))`,input.candidateZip,destination],{timeout:30_000});
  const parts:any[]=[];
  const diagnostics=input.evidence?JSON.stringify(input.evidence).slice(0,16000):"";
  const previousProvenance=path.join(destination,"GOOSE_AGENT_PROVENANCE.json");
  const prior=fs.existsSync(previousProvenance)?JSON.parse(fs.readFileSync(previousProvenance,"utf8")):null;
  let selected=TASKS,repairPlan:any=null;
  if(input.evidence){
    const spent=(await jobSpend(ctx.jobId)).total;
    const remaining=Math.max(0,ctx.budgetMicroUsd-(spent-startedSpend));
    const planned=await runAgentTask(client,{jobId:ctx.jobId,stage:ctx.stage,attempt:ctx.attempt,role:"implementation",purpose:"robotics-repair-plan",
      title:"Select the ROS components that need repair",budgetMicroUsd:Math.min(500_000,remaining),timeoutMs:10*60_000,outputSchema:REPAIR_SCHEMA,
      message:`Choose the smallest set of components to repair from actual independent build/runtime diagnostics. Do not write code or run tools. Preserve passing components, especially core algorithm parity, unless diagnostics implicate them. Include package only when build metadata, dependencies or launch wiring also need changing. If the failure cannot be repaired within the approved scope, return blocked.\nApproved requirements:\n${requirements}\nAvailable components: ${JSON.stringify(TASKS.map(t=>({name:t.name,files:t.outputs})))}\nCurrent package metadata:\n${fs.existsSync(path.join(destination,"package.xml"))?fs.readFileSync(path.join(destination,"package.xml"),"utf8").slice(0,6000):"missing"}\nIndependent diagnostics:\n${diagnostics}`});
    if(!planned.ok)return planned;
    const names=planned.output.tasks;
    if(!Array.isArray(names)||names.some((n:any)=>!TASKS.some(t=>t.name===n))||new Set(names).size!==names.length)
      return {ok:false as const,reason:"no_output" as const,message:"Repair planner returned invalid or duplicate component names",sessionId:planned.sessionId};
    if(planned.output.decision!=="repair"||names.length===0)
      return {ok:false as const,reason:"blocked" as const,message:planned.output.summary||"No scoped robotics repair was proposed",sessionId:planned.sessionId};
    selected=TASKS.filter(t=>names.includes(t.name));
    repairPlan={sessionId:planned.sessionId,model:planned.model,consumedMicroUsd:planned.consumedMicroUsd,...planned.output};
    await logEvent(ctx.jobId,"implementation","decision",`Naive selected ${names.join(", ")} for diagnostic repair; other components will retain their exact bytes.`,{session_id:planned.sessionId,plan:planned.output},{origin:"agent",originDetail:{session_id:planned.sessionId}});
  }
  const preserved=Object.fromEntries(TASKS.filter(t=>!selected.includes(t)).flatMap(t=>t.outputs).filter(p=>fs.existsSync(path.join(destination,p))).map(p=>[p,crypto.createHash("sha256").update(fs.readFileSync(path.join(destination,p))).digest("hex")]));
  for(const task of selected) {
    const source=task.source.map(p=>`FILE ${p}\n${fs.readFileSync(path.join(original,p),"utf8")}`).join("\n\n");
    const current=input.evidence?task.outputs.filter(p=>fs.existsSync(path.join(destination,p))).map(p=>`CURRENT ${p}\n${fs.readFileSync(path.join(destination,p),"utf8")}`).join("\n").slice(0,40000):"";
    const spent=(await jobSpend(ctx.jobId)).total;
    const remaining=Math.max(0,ctx.budgetMicroUsd-(spent-startedSpend));
    const r=await runAgentTask(client,{jobId:ctx.jobId,stage:ctx.stage,attempt:ctx.attempt,role:"implementation",purpose:`robotics-${task.name}`,
      title:`${input.evidence?"Repair":"Migrate"} ROS ${task.name}`,budgetMicroUsd:Math.min(2_000_000,remaining),timeoutMs:15*60_000,outputSchema:SCHEMA,
      message:`You are implementing one bounded component of this approved ROS migration, using source supplied inline to avoid provider context overflow. For this task, do NOT fetch archives or publish a zip. Return complete source text ONLY for ${JSON.stringify(task.outputs)} in the structured files array. No tools are necessary. Other bounded tasks implement the other files. Do not claim tests passed. ${input.evidence?"Make the smallest diagnostic repair to CURRENT source. Preserve existing working behavior; do not gratuitously rewrite the component.":""}\n${requirements}\n${SHARED}\nROS2 Jazzy pitfalls: tf2 transformations of PointStamped need the tf2_geometry_msgs registration import. There is no module-level rclpy.on_shutdown; use a supported context callback or try/finally shutdown lifecycle.\nCustomer-approved context: ${input.context.slice(0,3000)}\n${input.evidence?`Repair selection: ${JSON.stringify(repairPlan)}\nIndependent failure diagnostics: ${diagnostics}\n${current}`:""}\nLEGACY SOURCE:\n${source}`});
    if(!r.ok)return r;
    const files=r.output.files;
    if(!Array.isArray(files)||files.length!==task.outputs.length||new Set(files.map(x=>x.path)).size!==files.length||task.outputs.some(p=>!files.some(x=>x.path===p))||files.some(x=>typeof x.content!=="string"||x.content.length>200_000))
      return {ok:false as const,reason:"no_output" as const,message:`Robotics ${task.name} returned missing, duplicate or oversized source files`,sessionId:r.sessionId};
    const hashes:Record<string,string>={};
    for(const file of files) {
      if(!task.outputs.includes(file.path))return {ok:false as const,reason:"no_output" as const,message:"Unexpected generated source path",sessionId:r.sessionId};
      const target=path.join(destination,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.content);
      if(file.path.endsWith(".py"))fs.chmodSync(target,0o755);
      hashes[file.path]=crypto.createHash("sha256").update(file.content).digest("hex");
    }
    parts.push({name:task.name,sessionId:r.sessionId,model:r.model,consumedMicroUsd:r.consumedMicroUsd,summary:r.output.summary,files:hashes});
    fs.writeFileSync(path.join(destination,"GOOSE_AGENT_PROVENANCE.json"),JSON.stringify({jobId:ctx.jobId,attempt:ctx.attempt,sourceRevision:JSON.parse(fs.readFileSync(path.join(root,"source/manifest.json"),"utf8")).revision,repairPlan,preservedFiles:preserved,previousCandidateProvenance:prior,parts,verification:"pending",packaging:"Product runner assembles source files returned by live Naive sessions; checks execute separately"},null,2));
    await logEvent(ctx.jobId,"implementation","decision",`Completed robotics ${task.name} source generation; independent checks pending.`,{session_id:r.sessionId,files:hashes},{origin:"agent",originDetail:{session_id:r.sessionId}});
  }
  fs.mkdirSync(path.dirname(input.outZip),{recursive:true});
  execFileSync(config.python.engine,["-c","import pathlib,zipfile,sys; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [(z.write(p,p.relative_to(root))) for p in root.rglob('*') if p.is_file()]; z.close()",destination,input.outZip],{timeout:30_000});
  const file=await uploadFile(client,ctx.jobId,input.outZip,`${ctx.jobId}-robotics-agent-source-a${ctx.attempt}.zip`,["agent-generated-source","host-packaged"]);
  const last=parts.at(-1)!;
  return {ok:true as const,sessionId:last.sessionId,model:last.model,consumedMicroUsd:parts.reduce((sum,p)=>sum+p.consumedMicroUsd,0)+(repairPlan?.consumedMicroUsd??0),
    output:{result_file_id:file.id,summary:`${parts.length} bounded live Naive tasks ${input.evidence?"repaired selected components of":"migrated"} the ROS exploration package; independent build, behavior and simulation checks are pending.`,changed_files:parts.flatMap(p=>Object.keys(p.files).map(file=>({file,why:p.summary}))),tests:{command:"Independent Goose robotics verifier",passed:false,output_tail:"Not run by implementation agents; authoritative checks follow in the verification stage."},not_done:[]},
    download:{path:input.outZip,sha256:file.sha256,bytes:file.bytes}};
}
