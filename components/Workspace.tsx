import { CustomerBusiness } from "@/components/CustomerBusiness";
// The customer's project workspace for plan-driven jobs: their goal, the map of their application, the plan and why,
// the quote and questions, the work as it happens (with who or what made each decision), and the result.
import { AppMap, SourceLink } from "@/components/AppMap";
import { MigrationPreview } from "@/components/MigrationPreview";
import { ActionButton, AnswerForm, AutoRefresh, MessageForm, SignForm, UploadForm } from "@/components/client";
import { JobRun } from "@/components/job/JobRun";
import { dollars, JobStatus, KindTag, ModeBanner, Origin, ROLE_NAMES, runScene, runStages, usd, when } from "@/components/ui";
import { isInfraWait } from "@/lib/infraWait";

const CONSTRAINT_TEXT: Record<string, string> = {
  keep_framework: "Keep the current web framework", keep_database: "Keep the current database", keep_api: "Pages and API responses must not change",
  keep_connections: "Existing connections must keep working", no_data: "Our data cannot be shared",
};

/** An agent role is only called an agent when a Naive session made the decision; otherwise it is that role's step. */
function who(actor: string, origin: string | null) {
  const name = ROLE_NAMES[actor] ?? actor;
  if (origin === "agent" || !name.endsWith(" agent")) return name;
  return `${name.replace(/ agent$/, "")} step`;
}

