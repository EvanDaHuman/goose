import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { isOperatorRequest } from "@/lib/operatorAuth";
import { TryPanel } from "@/components/TryPanel";
import { CodeDiff } from "@/components/CodeDiff";
import { KindTag, when } from "@/components/ui";
import { sourceFile, resultView } from "@/lib/views";

export const dynamic = "force-dynamic";

const AREA_ORDER = ["records", "relationships", "same_name", "money", "stock", "retries", "dates_statuses", "read_update",
  "migration_retry", "app_starts", "compatibility"];

export default async function Result({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string; ops?: string }> }) {
  const { id } = await params;
  const { t, ops } = await searchParams;
  if(ops==="1"&&!isOperatorRequest(new Request("http://goose.internal",{headers:await headers()})))notFound();
  const v = await resultView(id);
  if (!v || (v.job.customer_token !== t && ops !== "1")) notFound();
  const { job, assessment: a, scope, report, runs, repairs, moved } = v;
  if (!a || !report) {
    return <main className="wrap"><h1>{job.title}</h1><p className="muted">The result screen appears once verification has run.</p></main>;
  }
  const s = report.summary;
  const pins = a.app.pins ?? {};
  const roles = scope?.roles ?? {};
  const findings = a.findings.filter((f: any) => f.severity === "high" || f.severity === "medium");
  const faultRun = repairs.length > 0;
  const testFault = job.test_fault;
  const byCat = report.by_category;
  const cancelRoute = a.routes.find((r: any) => r.kind === "cancel_order");
  const placeRoute = a.routes.find((r: any) => r.kind === "place_order");
  const listProducts = a.routes.find((r: any) => r.kind === "list" && r.kind_info?.table === roles.product);
  const getProduct = a.routes.find((r: any) => r.kind === "get" && r.kind_info?.table === roles.product && r.path_params.length === 1);
  const origSrc = cancelRoute ? sourceFile(id, "original", cancelRoute.module) : null;
  const pay = roles.order_payload ?? {};
  const tryCfg = {
    listProducts: listProducts ? { method: "GET", path: listProducts.path } : undefined,
    getProduct: getProduct ? { method: "GET", path: getProduct.path } : undefined,
    placeOrder: placeRoute ? { method: "POST", path: placeRoute.path } : undefined,
    cancelOrder: cancelRoute ? { method: "POST", path: cancelRoute.path } : undefined,
    customerKey: pay.keys?.find((k: string) => k !== pay.list_key) ?? "customer_id", listKey: pay.list_key ?? "items",
    productKey: pay.item_keys?.find((k: string) => !/qty|quant/.test(k)) ?? "product_id",
    qtyKey: pay.item_keys?.find((k: string) => /qty|quant/.test(k)) ?? "quantity", stockKey: roles.stock_column ?? "stock", customerId: 1,
  };
  return (
    <main className="wrap">
      <div className="row between">
        <div>
          <div className="kicker">{v.job.account_name} · {job.id} · result</div>
          <h1 style={{ marginBottom: 6 }}>{job.title}: upgraded and verified</h1>
          <div className="row"><KindTag kind={job.kind} />
            {job.mode === "local" && <span className="tag mode">Local mode · no AI model calls</span>}
            <span className="muted small">Verified {when(runs[runs.length - 1]?.created_at)}</span></div>
        </div>
        <Link className="btn" href={ops === "1" ? `/ops/jobs/${id}` : `/jobs/${id}?t=${t}`}>Back to the job</Link>
      </div>

      <div className={`banner ${s.verdict === "pass" ? "ok" : "bad"} section`}>
        <b>{s.verdict === "pass" ? "All agreed checks passed" : "Checks failed - delivery blocked"}</b>
        <span>{s.passed} of {s.total} checks passed on attempt {report.attempt}.{" "}
          {faultRun && `Attempt 1 failed ${runs[0]?.failed} checks${testFault ? " because of a labelled TEST FAULT the founder injected" : ""}; the repair fixed it.`}{" "}
          Frozen checks verified unchanged (integrity {report.integrity.ok ? "confirmed" : "FAILED"}).</span>
      </div>

      <h2 className="section">1. Here is the old application. Here is the upgraded application.</h2>
      <div className="versus" style={{ marginTop: 10 }}>
        <div className="card">
          <div className="kicker">Before</div>
          <h3>Flask {pins.flask ?? "?"} + SQLite</h3>
          <table><tbody>
            <tr><td>Python</td><td>{a.app.python_version ?? "not stated"}{a.app.python_version === "3.9" ? " (past end of life)" : ""}</td></tr>
            <tr><td>Libraries</td><td>{Object.entries(pins).map(([k, ver]) => `${k} ${ver}`).join(", ") || "-"}</td></tr>
            <tr><td>Code</td><td>{a.size.python_lines} lines in {a.size.modules} file(s), {a.size.routes} endpoints, SQL in {a.size.sql_sites} places</td></tr>
            <tr><td>Data</td><td>SQLite file, {a.size.tables} tables, {a.size.rows.toLocaleString("en-US")} rows, money as binary floats</td></tr>
            <tr><td>Tests</td><td>{a.app.test_functions} test functions</td></tr>
          </tbody></table>
          <p className="small muted" style={{ marginTop: 10, marginBottom: 4 }}>Main problems found</p>
          <ul className="small" style={{ margin: 0 }}>{findings.slice(0, 6).map((f: any) => <li key={f.id}>{f.title}</li>)}</ul>
        </div>
        <div className="arrow">&rarr;</div>
        <div className="card">
          <div className="kicker">After</div>
          <h3>FastAPI 0.162 + PostgreSQL 17</h3>
          <table><tbody>
            <tr><td>Python</td><td>3.13 (maintained)</td></tr>
            <tr><td>Libraries</td><td>fastapi 0.162.0, uvicorn 0.54.0, psycopg 3.3.7, psycopg-pool 3.3.3 (all pinned)</td></tr>
            <tr><td>Code</td><td>{v.codeLines.toLocaleString("en-US")} lines in {v.codeFiles.length} files; the same {a.size.routes} endpoints, plus /healthz and API docs at /docs</td></tr>
            <tr><td>Data</td><td>PostgreSQL with enforced links, exact NUMERIC money, time-zone-aware timestamps</td></tr>
            <tr><td>Tests</td><td>Generated unit tests for the business rules, run on delivery</td></tr>
          </tbody></table>
          <p className="small muted" style={{ marginTop: 10, marginBottom: 4 }}>Agreed changes made</p>
          <ul className="small" style={{ margin: 0 }}>{(scope?.changes ?? []).slice(0, 7).map((c: any) => <li key={c.id}>{c.title}</li>)}</ul>
        </div>
      </div>
      {origSrc && cancelRoute && <CodeDiff jobId={id} attempt={job.attempt} module={cancelRoute.module} fn={cancelRoute.function}
        title={`One handler, before and after: ${cancelRoute.methods[0]} ${cancelRoute.path}`} />}

      <h2 className="section">2. Here is what moved.</h2>
      <div className="card" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Table</th><th className="num">Rows in SQLite</th><th className="num">Rows in PostgreSQL</th><th>Every field matches</th><th>Notes</th></tr></thead>
          <tbody>{moved.map((m) => (
            <tr key={m.table}><td><code>{m.table}</code></td><td className="num">{m.before.toLocaleString("en-US")}</td>
              <td className="num">{m.after.toLocaleString("en-US")}</td>
              <td>{m.fieldsOk === null ? "-" : m.fieldsOk ? <span className="pill ok">Yes</span> : <span className="pill bad">No</span>}</td>
              <td className="muted small">{m.note ?? ""}</td></tr>))}</tbody>
        </table>
        <hr className="sep" />
        <div className="grid g2 small">
          <div><b>Converted exactly</b><ul style={{ marginBottom: 0 }}>
            <li>{scope.money_columns.length} money columns to exact cents: {scope.money_columns.map((c: string) => <code key={c}>{c} </code>)}</li>
            <li>{scope.timestamp_columns.length} text timestamps to time-zone-aware values in {scope.timezone}</li>
          </ul></div>
          <div><b>Data decisions applied (agreed in the proposal)</b><ul style={{ marginBottom: 0 }}>
            {Object.entries(scope.status_mappings).map(([col, mp]: any) => <li key={col}><code>{col}</code>: {Object.entries(mp).map(([x, y]) => `'${x}' becomes '${y}'`).join(", ")}</li>)}
            {scope.orphan_decisions.map((o: any) => <li key={o.question}>Lines pointing at deleted {o.references} {JSON.stringify(o.missing_ids)}: {o.decision.replace("_", " ")}</li>)}
            {a.ambiguous_times.length > 0 && <li>{a.ambiguous_times.length} times inside the repeated daylight-saving hour read as {scope.ambiguous_time_rule === "later" ? "standard time" : "daylight time"}</li>}
          </ul></div>
        </div>
      </div>

      <h2 className="section">3. Here are the checks that passed.</h2>
      <div className="grid g2" style={{ marginTop: 10, alignItems: "start" }}>
        <div className="card">
          <div className="row between"><div className="stat">{s.passed} / {s.total}</div><span className={`pill ${s.verdict === "pass" ? "ok" : "bad"}`}>{s.verdict === "pass" ? "Passed" : "Failed"}</span></div>
          <div className="bar" style={{ margin: "8px 0 14px" }}><span style={{ width: `${(100 * s.passed) / Math.max(1, s.total)}%` }} /></div>
          <ul className="checklist">
            {AREA_ORDER.filter((k) => byCat[k]).map((k) => (
              <li key={k}><span className={`mark ${byCat[k].fail ? "bad" : "ok"}`}>{byCat[k].fail ? "✕" : "✓"}</span>
                <span style={{ flex: 1 }}>{byCat[k].title}</span><span className="muted small">{byCat[k].pass} passed{byCat[k].fail ? `, ${byCat[k].fail} failed` : ""}</span></li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>How we got here</h3>
          <ul className="checklist">
            {runs.map((r: any, i: number) => (
              <li key={r.attempt}><span className={`mark ${r.verdict === "pass" ? "ok" : "bad"}`}>{r.verdict === "pass" ? "✓" : "✕"}</span>
                <span>Attempt {r.attempt}: {r.passed} of {r.total} passed{r.verdict === "fail" ? ` - ${r.failed} failed, delivery blocked` : ""}.
                  {repairs[i] && <span className="muted"> Repair: {repairs[i].diagnoses.map((d: any) => d.explanation).join(" ")}</span>}
                  {i === 0 && testFault && r.verdict === "fail" && <> <span className="tag test">Test fault</span> <span className="muted small">injected by the founder to demonstrate recovery</span></>}
                </span></li>
            ))}
          </ul>
          <p className="small muted" style={{ marginTop: 10 }}>Checks were frozen on {when(report.frozen_manifest.frozen_at)}, before any code was changed.
            The code that made the upgrade could not read them, and their hashes were checked before every run.</p>
          <details><summary>Every check ({s.total})</summary>
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto", marginTop: 8 }}>
              <table><tbody>{report.results.map((r: any) => (
                <tr key={r.id}><td><span className={`mark ${r.status === "pass" ? "ok" : r.status === "skip" ? "warn" : "bad"}`}>{r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✕"}</span></td>
                  <td className="small">{r.title}</td></tr>))}</tbody></table>
            </div>
          </details>
        </div>
      </div>

      <h2 className="section">4. Here is what still needs attention.</h2>
      <div className="grid g2" style={{ marginTop: 10, alignItems: "start" }}>
        <div className="card">
          <h3>Agreed differences to know about</h3>
          <ul className="small">{scope.intentional_differences.map((d: any) => <li key={d.id}><b>{d.title}.</b> <span className="muted">{d.detail}</span></li>)}</ul>
        </div>
        <div className="card">
          <h3>Not tested</h3>
          <ul className="small">{report.not_tested.map((n: string) => <li key={n}>{n}</li>)}
            {report.coverage.notes.map((n: string) => <li key={n}>{n}</li>)}
            {report.coverage.uncovered_routes.map((n: string) => <li key={n}>Endpoint not exercised: <code>{n}</code></li>)}</ul>
          <h3>Your next steps</h3>
          <ol className="small" style={{ marginBottom: 0 }}><li>Rehearse the switch-over with RUNBOOK.md on a copy.</li>
            <li>Keep the old app and SQLite file read-only for 30 days (ROLLBACK.md).</li>
            <li>Point the shop front-end and warehouse scripts at the new address; paths and JSON are unchanged.</li></ol>
        </div>
      </div>

      <h2 className="section">Try the upgraded app</h2>
      <div className="card" style={{ marginTop: 10 }}>
        {v.showroom?.status === "running" ? (
          <>
            <p className="small muted">A copy of the delivered app is running on its own migrated database (sandboxed, port {v.showroom.port}).
              Interactive API docs: <a href={`http://127.0.0.1:${v.showroom.port}/docs`} target="_blank">127.0.0.1:{v.showroom.port}/docs</a></p>
            <TryPanel jobId={id} cfg={tryCfg} token={t} ops={ops==="1"} />
          </>
        ) : <p className="muted small" style={{ margin: 0 }}>Not running right now. {ops === "1" ? "Start it from the operator view." : "Ask us for a live walkthrough."}</p>}
      </div>
    </main>
  );
}
