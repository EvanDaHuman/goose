"use client";

import { useEffect, useState } from "react";

type Ev = { id: number; at: string; actor: string; kind: string; important: boolean; summary: string };
const NAMES: Record<string, string> = { commercial: "Commercial agent", coordinator: "Coordinator", modernization: "Modernization agent",
  verification: "Verification agent", customer: "Customer", founder: "Founder", system: "System" };

/** Step through a recorded run. The elapsed time shown is the real time between recorded events. */
export function Replay({ events }: { events: Ev[] }) {
  const [n, setN] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [onlyImportant, setOnlyImportant] = useState(true);
  const list = onlyImportant ? events.filter((e) => e.important) : events;
  useEffect(() => {
    if (!playing) return;
    if (n >= list.length) { setPlaying(false); return; }
    const t = setTimeout(() => setN((x) => x + 1), 1100);
    return () => clearTimeout(t);
  }, [playing, n, list.length]);
  const t0 = new Date(events[0]?.at ?? Date.now()).getTime();
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={() => { if (n >= list.length) setN(1); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play replay"}</button>
        <button className="btn" onClick={() => setN((x) => Math.min(list.length, x + 1))}>Next</button>
        <button className="btn" onClick={() => { setN(list.length); setPlaying(false); }}>Show all</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={onlyImportant} onChange={(e) => { setOnlyImportant(e.target.checked); setN(1); }} /> Key moments only</label>
        <span className="small muted">{Math.min(n, list.length)} / {list.length}</span>
      </div>
      <ul className="timeline">
        {list.slice(0, n).map((e) => (
          <li key={e.id}><span className="t">+{((new Date(e.at).getTime() - t0) / 1000).toFixed(1)}s</span>
            <span className="who">{NAMES[e.actor] ?? e.actor}</span><span>{e.summary}</span></li>
        ))}
      </ul>
    </div>
  );
}
