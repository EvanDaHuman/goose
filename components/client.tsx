"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";

/** Refresh the server-rendered page while the job is moving, so the screen always shows real state. */
export function AutoRefresh({ active, seconds = 2 }: { active: boolean; seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

export function ActionButton({ url, body, label, confirm, tone = "", after }: {
  url: string; body: unknown; label: string; confirm?: string; tone?: string; after?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span>
      <button className={`btn ${tone}`} disabled={busy} onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true); setErr(null);
        try { const j = await post(url, body); if (after) router.push(after.replace("{id}", j.id ?? "")); else router.refresh(); }
        catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }}>{busy ? "Working..." : label}</button>
      {err && <span className="small" style={{ color: "var(--bad)", marginLeft: 8 }}>{err}</span>}
    </span>
  );
}

export function AnswerForm({ jobId, token, qkey, options, help, recommended }: {
  jobId: string; token: string; qkey: string; options: string[]; help: Record<string, string> | null; recommended: string | null;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(recommended ?? options[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="stack-sm">
      {options.map((o) => (
        <label key={o} className="check" style={{ fontWeight: 400 }}>
          <input type="radio" name={qkey} checked={choice === o} onChange={() => setChoice(o)} />
          <span><b>{o.replaceAll("_", " ")}</b>{o === recommended ? " (recommended)" : ""}{help?.[o] ? <> - <span className="muted">{help[o]}</span></> : null}</span>
        </label>
      ))}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await post(`/api/jobs/${jobId}/answer`, { t: token, key: qkey, answer: { decision: choice } }); router.refresh(); }
          catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Send answer</button>
        {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
      </div>
    </div>
  );
}

export function SignForm({ url, token, extra, button, statement, children }: {
  url: string; token: string; extra?: Record<string, unknown>; button: string; statement: string; children?: ReactNode;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const uid = useId();
  return (
    <div className="stack-sm">
      {children}
      <div className="grid g2">
        <div className="field"><label htmlFor={`${uid}-name`}>Your name</label>
          <input id={`${uid}-name`} type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor={`${uid}-email`}>Email</label>
          <input id={`${uid}-email`} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> <span>{statement}</span></label>
      <div className="row">
        <button className="btn primary" disabled={busy || !agree || name.trim().length < 2} onClick={async () => {
          setBusy(true); setErr(null);
          try { await post(url, { t: token, name, email, statement, ...extra }); router.refresh(); }
          catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{button}</button>
        {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
      </div>
    </div>
  );
}

export function MessageForm({ jobId, token }: { jobId: string; token: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ alignItems: "stretch" }}>
      <input type="text" placeholder="Ask a question about your job" value={body} onChange={(e) => setBody(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
      <button className="btn" disabled={busy || !body.trim()} onClick={async () => {
        setBusy(true);
        try { await post(`/api/jobs/${jobId}/message`, { t: token, body }); setBody(""); router.refresh(); } finally { setBusy(false); }
      }}>Send</button>
    </div>
  );
}

export function UploadForm({ jobId, token, kind }: { jobId: string; token: string; kind: "database" | "repository" }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="row">
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button className="btn primary" disabled={!file || busy} onClick={async () => {
        setBusy(true); setErr(null);
        const fd = new FormData(); fd.set("t", token); fd.set("kind", kind); fd.set("file", file!);
        const r = await fetch(`/api/jobs/${jobId}/upload`, { method: "POST", body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) setErr(j.error ?? "Upload failed"); else router.refresh();
        setBusy(false);
      }}>Upload</button>
      {err && <span className="small" style={{ color: "var(--bad)" }}>{err}</span>}
    </div>
  );
}

export function OpsNumberAction({ url, field, label, initial, extra }: { url: string; field: string; label: string; initial: number; extra?: Record<string, unknown> }) {
  const router = useRouter();
  const [v, setV] = useState(String(initial));
  const [busy, setBusy] = useState(false);
  return (
    <div className="row">
      <input type="number" step="0.01" value={v} onChange={(e) => setV(e.target.value)} style={{ width: 120 }} />
      <button className="btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await post(url, { ...extra, [field]: Number(v) }); router.refresh(); } finally { setBusy(false); }
      }}>{label}</button>
    </div>
  );
}

export function FaultPicker({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [f, setF] = useState("money-truncation");
  return (
    <div className="row">
      <select value={f} onChange={(e) => setF(e.target.value)} style={{ width: 240 }}>
        <option value="money-truncation">Data move drops fractions of a cent</option>
        <option value="case-sensitive-search">Customer search becomes case-sensitive</option>
        <option value="cancel-guard-missing">Cancelling twice puts stock back twice</option>
        <option value="sequence-not-reset">New records reuse old ids</option>
      </select>
      <button className="btn small danger" onClick={async () => {
        await post(`/api/ops/jobs/${jobId}/action`, { action: "inject_fault", fault: f }); router.refresh();
      }}>Schedule test fault</button>
    </div>
  );
}
