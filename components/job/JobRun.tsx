"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { siteFontVars } from "@/app/fonts";
import { createLive } from "@/components/site/goose/live";
import { createScenes, type SceneKind } from "@/components/site/goose/scenes";
import type { RunScene, RunStage } from "@/components/ui";
import type { LiveCode } from "@/lib/liveCode";
// the paper page, the report and the rest of the run are styled by the public site's stylesheet (scoped under .site)
import "@/app/site.css";

type Change = { id: number; path: string; line: number; kind: "chg" | "add" | "del"; lines: number; text: string };

const KIND_TEXT = { chg: "rewritten", add: "added", del: "removed" } as const;
const short = (p: string) => (p.length > 34 ? "…" + p.slice(-33) : p);

type Copy = { eyebrow: string; title: ReactNode; meta: string; pill: string; note: string };
function copyFor(scene: RunScene, o: { attempt: number | null; checks: { passed: number; total: number } | null; checksCount: number | null; replay: boolean }): Copy {
  const checks = o.checks ? `${o.checks.passed} of ${o.checks.total} checks passed` : null;
  switch (scene) {
    case "inspect": return { eyebrow: "Inspect", title: <>The geese are <em>reading your code</em>.</>, meta: "Inspecting your application · nothing changed", pill: "reading", note: "Goose is reading your repository to work out what it is and how it runs." };
    case "plan": return { eyebrow: "Plan", title: <>The geese are <em>thinking it over</em>.</>, meta: "Planning the work · your code isn't touched", pill: "planning", note: "The assessment agent is writing the plan, the checks and the price. Nothing in your code changes." };
    case "agree": return { eyebrow: "Agree", title: <>Waiting <em>for you</em>.</>, meta: "Your proposal is ready above", pill: "waiting for you", note: "Review the proposal above. Nothing is built until you accept it." };
    case "answer": return { eyebrow: "Question", title: <>The geese have <em>a question</em>.</>, meta: "Answer above to carry on", pill: "waiting for your answer", note: "Goose needs an answer from you before work can continue. The question is above." };
    case "founder": return { eyebrow: "With our founder", title: <>Resting while <em>our founder</em> takes a look.</>, meta: "A person is checking something before work continues", pill: "with our founder", note: "Our founder is looking at something before work continues. You'll see it here when the job moves on." };
    case "record": return { eyebrow: "Record", title: <>Recording how <em>your code behaves</em>.</>, meta: "An exact record of the original, before anything changes", pill: "recording the original", note: "Goose runs your original code and records how it behaves, so the new version can be compared with it." };
    case "freeze": return { eyebrow: "Freeze checks", title: <>Freezing <em>the checks</em>.</>, meta: o.checksCount ? `${o.checksCount} acceptance checks, locked before any code changes` : "Acceptance checks, locked before any code changes", pill: "freezing checks", note: "The agreed checks are locked so nobody, including the agents, can change them later." };
    case "build": return o.replay
      ? { eyebrow: `Build · attempt ${o.attempt ?? 1}`, title: <>The geese are <em>moving your code</em>.</>, meta: "", pill: "", note: "" }
      : { eyebrow: "Build", title: <>The agent is <em>writing the change</em>.</>, meta: "The geese read your code until the change is ready", pill: "reading", note: "The implementation agent is writing the change. When it's done, the geese walk the real diff here, line by line." };
    case "verify": return { eyebrow: "Verify", title: <>Checking <em>the new code</em>.</>, meta: checks ?? "Independent checks running", pill: checks ?? "checking", note: "An independent verifier runs the frozen checks against the new code and compares it with the recorded original." };
    case "package": return { eyebrow: "Package", title: <>Packing <em>your delivery</em>.</>, meta: "Code, report, run book and rollback guide", pill: "packaging", note: "The verified code, the evidence and the guides are going into one package." };
    case "deliver": return { eyebrow: "Deliver", title: <>Delivered. <em>Waiting for your OK</em>.</>, meta: "Download and accept the delivery below", pill: "delivered", note: "Your package is ready. Accept the delivery below when you're happy with it." };
    case "complete": return { eyebrow: "Complete", title: <>Migration <em>landed</em>.</>, meta: "Delivered and accepted", pill: "complete", note: "This job is complete. Support and follow-up changes are below." };
    case "nofit": return { eyebrow: "Stopped", title: <>Not <em>this one</em>.</>, meta: "Outside what Goose can carry out and verify today", pill: "stopped", note: "This job stopped. The plan and the messages below say why." };
  }
}

