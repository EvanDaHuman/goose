"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin",
  "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney", "UTC"];

const EXAMPLES = ["Update this application while keeping its current behaviour.", "Move the database without changing the customer-facing app.",
  "Migrate this service to Rust. Preserve existing records and API behaviour, and verify new writes.", "Fix these maintenance problems and prepare the application for future development."];
const CONSTRAINTS: [string, string][] = [["keep_framework", "Keep the current web framework"], ["keep_database", "Keep the current database"],
  ["keep_api", "Pages and API responses must not change"], ["keep_connections", "Existing connections (clients, scripts) must keep working"],
  ["no_data", "Our data cannot be shared"]];

export function StartForm() {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <form className="card stack-sm" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setErr(null);
      const r = await fetch("/api/jobs", { method: "POST", body: new FormData(e.currentTarget) });
      const j = await r.json().catch(() => ({}));
      setBusy(false);
      if (!r.ok) { setErr(j.error ?? "Could not create the job"); return; }
      router.push(`/jobs/${j.id}?t=${j.t}`);
    }}>
      <h3>Your application</h3>
      <div className="grid g2">
        <div className="field"><label htmlFor="f-business">Business name</label><input id="f-business" type="text" name="business" required /></div>
        <div className="field"><label htmlFor="f-title">Application name</label><input id="f-title" type="text" name="title" placeholder="e.g. Order service" required /></div>
        <div className="field"><label htmlFor="f-contact">Your name</label><input id="f-contact" type="text" name="contact" autoComplete="name" required /></div>
        <div className="field"><label htmlFor="f-email">Email</label><input id="f-email" type="email" name="email" autoComplete="email" required /></div>
      </div>
      <div className="field"><label htmlFor="f-tz">Business time zone (how the app's dates should be read)</label>
        <select id="f-tz" name="timezone" defaultValue="America/Chicago">{ZONES.map((z) => <option key={z}>{z}</option>)}</select></div>
      <h3 className="section">What you want</h3>
      <div className="field"><label htmlFor="f-goal">Your goal, in your own words</label>
        <textarea id="f-goal" name="goal" rows={3} required value={goal} onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Update this application while keeping its current behaviour." /></div>
      <div className="row" style={{ gap: 6 }}>{EXAMPLES.map((x) => (
        <button key={x} type="button" className="btn small" onClick={() => setGoal(x)}>{x}</button>))}</div>
      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="field"><label htmlFor="f-target">Target runtime (optional)</label>
          <select id="f-target" name="target_runtime" defaultValue="">
            <option value="">Let the goal and inspection guide the plan</option>
            <option value="rust">Rust</option><option value="node">Node.js</option><option value="python">Python</option>
          </select><span className="small muted">Rewrites use the live Naive team. The plan must pass capability and data checks before work begins.</span></div>
        <div className="field"><label htmlFor="f-data-changes">Requested data changes (optional)</label>
          <textarea id="f-data-changes" name="data_changes" rows={3} placeholder="Add a customer tier defaulting to standard for existing customers. Allow new customers to choose a tier. Keep their history and relationships." />
          <span className="small muted">Describe new fields, defaults, renamed fields, new tables or records to add. You review the exact transformations in the proposal.</span></div>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: "8px 0 0" }}>
        <legend className="small">Constraints (tick what applies)</legend>
        {CONSTRAINTS.map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" name="constraints" value={k} /><span>{label}</span></label>))}
      </fieldset>
      <div className="field"><label htmlFor="f-notes">Anything else we should know (optional)</label>
        <textarea id="f-notes" name="notes" rows={2} placeholder="e.g. A kiosk reads /api/slots.json every minute; we cannot have downtime on Mondays." /></div>
      <h3 className="section">Files</h3>
      <div className="grid g2">
        <div className="field"><label htmlFor="f-repo">Application or repository (.zip, up to 150 MB)</label><input id="f-repo" type="file" name="repository" accept=".zip" required /></div>
        <div className="field"><label htmlFor="f-db">Copy of the data (SQLite file or MySQL dump, optional)</label><input id="f-db" type="file" name="database" />
          <span className="small muted">Needed only when the work moves data or needs your records to test against; the plan will say.</span></div>
        <div className="field"><label htmlFor="f-docs">Documentation (optional, up to 5 files)</label><input id="f-docs" type="file" name="documents" multiple /></div>
      </div>
      <label className="check"><input type="checkbox" name="demo" /><span>This is a test with a made-up business and synthetic data
        (the job is labelled as a demonstration everywhere, and nothing is invoiced).</span></label>
      <label className="check"><input type="checkbox" name="authorized" onChange={(e) => setOk(e.target.checked)} />
        <span>I own this application and its data, or I am authorized to share them for this assessment. I understand Goose
          works on copies and will not change my live systems.</span></label>
      <div className="row">
        <button className="btn primary" disabled={busy || !ok}>{busy ? "Uploading..." : "Send for inspection and a plan"}</button>
        {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
      </div>
    </form>
  );
}
