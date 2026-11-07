"use client";
// The application map: every box is something inspection found in the customer's code or data, never a template.
// Selecting one shows what it does, what it uses, what uses it, what we found there, and what the plan does to it.
import { useEffect, useMemo, useState } from "react";

type Comp = { id: string; kind: string; name: string; summary: string; file: string | null; line: number | null; group: string; attrs: any };
type Edge = { from: string; to: string; kind: string };
type Finding = { id: string; severity: string; title: string; detail: string; evidence: any[]; component_ids: string[] };

const COLUMNS: { key: string; title: string; kinds: string[] }[] = [
  { key: "connections", title: "Outside connections", kinds: ["client", "script"] },
  { key: "entry", title: "Entry points", kinds: ["interface", "route"] },
  { key: "code", title: "Code and customizations", kinds: ["rule", "field", "function", "module", "template", "setting", "runtime", "test"] },
  { key: "access", title: "Access", kinds: ["role", "team"] },
  { key: "data", title: "Data", kinds: ["table", "database"] },
];
const KIND_LABEL: Record<string, string> = { client: "client", script: "script", interface: "interface", route: "address", function: "function",
  rule: "business rule", template: "template", setting: "setting", runtime: "runtime", test: "tests", module: "module", table: "table", database: "database",
  field: "custom field", role: "role", team: "team" };