/** The job's live run beside its report. The page shows what the job is doing:
    - inspect / build / verify: the geese on the customer's real code (paper page, components/site/goose/live.ts);
      the code comes from /api/jobs/[id]/live and is only fetched again when `sig` changes, so the page's 2-second
      refresh never restarts the animation;
    - every other stage: the same geese in that stage's scene (components/site/goose/scenes.ts). */
export function JobRun({ src, sig, scene, attempt, now, stages, checks = null, checksCount = null }: {
  src?: string | null; sig?: string | null; scene: RunScene; attempt: number | null; now: string; stages: RunStage[];
  checks?: { passed: number; total: number } | null; checksCount?: number | null;
}) {
  const page = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), code = useRef<HTMLOListElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null), sceneCanvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<ReturnType<typeof createLive> | null>(null);
  const scenesApi = useRef<ReturnType<typeof createScenes> | null>(null);
  const showCode = useRef(false), inView = useRef(false);
  const seq = useRef(0);
  const [data, setData] = useState<LiveCode | null>(null);
  const [fileIdx, setFileIdx] = useState(0);
  const [prog, setProg] = useState({ fileDone: 0, fileTotal: 0, done: 0, total: 0 });
  const [changes, setChanges] = useState<Change[]>([]);
  const [finished, setFinished] = useState(false);

  const codeScene = scene === "inspect" || scene === "build" || scene === "verify";
  const onCode = codeScene && !!data;
  const replay = onCode && data!.mode === "replay" && scene !== "inspect";
  const survey = replay && scene === "verify";
  // a code stage with no code to show yet (no repository, or nothing readable) uses the planning meadow
  const sceneKind: SceneKind = codeScene ? "plan" : (scene as SceneKind);

  // both engines and one animation loop live as long as the component
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const live = createLive({ page: page.current!, scroll: scroll.current!, code: code.current!, canvas: canvas.current! }, {
      file: (i) => { setFileIdx(i); setChanges([]); setFinished(false); },
      progress: (p) => setProg({ fileDone: p.fileDone, fileTotal: p.fileTotal, done: p.done, total: p.total }),
      change: (c) => setChanges((xs) => [{ ...c, id: ++seq.current }, ...xs].slice(0, 7)),
      finish: () => setFinished(true),
    }, reduce);
    const scenes = createScenes(sceneCanvas.current!, reduce);
    api.current = live;
    scenesApi.current = scenes;
    const io = new IntersectionObserver((es) => {
      for (const e of es) { inView.current = e.isIntersecting; live.setVisible(e.isIntersecting && showCode.current); scenes.setVisible(e.isIntersecting && !showCode.current); }
    }, { threshold: 0.12 });
    io.observe(page.current!);
    const onResize = () => { live.measure(); scenes.measure(); if (reduce) live.redraw(); };
    window.addEventListener("resize", onResize);
    document.fonts?.ready.then(() => live.measure());
    let raf = 0, last = performance.now();
    const frame = (ms: number) => {
      const dt = Math.min(0.05, Math.max(0, (ms - last) / 1000));
      last = ms;
      if (showCode.current) live.frame(dt, ms / 1000); else scenes.frame(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener("resize", onResize); api.current = null; scenesApi.current = null; };
  }, []);

  // fetch the code again only when what it would show has changed
  useEffect(() => {
    if (!src || !sig) { setData(null); return; }
    let alive = true;
    fetch(src, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((d: LiveCode) => {
      if (!alive) return;
      setChanges([]);
      setFinished(false);
      setData(d);
    }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // show the code or the stage's scene
  useEffect(() => {
    showCode.current = onCode;
    api.current?.setVisible(inView.current && onCode);
    scenesApi.current?.setVisible(inView.current && !onCode);
    if (!onCode) scenesApi.current?.show(sceneKind);
  }, [onCode, sceneKind]);

  // new code: load it, walking the change (build) or flying over the finished code (verify)
  useEffect(() => {
    if (!data || !api.current) return;
    api.current.setSurvey(survey);
    api.current.load(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => { api.current?.setSurvey(survey); }, [survey]);

  const files = data?.files ?? [];
  const file = files[fileIdx];
  const fileCount = files.length + (data?.moreFiles.length ?? 0);
  const c = copyFor(scene, { attempt, checks, checksCount, replay });
  const meta = replay && data ? `${data.totalChanged.toLocaleString("en-US")} changed lines across ${fileCount} file${fileCount === 1 ? "" : "s"}${survey && checks ? ` · ${checks.passed} of ${checks.total} checks passed` : ""}`
    : onCode && !replay && data ? `${files.length} of your files · nothing changed yet` : c.meta;
  return (
    <div className={`site embed ${siteFontVars}`}>
      <section className="jobrun" aria-labelledby="run-h">
        <div className="run-head">
          <div className="run-title">
            <div className="eyebrow">Live run · {c.eyebrow}</div>
            <h2 className="h2" id="run-h">{c.title}</h2>
            {meta && <div className="meta"><span>{meta}</span></div>}
          </div>
          {replay && !survey && (
            <div className="run-ctrl">
              <button className="s-btn" type="button" onClick={() => api.current?.replay()}>Replay</button>
              {!finished && <button className="s-btn ghost" type="button" onClick={() => api.current?.skip()}>Skip to the end</button>}
            </div>
          )}
        </div>
        <div className="run-grid">
          <div className={`page${onCode ? "" : " on-scene"}`} ref={page}>
            <div className="page-scroll" ref={scroll}>
              <div className="page-head">
                <span><b>{file?.path ?? " "}</b>{file?.isNew ? " · new file" : ""}</span>
                <span>{files.length ? `File ${fileIdx + 1} of ${files.length}` : ""}</span>
              </div>
              <ol className="code" ref={code} aria-label={replay ? "Your code, being changed" : "Your code"} />
            </div>
            <canvas className="run-canvas" ref={canvas} aria-hidden="true" />
            <canvas className="scene-canvas" ref={sceneCanvas} aria-hidden="true" />
            {onCode && file ? (
              <div className="run-pill" aria-live="polite">
                <span>{short(file.path)}</span>
                {replay && !survey && <span className="run-bar"><i style={{ width: `${prog.fileTotal ? (prog.fileDone / prog.fileTotal) * 100 : 0}%` }} /></span>}
                <b>{survey ? (checks ? `${checks.passed} of ${checks.total} checks` : "checking") : replay ? `${prog.fileDone} of ${prog.fileTotal} lines` : "reading"}</b>
              </div>
            ) : (
              <div className="run-pill" aria-live="polite"><b>{c.pill}</b></div>
            )}
          </div>

          <div className="report">
            <div className="report-top"><span>Goose report</span><span><b>{now}</b></span></div>
            <ol className="stages" aria-label="Progress">
              {stages.map((s) => (
                <li key={s.key} className={s.state === "stuck" || s.state === "failed" ? `active ${s.state}` : s.state === "todo" ? "" : s.state}>
                  <span>{s.label}</span>
                  <span className="st">{s.state === "done" ? "done" : s.state === "active" ? "running" : s.state === "stuck" ? "with our founder" : s.state === "failed" ? "repairing" : ""}</span>
                  <small>{s.detail ?? ""}</small>
                </li>
              ))}
            </ol>
            {onCode && files.length > 1 && (
              <div className="files">
                <div className="lbl">Files <span>{replay && !survey ? `${Math.min(fileIdx + (finished ? 1 : 0), files.length)} of ${fileCount} done` : replay ? `${fileCount} changed` : `${files.length} being read`}</span></div>
                <ul>
                  {files.map((f, i) => (
                    <li key={f.path} className={i === fileIdx ? "now" : replay && (survey || i < fileIdx || (finished && i === fileIdx)) ? "done" : ""}>
                      <span className="path" title={f.path}>{short(f.path)}</span>
                      {replay && <span className="n">{f.isNew ? "new" : `+${f.added} −${f.removed}`}</span>}
                    </li>
                  ))}
                  {(data?.moreFiles.length ?? 0) > 0 && <li className="more">and {data!.moreFiles.length} more in the full diff</li>}
                </ul>
              </div>
            )}
            {replay && !survey ? (
              <div className="changes">
                <div className="lbl">Changes <span>{prog.done.toLocaleString("en-US")} of {prog.total.toLocaleString("en-US")} lines</span></div>
                <ul>
                  {changes.length === 0 && <li className="empty">Changes appear here as the geese work down the file.</li>}
                  {changes.map((ch) => (
                    <li key={ch.id}>
                      <span className="chg-ln">L{ch.line}</span>
                      <span>{ch.lines > 1 ? `${ch.lines} lines ${KIND_TEXT[ch.kind]}` : `Line ${KIND_TEXT[ch.kind]}`} <span className="where">{short(ch.path)}</span>
                        {ch.text && <code className={`now-reads${ch.kind === "del" ? " gone" : ""}`}>{ch.text}</code>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="report-note">{c.note}</p>
            )}
          </div>
        </div>
        <p className="run-note">
          {replay ? (survey ? "The finished change. The flock flies over each file while the independent checks run; the real results are in the report."
            : "A replay of the real change from this attempt. The agent writes the whole change at once; the geese walk it line by line. Every changed line is also in the full diff below.")
            : onCode ? "Your code as you sent it, read-only. Nothing here has been changed yet."
            : "The geese show what the job is doing right now. The report beside them has the real progress."}
        </p>
      </section>
    </div>
  );
}
