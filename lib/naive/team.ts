// The company's agents on Naive, created once and updated when their definition changes (idempotent by role).
//
// Delivery: the worker sequences each job; the agents do the judgement and the code work in their own Naive computers:
//   coordinator     - scope, spending, repair-or-escalate, proposal wording, customer answers (no sandbox)
//   assessment      - reads the uploaded repository and writes the plan (sandbox: read-only use)
//   implementation  - edits the repository and publishes the result (sandbox: read and write)
//   verification    - explains failed checks from their evidence (sandbox: read-only use)
// Growth (lib/growth.ts): the company finding its own work. They never see customer code, and nothing they write is sent:
//   research        - finds organisations with outdated software from public sources (web search and fetch only)
//   qualification   - scores a prospect against today's recipes, reading its public code (web fetch only)
//   outreach        - writes the outreach draft (no tools)
// Budgets are required by Naive and checked before every model call. Tool policies deny everything not listed, and the
// tools that Naive offers by default or asks about (company.*, media, plan mode, operator questions) are denied by name
// so no session can park waiting for an approval nobody gives. Delegation (send_to_agent) is off: every agent session
// is started by the worker, with its own budget and record. The frozen acceptance checks are never uploaded.
import crypto from "node:crypto";
import type { AgentCreate, VettaClient } from "@usenaive-sdk/vetta";
import { config, TEAM, type Role } from "../config";
import { one, q } from "../db";

type Perm = "allow" | "ask" | "deny";
const tool = (permission: Perm) => ({ enabled: permission !== "deny", permission });
const DENY_BY_NAME = ["company.set_timezone", "company.set_logo", "company.set_brand", "data_run", "generate_video", "edit_video",
  "create_character", "mobile", "build_media_skill", "ask_operator", "request_tools", "propose_plan", "write_plan", "web_search",
  "web_fetch", "find_files", "email.send", "social.post", "browser", "send_to_agent", "wait_for_agents", "list_agents", "board_write",
  "post_to_channel"];
const policy = (allow: string[]) => ({
  default_config: { permission: "deny" as Perm },
  configs: Object.fromEntries([...DENY_BY_NAME.filter((t) => !allow.includes(t)).map((t) => [t, tool("deny")]),
    ...allow.map((t) => [t, tool("allow")])]),
});

const AGENT_PREFIX = process.env.GOOSE_AGENT_PREFIX || "goose";
const COMMON = `You work for Goose, an autonomous engineering company that delivers verified changes across existing software systems, code, data, infrastructure and integrations. You work only on
copies of the customer's code and data, never on their live systems. Write in plain, simple English. Every finding you report must
cite a file and line you read, or a value you observed. Never claim a check passed unless the verification report says so. Never
invent customers, prices or results. When a structured result is asked for, submit exactly the JSON the schema asks for.`;

const GROWTH_COMMON = `You work for Goose, an autonomous engineering company delivering verified software change across industries. Executable work includes repository-level engineering changes with approved command contracts, language/runtime migrations and data changes, plus supported framework upgrades. Use the current capability list supplied with each task; never promise unsupported execution. It proves agreed results with independent checks frozen before implementation. Goose has no past
customers yet. Use only public, lawfully available information about organisations: public code repositories, their public pages,
public announcements. Never collect or output personal contact details (personal e-mail addresses, phone numbers, home addresses) and
never research private individuals. Every claim you make must come with the public URL it comes from. Never invent organisations,
facts, prices or results. Write in plain, simple English. When a structured result is asked for, submit exactly the JSON the schema
asks for.`;

