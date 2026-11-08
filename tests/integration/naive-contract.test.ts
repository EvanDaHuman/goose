// Contract tests for the Naive integration WITHOUT a live account. The real SDK (@usenaive-sdk/vetta 0.10.0) talks to a
// fake fetch that answers in the API's shapes; the SDK parses every answer with its own zod schemas, and every request body
// we send is checked against Naive's published OpenAPI file (tests/fixtures/naive-openapi.json, fetched 2026-11-04), because
// the SDK itself never validates request bodies. This proves our calls and our handling of each outcome; it does NOT prove
// the live service behaves the same way. Separate evidence files record actual live runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { changeWithAgent, planWithAgent, answerCustomer } from "../../lib/agents";
import { config } from "../../lib/config";
import { naiveClient, naiveStatus } from "../../lib/naive/client";
import { createClient } from "@usenaive-sdk/vetta";
import { runAgentTask } from "../../lib/naive/run";
import { AGENT_SPECS, provisionTeam } from "../../lib/naive/team";
import { pool, q } from "../../lib/db";

const OPENAPI = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "naive-openapi.json"), "utf8"));
const now = new Date().toISOString();
const B32 = "abcdefghjkmnpqrstvwxyz0123456789";
let seq = 0;
const ID = (prefix: string) => { seq++; return `${prefix}_01j8rq5wn2k8zv4xm7c3h6${B32[(seq >> 5) % 32]}${B32[seq % 32]}${"abcd"[seq % 4]}${"efgh"[(seq >> 2) % 4]}`; };
const SHA = "a".repeat(64);
const KEY = ID("key");
const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
const problems: string[] = [];
const agents: any[] = [];
const files = new Map<string, Uint8Array>();
type Step = { status: string; stop: string | null; consumed: number; out?: any; pending?: any[] };
const scripts: Step[][] = [];            // one queued script per future session
const sessions = new Map<string, { steps: Step[]; i: number; schema: any }>();
let runningMessageConflicts = 0;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
function agentObj(body: any) {
  return { id: ID("agt"), object: "agent", name: body.name, harness: "pi", current_version: 1, created_at: now, model: body.model,
    window: body.window ?? "immediate", system: body.system ?? "", tools: body.tools, mcp_servers: [], skills: [], multiagent: false,
    handoffs: body.handoffs, budget: body.budget, output_schema: null, structured_output_required: false, description: body.description ?? null,
    metadata: body.metadata ?? {} };
}
function sessionObj(id: string, s: Step, schema: any) {
  return { id, object: "session", agent_id: agents[0]?.id ?? ID("agt"), agent_version: 1, deployment_id: null, identity_id: null, computer_id: null,
    parent_session_id: null, root_session_id: null, thread_role: null, status: s.status, stop_reason: s.stop, window: "immediate",
    budget_micro_usd: 400000, consumed_micro_usd: s.consumed, token_usage: { input: 1200, cache_write: 0, cache_read: 0, output: 300, reasoning: 0 },
    pending_actions: s.pending ?? [], output_schema: schema, structured_output: s.out ?? null, last_seq: 3, metadata: {}, started_at: now,
    ended_at: null, created_at: now };
}
const fileObj = (id: string, name: string, size: number) => ({ id, object: "file", name, content_type: "application/zip", size_bytes: size, scope: "published",
  session_id: null, sha256: SHA, created_at: now, title: null, description: null, tags: [], kind: "other", source: null, thumbnail_file_id: null,
  width: null, height: null, duration_seconds: null });

