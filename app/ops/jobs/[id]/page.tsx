import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, AutoRefresh, FaultPicker, OpsNumberAction } from "@/components/client";
import { Back, clock, dollars, JobStatus, KindTag, ModeBanner, Origin, ROLE_NAMES, Steps, usd, when } from "@/components/ui";
import { config } from "@/lib/config";
import { opsStageLabel } from "@/lib/jobs";
import { opsJobView } from "@/lib/views";

export const dynamic = "force-dynamic";

function DiffBlock({ diff }: { diff: string }) {
  return <pre className="diff">{diff.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add"
    : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>{l}</div>)}</pre>;
}

export default async function OpsJob({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await opsJobView(id);
  if (!v) notFound();
  const { job, events, stageRuns, costs, approvals, interventions, repairs, runs, artifacts, sessions, questions, showroom, plans, origins } = v;
  const important = events.filter((e: any) => e.important);
  // a role is only called an agent when a Naive session did the work; deterministic steps are "steps"
  const who = (actor: string, origin?: string | null) => {
    const n = ROLE_NAMES[actor] ?? actor;
    if (!n.endsWith(" agent") || origin === "agent" || (origin === undefined && job.mode === "naive")) return n;
    return n.replace(/ agent$/, " step");
  };
  const action = `/api/ops/jobs/${id}/action`;
  const totalMicro = costs.reduce((n: number, c: any) => n + Number(c.micro), 0);
  const founderQs = questions.filter((x: any) => x.audience === "founder" && x.status === "open");
  const delivered = ["delivered", "invoice", "follow_up", "closed"].includes(job.stage);
  const canFault = ["intake", "assess", "awaiting_info", "propose", "awaiting_acceptance", "baseline", "freeze"].includes(job.stage);
  return (
    <main className="wrap">
      <AutoRefresh active={job.status === "running" || showroom?.status === "requested"} seconds={2} />
      <Back href="/ops">All jobs</Back>
      <div className="row between">
        <div>
          <div className="kicker">{v.job.account_name} · {job.id}</div>
          <h1 style={{ marginBottom: 6 }}>{job.title}</h1>
          <div className="row"><JobStatus status={job.status} stage={job.stage} /><KindTag kind={job.kind} />
            {job.test_fault && <span className="tag test">Test fault: {job.test_fault}</span>}
            <span className="small muted">Responsible: {who(job.responsible)} · attempt {job.attempt} · repairs {job.repairs_used}/{job.repair_budget}</span></div>
        </div>
        <div className="row">
          <Link className="btn" href={`/jobs/${id}?t=${job.customer_token}`}>Customer view</Link>
          {runs.length > 0 && <Link className="btn primary" href={`/jobs/${id}/result?ops=1`}>Result screen</Link>}
        </div>
      </div>
      <div className="card section">
        <Steps stage={job.stage} status={job.status} failedAttempts={runs.filter((r: any) => r.verdict === "fail").length} pipeline={job.pipeline} />
        <p style={{ margin: "10px 0 0" }}><b>Now:</b> {opsStageLabel(job.stage)}{job.waiting_reason ? ` - ${job.waiting_reason}` : ""}</p>
      </div>
      {job.status === "waiting_founder" && (
        <div className="banner warn section"><b>Needs you</b><span>{job.waiting_reason}</span></div>
      )}
      {job.pipeline >= 2 && (
        <section className="section grid g2" style={{ alignItems: "start" }}>
          <div className="card">
            <h3>Goal and plan</h3>
            <p className="small">"{job.goal}"<br /><span className="muted">Constraints: {(job.constraints ?? []).join(", ") || "none"} · recipe: {job.recipe ?? "not chosen yet"} · work: {job.work_type ?? "-"}</span></p>
            <table className="small"><tbody>{plans.map((p: any) => (<tr key={p.version}><td>v{p.version}</td><td>{p.title ?? p.decision}<div className="muted">{p.author}{p.changed_because ? ` · ${p.changed_because}` : ""}</div>
              {(p.guard_problems ?? []).length > 0 && <div style={{ color: "var(--bad)" }}>Guard: {p.guard_problems.join("; ")}</div>}</td><td>{p.decision}</td></tr>))}
              {plans.length === 0 && <tr><td className="muted">No plan yet.</td></tr>}</tbody></table>
          </div>
          <div className="card">
            <h3>Where this job's steps came from</h3>
            <table className="small"><tbody>{origins.map((o: any) => (<tr key={o.origin ?? "none"}><td><Origin origin={o.origin} /></td>
              <td className="num">{o.n} events</td></tr>))}</tbody></table>
            <p className="small muted">Agent = a Naive session ran it. Tool = deterministic code. Person = customer or founder. Demo fixture = synthetic inputs or a labelled test fault.</p>
            <h3 className="section">Naive sessions</h3>
            <table className="small"><tbody>{sessions.map((x: any) => (<tr key={x.session_id}><td className="mono">{x.session_id}</td><td>{x.role} · {x.purpose ?? x.stage}</td>
              <td>{x.status}/{x.stop_reason ?? "-"}</td><td className="num">{usd(x.consumed_micro_usd)}</td></tr>))}
              {sessions.length === 0 && <tr><td className="muted">None: this job ran in {job.mode} mode{job.mode === "local" ? ", with no AI model calls" : ""}.</td></tr>}</tbody></table>
          </div>
        </section>
      )}

      <section className="section grid g2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>Important decisions</h3>
          <ul className="timeline">{important.map((e: any) => (
            <li key={e.id}><span className="t">{clock(e.at)}</span><span className="who">{who(e.actor, e.origin)}
              <div><Origin origin={e.origin} detail={e.origin_detail} source={e.source} /></div></span><span>{e.summary}</span></li>))}</ul>
        </div>
        <div className="stack">
          <div className="card">
            <h3>Customer approvals</h3>
            {approvals.length === 0 ? <p className="small muted">None yet.</p> : (
              <ul className="checklist">{approvals.map((a: any) => <li key={a.id}><span className={`mark ${a.decision === "accepted" ? "ok" : "bad"}`}>✓</span>
                <span><b>{a.kind === "proposal" ? "Proposal" : a.kind === "delivery" ? "Delivery" : "Change"} {a.decision}</b> by {a.by_name} · {when(a.at)}
                  <div className="small muted">"{a.statement}" · <code>{a.reference?.slice(0, 48)}</code></div></span></li>)}</ul>)}
          </div>
          <div className="card">
            <h3>Founder interventions</h3>
            {interventions.length === 0 ? <p className="small muted">None. The agents handled this job without the founder.</p> : (
              <ul className="checklist">{interventions.map((x: any) => <li key={x.id}><span className="mark warn">!</span>
                <span>{x.reason}<div className="small muted">{x.kind} · {x.minutes} min · {when(x.at)}</div></span></li>)}</ul>)}
          </div>
          <div className="card">
            <h3>Founder controls</h3>
            <div className="stack-sm small">
              <div><div className="muted">Spending limit ({usd(totalMicro)} used of {usd(job.cost_limit_micro_usd, 2)})</div>
                <OpsNumberAction url={action} field="usd" label="Set limit (USD)" initial={job.cost_limit_micro_usd / 1_000_000} extra={{ action: "raise_limit" }} /></div>
              {canFault && <div><div className="muted">Test fault (labelled; shows detection and repair)</div><FaultPicker jobId={id} /></div>}
              <div className="row">
                {job.status === "waiting_founder" && <ActionButton url={action} body={{ action: "retry", reason: "Founder approved this step after review." }} label={job.stage === "intake" ? "Approve assessment" : "Retry this step"} />}
                {job.status === "waiting_founder" && ["verify", "repair"].includes(job.stage) && <ActionButton url={action} body={{ action: "grant_repair", reason: "Founder allowed one more repair." }} label="Allow one more repair" />}
                {delivered && (showroom?.status === "running"
                  ? <ActionButton url={action} body={{ action: "showroom_stop" }} label="Stop the running app" />
                  : <ActionButton url={action} body={{ action: "showroom_start" }} label={showroom?.status === "requested" ? "Starting..." : "Start the upgraded app"} />)}
                <ActionButton url={action} body={{ action: "founder_time", minutes: 5, note: "Founder reviewed this job (5 min)." }} label="Log 5 min of my time" />
              </div>
              {showroom?.status === "running" && <p className="small">Running at <a href={`http://127.0.0.1:${showroom.port}${job.recipe === "agent-replatform" ? "/" : "/docs"}`} target="_blank">127.0.0.1:{showroom.port}{job.recipe === "agent-replatform" ? "/" : "/docs"}</a></p>}
              {showroom?.status === "failed" && <p className="small" style={{ color: "var(--bad)" }}>Could not start: {showroom.detail}</p>}
            </div>
          </div>
        </div>
      </section>

      {founderQs.length > 0 && (
        <section className="section card"><h2>Questions for the founder</h2>{founderQs.map((x: any) => <p key={x.id}>{x.prompt}</p>)}</section>
      )}

      <section className="section card">
        <h2>Failed checks and repairs</h2>
        {runs.length === 0 && <p className="small muted">No verification has run yet.</p>}
        {runs.map((r: any) => {
          const rep = repairs.find((x: any) => x.attempt === r.attempt);
          return (
            <div key={r.attempt} className="stack-sm" style={{ marginTop: 12 }}>
              <div className="row"><b>Attempt {r.attempt}</b>{r.verdict === "pass" ? <span className="pill ok">{r.passed}/{r.total} passed</span>
                : <span className="pill bad">{r.failed} of {r.total} failed - delivery blocked</span>}<span className="small muted">{when(r.created_at)}</span></div>
              {r.verdict === "fail" && (
                <div className="table-wrap"><table><thead><tr><th>Check</th><th>Expected</th><th>Actual</th></tr></thead><tbody>
                  {r.failed_checks.slice(0, 8).map((f: any) => (
                    <tr key={f.id}><td className="small"><code>{f.id}</code><div className="muted">{f.title}</div>
                      {f.evidence?.examples?.[0] && <div className="muted mono">e.g. row {f.evidence.examples[0].pk}.{f.evidence.examples[0].column}: {f.evidence.examples[0].expected} vs {f.evidence.examples[0].actual}</div>}</td>
                      <td className="small mono">{String(JSON.stringify(f.expected)).slice(0, 60)}</td><td className="small mono">{String(JSON.stringify(f.actual)).slice(0, 80)}</td></tr>))}
                  {r.failed_checks.length > 8 && <tr><td colSpan={3} className="small muted">... and {r.failed - 8} more</td></tr>}
                </tbody></table></div>
              )}
              {rep && (
                <div className="card tight" style={{ background: "var(--surface-2)" }}>
                  <div className="row between"><b>Repair after attempt {rep.attempt}</b><span className={`pill ${rep.outcome === "fixed" ? "ok" : rep.outcome === "escalated" ? "warn" : "neutral"}`}>{rep.outcome}</span></div>
                  {rep.diagnoses.map((d: any) => <p key={d.signature} className="small" style={{ margin: "6px 0" }}><b>Diagnosis ({d.signature}):</b> {d.explanation}</p>)}
                  {rep.actions.map((x: any, i: number) => <p key={i} className="small muted" style={{ margin: "2px 0" }}>Changed <code>{x.file}</code>: {x.action}</p>)}
                  {rep.diff && <details><summary>Code change</summary><DiffBlock diff={rep.diff} /></details>}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="section grid g2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>Spending</h3>
          <ModeBanner mode={job.mode} />
          <table style={{ marginTop: 10 }}><thead><tr><th>Who / step</th><th>Basis</th><th className="num">Quantity</th><th className="num">Cost</th></tr></thead>
            <tbody>{costs.map((c: any, i: number) => (
              <tr key={i}><td className="small">{who(c.actor)} · {c.stage}</td><td className="small muted">{c.basis === "naive_metered" ? "metered by Naive" : c.basis === "estimate_naive_rate" ? "estimate" : c.basis}</td>
                <td className="num small">{Number(c.qty).toFixed(1)} {c.unit}</td><td className="num small">{usd(c.micro)}</td></tr>))}
              <tr><td colSpan={3}><b>Total, including failed attempts and retries</b></td><td className="num"><b>{usd(totalMicro)}</b></td></tr></tbody></table>
          <p className="small muted" style={{ marginTop: 8 }}>Limit {usd(job.cost_limit_micro_usd, 2)}. Every step is priced before it runs and refused if it would pass the limit.
            Price to the customer: {dollars(job.price_cents)}.</p>
          {sessions.length > 0 && <><h3>Naive sessions</h3><ul className="small">{sessions.map((s: any) => <li key={s.id}><code>{s.session_id}</code> {s.role} · {s.stage} · {s.status}/{s.stop_reason} · {usd(s.consumed_micro_usd)}</li>)}</ul></>}
        </div>
        <div className="card">
          <h3>Evidence</h3>
          <table><tbody>{artifacts.map((a: any) => (
            <tr key={a.id}><td className="small">{a.label}{a.frozen && <span className="tag mode" style={{ marginLeft: 6 }}>frozen</span>}
              <div className="muted mono">{a.sha256 ? a.sha256.slice(0, 20) + "..." : "folder"} · {who(a.created_by, a.origin)}</div></td>
              <td className="small">{a.sha256 && <a href={`/api/jobs/${id}/artifacts/${a.id}?ops=1&inline=1`}>open</a>}</td></tr>))}</tbody></table>
          {job.checks_manifest_sha && <p className="small muted mono" style={{ marginTop: 8 }}>Frozen manifest {job.checks_manifest_sha}</p>}
        </div>
      </section>

      <section className="section card">
        <h3>Stage runs</h3>
        <table><thead><tr><th>Stage</th><th>Attempt</th><th>Status</th><th>Agent</th><th className="num">Runs</th><th className="num">Seconds</th></tr></thead>
          <tbody>{stageRuns.map((r: any) => (
            <tr key={r.id}><td>{opsStageLabel(r.stage)}</td><td>{r.attempt}</td><td>{r.status}</td><td className="small">{who(r.actor)}</td>
              <td className="num">{r.runs}{r.runs > 1 ? " (resumed)" : ""}</td>
              <td className="num">{r.finished_at ? ((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1) : "-"}</td></tr>))}</tbody></table>
      </section>

      <section className="section card">
        <h3>Full activity record ({events.length})</h3>
        <ul className="timeline">{events.map((e: any) => (
          <li key={e.id}><span className="t">{clock(e.at)}</span><span className="who">{who(e.actor, e.origin)}</span><span className="small">{e.summary}</span></li>))}</ul>
        <p className="small muted"><Link href={`/ops/replay/${id}`}>Replay this run step by step</Link> (a replay of recorded events, not live).</p>
      </section>
    </main>
  );
}
