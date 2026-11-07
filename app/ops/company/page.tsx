import Link from "next/link";
import { ActionButton, OpsNumberAction } from "@/components/client";
import { dollars, KindTag, usd, when } from "@/components/ui";
import { config } from "@/lib/config";
import { growthSettings, growthSpentToday } from "@/lib/growth";
import { getSetting, pilotOffer } from "@/lib/jobs";
import { companyView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function Company() {
  const v = await companyView();
  const offer = await pilotOffer();
  const growth = await growthSettings();
  const spentToday = await growthSpentToday();
  const lastRun = await getSetting<any>("growth_last_run", null);
  const agentFound = v.prospects.filter((p: any) => p.found_by === "research agent").length;
  const realAccounts = v.accounts.find((a: any) => a.kind === "real")?.n ?? 0;
  const realBookings = v.bookings.filter((b: any) => b.kind === "real");
  const testBookings = v.bookings.filter((b: any) => b.kind === "demo");
  const realInvoices = v.invoices.filter((i: any) => !i.is_test);
  const collected = v.payments.filter((p: any) => !p.is_test).reduce((n: number, p: any) => n + p.amount_cents, 0);
  const testCollected = v.payments.filter((p: any) => p.is_test).reduce((n: number, p: any) => n + p.amount_cents, 0);
  const minutes = v.interventions.reduce((n: number, i: any) => n + (i.minutes ?? 0), 0);
  const cost = v.costByBasis.reduce((n: number, c: any) => n + Number(c.micro), 0);
  return (
    <main className="wrap">
      <h1>Company</h1>
      <div className="banner warn"><b>No real customer yet</b><span>{realAccounts} real customer accounts, {realBookings.length} real bookings, {dollars(collected)} collected.
        Everything else on this page comes from demonstration jobs with synthetic data and is labelled as test.</span></div>

      <section className="section grid g4">
        <div className="card tight"><div className="stat-label">Bookings (real)</div><div className="stat">{dollars(realBookings.reduce((n: number, b: any) => n + b.price_cents, 0))}</div>
          <div className="small muted">{realBookings.length} accepted proposals</div></div>
        <div className="card tight"><div className="stat-label">Invoiced (real)</div><div className="stat">{dollars(realInvoices.reduce((n: number, i: any) => n + i.amount_cents, 0))}</div>
          <div className="small muted">{realInvoices.length} invoices</div></div>
        <div className="card tight"><div className="stat-label">Collected (real)</div><div className="stat">{dollars(collected)}</div>
          <div className="small muted">money actually received</div></div>
        <div className="card tight"><div className="stat-label">Test payments (no money moved)</div><div className="stat">{dollars(testCollected)}</div>
          <div className="small muted">from {testBookings.length} demonstration bookings</div></div>
      </section>

      <section className="section grid g2" style={{ alignItems: "start" }}>
        <div className="card">
          <h3>Bookings and invoices</h3>
          <table><thead><tr><th>Job</th><th>Invoice</th><th className="num">Amount</th><th>Status</th></tr></thead><tbody>
            {v.bookings.map((b: any) => {
              const inv = v.invoices.find((i: any) => i.job_id === b.job_id);
              return (<tr key={b.job_id}><td><Link href={`/ops/jobs/${b.job_id}`}>{b.job_id}</Link> <KindTag kind={b.kind} /><div className="small muted">{b.title}</div></td>
                <td className="small">{inv ? inv.number : "not yet (after delivery acceptance)"}{inv?.is_test && <div><span className="tag test">test</span></div>}</td>
                <td className="num">{dollars(b.price_cents)}</td><td className="small">{inv ? inv.status : "booked"}</td></tr>);
            })}
            {v.bookings.length === 0 && <tr><td colSpan={4} className="muted small">No accepted proposals yet.</td></tr>}
          </tbody></table>
          <h3 className="section">Payments</h3>
          <table><tbody>{v.payments.map((p: any) => (
            <tr key={p.id}><td className="small">{p.number}</td><td className="num">{dollars(p.amount_cents)}</td>
              <td>{p.is_test ? <span className="tag test">test payment - no money moved</span> : <span className="tag real">received</span>}</td></tr>))}
            {v.payments.length === 0 && <tr><td className="muted small">None.</td></tr>}</tbody></table>
        </div>
        <div className="card">
          <h3>Direct costs and founder time</h3>
          <table><tbody>
            {v.costByBasis.map((c: any) => <tr key={c.basis + c.kind}><td className="small">{c.kind} · {c.basis === "estimate_naive_rate" ? "estimate at Naive computer rate (local, not billed)" : c.basis === "naive_metered" ? "metered by Naive" : c.basis}</td>
              <td className="num small">{c.n} entries</td><td className="num">{usd(c.micro)}</td></tr>)}
            <tr><td><b>All recorded costs, including failed attempts</b></td><td /><td className="num"><b>{usd(cost)}</b></td></tr>
            <tr><td><b>Founder interventions</b></td><td className="num small">{v.interventions.length}</td><td className="num"><b>{minutes} min</b></td></tr>
          </tbody></table>
          <h3 className="section">Pilot offer (an experiment)</h3>
          <p className="small muted">New proposals price each plan by its kind of work, plus size. The prices test willingness to pay; they are not validated market rates.</p>
          <div className="stack-sm small">
            <div className="row between"><span>Code only (USD)</span><OpsNumberAction url="/api/ops/settings" field="price_code_usd" label="Save" initial={offer.price_code_usd} /></div>
            <div className="row between"><span>Data move (USD)</span><OpsNumberAction url="/api/ops/settings" field="price_data_usd" label="Save" initial={offer.price_data_usd} /></div>
            <div className="row between"><span>Code and data (USD)</span><OpsNumberAction url="/api/ops/settings" field="price_usd" label="Save" initial={offer.price_usd} /></div>
            <div className="row between"><span>Spending limit per job (USD)</span><OpsNumberAction url="/api/ops/settings" field="cost_limit_usd" label="Save" initial={offer.cost_limit_usd} /></div>
            <div className="row between"><span>Repair attempts per job</span><OpsNumberAction url="/api/ops/settings" field="repair_budget" label="Save" initial={offer.repair_budget} /></div>
          </div>
        </div>
      </section>

      <section className="section card">
        <div className="card-head"><h2>Growth agents</h2>
          <ActionButton url="/api/ops/growth" body={{}} label="Run a growth cycle now" /></div>
        <p className="small muted">The research agent finds organisations with outdated software from public sources, the qualification agent scores
          each one against what Goose can carry out today, and the outreach agent writes a draft. Every result passes a guard first; drafts are stored
          here and nothing is sent. {config.mode === "naive" ? "Live agents on Naive." : "Local mode: research needs the live agents; qualification and drafts use local rules."}</p>
        <div className="grid g4" style={{ marginTop: 8 }}>
          <div className="card tight"><div className="stat-label">Schedule</div><div className="stat">{growth.enabled ? `every ${growth.every_hours} h` : "off"}</div>
            <div className="small muted">up to {growth.research_per_cycle} new prospects per cycle</div></div>
          <div className="card tight"><div className="stat-label">Spent in the last 24 h</div><div className="stat">{usd(spentToday)}</div>
            <div className="small muted">daily limit ${growth.daily_limit_usd}</div></div>
          <div className="card tight"><div className="stat-label">Last cycle</div><div className="stat">{lastRun?.at ? when(lastRun.at) : "never"}</div>
            <div className="small muted">{lastRun?.at ? `${lastRun.found} found · ${lastRun.qualified} qualified · ${lastRun.drafted} drafted (${lastRun.mode})` : "the worker starts one when it runs"}</div></div>
          <div className="card tight"><div className="stat-label">Found by the research agent</div><div className="stat">{agentFound}</div>
            <div className="small muted">of {v.prospects.length} prospects</div></div>
        </div>
      </section>

      <section className="section card">
        <div className="card-head"><h2>Prospects</h2><span className="small muted">From public sources only. Nobody has been contacted.</span></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Prospect</th><th>Signal of need</th><th>Fit with today's scope</th><th>Status</th></tr></thead>
          <tbody>{v.prospects.map((p: any) => (
            <tr key={p.id}>
              <td style={{ minWidth: 180 }}><a href={p.url} target="_blank"><b>{p.name}</b></a><div className="small muted">{p.category === "a" ? "Open-source app" : p.category === "b" ? "Agency (partner channel)" : "Organisation with an internal tool"}</div>
                <span className={`pill ${p.fit_score === "High" ? "ok" : p.fit_score === "Medium" ? "warn" : "neutral"}`}>{p.fit_score ?? "Not yet qualified"}{p.fit_score ? " fit" : ""}</span>
                <div className="small muted" style={{ marginTop: 4 }}>Found by {p.found_by}{p.qualified_by ? ` · scored by ${p.qualified_by}` : ""}{p.drafted_by ? ` · drafted by ${p.drafted_by}` : ""}</div></td>
              <td className="small">{p.summary}<ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(p.evidence ?? []).slice(0, 2).map((e: any, i: number) => <li key={i}><a href={e.url} target="_blank">{e.text}</a></li>)}</ul></td>
              <td className="small">{p.notes && <div style={{ marginBottom: 6 }}><span className="pill bad">{p.notes}</span></div>}
                {p.qualification?.recipe && p.qualification.recipe !== "none" && <div><code>{p.qualification.recipe}</code></div>}
                {p.scope_fit}{(p.blockers ?? []).length > 0 && <div className="muted">Blockers: {(p.blockers ?? []).slice(0, 3).join("; ")}</div>}</td>
              <td className="small">{p.status === "draft_ready" ? <details><summary>Draft ready - not sent</summary><pre style={{ whiteSpace: "pre-wrap" }}>{p.outreach_draft}</pre></details>
                : <ActionButton url={`/api/ops/prospects/${p.id}/draft`} body={{}} label="Draft outreach" />}</td>
            </tr>))}</tbody>
        </table></div>
        <p className="small muted" style={{ marginTop: 8 }}>The founder's first research, with sources: <code>docs/research/prospects.md</code>. Sending any message needs the founder; nothing is sent automatically.</p>
      </section>

      <section className="section card">
        <h3>Follow-ups</h3>
        <table><tbody>{v.followups.map((f: any) => (
          <tr key={f.id}><td className="small">{f.title}<div className="muted">{f.kind.replaceAll("_", " ")} · due {when(f.due_at)}</div></td>
            <td className="small muted">{f.draft}</td><td className="small">{f.status} (draft, not sent)</td></tr>))}
          {v.followups.length === 0 && <tr><td className="muted small">None scheduled.</td></tr>}</tbody></table>
      </section>
    </main>
  );
}
