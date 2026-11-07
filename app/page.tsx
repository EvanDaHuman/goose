import Link from "next/link";
import { config } from "@/lib/config";
import { one } from "@/lib/db";
import { pilotOffer } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export default async function Home() {
  const offer = await pilotOffer();
  const demo = await one<{ id: string; customer_token: string }>(
    "SELECT id, customer_token FROM jobs WHERE kind = 'demo' AND status = 'done' AND pipeline >= 2 ORDER BY created_at LIMIT 1");
  return (
    <main className="wrap">
      <section className="hero">
        <div className="kicker">Goose</div>
        <h1>An AI team that plans and delivers upgrades to your business software.</h1>
        <p className="lead">
          Tell us what you want to improve and send us the application. We inspect it first, then propose a plan that fits it:
          what to change, what to keep, and how we will prove nothing you rely on breaks. You pay a fixed price, only after the
          agreed checks pass and you accept the delivery.
        </p>
        <div className="row" style={{ marginTop: 18 }}>
          <Link href="/start" className="btn primary">Start a job</Link>
          {demo && <Link href={`/jobs/${demo.id}?t=${demo.customer_token}`} className="btn">See a finished demonstration job</Link>}
        </div>
      </section>

      <section className="section grid g2">
        <div className="card">
          <h3>What you provide</h3>
          <ul>
            <li>Your application or repository, as a .zip.</li>
            <li>What you want to improve, in your own words.</li>
            <li>Your constraints: what must not change, what must keep working.</li>
            <li>Optional: documentation, and a copy of the data when the work needs it. We say when it does.</li>
          </ul>
        </div>
        <div className="card">
          <h3>Goals customers bring</h3>
          <ul>
            <li>"Update this application while keeping its current behaviour."</li>
            <li>"Move the database without changing the customer-facing app."</li>
            <li>"Replace this old service while preserving its existing connections."</li>
            <li>"Fix these maintenance problems and prepare the application for future development."</li>
          </ul>
        </div>
      </section>

      <section className="section">
        <h2>How it works</h2>
        <div className="grid g3" style={{ marginTop: 12 }}>
          {[
            ["1. Inspect", "We map your application: entry points, code, data, and the outside systems that depend on it. Every finding points at a file and line, or at your data."],
            ["2. Plan", "We compare the ways to reach your goal, recommend one and say why, list what we keep, and ask only the questions that change the plan."],
            ["3. Agree", "You get the plan, a fixed price, the intended differences in behaviour (if any), and the checks the result must pass."],
            ["4. Record and freeze", "Before any change we record how your current app behaves and lock the checks, so nobody doing the work can weaken them."],
            ["5. Change and verify", "The changes are made on copies. A separate verifier compares old and new; a failed check goes back for repair or to a person."],
            ["6. Deliver", "You get the upgraded app, every changed line, the verification report, a run book and a rollback guide."],
          ].map(([t, d]) => (
            <div className="card" key={t}><h3>{t}</h3><p className="muted" style={{ margin: 0 }}>{d}</p></div>
          ))}
        </div>
      </section>

      <section className="section grid g2">
        <div className="card">
          <h3>What we carry out today</h3>
          <ul>
            <li><b>Django</b> to the supported 5.2 LTS release on Python 3.13, keeping your database, pages and integrations.</li>
            <li><b>Flask</b> to current releases on Python 3.13, keeping your code and SQLite data.</li>
            <li><b>Flask + SQLite JSON services</b> replaced with FastAPI on PostgreSQL, data moved and checked row by row.</li>
            <li><b>Target-driven service rewrites</b> to Rust, Node.js or Python through the live Naive team, with a reviewed SQLite data contract, preserved API checks and new-write verification.</li>
          </ul>
          <p className="muted small">Each target needs an executable runtime adapter and a repeatable acceptance contract. Unsupported stacks, production cutovers and integrations outside that contract require additional work. If we cannot execute and verify the requested scope, the plan blocks delivery.</p>
        </div>
        <div className="card">
          <h3>Pilot prices (an experiment)</h3>
          <table className="small"><tbody>
            <tr><td>Code only (for example a framework upgrade)</td><td className="num"><b>${offer.price_code_usd.toLocaleString("en-US")}</b></td></tr>
            <tr><td>Data move</td><td className="num"><b>${offer.price_data_usd.toLocaleString("en-US")}</b></td></tr>
            <tr><td>Code and data together</td><td className="num"><b>${offer.price_usd.toLocaleString("en-US")}</b></td></tr>
          </tbody></table>
          <p className="muted small">Fixed per job, adjusted for size; invoiced only after the agreed checks pass and you accept. These are prices we are testing, not published rates.</p>
        </div>
      </section>

      <section className="section card">
        <h3>What our checks can and cannot prove</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          The same requests go to your old and new application on separate copies of the data, every row is compared, your own tests
          run, and the scripts that use your database run again. That is strong evidence, not a guarantee: passing the checks does not
          prove every possible behaviour is correct. Each report lists exactly what was tested and what was not.
        </p>
      </section>

      <p className="footer">Goose is a hackathon prototype{config.mode === "local" ? ", running in local mode: plans and changes come from deterministic tools, not AI agents, until Naive is connected" : ""}.
        Demonstration jobs use made-up businesses and synthetic data, and are labelled.</p>
    </main>
  );
}