export const AGENT_SPECS: Record<"coordinator" | "assessment" | "implementation" | "verification" | "research" | "qualification" | "outreach",
  { name: string; system: string; tools: AgentCreate["tools"]; capUsd: number; taskUsd: number }> = {
  coordinator: {
    name: `${AGENT_PREFIX}-coordinator`,
    system: `${COMMON}
You are the coordinator. You own each customer job: its scope, its dependencies, its spending and its repair budget. You decide what
happens after a failed verification: repair (only while repair budget and spending limit remain) or escalate to the founder, with a
one-sentence reason. You write proposal summaries and answer customer questions only from the job facts you are given; when the facts
do not answer a question, say so and hand it to the founder. You never change a price and never mark work delivered: the deterministic
checks decide. If a board digest arrives, reply with one sentence and take no action.`,
    tools: policy(["session_spend", "board_read"]), capUsd: 40, taskUsd: 2,
  },
  assessment: {
    name: `${AGENT_PREFIX}-assessment`,
    system: `${COMMON}
You are the assessment agent. You read a customer's application and their goal, and propose a plan Goose can carry out and
verify today. First run: command -v python3 unzip; then fetch_file the repository id you are given and unzip it into ./repo (use
"python3 -m zipfile -e repo.zip repo" if unzip is missing). Read the code, starting with the files the inspection lists. Choose only
from the recipes you are given and respect their preconditions; prefer the smallest change that meets the goal, and say what you
keep and why. List every change with its reason and the component ids and files it touches, every intended difference in behaviour
with its reason, and questions only when the answer changes the plan. If no recipe fits, decide "unsupported" and explain.`,
    tools: policy(["bash", "read", "ls", "find", "fetch_file", "session_spend"]), capUsd: 60, taskUsd: 3,
  },
  implementation: {
    name: `${AGENT_PREFIX}-implementation`,
    system: `${COMMON}
You are the implementation agent. You change the customer's repository to carry out the approved plan items you are given, and
nothing else. fetch_file the repository zip, unzip it into ./work, make only those changes, and keep comments, formatting and
behaviour except where a plan item says otherwise. If Python is available, install the requirements and run the application's own
tests. Never edit or delete an existing test to make it pass: report the failure instead. Zip the result ("cd work && python3 -m
zipfile -c ../result.zip .") and publish_file it. You cannot see the acceptance checks and must not look for them.`,
    tools: policy(["bash", "read", "write", "edit", "ls", "find", "fetch_file", "publish_file", "session_spend"]), capUsd: 100, taskUsd: 8,
  },
  verification: {
    name: `${AGENT_PREFIX}-verification`,
    system: `${COMMON}
You are the verification agent. You are given the checks that failed, with expected and actual values, and the code change as a
diff file. Find the most likely cause in the diff, cite file and line, and say what a repair should change. You cannot change a
result: the deterministic report decides pass or fail. You never see or edit the frozen checks.`,
    tools: policy(["bash", "read", "ls", "find", "fetch_file", "session_spend"]), capUsd: 40, taskUsd: 2,
  },
  research: {
    name: `${AGENT_PREFIX}-research`,
    system: `${GROWTH_COMMON}
You are the research agent. Find organisations (companies, universities, public bodies, non-profits, software agencies) that run
software Goose can upgrade today and show a public sign that they need it: a public repository pinning Flask 1.x/2.x or Django
below 5.2, open dependency or security-upgrade pull requests nobody merged, an end-of-life runtime, or a public mention of an old
SuiteCRM 7 install. Prefer organisations with an internal or business application over libraries and personal hobby projects. For
each one give its name, the main public URL (the repository or page), what the software is, 1 to 5 pieces of evidence each with its
own URL, and a public organisational contact channel (for example "GitHub issues on the repository" or "contact form on their
website"), never a person's e-mail address. Skip anything in the list of already-known URLs you are given.`,
    tools: policy(["web_search", "web_fetch", "read", "session_spend"]), capUsd: 20, taskUsd: 1,
  },
  qualification: {
    name: `${AGENT_PREFIX}-qualification`,
    system: `${GROWTH_COMMON}
You are the lead qualification agent. For one prospect, decide how well it fits what Goose can carry out and verify today, using
the recipes you are given and, where useful, the prospect's public code (fetch its requirements or settings files to confirm
versions). Score the fit High, Medium or Low, name the one recipe that would apply (or "none"), list what would block the work, and
give short reasons, each tied to a URL. Be strict: if the stack is outside every recipe's preconditions, the fit is Low.`,
    tools: policy(["web_fetch", "read", "session_spend"]), capUsd: 15, taskUsd: 0.5,
  },
  outreach: {
    name: `${AGENT_PREFIX}-outreach`,
    system: `${GROWTH_COMMON}
You are the outreach agent. Write one short, specific first message to an organisation, from Goose's founder, based only on the
evidence and qualification you are given. Say what you noticed (with the public link), what Goose would do, and that Goose would
start with a free written assessment of their public code. Say plainly that Goose is a new company with no past customers. Mention a
price only if one is given to you, exactly as given. No pressure tactics, no flattery, no claims you were not given. Sign it
"[Founder name], Goose". The message is stored as a draft for the founder; you do not send anything.`,
    tools: policy(["session_spend"]), capUsd: 10, taskUsd: 0.25,
  },
};
export type TeamRole = keyof typeof AGENT_SPECS;