/** Request body keys must be properties of the operation's requestBody schema in the published OpenAPI file. */
function checkAgainstOpenApi(method: string, p: string, body: any) {
  if (!body || typeof body !== "object") return;
  for (const [tmpl, ops] of Object.entries<any>(OPENAPI.paths)) {
    const re = new RegExp("^" + tmpl.replace(/\{[^}]+\}/g, "[^/]+") + "$");
    if (!re.test(p) || !ops[method.toLowerCase()]) continue;
    let schema = ops[method.toLowerCase()].requestBody?.content?.["application/json"]?.schema;
    if (schema?.$ref) schema = schema.$ref.split("/").slice(1).reduce((o: any, k: string) => o[k], OPENAPI);
    const props = schema?.properties ? Object.keys(schema.properties) : null;
    if (props) for (const k of Object.keys(body)) if (!props.includes(k)) problems.push(`${method} ${tmpl}: unknown field "${k}"`);
    return;
  }
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const isForm = init?.body instanceof FormData;
  const body = init?.body && !isForm ? JSON.parse(String(init.body)) : undefined;
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  calls.push({ method, path: url.pathname + url.search, body, headers });
  checkAgainstOpenApi(method, url.pathname, body);
  const p = url.pathname;
  if (method === "GET" && p === "/v1/me") return json({ object: "identity", principal: { type: "key", id: KEY },
    organization: { id: "org_x", name: "Goose", mode: "test" }, scopes: ["admin"], user: null });
  if (method === "GET" && p === "/v1/credits/subscription") return json({ object: "subscription", status: "active", current_period_end: now,
    grace_until: null, cancel_at_period_end: false, action_url: null, plan: "standard" });
  if (method === "GET" && p === "/v1/credits/balance") return json({ object: "credit_balance", balance_micro_usd: 20_000_000, mode: "test" });
  if (method === "GET" && p.startsWith("/v1/models/")) return json({ object: "model", id: decodeURIComponent(p.slice(11)), context_window: 1048576,
    max_output_tokens: 32768, supported_windows: ["immediate"], efforts: [] });
  if (method === "GET" && p === "/v1/agents") return json({ data: agents, has_more: false, next_cursor: null });
  if (method === "POST" && p === "/v1/agents") { const a = agentObj(body); agents.push(a); return json(a, 201); }
  if (method === "GET" && p.startsWith("/v1/agents/")) return json(agents.find((a) => a.id === p.split("/")[3]));
  if (method === "PATCH" && p.startsWith("/v1/agents/")) {
    const a = agents.find((x) => x.id === p.split("/")[3]);
    Object.assign(a, { ...body, current_version: a.current_version + 1 });
    delete (a as any).expected_version;
    return json(a);
  }
  if (method === "POST" && p === "/v1/boards") return json({ id: ID("brd"), object: "board", agent_id: body.agent_id, cards: { todo: 0, doing: 0, blocked: 0, done: 0 }, created_at: now }, 201);
  if (method === "POST" && p === "/v1/files") {
    const f = (init!.body as FormData).get("file") as File;
    const id = ID("fil");
    files.set(id, new Uint8Array(await f.arrayBuffer()));
    return json(fileObj(id, f.name, f.size), 201);
  }
  if (method === "GET" && p.startsWith("/v1/files/") && url.searchParams.get("download") === "true") {
    return new Response((files.get(p.split("/")[3]) ?? new Uint8Array()) as any, { status: 200, headers: { "content-type": "application/zip" } });
  }
  if (method === "DELETE" && p.startsWith("/v1/files/")) return json({ id: p.split("/")[3], object: "file", deleted: true });
  if (method === "POST" && p === "/v1/sessions") {
    const id = ID("ses");
    sessions.set(id, { steps: scripts.shift() ?? [{ status: "idle", stop: "end_turn", consumed: 10, out: { decision: "x" } }], i: 0, schema: body.output_schema });
    return json(sessionObj(id, { status: "queued", stop: null, consumed: 0 }, body.output_schema), 201);
  }
  const sm = p.match(/^\/v1\/sessions\/([^/]+)(\/\w+)?$/);
  if (sm && sessions.has(sm[1])) {
    const s = sessions.get(sm[1])!;
    if (method === "GET" && !sm[2]) { const st = s.steps[Math.min(s.i, s.steps.length - 1)]; s.i++; return json(sessionObj(sm[1], st, s.schema)); }
    if (method === "GET" && sm[2] === "/events") return json({ data: [{ id: ID("evt"), seq: 1, type: "session.idle", session_id: sm[1], data: { stop_reason: "end_turn" }, created_at: now }],
      has_more: false, next_cursor: null });
    if (method === "POST" && sm[2] === "/messages") {
      if (runningMessageConflicts > 0) {
        runningMessageConflicts--;
        return json({ error: { type: "conflict", code: "session_running", message: "interrupt the session to steer it, or queue the message", request_id: "req_race" } }, 409);
      }
      return json({ session_id: sm[1], status: "running", accepted_seq: 2 }, 202);
    }
    if (method === "POST" && sm[2] === "/cancel") { s.steps = [{ status: "cancelled", stop: null, consumed: 5 }]; s.i = 0; return json(sessionObj(sm[1], s.steps[0], s.schema)); }
    if (method === "POST" && sm[2] === "/tool_confirmations") return json(sessionObj(sm[1], s.steps[Math.min(s.i, s.steps.length - 1)], s.schema), 202);
  }
  return json({ error: { type: "not_found", code: "not_found", message: `no fake for ${method} ${p}`, request_id: "req_fake" } }, 404);
}) as typeof fetch;

