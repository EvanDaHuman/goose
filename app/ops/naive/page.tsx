import { config, ROLES, type Role } from "@/lib/config";
import { q } from "@/lib/db";
import { naiveStatus } from "@/lib/naive/client";
import { AGENT_SPECS } from "@/lib/naive/team";
import { usd } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Naive() {
  const status = await naiveStatus();
  const resources = await q<any>("SELECT * FROM naive_resources ORDER BY role");
  const tone = status.state === "ready" ? "ok" : status.state === "missing_key" ? "warn" : "bad";
  return (
    <main className="wrap">
      <h1>Naive Managed Agents</h1>
      <div className={`banner ${tone}`}><b>{status.state.replaceAll("_", " ")}</b><span>{status.message} <span className="muted">(checked {new Date(status.checkedAt).toLocaleTimeString()})</span></span></div>
      <p className="small muted section">Company mode: <b>{config.mode}</b>. SDK <code>@usenaive-sdk/vetta@0.10.0</code>, API <code>{config.naive.baseUrl}</code>, model <code>{config.naive.model}</code>.</p>

      <section className="section card">
        <h2>The team</h2>
        <p className="small muted">Four agents. The coordinator owns the team board and its roster pins each member's version. Every agent has a
          required budget (Naive refuses any call that would pass it) and a per-tool policy: everything is denied unless allowed, and tools Naive
          would otherwise offer or ask about are denied by name.</p>
        <table><thead><tr><th>Agent</th><th>Owns</th><th>Tools allowed</th><th>Denied explicitly</th><th className="num">Budget</th><th>Provisioned</th></tr></thead>
          <tbody>{(Object.keys(AGENT_SPECS) as (keyof typeof AGENT_SPECS)[]).map((r) => {
            const spec = AGENT_SPECS[r];
            const cfgs = spec.tools?.configs ?? {};
            const allowed = Object.entries(cfgs).filter(([, c]: any) => c.permission === "allow").map(([k]) => k);
            const denied = Object.entries(cfgs).filter(([, c]: any) => c.permission === "deny").map(([k]) => k);
            const res = resources.find((x: any) => x.role === r);
            return (<tr key={r}><td><b>{ROLES[r].name}</b><div className="small muted mono">{spec.name}</div></td><td className="small">{ROLES[r].owns}</td>
              <td className="small mono">{allowed.join(", ")}</td><td className="small mono">{denied.join(", ") || "-"}</td>
              <td className="num small">{usd(spec.capUsd * 1e6, 0)}/month<div className="muted">{usd(spec.taskUsd * 1e6, 0)} per task</div></td>
              <td className="small mono">{res ? res.naive_id : "not yet"}</td></tr>);
          })}</tbody></table>
      </section>

      <section className="section grid g2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>What runs on Naive in naive mode</h3>
          <ul className="small">
            <li><b>Assessment agent</b>: the repository is uploaded with <code>files.upload</code>; the agent fetches it into its own computer
              (<code>fetch_file</code>), reads it, and submits a typed plan chosen from the recipes whose preconditions hold. A guard rejects plans
              that name parts of the app inspection did not find, recipes that cannot run, or work that needs data nobody sent; the agent gets
              one retry with the reasons, then the founder decides.</li>
            <li><b>Implementation agent</b>: makes the plan's code changes that no tool can make, and repairs failed checks from their evidence; it
              publishes the result (<code>publish_file</code>) and the worker downloads it (<code>files.downloadBytes</code>). A guard refuses
              results that delete or thin out existing tests.</li>
            <li><b>Verification agent</b>: explains failed checks from the evidence and the diff. Pass or fail is decided only by the frozen checks,
              which never leave this machine.</li>
            <li><b>Coordinator</b>: repair or escalate (a guard enforces the repair budget), proposal wording (never the price), customer answers.</li>
            <li>Every session gets <code>budget_micro_usd</code> from the job's remaining limit and a deterministic idempotency key, so a restart
              finds the session again instead of starting a second one. <code>budget_paused</code>, timeouts and approval requests stop the task
              cleanly; metered cost (<code>consumed_micro_usd</code>) is recorded per session.</li>
          </ul>
          <p className="small muted">Deterministic tools still copy files, run django-upgrade and the Flask-to-FastAPI codemod, move and check
            data, and run every test. Delegation between agents (<code>send_to_agent</code>) is off: the worker starts each session itself, so
            every agent run has its own budget and record.</p>
        </div>
        <div className="card">
          <h3>Connect</h3>
          <ol className="small">
            <li>Create a Naive organization, start a plan and add credits (needs a person and a card).</li>
            <li><code>vetta keys create --name goose --scopes agents:write,agents:read,sessions:write,sessions:read,files:write,files:read,billing:read</code></li>
            <li>Put the key in <code>.env</code> as <code>VETTA_API_KEY</code> and set <code>GOOSE_MODE=naive</code>.</li>
            <li><code>npm run naive:smoke</code>: checks readiness, provisions the team (safe to run twice) and runs one small session.</li>
          </ol>
          <p className="small muted"><b>Live status: not yet run.</b> No API key was available while building, so no Naive session or model call has
            happened. The loop is tested against the published SDK and its zod schemas, with every request body checked against Naive's public
            OpenAPI file (<code>tests/integration</code>); that proves the calls, not the live behaviour.</p>
        </div>
      </section>
    </main>
  );
}