function DetailedText({ value, label = "Read the assessment rationale" }: { value: unknown; label?: string }) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > 420 ? <details className="small" style={{ marginTop: 5 }}><summary>{label}</summary><p className="muted" style={{ marginTop: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</p></details> : <span className="muted">{text}</span>;
}

export function Workspace({ v, token, ops = false }: { v: any; token: string; ops?: boolean }) {
  const { job, proposal, questions, messages, artifacts, runs, invoice, plan, plans, inspection: insp, report, events, pairs, diff } = v;
  const id = job.id;
  const p = plan?.plan;
  const workspace = job.recipe === "workspace-change";
  const engineeringContract = p?.workspace_contract;
  const open = questions.filter((x: any) => x.status === "open");
  const pkg = artifacts.find((a: any) => a.kind === "delivery_package");
  const reportArt = [...artifacts].reverse().find((a: any) => a.kind === "verification_report");
  const mission = [...artifacts].reverse().find((a:any)=>a.kind==="robotics_mission");
  const missionQuality = [...artifacts].reverse().find((a:any)=>a.kind==="robotics_quality");
  const delivered = ["delivered", "invoice", "follow_up", "closed"].includes(job.stage);
  const quote = proposal?.scope?.quote;
  const st = insp?.stack;
  const findings = insp?.findings ?? [];
  const same = pairs.filter((x: any) => x.after && x.after.status === x.before.status && x.after.body === x.before.body).length;
  return (
    <main className="wrap">
      <AutoRefresh active={job.status === "running" || v.preview?.status === "requested"} />
      <header className="job-head">
        <div>
          <div className="kicker">{job.account_name} · {job.id}</div>
          <h1>{job.title}</h1>
          <div className="row"><JobStatus status={job.status} stage={job.stage} /><KindTag kind={job.kind} />
            <span className="tag mode">{job.mode === "naive" ? "Live agents" : "Local mode - no AI"}</span></div>
        </div>
      </header>

      {open.length > 0 && (
        <section className="section card needs-answer">
          <h2>Needs your answer</h2>
          {open.map((x: any) => (
            <div key={x.id} className="stack-sm" style={{ marginTop: 10 }}>
              <p style={{ marginBottom: 6 }}>{x.prompt}</p>
              {x.fields?.[0]?.type === "choice" && <AnswerForm jobId={id} token={token} qkey={x.key} options={x.fields[0].options} help={x.options_help} recommended={x.recommended} />}
              {x.fields?.[0]?.type === "upload" && <UploadForm jobId={id} token={token} kind={x.fields[0].key === "repository" ? "repository" : "database"} />}
            </div>))}
        </section>
      )}

      {proposal && proposal.status === "sent" && job.stage === "awaiting_acceptance" && !ops && (
        <div className="section job-callout"><div><b>Your proposal is ready.</b><p>A fixed price, the plan and the acceptance checks. Nothing changes in your code until you accept.</p></div>
          <a className="btn primary" href="#proposal">Review and accept</a></div>
      )}

      <div className="job-run">
        <JobRun src={v.runSig ? `/api/jobs/${id}/live?${ops ? "ops=1" : `t=${encodeURIComponent(token)}`}` : null} sig={v.runSig?.sig ?? null}
          scene={runScene(job.stage, job.status, open.length)} paused={isInfraWait(job.waiting_reason) ? "environment" : undefined} attempt={v.runSig?.attempt ?? null} now={v.stageLabel}
          detail={job.status === "waiting_founder" ? job.waiting_reason : (events.filter((e: any) => /^Attempt \d+ of \d+ did not work/.test(e.summary)).at(-1)?.summary ?? null)}
          stages={runStages(job.stage, job.status, 2, { failedAttempts: runs.filter((r: any) => r.verdict === "fail").length, checks: runs.length ? { passed: runs.at(-1).passed, total: runs.at(-1).total } : null })}
          checks={runs.length ? { passed: runs.at(-1).passed, total: runs.at(-1).total } : null}
          checksCount={engineeringContract?.checks?.length ?? p?.adaptive_plan?.checks?.length ?? p?.acceptance_checks?.length ?? null} />
        {diff && <details className="full-diff"><summary className="small">The full diff (+{diff.split("\n").filter((l: string) => /^\+(?!\+\+)/.test(l)).length} −{diff.split("\n").filter((l: string) => /^-(?!--)/.test(l)).length} lines)</summary><pre className="diff">{diff.slice(0, 40000)}</pre></details>}
      </div>

      <div className="card section">
        <p style={{ margin: 0 }}><b>Now:</b> {v.stageLabel}.{" "}
          {job.status === "running" && <span className="muted">{job.mode === "naive" ? `The ${ROLE_NAMES[job.responsible]?.toLowerCase()} is on it.`
            : `The ${who(job.responsible, null).toLowerCase()} is running (deterministic tools, no AI).`}</span>}
          {job.status === "waiting_customer" && <span className="muted">{job.waiting_reason}.</span>}
          {job.status === "waiting_founder" && <span className="muted">{isInfraWait(job.waiting_reason) ? "Waiting for the build environment to start; work resumes automatically." : <>Our founder is looking at something before work continues: {job.waiting_reason}</>}</span>}
          {job.status === "rejected" && <span className="muted">This goal is outside what we can carry out and verify today. See the plan and the message below.</span>}</p>
      </div>
      <div className="section"><ModeBanner mode={job.mode} /></div>

      <section className="section grid g2" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="stat-label">Your goal</div>
          {job.goal.length > 600 ? <>
            <p style={{ fontSize: "1.05rem", margin: "4px 0 10px" }}>{job.goal.slice(0, 320).replace(/\s+\S*$/, "")}…</p>
            <details style={{ marginBottom: 12 }}><summary>Read the full objective</summary><p style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{job.goal}</p></details>
          </> : <p style={{ fontSize: "1.05rem", margin: "4px 0 10px", whiteSpace: "pre-wrap" }}>"{job.goal}"</p>}
          {(job.constraints ?? []).length > 0 && <div className="row" style={{ gap: 6 }}>{job.constraints.map((c: string) => <span key={c} className="pill neutral">{CONSTRAINT_TEXT[c] ?? c}</span>)}</div>}
          {job.constraint_notes && <p className="small muted" style={{ marginTop: 8 }}>{job.constraint_notes}</p>}
        </div>
        <div className="card">
          <div className="stat-label">What we found</div>
          {workspace ? <p style={{ margin: "4px 0" }}>Executable repository engineering{engineeringContract ? <> · {engineeringContract.checks.length} agreed behavior checks · {engineeringContract.deliverables.length} deliverables</> : ". The assessment is establishing an executable contract."}</p> : st && st.framework === "SuiteCRM" ? <p style={{ margin: "4px 0" }}>SuiteCRM {st.framework_version} (PHP) · {insp.size.sales_rows.toLocaleString("en-US")} sales records ·{" "}
            {insp.size.customizations} customizations · {insp.components.filter((c: any) => c.kind === "role").length} roles, {insp.components.filter((c: any) => c.kind === "team").length} teams ·{" "}
            {findings.length} findings</p>
            : st ? <p style={{ margin: "4px 0" }}>{st.framework ?? "No supported framework"} {st.framework_version ?? ""}{st.python ? ` on Python ${st.python}` : ""} ·{" "}
            {insp.components.filter((c: any) => c.kind === "route").length} entry points · {insp.components.filter((c: any) => c.kind === "table").length} tables ·{" "}
            {insp.components.filter((c: any) => c.kind === "client" || c.kind === "script").length} outside connections · {findings.length} findings</p>
            : <p className="muted">Inspection has not run yet.</p>}
          <p className="small muted" style={{ margin: 0 }}>Database: {st?.database?.copy_supplied ? "a copy was sent; it is used only on copies" : "no copy sent"}{p?.database_use ? `. This plan: ${p.database_use}.` : "."}</p>
        </div>
      </section>

      {mission&&<section className="card section"><div className="card-head"><h2>Recorded simulation</h2><span className="small muted">Actual Gazebo, SLAM and odometry telemetry</span></div>
        <img src={`/api/jobs/${id}/artifacts/${mission.id}?${ops?"ops=1":`t=${encodeURIComponent(token)}`}&inline=1`} alt="Observed robot occupancy map and measured trajectory with independent acceptance results" style={{width:"100%",height:"auto",borderRadius:12}} />
        <p className="small muted">One simulated robot. Physical hardware has not been validated. The source report and map are available with the verification artifacts.</p>
        {missionQuality&&<p className="notice warn" style={{marginTop:12}}>{missionQuality.label}</p>}
      </section>}

      {insp && (
        <section className="section card">
          <div className="card-head"><h2>Your application</h2><span className="small muted">{workspace ? "Executable scope and preserved behavior" : <>Built from reading your code{st?.database?.copy_supplied ? " and data" : ""}. Select a box.</>}</span></div>
          {workspace ? <div className="grid g3">
            <div><div className="stat-label">Original behavior</div><b>{engineeringContract?.checks.filter((c: any) => c.kind === "preserve").length ?? "Pending"} preservation checks</b><p className="small muted">Recorded against the source before implementation.</p></div>
            <div><div className="stat-label">Requested changes</div><b>{engineeringContract?.checks.filter((c: any) => c.kind === "requirement").length ?? "Pending"} requirement checks</b><p className="small muted">Explicit expectations for the new capabilities.</p></div>
            <div><div className="stat-label">Delivered files</div><p className="small mono">{engineeringContract?.deliverables.join(", ") ?? "Established during assessment"}</p></div>
          </div> : <AppMap jobId={id} token={token} ops={ops} components={insp.components} edges={insp.edges} findings={findings} changes={p?.changes ?? []} preserve={p?.preserve ?? []} />}
          <h3 className="section">Findings</h3>
          <table><tbody>{findings.map((f: any) => (
            <tr key={f.id}><td style={{ width: 70 }}><span className={`pill ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}`}>{f.severity}</span></td>
              <td><b>{f.title}.</b> <span className="muted small">{f.detail}</span>
                <div className="row" style={{ gap: 8, marginTop: 4 }}>{(f.evidence ?? []).slice(0, 6).map((e: any, i: number) => e.file
                  ? <SourceLink key={i} jobId={id} token={token} ops={ops} path={e.file} line={e.line ?? null} />
                  : e.db ? <details key={i} className="evidence-db"><summary className="small mono">database query</summary>
                    <pre className="source small">{e.db}{"\n→ "}{JSON.stringify(e.result, null, 1)?.slice(0, 900)}</pre></details>
                  : e.doc ? <span key={i} className="small muted">{e.doc}</span>
                  : <span key={i} className="small mono muted">{e.observed}</span>)}</div></td></tr>))}</tbody></table>
        </section>
      )}

      {p && (
        <section className="section card">
          <div className="card-head"><h2>The plan</h2><span className="small muted">v{plan.version} · {plan.author_kind === "agent" ? "written by the assessment agent" : "written by the deterministic planner"}{plan.changed_because ? ` · ${plan.changed_because}` : ""}</span></div>
          {p.decision === "unsupported" ? <div className="banner warn"><b>Not something we can do yet</b><span>{(p.reasons ?? []).join(" ")}</span></div>
            : <p><b>{p.title}.</b> <span className="muted">{(p.reasons ?? []).join(" ")}</span></p>}
          {(p.options ?? []).length > 0 && (<>
            <h3 className="section">Options we considered</h3>
            <table><thead><tr><th>Option</th><th>Changes framework</th><th>Moves data</th><th>Can run now</th><th>Why</th></tr></thead><tbody>
              {p.options.map((o: any) => (<tr key={o.recipe} style={o.recipe === p.recommended ? { background: "var(--accent-soft)" } : undefined}>
                <td className="small"><b>{o.title}</b>{o.recipe === p.recommended && <div className="pill info">recommended</div>}</td>
                <td className="small">{o.changes_framework ? "yes" : "no"}</td><td className="small">{o.changes_database ? "yes" : "no"}</td>
                <td className="small">{o.executable_now ? "yes" : <span className="muted">no: {(o.blocked_by ?? []).join("; ")}</span>}</td>
                <td className="small muted">{o.why}</td></tr>))}</tbody></table></>)}
          {p.decision !== "unsupported" && (
            <div className="grid g2 section" style={{ alignItems: "start" }}>
              <div><h3>What changes, and why</h3><ul>{(p.changes ?? []).map((c: any) => <li key={c.id}>{String(c.title??"").length>420?<><b>Engineering objective</b><DetailedText value={c.title} label="Read the full change objective" /></>:<b>{c.title}.</b>} <DetailedText value={c.reason} />
                {c.by === "agent" && <span className="origin agent" style={{ marginLeft: 6 }}>implementation agent</span>}</li>)}</ul>
                <h3>Intended differences</h3>
                <ul>{(p.intended_differences ?? []).map((d: any) => <li key={d.id}><b>{d.title ?? d.what}.</b> <span className="muted">{d.reason ?? d.why}</span></li>)}
                  {(p.intended_differences ?? []).length === 0 && <li className="muted">None: every recorded request must answer exactly as today.</li>}</ul></div>
              <div><h3>What we keep as it is</h3><ul>{(p.preserve ?? []).map((k: any, i: number) => <li key={i}>{k.what} <span className="muted small">{k.reason}</span></li>)}</ul>
                <h3>Not in this job</h3><ul>{(p.follow_ups ?? []).map((f: any) => <li key={f.finding_id ?? f.id} className="small">{f.title} <span className="muted">- {f.why_not_now ?? (f.quote === "separate" ? "quoted separately if you want it" : "")}</span></li>)}
                  {(p.follow_ups ?? []).length === 0 && <li className="muted small">No additional exclusions were listed at assessment. Later requests appear under Support &amp; next steps.</li>}</ul></div>
            </div>)}
          {(p.boundary ?? []).length > 0 && (
            <div className="section">
              <h3>What moves, what stays in SuiteCRM, and what crosses between them</h3>
              <div className="grid g2" style={{ alignItems: "start" }}>
                <div><div className="stat-label">Stays in SuiteCRM</div>
                  <ul className="small">{(p.stays_in_original ?? []).filter((s: any) => s.rows > 0).map((s: any) => <li key={s.module}>{s.module} ({s.rows.toLocaleString("en-US")} records)</li>)}
                    {(p.stays_in_original ?? []).some((s: any) => !s.rows) && <li className="muted">{(p.stays_in_original ?? []).filter((s: any) => !s.rows).map((s: any) => s.module).join(", ")} (no records)</li>}</ul>
                  {p.target && <><div className="stat-label" style={{ marginTop: 10 }}>The new workspace</div>
                    <p className="small" style={{ margin: "4px 0" }}><b>{p.target.architecture}.</b> {(p.target.why ?? []).join(" ")}</p>
                    <p className="small muted" style={{ margin: 0 }}>New code: {(p.target.modernized ?? []).join("; ")}. Still used: {(p.target.still_used ?? []).join("; ")}.</p></>}</div>
                <div><div className="stat-label">Links that cross the boundary</div>
                  <table className="small"><tbody>{p.boundary.map((b: any, i: number) => (
                    <tr key={i}><td className="nowrap">{b.from} → {b.to}</td><td className="num">{b.rows.toLocaleString("en-US")}</td><td className="muted">{b.handling}</td></tr>))}</tbody></table></div>
              </div>
              {p.cutover && <><h3>Switching over</h3><ol className="small">{p.cutover.steps.map((s: string) => <li key={s}>{s}</li>)}</ol>
                <p className="small muted">{p.cutover.downtime} Rollback: {p.cutover.rollback}</p></>}
            </div>)}
          {engineeringContract && !p.adaptive_plan && <details className="section"><summary>Engineering execution contract</summary><div className="grid g2" style={{ marginTop: 14 }}><div><h3>Build the source</h3><pre>{engineeringContract.source_build.length ? engineeringContract.source_build.map((c: any) => c.argv.join(" ")).join("\n") : "No build step required"}</pre></div><div><h3>Build the target</h3><pre>{engineeringContract.target_build.length ? engineeringContract.target_build.map((c: any) => c.argv.join(" ")).join("\n") : "No build step required"}</pre></div></div><p className="small muted" style={{ marginTop: 12 }}>Each behavior check runs the agreed command in an isolated environment. Preservation checks compare against the recorded source; new requirements compare against the approved expectation.</p><ul className="small">{engineeringContract.limitations.map((limit: string, index: number) => <li key={index}>{limit}</li>)}</ul></details>}
          {p.adaptive_plan && <section className="section card"><h3>Environment discovered from your repository</h3><p>The agents reproduced the original environment, exercised existing tests, and checked that deliberate behavior faults are detected before proposing this scope.</p><div className="grid g3"><div><div className="stat-label">Runtime</div><b>{p.adaptive_plan.image}</b></div><div><div className="stat-label">Acceptance groups</div><b>{p.adaptive_plan.checks.length}</b></div><div><div className="stat-label">Negative controls</div><b>{p.adaptive_plan.mutations.length}</b></div></div><details className="section"><summary>Setup, checks and coverage limits</summary><h4>Dependency setup</h4><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{p.adaptive_plan.setup}</pre><p className="small">Each check runs on an independent copy. Existing test files remain protected. The delivery includes this environment and the acceptance scripts.</p><ul>{p.adaptive_plan.limitations.map((s:string,i:number)=><li key={i}>{s}</li>)}</ul></details></section>}
          {p.migration_contract && <div className="section card" style={{ background: "var(--panel)" }}>
            <h3>Migration contract</h3>
            <p><b>{p.migration_contract.target === "rust" ? "Rust" : p.migration_contract.target}</b> application with SQLite data continuity.</p>
            <div className="grid g3">
              <div><div className="stat-label">Existing behaviour</div><b>{p.migration_contract.legacy_requests.length} baseline requests</b><p className="small muted">Recorded twice and frozen before implementation.</p></div>
              <div><div className="stat-label">New data</div><b>{p.migration_contract.new_requests.length} feature checks</b><p className="small muted">API writes plus independent database assertions.</p></div>
              <div><div className="stat-label">After restart</div><b>{p.migration_contract.persistence_requests.length} persistence checks</b><p className="small muted">Saved records must survive an application restart.</p></div>
            </div>
            <h4>Approved data transformations</h4>
            {p.migration_contract.data_changes.length ? <ul className="small">{p.migration_contract.data_changes.map((d: any, i: number) => <li key={i}><b>{d.op.replaceAll("_", " ")} · {d.table}</b><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(d, null, 2)}</pre></li>)}</ul> : <p className="small muted">No schema or seed-data changes. All current values are preserved.</p>}
            <p className="small muted">Cutover uses a fresh source snapshot while writes are paused. The package includes a repeatable migration tool and rollback instructions.</p>
            {(p.limitations ?? []).length > 0 && <details><summary>Coverage limits</summary><ul className="small">{p.limitations.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul></details>}
          </div>}
          {(p.acceptance_checks ?? []).length > 0 && (<><h3>Acceptance checks</h3>
            <ol className="small">{p.acceptance_checks.map((a: any) => <li key={a.id}>{a.text ?? a.what}{a.mandatory === false && <span className="muted"> (optional)</span>}</li>)}</ol></>)}
          {plans.length > 1 && (<><h3 className="section">How the plan changed</h3><ul className="small">{plans.map((x: any) => (
            <li key={x.version}>v{x.version} · {when(x.created_at)} · {x.author}{x.changed_because ? ` · ${x.changed_because}` : ""}</li>))}</ul></>)}
        </section>
      )}

      {proposal && quote && (
        <section className="section card" id="proposal" style={{ scrollMarginTop: 84 }}>
          <div className="card-head"><h2>Proposal v{proposal.version}</h2>
            <span className={`pill ${proposal.status === "accepted" ? "ok" : proposal.status === "sent" ? "info" : "neutral"}`}>{proposal.status === "sent" ? "Waiting for you" : proposal.status}</span></div>
          <p><b>{proposal.summary.headline}</b></p>
          <p className="muted">{proposal.summary.plain_summary}</p>
          <table><tbody>{quote.lines.map((l: any, i: number) => <tr key={i}><td>{l.label}</td><td className="num">${l.usd.toLocaleString("en-US")}</td></tr>)}
            <tr><td><b>Fixed price</b> <span className="small muted">invoiced only after the checks pass and you accept</span></td><td className="num"><b>{dollars(proposal.price_cents)}</b></td></tr></tbody></table>
          <p className="small muted">{quote.note} Delivery within {proposal.delivery_days} working days of acceptance.</p>
          {proposal.status === "sent" && job.stage === "awaiting_acceptance" && !ops && (
            <div className="section">
              <SignForm url={`/api/jobs/${id}/accept`} token={token} extra={{ version: proposal.version }} button="Accept proposal"
                statement="I accept the plan, the fixed price and the acceptance checks in this proposal." />
              <div style={{ marginTop: 10 }}><ActionButton url={`/api/jobs/${id}/decline`} body={{ t: token, version: proposal.version, name: "Customer" }} label="Decline" confirm="Decline this proposal?" /></div>
            </div>)}
        </section>
      )}

      <section className="section card">
        <h2>Work and decisions</h2>
        <ul className="timeline two">{events.map((e: any) => (
          <li key={e.id}><span className="mono small muted">{when(e.at)}</span>
            <div><span className="small"><b>{who(e.actor, e.origin)}</b></span> <Origin origin={e.origin} detail={e.origin_detail} source={e.source} /><br /><DetailedText value={e.summary} label="Read the full recorded decision" /></div></li>))}
          {events.length === 0 && <li className="muted small">Nothing yet.</li>}</ul>
      </section>

      {runs.length > 0 && (
        <section className="section card">
          <h2>Verification</h2>
          <table><thead><tr><th>Attempt</th><th>Result</th><th className="num">Passed</th><th className="num">Failed</th><th>When</th></tr></thead>
            <tbody>{runs.map((r: any) => (<tr key={r.attempt}><td>{r.attempt}</td>
              <td>{r.verdict === "pass" ? <span className="pill ok">All mandatory checks passed</span> : <span className="pill bad">Failed - delivery blocked</span>}</td>
              <td className="num">{r.passed}</td><td className="num">{r.failed}</td><td>{when(r.created_at)}</td></tr>))}</tbody></table>
          {report && (<>
            <div className="grid g3 section">{Object.entries(report.by_category ?? {}).map(([k, c]: any) => {
              const passed=c.passed??c.pass??0,failed=c.failed??c.fail??0,skipped=c.skipped??c.skip??0,total=c.total??passed+failed+skipped;
              return <div key={k} className="card tight"><div className="stat-label">{c.title??k.replaceAll("_"," ")}</div><div className="stat">{passed}/{total}</div>
                {failed + skipped > 0 && <div className="small" style={{ color: "var(--bad)" }}>{failed} failed, {skipped} not run</div>}</div>;})}</div>
            {(report.failed ?? []).length > 0 && (<><h3>What failed</h3><ul className="small">{report.failed.slice(0, 12).map((f: any) => <li key={f.id}><b>{f.title}</b>
              <span className="mono muted"> {JSON.stringify(f.evidence?.problems?.[0] ?? f.evidence ?? {}).slice(0, 220)}</span></li>)}</ul></>)}
            {(report.summary?.optional_skipped ?? []).length > 0 && <p className="small">Optional checks not run: {report.summary.optional_skipped.map((x: any) => `${x.id} (${x.reason})`).join("; ")}</p>}
          </>)}
          {(report?.results ?? []).some((r: any) => r.category === "approval") && (<>
            <h3 className="section">The approval rule: the original SuiteCRM and the new workspace, scenario by scenario</h3>
            <table className="small"><thead><tr><th>Scenario</th><th>Original SuiteCRM (recorded on a copy)</th><th>New workspace</th><th></th></tr></thead><tbody>
              {report.results.filter((r: any) => r.category === "approval").map((r: any) => {
                const last = r.evidence?.steps?.at(-1);
                return (<tr key={r.id}><td>{r.title}</td>
                  <td className="mono">{last ? `${last.original.stage} · ${last.original.approval || "no approval"}${last.original.refused ? " · refused" : ""}` : String(r.expected ?? "")}</td>
                  <td className="mono">{last ? `${last.workspace.stage} · ${last.workspace.approval || "no approval"}${[403, 404].includes(last.status) ? " · refused" : ""}` : String(r.actual ?? "")}</td>
                  <td>{r.status === "pass" ? <span className="pill ok">same</span> : <span className="pill bad">different</span>}</td></tr>);
              })}</tbody></table></>)}
          {pairs.length > 0 && (<>
            <h3 className="section">Before and after: the same requests to the old and the new app</h3>
            <p className="small muted">{same} of {pairs.length} recorded answers match. {p?.migration_contract ? "The migration compares status codes and complete JSON values exactly." : "Volatile values such as security tokens are normalised."} The full comparison is in the report.</p>
            <details><summary className="small">Show the requests</summary>
              <table className="small"><thead><tr><th>Request</th><th>Before</th><th>After</th></tr></thead><tbody>{pairs.slice(0, 60).map((x: any) => (
                <tr key={x.step}><td className="mono">{x.method} {x.path}</td><td><b>{x.before.status}</b> <span className="muted mono">{x.before.body.slice(0, 90)}</span></td>
                  <td><b>{x.after?.status ?? "-"}</b> <span className="muted mono">{x.after?.body?.slice(0, 90)}</span></td></tr>))}</tbody></table></details></>)}
          {reportArt && <p className="small" style={{ marginTop: 10 }}><a href={`/api/jobs/${id}/artifacts/${reportArt.id}?${ops ? "ops=1" : `t=${token}`}&inline=1`}>Read the full verification report</a></p>}
        </section>
      )}

      {v.live && (
        <section className="section card">
          <h2>Before and after</h2>
          <div className="grid g2">
            <div className="card tight"><div className="stat-label">Original: SuiteCRM 7.11.23</div>
              <p className="small" style={{ margin: "4px 0" }}>{v.live.original.up ? <a href={v.live.original.url} target="_blank" rel="noreferrer">{v.live.original.url}</a> : <span className="muted">not running ({v.live.original.url})</span>}</p>
              <p className="small muted" style={{ margin: 0 }}>Your system as it is. Goose never connects to it; we work on the snapshot you sent.</p></div>
            <div className="card tight"><div className="stat-label">Delivered: sales workspace</div>
              <p className="small" style={{ margin: "4px 0" }}>{v.live.workspace?.up ? <a href={v.live.workspace.url} target="_blank" rel="noreferrer">{v.live.workspace.url}</a>
                : <span className="muted">not running. Start it with <code>npm run crm -- serve {id}</code></span>}</p>
              <p className="small muted" style={{ margin: 0 }}>Runs on the moved copy of your data{v.live.cutover ? `, switched over ${when(v.live.cutover)}` : " (before the switch-over)"}.</p></div>
          </div>
        </section>
      )}

      {delivered && pkg && (
        <section className="section card">
          <h2>Delivery</h2>
          <p>{workspace?"The verified source, frozen contract, change diff, run book and verification evidence are in one package.":"The upgraded application, what changed and why, the run book, the rollback guide and the verification evidence are in one package."}</p>
          <a className="btn primary" href={`/api/jobs/${id}/artifacts/${pkg.id}?${ops ? "ops=1" : `t=${token}`}`}>Download the package</a>
          <p className="small muted mono" style={{ marginTop: 8 }}>SHA-256 {pkg.sha256}</p>
          {job.stage === "delivered" && !ops && <div className="section"><SignForm url={`/api/jobs/${id}/accept-delivery`} token={token} button="Accept the delivery"
            statement="I have reviewed the verification report and accept the delivery." /></div>}
        </section>
      )}

      {delivered && p?.migration_contract && <MigrationPreview id={id} auth={ops ? "ops=1" : `t=${token}`} runtime={p.migration_contract.target}
        steps={[...p.migration_contract.legacy_requests, ...p.migration_contract.new_requests]} room={v.preview} />}

      {(report?.not_tested || (p?.follow_ups ?? []).length > 0) && (
        <section className="section card">
          <h2>Still needs attention</h2>
          <ul className="small">{(p?.follow_ups ?? []).map((f: any) => <li key={f.finding_id ?? f.id}><b>{f.title}</b> - {f.why_not_now ?? "quoted separately if you want it"}</li>)}
            {(report?.not_tested ?? []).map((x: string) => <li key={x} className="muted">{x}</li>)}</ul>
        </section>
      )}

      {invoice && (
        <section className="section card">
          <div className="card-head"><h2>Invoice {invoice.number}</h2>{invoice.is_test && <span className="tag test">Test invoice - not sent, nothing owed</span>}</div>
          <p>{dollars(invoice.amount_cents)} · {invoice.status} · due {when(invoice.due_at)}</p>
        </section>
      )}

      {!ops && <CustomerBusiness jobId={id} token={token} delivered={delivered} />}

      <section className="section card">
        <h2>Messages</h2>
        <div className="stack-sm">{messages.map((m: any) => (
          <div key={m.id} className="card tight" style={{ background: m.sender === "customer" ? "var(--surface-2)" : "var(--surface)" }}>
            <div className="small muted">{m.sender === "customer" ? "You" : m.sender === "founder" ? "Founder" : ROLE_NAMES[m.sender] ?? m.sender}
              {m.handled_by && m.sender !== "customer" ? ` · ${m.handled_by}` : ""} · {when(m.at)}</div>
            <div>{m.body}</div></div>))}</div>
        {!ops && <div style={{ marginTop: 12 }}><MessageForm jobId={id} token={token} /></div>}
        {ops && <p className="small muted">Spend so far: {usd(v.spend.total)}.</p>}
      </section>
    </main>
  );
}
