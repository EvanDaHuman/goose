"use client";

import Link from "next/link";
import { useState } from "react";

export function InquiryForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ id: number | string; message: string; startUrl?: string } | null>(null);
  return <form className="card stack-sm" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError("");
    const form = e.currentTarget;
    const data = new FormData(form);
    try {
      const response = await fetch("/api/commerce/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        name: data.get("name"), email: data.get("email"), organization: data.get("organization"), goal: data.get("goal"), repositoryUrl: data.get("repositoryUrl") || undefined, isTest: data.get("isTest") === "on",
      }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Your inquiry could not be submitted.");
      setResult(json); form.reset();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>
    <h2>Tell us what needs to change.</h2><p className="small muted">Share the objective, the current system, and anything the result must preserve.</p>
    {result ? <div className="stack" role="status"><div className="form-message"><b>Inquiry received · #{result.id}</b><p style={{ margin: "6px 0 0" }}>{result.message || "Your inquiry is now in the Goose assessment queue."}</p></div><p className="small muted">If your source is ready, you can submit it for an executable assessment.</p><div className="row"><Link className="btn primary" href={result.startUrl || "/start"}>Start a job ↗</Link><button type="button" className="btn" onClick={() => setResult(null)}>Send another inquiry</button></div></div> : <>
      <div className="grid g2"><div className="field"><label htmlFor="inquiry-name">Your name</label><input id="inquiry-name" name="name" type="text" autoComplete="name" maxLength={160} required /></div><div className="field"><label htmlFor="inquiry-email">Work email</label><input id="inquiry-email" name="email" type="email" autoComplete="email" maxLength={254} required /></div></div>
      <div className="field"><label htmlFor="inquiry-org">Organization</label><input id="inquiry-org" name="organization" type="text" autoComplete="organization" maxLength={200} required /></div>
      <div className="field"><label htmlFor="inquiry-goal">What outcome do you need?</label><textarea id="inquiry-goal" name="goal" minLength={20} maxLength={10000} rows={6} required placeholder="We need to move an existing service to a new runtime while preserving its integrations and data. Our deadline is..." /></div>
      <div className="field"><label htmlFor="inquiry-repo">Public repository URL (optional)</label><input id="inquiry-repo" name="repositoryUrl" type="url" placeholder="https://github.com/your-org/your-project" maxLength={2000} /><span className="small muted">Keep private source and credentials out of this form.</span></div>
      <label className="check"><input type="checkbox" name="isTest" /><span>This is a demonstration inquiry with synthetic information.</span></label>
      <button className="btn primary" disabled={busy}>{busy ? "Submitting..." : "Send inquiry"}</button>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </>}
  </form>;
}