const JOB = "TEST-NAIVE";
let ownsFixtures = false;
before(async () => {
  if ((await q("SELECT 1 FROM naive_resources")).length) throw new Error("naive_resources is not empty; refusing to run against a provisioned company");
  ownsFixtures = true;
  await q("INSERT INTO accounts (id, name, kind) OVERRIDING SYSTEM VALUE VALUES (999999, 'contract test', 'demo') ON CONFLICT DO NOTHING");
  await q(`INSERT INTO jobs (id, account_id, title, kind, app_slug, timezone, mode, stage, status, responsible, repair_budget, cost_limit_micro_usd, customer_token, pipeline)
           VALUES ($1, 999999, 'contract', 'demo', 'x', 'UTC', 'naive', 'plan', 'done', 'coordinator', 1, 5000000, 'x', 2) ON CONFLICT DO NOTHING`, [JOB]);
  (globalThis as any).fetch = fakeFetch;                 // naiveClient() inside lib/agents uses the global fetch
  (config.naive as any).apiKey = "sk_test_contract";
});
after(async () => {
  if (!ownsFixtures) { await pool.end(); return; }
  for (const t of ["cost_entries", "naive_sessions", "naive_files", "events"]) await q(`DELETE FROM ${t} WHERE job_id = $1`, [JOB]);
  await q("DELETE FROM naive_resources");
  await q("DELETE FROM jobs WHERE id = $1", [JOB]);
  await q("DELETE FROM accounts WHERE id = 999999");
  await pool.end();
});

const client = () => naiveClient(fakeFetch, "sk_test_contract");
const ctx = { jobId: JOB, stage: "plan", attempt: 1, budgetMicroUsd: 2_000_000 };

test("readiness: a key with an active plan, credits and a served model is ready", async () => {
  const s = await naiveStatus(client(), "sk_test_contract");
  assert.equal(s.state, "ready", s.message);
  assert.equal((await naiveStatus(client(), "")).state, "missing_key");
});

test("provisioning: seven budgeted agents, deny by default, risky tools denied by name, roster pinned with versions", async () => {
  const r = await provisionTeam(client());
  assert.equal(agents.length, 7);
  for (const a of agents) {
    assert.equal(a.harness, "pi");
    assert.ok(a.budget.cap_micro_usd > 0 && a.budget.max_task_micro_usd > 0 && a.budget.period === "month");
    assert.equal(a.tools.default_config.permission, "deny");
    for (const t of ["company.set_timezone", "ask_operator", "send_to_agent", "email.send", "social.post", "browser"]) {
      assert.equal(a.tools.configs[t]?.permission, "deny", `${a.name} ${t}`);
    }
  }
  // only the growth agents reach the public web; the agents that touch customer code never do
  const byName = (role: keyof typeof AGENT_SPECS) => agents.find((a) => a.name === AGENT_SPECS[role].name);
  for (const role of ["coordinator", "assessment", "implementation", "verification", "outreach"] as const) {
    for (const t of ["web_search", "web_fetch"]) assert.equal(byName(role).tools.configs[t]?.permission, "deny", `${role} ${t}`);
  }
  for (const t of ["web_search", "web_fetch"]) assert.equal(byName("research").tools.configs[t].permission, "allow");
  assert.equal(byName("qualification").tools.configs.web_fetch.permission, "allow");
  for (const t of ["bash", "write", "edit", "fetch_file", "publish_file"]) {
    for (const role of ["research", "qualification", "outreach"] as const) assert.notEqual(byName(role).tools.configs[t]?.permission, "allow", `${role} ${t}`);
  }
  const impl = agents.find((a) => a.name === AGENT_SPECS.implementation.name);
  for (const t of ["bash", "write", "edit", "fetch_file", "publish_file"]) assert.equal(impl.tools.configs[t].permission, "allow");
  const coord = agents.find((a) => a.name === AGENT_SPECS.coordinator.name);
  assert.equal(coord.multiagent.type, "coordinator");
  assert.ok(coord.multiagent.agents.every((m: any) => typeof m.version === "number"), "every roster member is pinned to a version");
  assert.equal(coord.tools.configs.board_write.permission, "deny", "the coordinator cannot create or assign cards");
  assert.ok(r.boardId.startsWith("brd_"));
  const before = calls.filter((c) => c.method === "POST" && c.path === "/v1/agents").length;
  await provisionTeam(client());
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/v1/agents").length, before, "a second run creates nothing");
});

