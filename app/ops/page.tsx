import Link from "next/link";
import { AutoRefresh } from "@/components/client";
import { JobStatus, KindTag, ModeBanner, ROLE_NAMES, usd, when } from "@/components/ui";
import { config } from "@/lib/config";
import { opsStageLabel } from "@/lib/jobs";
import { opsOverview } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function Ops() {
  const { jobs, totals } = await opsOverview();
  const anyRunning = jobs.some((j: any) => j.status === "running");
  return (
    <main className="wrap">
      <AutoRefresh active={anyRunning} seconds={3} />
      <div className="row between"><h1>Operator</h1><span className="small muted">Operator view (local prototype, no login)</span></div>
      <ModeBanner mode={config.mode} />
      <div className="grid g4 section">
        <div className="card tight"><div className="stat">{totals.running}</div><div className="stat-label">jobs the agents are working on</div></div>
        <div className="card tight"><div className="stat">{totals.customer}</div><div className="stat-label">waiting for a customer</div></div>
        <div className="card tight"><div className="stat" style={{ color: totals.founder ? "var(--warn)" : undefined }}>{totals.founder}</div><div className="stat-label">waiting for the founder</div></div>
        <div className="card tight"><div className="stat">{totals.interventions}</div><div className="stat-label">founder interventions ({totals.founder_minutes} min logged)</div></div>
      </div>
      <div className="card section">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Customer</th><th>Stage</th><th>Responsible</th><th>Status</th><th>Checks</th><th className="num">Spend / limit</th><th>Flags</th></tr></thead>
            <tbody>
              {jobs.map((j: any) => (
                <tr key={j.id}>
                  <td><Link href={`/ops/jobs/${j.id}`}><b>{j.id}</b></Link><div className="small muted">{j.title}</div></td>
                  <td>{j.account_name}<div><KindTag kind={j.kind} /></div></td>
                  <td>{opsStageLabel(j.stage)}{j.attempt > 1 ? <div className="small muted">attempt {j.attempt}</div> : null}</td>
                  <td className="small">{ROLE_NAMES[j.responsible]}</td>
                  <td><JobStatus status={j.status} stage={j.stage} />{j.waiting_reason && <div className="small muted" style={{ maxWidth: 260 }}>{j.waiting_reason}</div>}</td>
                  <td className="small">{j.run ? `${j.run.passed}/${j.run.total}${j.run.verdict === "fail" ? " failed" : ""}` : "-"}</td>
                  <td className="num small">{usd(j.spent)}<div className="muted">of {usd(j.cost_limit_micro_usd, 2)}</div></td>
                  <td className="small">
                    {j.test_fault && <span className="tag test">test fault</span>} {j.repairs > 0 && <span className="pill warn">{j.repairs} repair</span>}{" "}
                    {j.open_questions > 0 && <span className="pill info">{j.open_questions} question</span>}
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && <tr><td colSpan={8} className="muted">No jobs yet. Start one from <Link href="/start">Start a job</Link> or run <code>npm run demo</code>.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">Updated {when(new Date())}. Total recorded spend across all jobs: {usd(totals.spent)} ({config.mode === "local" ? "estimates at Naive's published computer rate; nothing billed" : "metered by Naive"}).</p>
    </main>
  );
}
