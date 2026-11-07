import Link from "next/link";
import { config } from "@/lib/config";
import { one } from "@/lib/db";
import { pilotOffer } from "@/lib/jobs";

export const dynamic = "force-dynamic";

const journey = [
  ["01", "Understand", "Read the system, clarify the outcome, and identify the dependencies."],
  ["02", "Agree", "Approve the scope, fixed price, and measurable acceptance criteria."],
  ["03", "Build", "Agents implement the change and repair failures within a spending limit."],
  ["04", "Verify", "Independent checks compare the result with the agreed behavior and data."],
  ["05", "Deliver", "Receive working software, the evidence, and a practical handover."],
  ["06", "Keep moving", "Manage payment, support, and the next change in one workspace."],
];

export default async function Home() {
  const [offer, demo] = await Promise.all([
    pilotOffer(),
    one<{ id: string; customer_token: string }>("SELECT id, customer_token FROM jobs WHERE kind = 'demo' AND status = 'done' AND pipeline >= 2 ORDER BY created_at DESC LIMIT 1"),
  ]);
  return (
    <main>
      <section className="landing-hero wrap">
        <div className="hero-copy">
          <div className="eyebrow"><span className="live-dot" /> Autonomous engineering, powered by Naïve</div>
          <h1>Change the software.<br /><span>Keep the business moving.</span></h1>
          <p className="lead">Give Goose your existing system and the outcome you need. Our agent team investigates, plans, implements, and independently verifies the change. You approve the scope and receive the working result.</p>
          <div className="row hero-actions">
            <Link href="/start" className="btn primary">Start a job <span aria-hidden="true">↗</span></Link>
            <Link href="/contact" className="btn">Discuss a change</Link>
          </div>
          <p className="small muted hero-note">A clear scope. A fixed price. Evidence before acceptance.</p>
        </div>
        <div className="mission-panel" aria-label="The Goose delivery workflow">
          <div className="mission-head"><span className="mono">GOOSE / COMPANY WORKFLOW</span><span className="mission-indicator">{config.mode === "naive" ? "Naïve mode" : "Local mode"}</span></div>
          <div className="mission-request"><span className="mission-label">The brief</span><p>“Here is our system.<br />Here is what needs to change.”</p></div>
          <div className="mission-chain">
            <div><span className="mission-number">01</span><b>Assessment</b><span>Scope & acceptance</span></div>
            <div><span className="mission-number">02</span><b>Engineering</b><span>Implementation & repair</span></div>
            <div><span className="mission-number">03</span><b>Independent verification</b><span>Behavior, data & evidence</span></div>
          </div>
          <div className="mission-outcome"><span className="mission-check" aria-hidden="true">✓</span><div><b>A result you can inspect</b><span>Software · change report · verification evidence</span></div></div>
          <div className="mission-bottom">Scope and spending are bounded. Failed checks block delivery.</div>
        </div>
      </section>

      <div className="capability-strip"><div className="wrap"><span>One company. Your next technical change.</span><b>Code</b><span aria-hidden="true">/</span><b>Data</b><span aria-hidden="true">/</span><b>Dependencies</b><span aria-hidden="true">/</span><b>Integrations</b></div></div>

      <section className="wrap landing-section" id="capabilities">
        <div className="section-intro"><div><div className="kicker">From an objective to a working result</div><h2>Bring the change your team needs.</h2></div><p className="muted">Goose assesses each request against executable capabilities. Your proposal states exactly what will be delivered and how it will be checked.</p></div>
        <div className="grid g3 capability-grid">
          <article className="capability-card"><span className="capability-symbol" aria-hidden="true">↗</span><h3>Move your stack forward</h3><p>Upgrade supported frameworks and runtimes while preserving the behavior your customers depend on.</p><span className="capability-foot">Framework & dependency upgrades</span></article>
          <article className="capability-card"><span className="capability-symbol" aria-hidden="true">⇄</span><h3>Change how your data works</h3><p>Move supported data stores, evolve schemas, and verify the records, relationships, and new writes.</p><span className="capability-foot">Data migration & continuity</span></article>
          <article className="capability-card"><span className="capability-symbol" aria-hidden="true">⌘</span><h3>Build the replacement</h3><p>Give the agents a target runtime and approved requirements. Receive a working service and independently checked results.</p><span className="capability-foot">Agent-led service replatforming</span></article>
        </div>
        <div className="scope-note"><div><b>A larger system or a different objective?</b><p>Start with an inquiry. We assess the dependencies and verification requirements before committing to a job.</p></div><Link className="btn" href="/contact">Describe your system <span aria-hidden="true">↗</span></Link></div>
      </section>

      <section className="workflow-section"><div className="wrap landing-section">
        <div className="section-intro"><div><div className="kicker">The complete engagement</div><h2>One accountable workflow.</h2></div><p className="muted">Follow decisions, questions, work, and evidence from the first assessment through delivery and support.</p></div>
        <div className="journey-grid">{journey.map(([n, title, text]) => <article key={n}><span className="journey-number">{n}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
      </div></section>

      <section className="wrap landing-section grid g2">
        <div className="proof-copy"><div className="kicker">Evidence is part of the delivery</div><h2>See what changed.<br />See why it passed.</h2><p className="muted">The implementation is checked against requirements agreed before the work begins. Your workspace keeps the proposal, verification attempts, changes, and delivery package together.</p><ul className="proof-list"><li>Acceptance criteria frozen before implementation</li><li>Independent behavior and data checks</li><li>Failed checks, repairs, and interventions on record</li><li>Downloadable software and verification evidence</li></ul>{demo && <Link href={`/jobs/${demo.id}?t=${demo.customer_token}`} className="btn">Inspect a completed demonstration ↗</Link>}</div>
        <div className="card scope-card"><div className="kicker">Current delivery capabilities</div><h3>What we carry out today</h3><p className="small muted">Every job is assessed before a proposal is offered.</p><ul className="capability-list"><li><b>Repository engineering changes</b><span>Executable repositories with a bounded build environment and agreed checks for the requested change.</span></li><li><b>Service migrations</b><span>Supported Python and Node.js JSON services to Rust, Node.js, or Python, with SQLite data contracts.</span></li><li><b>Framework upgrades</b><span>Supported Django and Flask applications, with checks against the original behavior.</span></li><li><b>Database migrations</b><span>Supported Flask and SQLite services to FastAPI and PostgreSQL, with data continuity checks.</span></li></ul><p className="small muted">Additional systems need an executable environment and agreed verification. Production cutovers and external integrations are included only when explicitly supported in the proposal.</p></div>
      </section>

      <section className="wrap"><div className="engagement-band"><div><div className="kicker">Pilot engagements</div><h2>Know the scope before you commit.</h2><p>Assessment comes first. Your proposal includes the fixed price and the checks required for acceptance.</p></div><div className="pilot-price"><span className="small">Code-only pilot starting at</span><strong>${offer.price_code_usd.toLocaleString("en-US")}</strong><span className="small">Final quote follows assessment.</span></div><Link href="/start" className="btn primary">Start a job ↗</Link></div></section>
      <footer className="wrap landing-footer"><span>Goose · Autonomous engineering</span><span>{config.mode === "naive" ? "Configured for live Naïve agents." : "Local mode uses deterministic tools."} Demonstration work and test payments are labelled.</span><Link href="/ops">Company operations ↗</Link></footer>
    </main>
  );
}
