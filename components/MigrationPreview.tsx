"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { resolveRefs, type RequestStep } from "@/lib/migrationContract";

export function MigrationPreview({ id, auth, runtime, steps, room }: { id: string; auth: string; runtime: string; steps: RequestStep[]; room: any }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(0), [saved, setSaved] = useState<Record<string, any>>({});
  const [body, setBody] = useState(JSON.stringify(steps[0]?.body ?? {}, null, 2));
  const [result, setResult] = useState<any>(null), [busy, setBusy] = useState(false);
  return <section className="section card">
    <div className="card-head"><h2>Try the migrated application</h2><span className="pill info">{runtime} · isolated data copy</span></div>
    <p className="small muted">Use the actual delivered backend. Create a record, keep its returned identifier, and read or edit it. Preview writes stay in this disposable copy.</p>
    {room?.status !== "running" ? <>
      <button className="btn primary" disabled={busy || room?.status === "requested"} onClick={async () => {
        setBusy(true);
        try { const r = await fetch(`/api/jobs/${id}/preview?${auth}`, { method: "POST" }); const b = await r.json(); if (!r.ok) setResult(b); router.refresh(); }
        catch (e) { setResult({ error: String(e) }); } finally { setBusy(false); }
      }}>{room?.status === "requested" ? "Starting the application..." : "Start preview"}</button>
      {room?.detail && <p className="small">{room.detail}</p>}
    </> : <>
      <p className="small">Running at <a href={`http://127.0.0.1:${room.port}/`} target="_blank" rel="noreferrer">127.0.0.1:{room.port}</a></p>
      <div className="grid g2"><div className="stack-sm">
        <label htmlFor={`preview-step-${id}`}>Request</label>
        <select id={`preview-step-${id}`} value={chosen} onChange={e => { const i = Number(e.target.value); setChosen(i); setBody(JSON.stringify(steps[i].body ?? {}, null, 2)); }}>
          {steps.map((s, i) => <option key={s.id} value={i}>{s.id.replaceAll("_", " ")} · {s.method} {s.path}</option>)}
        </select>
        <label htmlFor={`preview-body-${id}`}>JSON body (edit to try your own records)</label>
        <textarea id={`preview-body-${id}`} rows={6} className="mono" value={body} onChange={e => setBody(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            const s = steps[chosen];
            const r = await fetch(`/api/try/${id}?${auth}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: s.method, path: resolveRefs(s.path, saved), body: s.method === "GET" ? undefined : resolveRefs(JSON.parse(body), saved) }) });
            const b = await r.json(); setResult(b);
            const next = { ...saved };
            for (const [key, ptr] of Object.entries(s.save ?? {})) { let value = b.body; for (const part of ptr.slice(1).split("/")) value = value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")]; if (value !== undefined) next[key] = value; }
            setSaved(next);
          } catch (e) { setResult({ error: String(e), hint: "Run the create request first when a path uses a saved identifier." }); }
          finally { setBusy(false); }
        }}>{busy ? "Running..." : "Send request"}</button>
        {Object.keys(saved).length > 0 && <p className="small mono">Saved identifiers: {JSON.stringify(saved)}</p>}
      </div><div><div className="stat-label">Live response</div><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 400, overflow: "auto" }}>{result ? JSON.stringify(result, null, 2) : "Send a request to see its actual response."}</pre></div></div>
    </>}
    {room?.status !== "running" && result && <p className="small">{JSON.stringify(result)}</p>}
  </section>;
}