test("assessment: the repository is uploaded, its file id is in the message, the plan comes back typed, and a restart reuses the session", async () => {
  const zip = path.join(os.tmpdir(), "gs-contract-repo.zip");
  fs.writeFileSync(zip, Buffer.from("PK fake zip"));
  const plan = { decision: "supported", recommended: "django-lts-upgrade", reasons: ["fits"], changes: [], preserve: [], intended_differences: [],
    questions: [], acceptance_checks: [], follow_ups: [], findings_added: [] };
  scripts.push([{ status: "running", stop: null, consumed: 100 }, { status: "idle", stop: "awaiting_input", consumed: 2500, out: plan }]);
  const input = { repoZip: zip, goal: "Update", constraints: [], notes: null, answers: {}, toolPlan: { options: [] },
    inspection: { stack: {}, size: {}, components: [], edges: [], findings: [] } };
  const r = await planWithAgent(ctx, input);
  assert.equal(r.ok, true, JSON.stringify(r));
  const create = calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions").at(-1)!;
  assert.match(create.body.message, new RegExp(r.fileId!), "the message names the uploaded file");
  assert.equal(create.body.structured_output_required, true);
  assert.ok(create.body.budget_micro_usd <= AGENT_SPECS.assessment.taskUsd * 1e6);
  assert.match(create.headers["idempotency-key"], /^[0-9a-f]{48}$/, "a deterministic idempotency key, so a retried create cannot duplicate the session");
  assert.equal(create.headers["vetta-version"], "2026-09-30");
  const n = calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions").length;
  const again = await planWithAgent(ctx, input);
  assert.equal(again.ok, true);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions").length, n, "the finished task is found again; no second session");
  const cost = await q<{ micro_usd: number; basis: string }>("SELECT micro_usd, basis FROM cost_entries WHERE job_id = $1 AND naive_session_id IS NOT NULL", [JOB]);
  assert.ok(cost.some((c) => c.basis === "naive_metered" && Number(c.micro_usd) === 2500), "metered cost recorded at the session's total");
});

test("stop reasons: max_iterations continues, budget_paused stops, awaiting_approval is denied and cancelled, timeout cancels", async () => {
  const schema = { type: "object", required: ["decision"], properties: { decision: { type: "string" } } };
  const task = (purpose: string, extra: any = {}) => runAgentTask(client(), { jobId: JOB, stage: "verify", attempt: 1, role: "coordinator", purpose, title: purpose,
    message: purpose, outputSchema: schema, budgetMicroUsd: 1_000_000, pollMs: 5, ...extra });
  scripts.push([{ status: "idle", stop: "max_iterations", consumed: 50 }, { status: "idle", stop: "end_turn", consumed: 90, out: { decision: "repair" } }]);
  const a = await task("continue");
  assert.equal(a.ok, true);
  assert.ok(calls.some((c) => c.method === "POST" && /\/messages$/.test(c.path) && /Continue/.test(c.body.message)));
  scripts.push([{ status: "idle", stop: "budget_paused", consumed: 1_000_000 }]);
  assert.equal(((await task("budget")) as any).reason, "budget");
  scripts.push([{ status: "idle", stop: "awaiting_approval", consumed: 30, pending: [{ kind: "tool", tool_call_id: "call_1", name: "company.set_logo", args: {} }] }]);
  const c = await task("approval");
  assert.equal((c as any).reason, "blocked");
  assert.ok(calls.some((x) => /tool_confirmations$/.test(x.path) && x.body.decision === "deny"));
  scripts.push([{ status: "running", stop: null, consumed: 10 }]);
  const d = await task("timeout", { timeoutMs: 20 });
  assert.equal((d as any).reason, "timeout");
  assert.ok(calls.some((x) => x.method === "POST" && /\/cancel$/.test(x.path)), "a timed-out session is cancelled so it stops spending");
  const e = await task("floor", { budgetMicroUsd: 10 });
  assert.equal((e as any).reason, "budget", "no session starts when the job has almost no budget left");
});

test("implementation: the agent's published result is downloaded as bytes", async () => {
  const zip = path.join(os.tmpdir(), "gs-contract-candidate.zip");
  fs.writeFileSync(zip, Buffer.from("PK candidate"));
  const resultId = ID("fil");
  files.set(resultId, new Uint8Array(Buffer.from("PK changed result")));
  scripts.push([{ status: "idle", stop: "end_turn", consumed: 400, out: { result_file_id: resultId, summary: "fixed", changed_files: [{ file: "a.py", why: "x" }],
    tests: { command: "pytest", passed: true, output_tail: "1 passed" }, not_done: [] } }]);
  const out = path.join(os.tmpdir(), "gs-contract-result.zip");
  const r: any = await changeWithAgent({ ...ctx, stage: "implement" }, { candidateZip: zip, items: [{ id: "C1" }], context: "", outZip: out });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(out, "utf8"), "PK changed result");
  assert.ok(calls.some((c) => c.method === "GET" && c.path === `/v1/files/${resultId}?download=true`));
});

