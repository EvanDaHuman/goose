"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { BrandIcon } from "./BrandIcon";
import { createRun } from "./goose/run";
import { createSky } from "./goose/sky";
import { EXAMPLES, PAIRS, PAIR_ORDER, SAMPLE_TITLES, type SampleKey } from "./samples";

/** The homepage: the goose hero, what Goose does, example migrations, and the live-run demo. The two canvas
    scenes are driven imperatively from one animation loop; React only renders the static markup. */
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const exGrid = useRef<HTMLDivElement>(null);
  const runApi = useRef<ReturnType<typeof createRun> | null>(null);

  useEffect(() => {
    const el = root.current!;
    const $ = <T extends Element>(sel: string) => el.querySelector<T>(sel)!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const sky = createSky({
      canvas: $<HTMLCanvasElement>(".sky"), hero: $<HTMLElement>("#home"), stage: $<HTMLElement>(".hero-stage"),
      desc: $<HTMLElement>(".hero-desc"), cue: el.querySelector<HTMLElement>(".scroll-cue"),
      obstacles: [$<HTMLElement>(".hero-logo"), $<HTMLElement>(".s-hero h1"), $<HTMLElement>(".hero-desc p")],
    });
    const run = createRun({
      page: $("[data-run=page]"), scroll: $("[data-run=scroll]"), code: $("[data-run=code]"), canvas: $("[data-run=canvas]"),
      fileName: $("[data-run=file]"), fileMeta: $("[data-run=file-meta]"), pillFile: $("[data-run=pill-file]"),
      pillCount: $("[data-run=pill-count]"), pillBar: $("[data-run=pill-bar]"), title: $("[data-run=title]"), meta: $("[data-run=meta]"),
      reportJob: $("[data-run=report-job]"), stages: $("[data-run=stages]"), changesBox: $("[data-run=changes-box]"),
      changeCount: $("[data-run=change-count]"), changes: $("[data-run=changes]"), findings: $("[data-run=findings]"),
      sampleSelect: $("[data-run=sample]"),
    }, reduce);
    runApi.current = run;

    sky.layout();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        run.setVisible(e.isIntersecting);
        if (e.isIntersecting && !run.started) { run.measure(); run.start(run.key); }
      }
    }, { threshold: 0.12 });
    io.observe($("[data-run=page]"));

    const onResize = () => {
      sky.layout();
      run.measure();
      if (reduce) { sky.drawStill(); run.redraw(); }
    };
    window.addEventListener("resize", onResize);
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) { sky.layout(); run.measure(); } });

    let raf = 0, last = performance.now();
    const frame = (ms: number) => {
      const dt = Math.min(0.05, Math.max(0, (ms - last) / 1000));
      last = ms;
      sky.frame(dt, ms / 1000);
      run.frame(dt, ms / 1000);
      raf = requestAnimationFrame(frame);
    };
    if (reduce) sky.drawStill();
    else raf = requestAnimationFrame(frame);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", onResize);
      runApi.current = null;
    };
  }, []);

  // keep every route on one line: if any card is too narrow, shrink all four routes by the same amount
  useEffect(() => {
    const grid = exGrid.current!;
    const fit = () => {
      grid.style.setProperty("--fit", "1");
      let k = 1;
      grid.querySelectorAll<HTMLElement>(".route").forEach((r) => {
        if (r.clientWidth > 0 && r.scrollWidth > r.clientWidth) k = Math.min(k, r.clientWidth / r.scrollWidth);
      });
      if (k < 1) grid.style.setProperty("--fit", Math.max(0.6, k * 0.98).toFixed(3));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(grid);
    document.fonts?.ready.then(fit);
    fit();
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={root}>
      <canvas className="sky" aria-hidden="true" />

      <header className="s-hero" id="home">
        <div className="hero-stage">
          <div className="s-hero-copy gutter">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="hero-logo" src="/brand/goose-logo.webp" alt="Goose" width={757} height={210} />
            <h1>Migrations that <em>land</em>.</h1>
          </div>
          <div className="hero-desc gutter">
            <p>Goose moves your code and data to a modern stack, proves nothing broke, and bills you only when the checks pass.</p>
          </div>
          <div className="scroll-cue" aria-hidden="true">Scroll<span /></div>
        </div>
      </header>

      <main>
        <section className="block gutter" id="intro" aria-labelledby="intro-h">
          <div className="container">
            <div className="intro-grid">
              <div style={{ display: "grid", gap: 16 }}>
                <div className="eyebrow">What Goose does</div>
                <h2 className="h2" id="intro-h">An AI team that upgrades your software, <em>and proves it</em>.</h2>
              </div>
              <p className="s-lead">
                Connect your repository and tell Goose what needs to change. It inspects the code, plans the smallest change that gets
                you there, and records how today&apos;s version behaves. Then it freezes the checks the new version must pass, does the
                work on copies, and verifies the result on its own.
              </p>
            </div>
            <div className="facts">
              <div className="fact"><b>Fixed price</b><span>Quoted after inspection, before any work starts.</span></div>
              <div className="fact"><b>Paid after the checks pass</b><span>No pass, no invoice. Every report lists what was tested and what was not.</span></div>
              <div className="fact"><b>Works on copies</b><span>Read-only access to your code. Your live systems are never touched.</span></div>
            </div>
            <ol className="pipeline" aria-label="How a job runs">
              {["Inspect", "Plan", "Quote", "Record", "Freeze", "Build", "Verify", "Deliver"].map((s) => (
                // grow in proportion to the label (plus the number in front), so wider pills take more of the spare space
                <li key={s} style={{ flexGrow: s.length + 3 }}>{s}</li>
              ))}
            </ol>
          </div>
        </section>

        <section className="block gutter" id="examples" aria-labelledby="ex-h" style={{ paddingTop: 0 }}>
          <div className="container">
            <div style={{ display: "grid", gap: 16 }}>
              <div className="eyebrow">Examples</div>
              <h2 className="h2" id="ex-h">From what you run <em>to what you need</em>.</h2>
            </div>
            <div className="ex-grid" ref={exGrid}>
              {EXAMPLES.map((ex) => (
                <article className="ex" key={ex.sample}>
                  <div className="route">
                    <div className="side">
                      <span className="logos">{ex.fromIcons.map((n) => <BrandIcon key={n} name={n} />)}</span>
                      <span className="name">{ex.from}</span>
                    </div>
                    <span className="route-arrow" aria-label="to">→</span>
                    <div className="side">
                      <span className="logos">{ex.toIcons.map((n) => <BrandIcon key={n} name={n} />)}</span>
                      <span className="name">{ex.to}</span>
                    </div>
                  </div>
                  <p>{ex.desc}</p>
                  <Link className="use" href={`/start?example=${ex.sample}`}>Start with this →</Link>
                </article>
              ))}
            </div>
            <div className="ex-note">
              <p>
                These are only examples. <b>Goose can move any stack to any other:</b> connect the repository, and the inspection tells you
                what it takes and what it costs.
              </p>
              <Link className="s-btn" href="/start">Bring your own stack →</Link>
            </div>
          </div>
        </section>

        <section className="block gutter" id="demo" aria-labelledby="demo-h" style={{ paddingTop: 0 }}>
          <div className="container">
            <div style={{ display: "grid", gap: 14, marginBottom: 28 }}>
              <div className="eyebrow">Live run · demo</div>
              <h2 className="h2" id="demo-h">Watch the geese <em>work</em>.</h2>
              <span className="placeholder">A sample run. On a real job, the geese work on your code after you start a migration.</span>
            </div>

            <div className="run-head">
              <div className="run-title">
                <div className="eyebrow">Sample run</div>
                <h3 className="h2" data-run="title">{SAMPLE_TITLES["flask-fastapi"]}</h3>
                <div className="meta" data-run="meta" />
              </div>
              <div className="run-ctrl">
                <label htmlFor="pairSel" className="eyebrow">Sample</label>
                <select id="pairSel" data-run="sample" defaultValue="flask-fastapi"
                  onChange={(e) => runApi.current?.start(e.target.value as SampleKey)}>
                  {PAIR_ORDER.map((k) => <option key={k} value={k}>{`${PAIRS[k].from} → ${PAIRS[k].to}`}</option>)}
                </select>
                <button className="s-btn" type="button" onClick={() => runApi.current?.start(runApi.current.key)}>Replay</button>
              </div>
            </div>
            <div className="run-grid">
              <div className="page" data-run="page">
                <div className="page-scroll" data-run="scroll">
                  <div className="page-head"><span data-run="file" /><span data-run="file-meta" /></div>
                  <ol className="code" data-run="code" aria-label="Code being migrated" />
                </div>
                <canvas className="run-canvas" data-run="canvas" aria-hidden="true" />
                <div className="run-pill" aria-live="polite">
                  <span data-run="pill-file" />
                  <span className="run-bar"><i data-run="pill-bar" /></span>
                  <b data-run="pill-count">0 of 0</b>
                </div>
              </div>
              <div className="report">
                <div className="report-top"><span>Goose report · built with Claude</span><span>Migrating <b data-run="report-job" /></span></div>
                <ol className="stages" data-run="stages" aria-label="Pipeline" />
                <div className="changes" data-run="changes-box">
                  <div className="lbl">Changes <span data-run="change-count">0 of 0</span></div>
                  <ul data-run="changes" />
                </div>
                <div className="findings" data-run="findings" hidden />
              </div>
            </div>
            <p className="run-note">Sample code and figures for illustration.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