export function AppMap({ jobId, token, ops, components, edges, findings, changes, preserve }: {
  jobId: string; token?: string; ops?: boolean; components: Comp[]; edges: Edge[]; findings: Finding[]; changes: any[]; preserve: any[];
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [src, setSrc] = useState<{ path: string; line: number | null } | null>(null);
  const byId = useMemo(() => Object.fromEntries(components.map((c) => [c.id, c])), [components]);
  const related = useMemo(() => {
    if (!sel) return null;
    const s = new Set([sel]);
    for (const e of edges) { if (e.from === sel) s.add(e.to); if (e.to === sel) s.add(e.from); }
    return s;
  }, [sel, edges]);
  const findingsOf = (id: string) => findings.filter((f) => f.component_ids?.includes(id));
  const changesOf = (id: string) => (changes ?? []).filter((c) => (c.component_ids ?? []).includes(id));
  const keptOf = (id: string) => (preserve ?? []).filter((k) => (k.component_ids ?? []).includes(id));
  const c = sel ? byId[sel] : null;
  const worst = (id: string) => { const f = findingsOf(id); return f.some((x) => x.severity === "high") ? "bad" : f.some((x) => x.severity === "medium") ? "warn" : f.length ? "neutral" : null; };
  return (
    <div className="appmap">
      <div className="appmap-cols" style={{ gridTemplateColumns: `repeat(${COLUMNS.filter((col) => col.key !== "access" || components.some((x) => col.kinds.includes(x.kind))).length}, minmax(0, 1fr))` }}>
        {COLUMNS.filter((col) => col.key !== "access" || components.some((x) => col.kinds.includes(x.kind))).map((col) => {
          const items = components.filter((x) => col.kinds.includes(x.kind))
            .map((x, i) => ({ x, i })).sort((a, b) => col.kinds.indexOf(a.x.kind) - col.kinds.indexOf(b.x.kind) || a.i - b.i).map((p) => p.x);
          return (
            <div key={col.key} className="appmap-col">
              <div className="stat-label">{col.title} <span className="faint">({items.length})</span></div>
              {items.length === 0 && <div className="small faint">None found</div>}
              {items.map((x) => {
                const w = worst(x.id);
                return (
                  <button key={x.id} type="button" onClick={() => setSel(sel === x.id ? null : x.id)}
                    className={`node ${sel === x.id ? "selected" : ""} ${related && !related.has(x.id) ? "dim" : ""}`} aria-pressed={sel === x.id}>
                    <span className="node-kind">{KIND_LABEL[x.kind] ?? x.kind}</span>
                    <span className="node-name">{x.name}</span>
                    <span className="node-badges">
                      {w && <span className={`dot ${w}`} title={`${findingsOf(x.id).length} finding(s)`} />}
                      {changesOf(x.id).length > 0 && <span className="tag change">change</span>}
                      {keptOf(x.id).length > 0 && changesOf(x.id).length === 0 && <span className="tag kept">kept</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="appmap-detail card tight" aria-live="polite">
        {!c && <p className="small muted" style={{ margin: 0 }}>Select a box to see what it does, what it uses, what uses it, what we found there and what the plan does to it.
          Every box comes from reading your code and data.</p>}
        {c && (
          <div className="stack-sm">
            <div><span className="node-kind">{KIND_LABEL[c.kind] ?? c.kind}</span> <b>{c.name}</b></div>
            {c.summary && <div className="small">{c.summary}</div>}
            {c.file && <div className="small"><button type="button" className="linkish mono" onClick={() => setSrc({ path: c.file!, line: c.line })}>{c.file}{c.line ? `:${c.line}` : ""}</button></div>}
            <Rel title="Uses" items={edges.filter((e) => e.from === c.id).map((e) => ({ id: e.to, kind: e.kind }))} byId={byId} onPick={setSel} />
            <Rel title="Used by" items={edges.filter((e) => e.to === c.id).map((e) => ({ id: e.from, kind: e.kind }))} byId={byId} onPick={setSel} />
            {findingsOf(c.id).length > 0 && <div><div className="stat-label">Found here</div><ul className="small tight-list">{findingsOf(c.id).map((f) => (
              <li key={f.id}><span className={`pill ${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "neutral"}`}>{f.severity}</span> {f.title}</li>))}</ul></div>}
            {changesOf(c.id).length > 0 && <div><div className="stat-label">The plan changes it</div><ul className="small tight-list">{changesOf(c.id).map((x) => (
              <li key={x.id}><b>{x.title}.</b> <span className="muted">{x.reason}</span></li>))}</ul></div>}
            {keptOf(c.id).length > 0 && <div><div className="stat-label">The plan keeps it</div><ul className="small tight-list">{keptOf(c.id).map((k, i) => (
              <li key={i}>{k.what} <span className="muted">{k.reason}</span></li>))}</ul></div>}
          </div>
        )}
      </div>
      {src && <SourceViewer jobId={jobId} token={token} ops={ops} path={src.path} line={src.line} onClose={() => setSrc(null)} />}
    </div>
  );
}

function Rel({ title, items, byId, onPick }: { title: string; items: { id: string; kind: string }[]; byId: Record<string, Comp>; onPick: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div><div className="stat-label">{title}</div>
      <ul className="small tight-list">{items.map((i) => (
        <li key={i.id + i.kind}><span className="muted">{i.kind}</span>{" "}
          <button type="button" className="linkish" onClick={() => onPick(i.id)}>{byId[i.id]?.name ?? i.id}</button></li>))}</ul></div>
  );
}

export function SourceLink({ jobId, token, ops, path, line }: { jobId: string; token?: string; ops?: boolean; path: string; line: number | null }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button type="button" className="linkish mono small" onClick={() => setOpen(true)}>{path}{line ? `:${line}` : ""}</button>
    {open && <SourceViewer jobId={jobId} token={token} ops={ops} path={path} line={line} onClose={() => setOpen(false)} />}
  </>);
}

function SourceViewer({ jobId, token, ops, path, line, onClose }: { jobId: string; token?: string; ops?: boolean; path: string; line: number | null; onClose: () => void }) {
  const [data, setData] = useState<{ start: number; lines: string[] } | null | "error">(null);
  useEffect(() => {
    const qs = new URLSearchParams({ path, ...(line ? { line: String(line) } : {}), ...(ops ? { ops: "1" } : { t: token ?? "" }) });
    fetch(`/api/jobs/${jobId}/source?${qs}`).then((r) => (r.ok ? r.json() : "error")).then(setData).catch(() => setData("error"));
  }, [jobId, token, ops, path, line]);
  return (
    <div className="modal" role="dialog" aria-label={`Source of ${path}`} onClick={onClose}>
      <div className="modal-body card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head"><b className="mono small">{path}{line ? `:${line}` : ""}</b><button type="button" className="btn" onClick={onClose}>Close</button></div>
        <p className="small muted">From the unchanged snapshot of the code you sent.</p>
        {data === null && <p className="small muted">Loading...</p>}
        {data === "error" && <p className="small">This file is not in the snapshot.</p>}
        {data && data !== "error" && (
          <pre className="source">{data.lines.map((l, i) => {
            const n = data.start + i;
            return <div key={n} className={n === line ? "hl" : ""}><span className="ln">{n}</span>{l || " "}</div>;
          })}</pre>
        )}
      </div>
    </div>
  );
}
