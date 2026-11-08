import { CustomerBusiness } from "@/components/CustomerBusiness";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, AnswerForm, AutoRefresh, MessageForm, SignForm, UploadForm } from "@/components/client";
import { JobRun } from "@/components/job/JobRun";
import { dollars, JobStatus, KindTag, ROLE_NAMES, runScene, runStages, Steps, when } from "@/components/ui";
import { Workspace } from "@/components/Workspace";
import { customerView, workspaceView } from "@/lib/views";
import { isInfraWait } from "@/lib/infraWait";

export const dynamic = "force-dynamic";

export default async function CustomerJob({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = await params;
  const { t } = await searchParams;
  const v = await customerView(id);
  if (!v || v.job.customer_token !== t) notFound();
  if (v.job.pipeline >= 2) return <Workspace v={await workspaceView(id)} token={t!} />;
  const { job, proposal, questions, messages, artifacts, runs, invoice } = v;
  const token = t!;
  const open = questions.filter((x: any) => x.status === "open");
  const scope = proposal?.scope;
  const pkg = artifacts.find((a: any) => a.kind === "delivery_package");
  const report = [...artifacts].reverse().find((a: any) => a.kind === "verification_report");
  const failedRuns = runs.filter((r: any) => r.verdict === "fail").length;
  const delivered = ["delivered", "invoice", "follow_up", "closed"].includes(job.stage);
  return (
    <main className="wrap">
      <AutoRefresh active={job.status === "running"} />
      <div className="job-head">
        <div>
          <div className="kicker">{v.job.account_name} · {job.id}</div>
          <h1>{job.title}</h1>
          <div className="row"><JobStatus status={job.status} stage={job.stage} /><KindTag kind={job.kind} />
            {job.mode === "local" && <span className="tag mode" title="Deterministic local workers; no AI model calls">Local mode</span>}</div>
        </div>
        {delivered && <Link className="btn primary" href={`/jobs/${id}/result?t=${token}`}>See the result</Link>}
      </div>

      <div className="card section">
        <Steps stage={job.stage} status={job.status} failedAttempts={failedRuns} />
        <p style={{ margin: "12px 0 0" }}>
          <b>Now:</b> {v.stageLabel}. {job.status === "running" && <span className="muted">The {ROLE_NAMES[job.responsible]?.toLowerCase()} is working on it.</span>}
          {job.status === "waiting_customer" && <span className="muted">{job.waiting_reason}.</span>}
          {job.status === "waiting_founder" && <span className="muted">{isInfraWait(job.waiting_reason) ? "Waiting for the build environment to start; work resumes automatically." : <>Work is paused{job.waiting_reason ? `: ${job.waiting_reason}` : ""}. Our founder is looking at it before work continues.</>}</span>}
          {job.status === "rejected" && <span className="muted">This application is outside what we can upgrade today. See the message below.</span>}
        </p>
      </div>

      <div className="job-run">
        <JobRun src={v.runSig ? `/api/jobs/${id}/live?t=${encodeURIComponent(token)}` : null} sig={v.runSig?.sig ?? null} scene={runScene(job.stage, job.status, open.length)} paused={isInfraWait(job.waiting_reason) ? "environment" : undefined}
          attempt={v.runSig?.attempt ?? null} now={v.stageLabel} checks={runs.length ? { passed: runs.at(-1).passed, total: runs.at(-1).total } : null}
          stages={runStages(job.stage, job.status, job.pipeline, { failedAttempts: failedRuns, checks: runs.length ? { passed: runs.at(-1).passed, total: runs.at(-1).total } : null })} />
      </div>

      {open.length > 0 && (
        <section className="section card needs-answer">
          <h2>Needs your answer</h2>
          {open.map((x: any) => (
            <div key={x.id} className="stack-sm" style={{ marginTop: 10 }}>
              <p style={{ marginBottom: 6 }}>{x.prompt}</p>
              {x.fields?.[0]?.type === "choice" && <AnswerForm jobId={id} token={token} qkey={x.key} options={x.fields[0].options}
                help={x.options_help} recommended={x.recommended} />}
              {x.fields?.[0]?.type === "upload" && <UploadForm jobId={id} token={token} kind={x.fields[0].key === "repository" ? "repository" : "database"} />}
            </div>
          ))}
        </section>
      )}

      {proposal && scope && (
        <section className="section card">
          <div className="card-head">
            <h2>Proposal v{proposal.version}</h2>
            <span className={`pill ${proposal.status === "accepted" ? "ok" : proposal.status === "sent" ? "info" : "neutral"}`}>
              {proposal.status === "sent" ? "Waiting for you" : proposal.status}</span>
          </div>
          <p><b>{proposal.summary.headline}</b></p>
          <p className="muted">{proposal.summary.plain_summary}</p>
          <div className="grid g3" style={{ margin: "14px 0" }}>
            <div className="card tight"><div className="stat-label">Fixed price</div><div className="stat">{dollars(proposal.price_cents)}</div>
              <div className="small muted">Invoiced only after the checks pass and you accept</div></div>
            <div className="card tight"><div className="stat-label">Delivery</div><div className="stat">{proposal.delivery_days} days</div>
              <div className="small muted">working days after acceptance</div></div>
            <div className="card tight"><div className="stat-label">Acceptance checks</div><div className="stat">{scope.acceptance_checklist.length} areas</div>
              <div className="small muted">frozen before any code changes</div></div>
          </div>
          <div className="grid g2">
            <div><h3>What we will change</h3><ul>{scope.changes.map((c: any) => <li key={c.id}><b>{c.title}.</b> <span className="muted">{c.why}</span></li>)}</ul></div>
            <div><h3>What stays the same</h3><ul>{scope.keep.map((k: string) => <li key={k}>{k}</li>)}</ul>
              <h3>Not included</h3><ul>{scope.not_included.map((k: string) => <li key={k} className="muted">{k}</li>)}</ul></div>
          </div>
          <h3 className="section">What we found in your code and data</h3>
          <ul>{(proposal.summary.findings ?? []).filter((f: any) => f.severity !== "info" || true).slice(0, 12).map((f: any) => (
            <li key={f.id}><span className={`pill ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}`}>{f.severity}</span>{" "}
              <b>{f.title}.</b> <span className="muted">{f.detail}</span></li>))}</ul>
          <h3 className="section">Intentional differences you are agreeing to</h3>
          <ul>{scope.intentional_differences.map((d: any) => <li key={d.id}><b>{d.title}.</b> <span className="muted">{d.detail}</span></li>)}</ul>
          <h3 className="section">Acceptance checklist</h3>
          <ol>{scope.acceptance_checklist.map((c: any) => <li key={c.id}>{c.text}</li>)}</ol>
          {proposal.status === "sent" && job.stage === "awaiting_acceptance" && (
            <div className="section">
              <SignForm url={`/api/jobs/${id}/accept`} token={token} extra={{ version: proposal.version }} button="Accept proposal"
                statement="I accept the scope, the fixed price and the acceptance checklist in this proposal." />
              <div style={{ marginTop: 10 }}>
                <ActionButton url={`/api/jobs/${id}/decline`} body={{ t: token, version: proposal.version, name: "Customer" }} label="Decline"
                  confirm="Decline this proposal?" />
              </div>
            </div>
          )}
        </section>
      )}

      {runs.length > 0 && (
        <section className="section card">
          <h2>Verification</h2>
          <table><thead><tr><th>Attempt</th><th>Result</th><th className="num">Passed</th><th className="num">Failed</th><th>When</th></tr></thead>
            <tbody>{runs.map((r: any) => (
              <tr key={r.attempt}><td>{r.attempt}</td><td>{r.verdict === "pass" ? <span className="pill ok">Passed</span> : <span className="pill bad">Failed - sent back for repair</span>}</td>
                <td className="num">{r.passed}</td><td className="num">{r.failed}</td><td>{when(r.created_at)}</td></tr>))}</tbody></table>
          {report && <p className="small" style={{ marginTop: 10 }}><a href={`/api/jobs/${id}/artifacts/${report.id}?t=${token}&inline=1`}>Read the latest verification report</a></p>}
        </section>
      )}

      {delivered && pkg && (
        <section className="section card">
          <h2>Delivery</h2>
          <p>Your upgraded application, the data-move scripts, the verification report and the rollback guide are in one package.</p>
          <div className="row">
            <a className="btn primary" href={`/api/jobs/${id}/artifacts/${pkg.id}?t=${token}`}>Download the package</a>
            <Link className="btn" href={`/jobs/${id}/result?t=${token}`}>See what was upgraded and tested</Link>
          </div>
          <p className="small muted mono" style={{ marginTop: 8 }}>SHA-256 {pkg.sha256}</p>
          {job.stage === "delivered" && (
            <div className="section">
              <SignForm url={`/api/jobs/${id}/accept-delivery`} token={token} button="Accept the delivery"
                statement="I have reviewed the verification report and accept the delivery." />
            </div>
          )}
        </section>
      )}

      {invoice && (
        <section className="section card">
          <div className="card-head"><h2>Invoice {invoice.number}</h2>{invoice.is_test && <span className="tag test">Test invoice - not sent, nothing owed</span>}</div>
          <p>{dollars(invoice.amount_cents)} · {invoice.status} · due {when(invoice.due_at)}</p>
        </section>
      )}

      <CustomerBusiness jobId={id} token={token} delivered={delivered} />

      <section className="section card">
        <h2>Messages</h2>
        <div className="stack-sm">
          {messages.map((m: any) => (
            <div key={m.id} className="card tight" style={{ background: m.sender === "customer" ? "var(--surface-2)" : "var(--surface)" }}>
              <div className="small muted">{m.sender === "customer" ? "You" : m.sender === "founder" ? "Founder" : "Commercial agent"}
                {m.handled_by && m.sender !== "customer" ? ` · ${m.handled_by}` : ""} · {when(m.at)}</div>
              <div>{m.body}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}><MessageForm jobId={id} token={token} /></div>
      </section>
    </main>
  );
}