test("continuations tolerate stale idle reads and an already-running session without duplicate messages", async () => {
  for (const conflict of [false, true]) {
    const before = calls.filter(c => c.method === "POST" && /\/messages$/.test(c.path)).length;
    runningMessageConflicts = conflict ? 1 : 0;
    scripts.push([{ status: "idle", stop: "max_iterations", consumed: 50 },
      { status: conflict ? "running" : "idle", stop: conflict ? null : "max_iterations", consumed: 50 },
      { status: "running", stop: null, consumed: 70 },
      { status: "idle", stop: "end_turn", consumed: 90, out: { decision: "done" } }]);
    const result = await runAgentTask(client(), { jobId: JOB, stage: "verify", attempt: 1, role: "coordinator", purpose: `continuation-race-${conflict}`,
      title: "Continuation race", message: `race-${conflict}`, outputSchema: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"] }, budgetMicroUsd: 1_000_000, pollMs: 5, timeoutMs: 1000 });
    assert.equal(result.ok, true, JSON.stringify({ result, errors: result.ok ? [] : await q("SELECT detail FROM events WHERE job_id=$1 AND kind='error' ORDER BY id DESC LIMIT 1", [JOB]) }));
    assert.equal(calls.filter(c => c.method === "POST" && /\/messages$/.test(c.path)).length - before, 1);
  }
});

test("two different customer questions get two sessions, not the first answer twice", async () => {
  scripts.push([{ status: "idle", stop: "end_turn", consumed: 20, out: { answer: "first", needs_founder: false } }]);
  scripts.push([{ status: "idle", stop: "end_turn", consumed: 20, out: { answer: "second", needs_founder: false } }]);
  const prev = config.mode;
  (config as any).mode = "naive";
  try {
    const a = await answerCustomer({ ...ctx, stage: "support", attempt: 11 }, "When is it ready?", { stageLabel: "x", nextStep: "y" });
    const b = await answerCustomer({ ...ctx, stage: "support", attempt: 12 }, "Is my data safe?", { stageLabel: "x", nextStep: "y" });
    assert.equal(a.answer, "first");
    assert.equal(b.answer, "second");
  } finally {
    (config as any).mode = prev;
  }
});

test("every request body we sent uses only fields the published API accepts", () => {
  assert.deepEqual(problems, []);
});

test("provider capacity errors resume the same live task without cancelling or duplicating it",async()=>{
 scripts.push([{status:"idle",stop:"end_turn",consumed:50,out:{decision:"done"}}]);
 let limited=true,createLimited=true;const creationKeys:string[]=[];const before=calls.length;
 const c=createClient({baseUrl:config.naive.baseUrl,apiKey:"sk_test_contract",idempotencyKey:()=>ID("req"),fetch:(async(input:any,init:any)=>{
  if(init?.method==="POST"&&String(input).endsWith("/sessions")){creationKeys.push(new Headers(init.headers).get("idempotency-key")!);if(createLimited){createLimited=false;return json({error:{type:"rate_limit",code:"rate_limited",message:"at capacity",request_id:"req_capacity_create"}},429);}}
  if(limited&&(init?.method??"GET")==="GET"&&/\/sessions\/[^/?]+$/.test(String(input))){limited=false;return json({error:{type:"rate_limit",code:"rate_limited",message:"at capacity",request_id:"req_capacity"}},429);}
  return fakeFetch(input,init);
 }) as typeof fetch});
 const result=await runAgentTask(c,{jobId:JOB,stage:"verify",attempt:1,role:"coordinator",purpose:"capacity-recovery",title:"Capacity recovery",message:"Resume the same session",outputSchema:{type:"object",properties:{decision:{type:"string"}},required:["decision"]},budgetMicroUsd:100000,pollMs:1,timeoutMs:1000});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(limited,false);assert.equal(creationKeys.length,2);assert.equal(creationKeys[0],creationKeys[1]);
 const added=calls.slice(before);assert.equal(added.filter(c=>c.method==="POST"&&c.path==="/v1/sessions").length,1);assert.equal(added.filter(c=>c.path.endsWith("/cancel")).length,0);
});
