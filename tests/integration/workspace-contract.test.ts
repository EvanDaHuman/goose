import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { commandProblems, workspaceProblems, observedOutput } from "../../lib/workspaceContract";
const fixture=()=>JSON.parse(fs.readFileSync("demo/workspace-routing/repo/goose-workspace.json","utf8"));
test("workspace contracts preserve executable behavior and require explicit new outcomes",()=>{
  assert.deepEqual(workspaceProblems(fixture()),[]);
  for(const change of [
    (c:any)=>{c.checks=[];},
    (c:any)=>{c.checks[0].source=undefined;},
    (c:any)=>{delete c.checks.find((x:any)=>x.kind==="requirement").expected;},
    (c:any)=>{c.deliverables=["../outside"];},
    (c:any)=>{c.checks[1].id=c.checks[0].id;},
    (c:any)=>{c.source_build=[{argv:["bash","-c","echo bypass"]}];},
  ]) {const c=fixture();change(c);assert.ok(workspaceProblems(c).length);}
});
test("workspace commands reject shell entrypoints, escaping programs and unbounded execution",()=>{
  assert.deepEqual(commandProblems({argv:["python3","planner.py"]}),[]);
  for(const argv of [["/bin/sh"],["./../escape"],["curl","https://example.com"]])assert.ok(commandProblems({argv}).length);
  assert.ok(commandProblems({argv:["node","app.mjs"],timeout_seconds:999}).length);
  assert.deepEqual(commandProblems({argv:["goose-ros2","simulate"],timeout_seconds:360}),[]);
  for(const argv of [["goose-ros2","bash"],["goose-ros2","build","--candidate","/tmp"],["goose-ros2"]])assert.ok(commandProblems({argv}).length);
  assert.throws(()=>observedOutput({stdout:"not JSON",code:0},"json"));
  assert.deepEqual(observedOutput({stdout:'{"value":3}',code:0},"json"),{value:3});
});
