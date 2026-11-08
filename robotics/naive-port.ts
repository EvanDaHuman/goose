// Explicit, budgeted live Naive source migration. Does not contact customers or modify hardware.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { naiveClient } from "../lib/naive/client";
import { config } from "../lib/config";

const root = path.join(config.root, "robotics");
const runDir = path.join(config.varDir, "robotics");
fs.mkdirSync(runDir, { recursive: true });
const statePath = path.join(runDir, "naive-state.json");
const client = naiveClient();
const repair = process.argv.includes("--repair");
const budget = 8_000_000;
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string" }, limitations: { type: "array", items: { type: "string" } },
    archive_file_id: { type: "string" },
  }, required: ["summary", "limitations", "archive_file_id"],
};
const files = ["scripts/functions.py", "scripts/assigner.py", "scripts/filter.py", "src/functions.cpp", "src/global_rrt_detector.cpp", "msg/PointArray.msg", "package.xml", "CMakeLists.txt"];
const source = files.map(f => `FILE ${f}\n${fs.readFileSync(path.join(root,"source/rrt_exploration",f),"utf8")}`).join("\n\n");
const requirements = `Migrate the supplied real MIT ROS1 rrt_exploration source to a buildable ROS2 Jazzy package called goose_rrt_exploration. Target ONE differential-drive robot, an existing Nav2 NavigateToPose action server, existing SLAM /map (nav_msgs/OccupancyGrid), and tf2 map -> base_link. Nav2 and Gazebo are existing infrastructure, not things you must recreate. Never claim simulation or tests passed; an independent runner checks the result.
Use fetch_file to download the source archive, extract it and read relevant files selectively. WRITE the complete migrated source into a directory called output, zip that directory's contents and publish_file the archive. Return its fil_ identifier as archive_file_id. Do not return source code inline. Required paths relative to the package: package.xml, CMakeLists.txt, msg/PointArray.msg, src/rrt_detector.cpp, scripts/core.py, scripts/filter.py, scripts/assigner.py, launch/exploration.launch.py, README.md. Use ament_cmake and rosidl_default_generators, install Python scripts executable with core.py beside them. Generated PointArray retains geometry_msgs/Point[] points. Use only standard ROS2 packages, numpy, and Python standard library (no sklearn).
Port real algorithm concepts: RRT samples free-to-unknown frontiers, frontier filtering removes invalid/occupied/low-information candidates, assigner uses information gain minus travel cost with hysteresis. Preserve RRT logic from supplied C++ source. Do not replace this with hardcoded waypoints or mock physics. Use bounded timer callbacks and async actions, never blocking loops in callbacks. Handle missing TF, unavailable map/action server, failed goals and cancellation with bounded timeouts. Enable use_sim_time, configurable topics, robot frame, max_goals and random_seed. Map publisher QoS should support transient-local /map. Treat unknown and occupied cells carefully; do not send goals into occupied space. Output goals use the /map header's frame id normalized without leading slash. Goal orientation.w=1.0. Expose /goose/exploration_status (std_msgs/String JSON) with completed_goals, failed_goals and selected goal so the external runner can observe behavior. Use a single active NavigateToPose goal and handle get_result_async. On shutdown cancel active goal and stop dispatching.
Keep core.py importable WITHOUT ROS or numpy. It must expose index_of_point(mapData, Xp), point_of_index(mapData,i), informationGain(mapData,point,r), discount(mapData,assigned_pt,centroids,infoGain,r), gridValue(mapData,Xp), pathCost(path), and select_goal(mapData,position,frontiers,info_radius=1.0,info_multiplier=3.0,hysteresis_radius=3.0,hysteresis_gain=2.0). Map objects have info.width,height,resolution,origin.position.x/y, data. Return plain Python numbers/lists. select_goal returns the chosen [x,y] or None.
For valid in-bounds inputs preserve the original Python2 algorithm's integer division semantics and discount subtraction of 1 per cell. Authorized changes: safe coordinate bounds (gridValue outside returns 100), validate zero/invalid map resolution, avoid negative indexing/row wrap at invalid coordinates, bound empty inputs, correct Python2 integer divisions for Python3. point_of_index returns cell-corner coordinates as original. informationGain counts unknown cells within radius and multiplies resolution squared. select_goal must ignore out-of-map and occupied points, select the maximum score with deterministic tie handling, and apply hysteresis to nearby frontiers. No new endpoints or network calls except ROS communication. Include original MIT attribution in README and comments. Do not inspect or invent acceptance test results.`;
let state: any = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath,"utf8")) : {};
if (process.argv.includes("--restart")) {
  fs.writeFileSync(path.join(runDir,`previous-${Date.now()}.json`),JSON.stringify(state,null,2));
  state={};
}
if (!state.agentId) {
  const agent = await client.agents.create({ name: `goose-robotics-implementation-${Date.now()}`, model: config.naive.model,
    harness: "pi", window: "immediate", system: "You are Goose's robotics migration engineer. Produce complete compilable source code using the supplied legacy source and acceptance requirements. Output the exact structured JSON schema. You do not have access to the verifier. Never fabricate test results.",
    tools: { default_config: { permission: "deny" }, configs: Object.fromEntries(["bash","read","write","edit","ls","find","fetch_file","publish_file","session_spend"].map(t=>[t,{enabled:true,permission:"allow"}])) }, handoffs: false,
    budget: { cap_micro_usd: 24_000_000, max_task_micro_usd: budget, period: "month" }, metadata: { company: "goose", task: "ros1-to-ros2" } } as any);
  state.agentId = agent.id; fs.writeFileSync(statePath,JSON.stringify(state,null,2));
}
if (repair && state.result) { state.previousSession = state.sessionId; delete state.sessionId; delete state.result; }
if (!state.sessionId) {
  const archive=path.join(runDir,"legacy-source.zip");
  execFileSync("python3",["-c","import zipfile,sys,pathlib; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED); [(z.write(p,p.relative_to(root))) for p in root.rglob('*') if p.is_file()]; z.close()",path.join(root,"source/rrt_exploration"),archive]);
  if(!state.sourceFileId) {
    const form=new FormData();form.append("file",new Blob([fs.readFileSync(archive)],{type:"application/zip"}),"legacy-rrt-source.zip");form.append("name","legacy-rrt-source.zip");form.append("tags","goose,robotics,source");
    state.sourceFileId=(await client.files.upload(form)).id;
  }
  const diagnostics = repair && fs.existsSync(path.join(runDir,"repair.txt")) ? fs.readFileSync(path.join(runDir,"repair.txt"),"utf8") : "";
  const current = repair && fs.existsSync(path.join(root,"generated")) ? fs.readdirSync(path.join(root,"generated"),{recursive:true}).filter(x=>fs.statSync(path.join(root,"generated",String(x))).isFile()).map(x=>`FILE ${x}\n${fs.readFileSync(path.join(root,"generated",String(x)),"utf8")}`).join("\n\n") : "";
  const message = requirements + "\n\nLEGACY SOURCE ARCHIVE: " + state.sourceFileId + (repair ? `\n\nREPAIR REQUEST: Fix the reported issues in this candidate. Publish a full repaired package archive again.\n${diagnostics}\nCURRENT CANDIDATE:\n${current}` : "");
  const session = await client.sessions.create({ agent_id: state.agentId, message, output_schema: schema, structured_output_required: true,
    budget_micro_usd: budget, metadata: { company: "goose", fixture: "rrt_exploration", synthetic: "true", source_revision: JSON.parse(fs.readFileSync(path.join(root,"source/manifest.json"),"utf8")).revision } } as any);
  state.sessionId = session.id; state.startedAt = new Date().toISOString(); fs.writeFileSync(statePath,JSON.stringify(state,null,2));
}
console.log(`Naive robotics session ${state.sessionId}; budget ceiling $8; source migration only.`);
const deadline = Date.now()+25*60_000;
let lastStatus = "", continued = new Set<number>();
for (;;) {
  const session:any = await client.sessions.get(state.sessionId);
  const label = `${session.status}/${session.stop_reason ?? ""}`;
  if (label !== lastStatus) { console.log(label); lastStatus = label; }
  state.consumedMicroUsd = Number(session.consumed_micro_usd ?? 0); state.status = session.status; state.stopReason = session.stop_reason;
  fs.writeFileSync(statePath,JSON.stringify(state,null,2));
  if (["completed","failed","cancelled","idle"].includes(session.status)) {
    if (session.stop_reason === "max_iterations" && continued.has(session.last_seq)) {
      if(Date.now()>deadline) {await client.sessions.cancel(state.sessionId);throw new Error("Continuation deadline reached");}
      await new Promise(r=>setTimeout(r,3000));continue;
    }
    if (session.stop_reason === "max_iterations" && continued.size < 3 && !continued.has(session.last_seq)) {
      continued.add(session.last_seq); await client.sessions.send(state.sessionId,{message:"Continue and submit the complete structured result."});
    } else {
      let after: number|undefined; const events:any[]=[];
      for(let page=0;page<50;page++) {
        const res:any=await client.sessions.events(state.sessionId,{limit:100,...(after===undefined?{}:{after_seq:after})});
        events.push(...res.data); after=res.data.at(-1)?.seq;
        if(!res.has_more) break;
      }
      fs.writeFileSync(path.join(runDir,`${state.sessionId}.jsonl`),events.map(x=>JSON.stringify(x)).join("\n")+"\n");
      const result=session.structured_output ?? [...events].reverse().find(x=>x.type==="session.idle"&&x.data?.structured_output)?.data.structured_output;
      if(!result?.archive_file_id) throw new Error(`No source archive returned (${label}); inspect saved transcript`);
      const dest=path.join(root,"generated"); fs.mkdirSync(dest,{recursive:true});
      const downloaded=await client.files.downloadBytes(result.archive_file_id);
      const archive=path.join(runDir,"generated.zip");fs.writeFileSync(archive,downloaded);
      const unpack = `import zipfile,sys,pathlib,json,stat
z=zipfile.ZipFile(sys.argv[1]); files=[]
for entry in z.infolist():
 p=pathlib.PurePosixPath(entry.filename)
 if entry.is_dir(): continue
 if p.is_absolute() or '..' in p.parts or stat.S_ISLNK(entry.external_attr>>16): raise ValueError('Unsafe archive')
 if entry.file_size>1000000: raise ValueError('Oversized source file')
 parts=list(p.parts)
 while parts and parts[0] in ['output','goose_rrt_exploration']: parts=parts[1:]
 files.append({'path':'/'.join(parts),'content':z.read(entry).decode('utf-8')})
if len(files)>40: raise ValueError('Too many source files')
print(json.dumps(files))`;
      result.files=JSON.parse(execFileSync("python3",["-c",unpack,archive],{encoding:"utf8",maxBuffer:2*1024*1024}));
      const manifest:Record<string,string>={};
      for(const file of result.files) {
        const rel=String(file.path).replace(/^goose_rrt_exploration\//,"");
        if(!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(rel)) throw new Error("Unsafe source path");
        const p=path.join(dest,rel); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,file.content);
        if(rel.startsWith("scripts/") && rel.endsWith(".py")) fs.chmodSync(p,0o755);
        manifest[rel]=crypto.createHash("sha256").update(file.content).digest("hex");
      }
      state.result={summary:result.summary,limitations:result.limitations,files:manifest}; state.finishedAt=new Date().toISOString();
      fs.writeFileSync(statePath,JSON.stringify(state,null,2));
      fs.writeFileSync(path.join(root,"evidence","naive-generation.json"),JSON.stringify({...state,verification:"pending",realCustomer:false},null,2)+"\n");
      console.log(JSON.stringify({session:state.sessionId,costUsd:state.consumedMicroUsd/1e6,files:Object.keys(manifest),limitations:result.limitations})); break;
    }
  }
  if(Date.now()>deadline) {await client.sessions.cancel(state.sessionId);throw new Error("Robotics migration deadline reached; session cancelled");}
  await new Promise(r=>setTimeout(r,3000));
}