// Optional ceilings from .env (NAIVE_CAP_USD, NAIVE_TASK_USD) for a small balance; each agent gets the lower of its design
// budget and the ceiling. Unset = the design budgets above.
const ceiling = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : Infinity);
const capUsd = (role: TeamRole) => Math.min(AGENT_SPECS[role].capUsd, ceiling(process.env.NAIVE_CAP_USD));
const taskUsd = (role: TeamRole) => Math.min(AGENT_SPECS[role].taskUsd, ceiling(process.env.NAIVE_TASK_USD));

function agentBody(role: TeamRole): AgentCreate & { budget: { cap_micro_usd: number; max_task_micro_usd: number; period: "month" } } {
  const spec = AGENT_SPECS[role];
  return {
    name: spec.name,
    model: config.naive.model,
    harness: "pi",                     // the only harness with typed results and approvals
    window: "immediate",
    system: spec.system,
    description: `Goose ${role} agent`,
    tools: spec.tools,
    handoffs: false,
    metadata: { company: "goose", role },
    budget: { cap_micro_usd: Math.round(capUsd(role) * 1_000_000), max_task_micro_usd: Math.round(taskUsd(role) * 1_000_000), period: "month" },
  };
}

export function configSha(role: TeamRole) {
  return crypto.createHash("sha256").update(JSON.stringify(agentBody(role))).digest("hex");
}

export function taskCeiling(role: TeamRole) {
  return Math.round(taskUsd(role) * 1_000_000);
}

async function findAgent(client: VettaClient, role: TeamRole) {
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.agents.list({ limit: 100, ...(after ? { after } : {}) });
    const hit = res.data.find((a: any) => a.name === AGENT_SPECS[role].name && (a.metadata?.role ?? role) === role);
    if (hit) return hit;
    if (!res.has_more || !res.next_cursor) return null;
    after = res.next_cursor;
  }
  return null;
}

/** Create missing agents, update changed ones, then (re)pin the coordinator's roster and ensure its board. */
export async function provisionTeam(client: VettaClient) {
  const ids: Partial<Record<TeamRole, string>> = {};
  const versions: Partial<Record<TeamRole, number>> = {};
  const report: string[] = [];
  for (const role of ["assessment", "implementation", "verification", "research", "qualification", "outreach", "coordinator"] as TeamRole[]) {
    const sha = configSha(role);
    const known = await one<{ naive_id: string; config_sha: string | null }>("SELECT naive_id, config_sha FROM naive_resources WHERE role = $1", [role]);
    let agent: any = known ? await client.agents.get(known.naive_id).catch(() => null) : null;
    agent = agent ?? (await findAgent(client, role));
    if (!agent) {
      agent = await client.agents.create(agentBody(role));
      report.push(`created ${AGENT_SPECS[role].name} (${agent.id})`);
    } else if (known?.config_sha !== sha) {
      const { name: _n, ...patch } = agentBody(role);
      agent = await client.agents.update(agent.id, { ...patch, expected_version: agent.current_version } as any);
      report.push(`updated ${AGENT_SPECS[role].name} to version ${agent.current_version}`);
    } else {
      report.push(`${AGENT_SPECS[role].name} up to date (version ${agent.current_version})`);
    }
    await q(`INSERT INTO naive_resources (role, naive_id, version, config_sha) VALUES ($1,$2,$3,$4)
             ON CONFLICT (role) DO UPDATE SET naive_id = EXCLUDED.naive_id, version = EXCLUDED.version, config_sha = EXCLUDED.config_sha`,
      [role, agent.id, agent.current_version, sha]);
    ids[role] = agent.id;
    versions[role] = agent.current_version;
  }
  // members never pick up their own later edits until the roster is saved again, so pin explicit versions every time
  const coord = await client.agents.get(ids.coordinator!);
  await client.agents.update(coord.id, {
    expected_version: coord.current_version,
    multiagent: {
      type: "coordinator",
      agents: (["assessment", "implementation", "verification"] as TeamRole[]).map((r) => ({ type: "agent" as const, id: ids[r]!, version: versions[r] })),
      board: true,
    },
  } as any);
  report.push("coordinator roster pinned to the current member versions");
  const board = await client.board.create(ids.coordinator!);
  await q("INSERT INTO naive_resources (role, naive_id) VALUES ('board', $1) ON CONFLICT (role) DO UPDATE SET naive_id = EXCLUDED.naive_id",
    [board.id]);
  return { ids, boardId: board.id, report };
}

export async function agentId(role: Role) {
  const r = await one<{ naive_id: string }>("SELECT naive_id FROM naive_resources WHERE role = $1", [role]);
  if (!r) throw new Error(`Naive agent for ${role} is not provisioned; run npm run naive:provision`);
  return r.naive_id;
}

export const NAIVE_TEAM = TEAM;
