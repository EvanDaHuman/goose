/* The live run: six geese work down a code file printed on a paper page. Walking, they leave a trail of
   footprints and step on the exact characters that change, which rewrite in place. Every so often they take
   off one after another and fly a stretch in a loose V, leaving droppings; a change they fly over is
   converted and marked with a dropping. They always move down the page and never get ahead of the line
   being changed; the page scrolls up under them. Beside it, a report follows the job's pipeline. */
import { PAIRS, PAIR_ORDER, SAMPLE_TITLES, type Sample, type SampleKey } from "../samples";
import { advanceFlap, drawDropping, drawGoose, drawGooseShadow, drawPrint, type GoosePose } from "./draw";
import { DOWN, TAU, angDiff, clamp, easeInOut, fitCanvas, lerp, rnd, smooth } from "./math";

export interface RunElements {
  page: HTMLElement;
  scroll: HTMLElement;
  code: HTMLOListElement;
  canvas: HTMLCanvasElement;
  fileName: HTMLElement;
  fileMeta: HTMLElement;
  pillFile: HTMLElement;
  pillCount: HTMLElement;
  pillBar: HTMLElement;
  title: HTMLElement;
  meta: HTMLElement;
  reportJob: HTMLElement;
  stages: HTMLOListElement;
  changesBox: HTMLElement;
  changeCount: HTMLElement;
  changes: HTMLUListElement;
  findings: HTMLElement;
  sampleSelect: HTMLSelectElement;
}

type Parts = { pre: string; oldMid: string; newMid: string; suf: string };
type Line = {
  li: HTMLLIElement; tx: HTMLElement; c: HTMLElement; p: HTMLElement; parts: Parts;
  changed: boolean; done: boolean; rm: boolean; i: number;
  y: number; hgt: number; cy: number; x0: number; xw: number; sx0: number; sx1: number; cx: number;
  owner?: RunGoose;
};
type Flight = { sx: number; sy: number; x: number; y: number; t: number; dur: number };
type RunGoose = GoosePose & {
  id: number; size: number; speed: number; hz: number; seed: number; peckT: number;
  mode: "fly" | "land" | "ground" | "air"; fl: Flight | null; landT: number;
  laneX: number; queue: Line[]; rankF: number; tailY: number | null;
  airT: number; dropT: number; dx: number; rk: number; side: number;
};
type Air = {
  x: number; y: number; v: number; t: number; dur: number; landing: boolean; landT: number; leave: boolean;
  minDx: number; maxDx: number; toY?: number;
};
type Mark = { x: number; y: number; h: number; trail?: boolean };

const STAGES = ["Inspect", "Plan", "Quote", "Record", "Freeze", "Build", "Verify", "Deliver"];
/** Seconds each stage before Build lasts in the demo. */
const PRE = [1.6, 1.3, 1.0, 1.3, 1.0];
const PRINT = "rgba(92,66,40,0.6)";
const TRAIL = "rgba(92,66,40,0.38)";
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Split a changed line into the common prefix, the old and new middle, and the common suffix. */
function splitLine(o: string, n: string): Parts {
  let a = 0;
  while (a < o.length && a < n.length && o[a] === n[a]) a++;
  let b = 0;
  while (b < o.length - a && b < n.length - a && o[o.length - 1 - b] === n[n.length - 1 - b]) b++;
  return { pre: o.slice(0, a), oldMid: o.slice(a, o.length - b), newMid: n.slice(a, n.length - b), suf: o.slice(o.length - b) };
}

function span(cls: string, text = "") {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

export function createRun(els: RunElements, reduceMotion: boolean) {
  const ctx = els.canvas.getContext("2d")!;
  const run = {
    key: "flask-fastapi" as SampleKey, pair: PAIRS["flask-fastapi"] as Sample,
    started: false, visible: false,
    lines: [] as Line[], changes: [] as Line[], geese: [] as RunGoose[], prints: [] as Mark[], drops: [] as { x: number; y: number }[],
    w: 1, h: 1, dpr: 1, lh: 26, sc: 0.68, contentH: 0, camY: 0,
    stage: 0, t: 0, cur: 0, doneCount: 0, total: 0, verifyT: 0, deliverT: 0, leaveT: 0, walkT: 0, walkConv: 0,
    phase: "enter" as "enter" | "build" | "tail" | "leave",
    air: null as Air | null,
  };

  function buildRun(key: SampleKey) {
    const P = PAIRS[key];
    run.key = key;
    run.pair = P;
    els.code.textContent = "";
    run.lines = P.old.map((o, i) => {
      const n = P.neu[i];
      const changed = o !== n;
      const li = document.createElement("li");
      li.className = changed ? "todo" : "same";
      const parts = changed ? splitLine(o, n) : { pre: o, oldMid: "", newMid: "", suf: "" };
      const p = span("p", o ? parts.pre : " "), c = span("c", parts.oldMid), s = span("s", parts.suf);
      const tx = span("tx");
      tx.append(p, c, s);
      li.append(span("no", String(i + 1)), span("mk"), tx);
      els.code.appendChild(li);
      return { li, tx, c, p, parts, changed, done: !changed, rm: P.removed.includes(i), i, y: 0, hgt: 0, cy: 0, x0: 0, xw: 0, sx0: 0, sx1: 0, cx: 0 };
    });
    run.changes = run.lines.filter((l) => l.changed);
    run.total = run.changes.length;
    Object.assign(run, { doneCount: 0, cur: 0, stage: 0, t: 0, prints: [], drops: [], verifyT: 0, deliverT: 0, phase: "enter", air: null, walkT: 0, walkConv: 0 });
    els.fileName.textContent = "";
    const b = document.createElement("b");
    b.textContent = P.fileOld;
    els.fileName.appendChild(b);
    els.fileMeta.textContent = P.meta;
    els.pillFile.textContent = P.fileOld === P.fileNew ? P.fileOld : `${P.fileOld} → ${P.fileNew}`;
    els.title.textContent = SAMPLE_TITLES[key];
    els.meta.textContent = `${P.from} → ${P.to}`;
    els.reportJob.textContent = SAMPLE_TITLES[key].toUpperCase();
    els.sampleSelect.value = key;
    els.changes.textContent = "";
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Changes appear here as the geese work down the file.";
    els.changes.appendChild(empty);
    els.findings.hidden = true;
    els.findings.textContent = "";
    els.changesBox.hidden = false;
    renderStages();
    updatePill();
    run.camY = 0;
    els.scroll.style.transform = "translateY(0)";
    measure();
  }

  function renderStages() {
    els.stages.textContent = "";
    STAGES.forEach((s, i) => {
      const li = document.createElement("li");
      li.className = i < run.stage ? "done" : i === run.stage ? "active" : "";
      const sm = document.createElement("small");
      if (i < run.stage || (i === run.stage && i >= 5)) sm.textContent = stageDetail(i);
      li.append(span("", s), span("st", i < run.stage ? "done" : i === run.stage ? "running" : ""), sm);
      els.stages.appendChild(li);
    });
  }
  function stageDetail(i: number) {
    const P = run.pair;
    if (i < 5) return P.logs[STAGES[i]] ?? "";
    if (i === 5) return `${run.doneCount} of ${run.total} lines changed`;
    if (i === 6) {
      const k = clamp(run.verifyT / 3, 0, 1);
      return `${fmt(P.verify.n * k)} of ${fmt(P.verify.n)} ${P.verify.label}`;
    }
    if (i === 7) return "Changed code, report, switch-over plan, rollback guide";
    return "";
  }
  function setStageText() {
    const sm = els.stages.children[run.stage]?.querySelector("small");
    if (sm) sm.textContent = stageDetail(run.stage);
  }
  function updatePill() {
    els.pillCount.textContent = `${run.doneCount} of ${run.total} lines`;
    els.pillBar.style.width = `${run.total ? (run.doneCount / run.total) * 100 : 0}%`;
    els.changeCount.textContent = `${run.doneCount} of ${run.total}`;
  }

  /** Where every line and every changed span sits on the page, in the page's own coordinates. */
  function measure() {
    if (!els.page.isConnected) return;
    const f = fitCanvas(els.canvas);
    run.w = f.w; run.h = f.h; run.dpr = f.dpr;
    const S = els.scroll.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(els.code).lineHeight) || 26;
    run.lh = lh;
    for (const l of run.lines) {
      const r = l.li.getBoundingClientRect();
      l.y = r.top - S.top; l.hgt = r.height; l.cy = l.y + lh / 2;
      const tr = l.tx.getBoundingClientRect();
      l.x0 = tr.left - S.left; l.xw = tr.width;
      const rects = l.c.getClientRects();
      if (rects.length === 1 && rects[0].width > 0) { l.sx0 = rects[0].left - S.left; l.sx1 = rects[0].right - S.left; }
      else if (rects.length > 1) { l.sx0 = l.x0; l.sx1 = l.x0 + Math.min(l.xw, 360); }
      else {
        const pr = l.p.getClientRects();
        const x = pr.length ? pr[pr.length - 1].right - S.left : l.x0;
        l.sx0 = x - 8; l.sx1 = x + 8;
      }
      if (l.sx1 - l.sx0 < 14) { const m = (l.sx0 + l.sx1) / 2; l.sx0 = m - 7; l.sx1 = m + 7; }
      l.cx = clamp((l.sx0 + l.sx1) / 2, 30, run.w - 24);
    }
    run.contentH = els.scroll.offsetHeight;
    run.sc = run.w < 520 ? 0.5 : 0.68;
    for (const g of run.geese) g.scale = run.sc * g.size;
  }

  /** Each bird gets a lane across the page and the changes nearest it, spread fairly. */
  function assignOwners() {
    const n = run.geese.length;
    const left = run.lines.length ? run.lines[0].x0 : 60, right = Math.min(run.w - 28, left + 600);
    run.geese.forEach((g, i) => { g.laneX = left + ((i + 0.5) / n) * (right - left); g.queue = []; });
    const expect = run.geese.map((g) => g.laneX), count = run.geese.map(() => 0);
    let prev = -1;
    for (const c of run.changes) {
      let best = 0, bc = Infinity;
      run.geese.forEach((_, i) => {
        const cost = Math.abs(c.cx - expect[i]) + (i === prev ? 70 : 0) + count[i] * 6;
        if (cost < bc) { bc = cost; best = i; }
      });
      c.owner = run.geese[best];
      run.geese[best].queue.push(c);
      expect[best] = c.cx;
      count[best]++;
      prev = best;
    }
  }
  const nextOwn = (g: RunGoose) => g.queue.find((c) => !c.done);

  function spawnGeese() {
    const sizes = [1.14, 0.84, 1.0, 0.92, 1.2, 0.88];
    run.geese = sizes.map((size, id) => ({
      id, size, x: 0, y: -200, heading: DOWN, speed: 0, alt: 1, sigma: 1, flapT: rnd(0, TAU), flapAmp: 0.6, hz: rnd(2.6, 3.3) / Math.sqrt(size),
      gait: rnd(0, 1), walking: 0, neckYaw: 0, reach: 0, scale: run.sc * size, seed: rnd(0, 100), mode: "fly", fl: null, landT: 0,
      peckT: rnd(1, 4), outline: "rgba(46,34,22,0.42)", laneX: 0, queue: [], rankF: 0, tailY: null, airT: 0, dropT: 1, dx: 0, rk: 0, side: 0,
    }));
  }

  function flyTo(g: RunGoose, x: number, y: number, delay: number) {
    const dist = Math.hypot(x - g.x, y - g.y);
    g.mode = "fly";
    g.fl = { sx: g.x, sy: g.y, x, y, t: -delay, dur: clamp(dist / 150, 1.4, 3.4) };
  }
  /** The flock flies in from above the page and lands just above the first change. */
  function flyIn(target: Line | null) {
    const lead = target?.owner;
    const order = run.geese.slice().sort((a, b) => (a === lead ? -1 : b === lead ? 1 : Math.abs(a.x - (lead ? lead.x : 0)) - Math.abs(b.x - (lead ? lead.x : 0))));
    order.forEach((g, r) => {
      g.rankF = r;
      const own = nextOwn(g);
      const tx = own ? own.cx : g.laneX;
      const ty = target ? (g === lead ? target.y - 24 : target.y - 30 - (r % 2 ? 10 : 2)) : run.contentH + 220;
      g.x = clamp(tx + rnd(-30, 30), 30, run.w - 30);
      g.y = run.camY - 120 - r * 50;
      g.alt = 1; g.sigma = 1; g.heading = DOWN;
      flyTo(g, clamp(tx, 30, run.w - 24), Math.max(14, ty), r * 0.12 + rnd(0, 0.08));
    });
  }

  function steerDown(g: RunGoose, tx: number, ty: number, dt: number, now: number) {
    let want = Math.atan2(ty - g.y, tx - g.x);
    if (ty <= g.y) want = DOWN;
    want = clamp(want, DOWN - 0.5, DOWN + 0.5) + Math.sin(now * 0.9 + g.seed) * 0.05;
    g.heading += clamp(angDiff(g.heading, want), -1.1 * dt, 1.1 * dt);
  }

  function convertLine(c: Line | undefined, g: RunGoose | null) {
    if (!c || c.done) return;
    c.done = true;
    c.c.textContent = c.parts.newMid;
    c.li.className = "done" + (c.rm ? " rm" : "");
    run.doneCount++;
    run.cur++;
    if (g && g.mode === "air") {
      // from the air the mark is a dropping, landing on the characters that change
      run.drops.push({ x: clamp(g.x, c.sx0 + 4, c.sx1 - 4), y: c.cy + 1 });
    } else if (g) {
      run.walkConv++;
      // footsteps on the exact characters that change (or anywhere on the line if the bird is too far off)
      const footX = g.x + Math.cos(g.heading) * 13 * g.scale;
      const near = footX > c.sx0 - 45 && footX < c.sx1 + 45;
      const perp = 7.5 * g.scale;
      const xs = [footX - perp, footX + perp].map((x) => (near ? clamp(x, c.sx0 + 3, c.sx1 - 3) : x));
      run.prints.push({ x: xs[0], y: c.cy - 2, h: g.heading - 0.1 }, { x: xs[1], y: c.cy + 3, h: g.heading + 0.1 });
      if (c.sx1 - c.sx0 > 120 && near) run.prints.push({ x: clamp(footX + (footX < (c.sx0 + c.sx1) / 2 ? 34 : -34), c.sx0 + 3, c.sx1 - 3), y: c.cy, h: g.heading });
      if (c.rm) run.drops.push({ x: Math.min(c.sx1 + 12, run.w - 20), y: c.cy + 1 });
    }
    els.changes.querySelector(".empty")?.remove();
    const li = document.createElement("li");
    li.append(span("chg-ln", "L" + (c.i + 1)), span("", run.pair.notes[c.i] || "Line rewritten"));
    els.changes.prepend(li);
    while (els.changes.children.length > 7) els.changes.lastChild!.remove();
    updatePill();
    setStageText();
    measure();
    if (run.doneCount >= run.total) { nextStage(); run.phase = "tail"; startTail(); }
  }

  function startTail() {
    const last = run.lines[run.lines.length - 1];
    const ty = last.y + last.hgt + 34;
    const minY = Math.min(...run.geese.map((g) => g.y));
    for (const g of run.geese) g.tailY = ty - (g.id % 2) * 14;
    // a long way to go: take off together and fly down to the end of the file, then walk the last steps
    if (run.air && !run.air.landing) { run.air.dur = Infinity; run.air.toY = ty - 40; }
    else if (ty - minY > 6 * run.lh && !run.air && run.geese.every((g) => g.mode === "ground")) {
      startAir(false);
      run.air!.dur = Infinity;
      run.air!.toY = ty - 40;
    }
  }

  function nextStage() {
    run.stage++;
    run.t = 0;
    if (run.stage === 5) run.phase = "build";
    if (run.stage === 6) run.verifyT = 0;
    if (run.stage === 7) showFindings();
    renderStages();
  }
  function showFindings() {
    els.findings.textContent = "";
    run.pair.findings.forEach((f, i) => {
      const d = document.createElement("div");
      d.className = "finding";
      d.style.animationDelay = `${i * 90}ms`;
      const b = document.createElement("b");
      b.textContent = f[1].replace("{n}", String(run.total));
      const sm = document.createElement("small");
      sm.textContent = f[2];
      d.append(span("chip" + (f[0] === "Checked" || f[0] === "Data" ? " gold" : ""), f[0]), b, sm);
      els.findings.appendChild(d);
    });
    els.changesBox.hidden = true;
    els.findings.hidden = false;
  }

  function start(key: SampleKey) {
    buildRun(key);
    run.started = true;
    if (!run.geese.length) spawnGeese();
    for (const g of run.geese) { g.scale = run.sc * g.size; g.tailY = null; }
    assignOwners();
    if (reduceMotion) { finishStatic(); return; }
    flyIn(run.changes[0] ?? null);
  }

  function updateGoose(g: RunGoose, dt: number, now: number) {
    if ((g.sigma ?? 0) > 0.01) advanceFlap(g, dt, g.hz);
    if (g.mode === "fly" && g.fl) {
      const f = g.fl;
      f.t += dt;
      const uu = clamp(f.t / f.dur, 0, 1);
      const s = easeInOut(uu), mid = Math.sin(Math.PI * uu);
      const lead = run.geese.find((x) => x.rankF === 0) ?? g;
      let x = lerp(f.sx, f.x, s), y = lerp(f.sy, f.y, s);
      // loose V while flying in: followers drift in behind the lead bird, each on the side it is already on
      if (g !== lead) {
        const lx = lerp(lead.fl ? lead.fl.sx : lead.x, lead.fl ? lead.fl.x : lead.x, s);
        x += (lx + (f.x < (lead.fl ? lead.fl.x : lead.x) ? -1 : 1) * Math.ceil(g.rankF / 2) * 46 - x) * 0.35 * mid;
        y -= Math.ceil(g.rankF / 2) * 26 * mid;
      }
      const vx = x - g.x, vy = y - g.y;
      g.x = x; g.y = y;
      if (Math.hypot(vx, vy) > 0.2) g.heading += angDiff(g.heading, Math.atan2(vy, vx)) * Math.min(1, dt * 5);
      g.alt = uu <= 0 ? g.alt : smooth(0, 0.22, uu) * (1 - smooth(0.8, 1, uu));
      if (f.t < 0 && (g.alt ?? 0) < 0.05) g.alt = 0;
      g.sigma = f.t < 0 ? g.sigma : Math.max(smooth(0, 0.14, uu), 1 - smooth(0.98, 1, uu));
      let amp = lerp(0.9, 0.16, smooth(0.15, 0.35, uu));
      amp = lerp(amp, 0.72, smooth(0.68, 0.85, uu));
      g.flapAmp = amp; g.walking = 0; g.reach = 0; g.neckYaw = (g.neckYaw ?? 0) * 0.9;
      if (uu >= 1) { g.mode = "land"; g.landT = 0; g.alt = 0; }
      return;
    }
    if (g.mode === "air") { updateAir(g, dt, now); return; }
    if (g.mode === "land") {
      g.landT += dt;
      g.sigma = 1 - smooth(0, 0.35, g.landT);
      if (g.landT > 0.35) { g.sigma = 0; g.mode = "ground"; }
    }
    // on the ground: walk down toward the bird's next change, but never past the current line
    const cur = run.changes[run.cur];
    let tx = g.laneX, ty = g.y, owner = false;
    if (run.phase === "build" && cur) {
      const own = nextOwn(g);
      owner = own === cur;
      if (owner) { tx = cur.cx; ty = cur.cy + 4; }
      else { tx = own ? lerp(own.cx, g.laneX, 0.7) : g.laneX; ty = cur.y - 22 - (g.id % 2) * 12; }
      // keep a little room between neighbours
      for (const o of run.geese) {
        if (o === g || o.mode !== "ground") continue;
        const dx = g.x - o.x;
        if (Math.abs(dx) < 56 * (g.scale / 0.68) && Math.abs(g.y - o.y) < 60) tx += (dx >= 0 ? 1 : -1) * 40;
      }
    } else if (run.phase === "tail" && g.tailY != null) ty = g.tailY;
    const moving = ty > g.y + 3;
    if (moving) {
      steerDown(g, tx, ty, dt, now);
      g.speed += (58 * (g.scale / 0.68) - g.speed) * Math.min(1, dt * 3);
      g.neckYaw = (g.neckYaw ?? 0) * (1 - Math.min(1, dt * 3));
      g.reach = (g.reach ?? 0) * 0.9;
    } else {
      g.speed *= Math.pow(0.02, dt);
      g.heading += angDiff(g.heading, DOWN) * Math.min(1, dt * 0.8);
      // standing: look around and pick at the code
      g.neckYaw = (g.neckYaw ?? 0) + (Math.sin(now * 0.55 + g.seed) * 0.5 - (g.neckYaw ?? 0)) * Math.min(1, dt * 2);
      g.peckT -= dt;
      if (g.peckT < 0) {
        g.reach = Math.max(0, Math.sin(-g.peckT * 7));
        if (g.peckT < -0.9) { g.peckT = rnd(1.5, 4); g.reach = 0; }
      }
    }
    const dist = g.speed * dt;
    g.x = clamp(g.x + Math.cos(g.heading) * dist, 24, run.w - 18);
    g.y += Math.sin(g.heading) * dist;
    const before = g.gait ?? 0;
    g.gait = before + dist / (36 * g.scale);
    if ((g.walking ?? 0) > 0.4 && Math.floor(before * 2) !== Math.floor(g.gait * 2)) {
      const side = Math.floor(g.gait * 2) % 2 ? 1 : -1;
      const lx = 18 * g.scale, ly = side * 9 * g.scale, c = Math.cos(g.heading), sn = Math.sin(g.heading);
      run.prints.push({ x: g.x + lx * c - ly * sn, y: g.y + lx * sn + ly * c, h: g.heading + side * 0.1, trail: true });
      if (run.prints.length > 2400) run.prints.splice(0, 300);
    }
    g.walking = (g.walking ?? 0) + ((g.speed > 6 ? 1 : 0) - (g.walking ?? 0)) * Math.min(1, dt * 6);
    if (owner && cur && g.y + Math.sin(g.heading) * 13 * g.scale >= cur.cy - 1) convertLine(cur, g);
  }

  /* Flock flight. Places in the V keep each bird's order across the page, so nobody crosses another's path,
     opened out just enough that wings don't touch. The lead is the middle bird nearest the work. */
  function startAir(leave: boolean) {
    const cur = leave ? undefined : run.changes[run.cur];
    const aimX = cur ? cur.cx : run.w / 2;
    const byX = run.geese.slice().sort((a, b) => a.x - b.x), n = byX.length;
    const gap = Math.min(0.62 * 218 * run.sc, (run.w - 60) / Math.max(1, n - 1));
    const xs = byX.map((g) => g.x);
    for (let it = 0; it < 6; it++) for (let k = 1; k < n; k++) {
      const d = gap - (xs[k] - xs[k - 1]);
      if (d > 0) { xs[k] += d / 2; xs[k - 1] -= d / 2; }
    }
    const lo = 30, hi = run.w - 24;
    let shift = 0;
    if (xs[0] < lo) shift = lo - xs[0];
    else if (xs[n - 1] > hi) shift = hi - xs[n - 1];
    for (let k = 0; k < n; k++) xs[k] = clamp(xs[k] + shift, lo, hi);
    const m = n >> 1;
    const li = m > 0 && Math.abs(byX[m - 1].x - aimX) < Math.abs(byX[m].x - aimX) ? m - 1 : m;
    const front = Math.max(...run.geese.map((g) => g.y));
    byX.forEach((g, k) => { g.dx = xs[k] - xs[li]; g.rk = Math.abs(k - li); g.side = Math.sign(k - li); });
    run.air = { x: xs[li], y: front, v: 78, t: 0, dur: leave ? Infinity : rnd(4.2, 5.6), landing: false, landT: 0, leave,
      minDx: Math.min(...byX.map((g) => g.dx)), maxDx: Math.max(...byX.map((g) => g.dx)) };
    for (const g of run.geese) {
      g.rankF = g.rk;
      g.mode = "air";
      g.airT = -(g.rk * 0.26 + (g.side > 0 ? 0.12 : 0) + rnd(0, 0.08)); // one after another, lead first
      g.dropT = rnd(0.5, 1.2);
    }
    run.walkT = 0;
    run.walkConv = 0;
  }

  function updateAir(g: RunGoose, dt: number, now: number) {
    const A = run.air!;
    g.airT += dt;
    if (g.airT < 0) { g.speed *= Math.pow(0.05, dt); return; } // waiting for its turn to go
    const wob = g.rk ? 1 : 0.4;
    const sx = clamp(A.x + g.dx + Math.sin(now * 0.8 + g.seed) * 6 * wob, 30, run.w - 24);
    const sy = A.y - g.rk * 96 * (run.sc / 0.68) + Math.cos(now * 0.6 + g.seed) * 5 * wob;
    // fly like a bird: always forward along the heading, which stays close to straight down;
    // reaching its place in the V is done by leaning a little, never by sliding sideways
    let vx = clamp((sx - g.x) * 0.9, -60, 60), cap = Infinity;
    for (const o of run.geese) {
      if (o === g || o.mode !== "air" || o.airT < 0) continue;
      const dx = g.x - o.x, dy = g.y - o.y;
      const sep = (74 * (g.scale + o.scale)) / 1.36;
      if (Math.abs(dx) < sep && Math.abs(dy) < 70) vx += (dx > 0 || (dx === 0 && g.id > o.id) ? 1 : -1) * 70 * (1 - Math.abs(dx) / sep);
      if (Math.abs(dx) < sep * 0.8 && dy < 0 && dy > -64) cap = Math.min(cap, o.speed * 0.85); // close behind: ease off
    }
    const v = Math.max(34, g.speed);
    const want = DOWN - clamp(Math.atan2(vx, v), -0.45, 0.45);
    const steer = smooth(0.1, 0.6, g.airT); // hardly any turning during the take-off run
    g.heading += clamp(angDiff(g.heading, want), -dt, dt) * steer;
    const behind = sy - g.y; // > 0: its place is ahead, so speed up
    let target = A.landing ? 18 : clamp(A.v + behind * 1.1, A.v * 0.45, A.v + 70);
    if (g.airT < 0.5) target = Math.max(target, 30 + 80 * g.airT); // the run builds speed before lift-off
    if (!A.landing) target = Math.max(A.v * 0.4, Math.min(target, cap));
    g.speed += (target - g.speed) * Math.min(1, dt * (g.airT < 0.5 ? 2.6 : 1.5));
    const dist = g.speed * dt;
    g.x = clamp(g.x + Math.cos(g.heading) * dist, 24, run.w - 18);
    g.y += Math.sin(g.heading) * dist;
    // feet patter for the first moments, then fold away
    g.walking = 1 - smooth(0.22, 0.5, g.airT);
    if (g.walking > 0.05) g.gait = (g.gait ?? 0) + dist / (36 * g.scale);
    if (A.landing) {
      g.alt = Math.min(g.alt ?? 0, 0.65 * (1 - smooth(0, 0.8, A.landT)));
      g.flapAmp = lerp(0.65, 0.85, smooth(0.3, 0.8, A.landT));
    } else {
      g.alt = 0.65 * smooth(0.25, 1.0, g.airT);
      const glide = smooth(0.5, 0.9, Math.sin(now * 0.7 + g.seed));
      g.flapAmp = g.airT < 1.0 ? 0.95 : 0.7 * (1 - 0.7 * glide);
    }
    g.sigma = A.landing ? 1 : Math.max(g.sigma ?? 0, smooth(0, 0.3, g.airT));
    g.reach = 0;
    g.neckYaw = (g.neckYaw ?? 0) * 0.9;
    // droppings while flying, a little less often than footsteps
    if (g.alt > 0.4) {
      g.dropT -= dt;
      if (g.dropT <= 0) {
        const c = Math.cos(g.heading), sn = Math.sin(g.heading);
        run.drops.push({ x: g.x - c * 30 * g.scale, y: g.y - sn * 30 * g.scale });
        if (run.drops.length > 500) run.drops.splice(0, 60);
        g.dropT = rnd(0.7, 1.3);
      }
    }
    if (A.landing && A.landT > 0.8) { g.alt = 0; g.mode = "land"; g.landT = 0; }
  }

  function updateAirLead(dt: number) {
    const A = run.air;
    if (!A) return;
    A.t += dt;
    const cur = run.changes[run.cur];
    const near = cur && cur.cy - A.y < 2.5 * run.lh;
    A.v = A.leave ? Math.min(110, 60 + A.t * 30) : near ? 42 : 78;
    A.y += A.v * dt;
    // keep the whole V on the page; the V drifts over gently toward the work
    const tx = clamp(cur && !A.leave ? cur.cx : run.w / 2, 30 - A.minDx, Math.max(30 - A.minDx, run.w - 24 - A.maxDx));
    A.x += clamp(tx - A.x, -A.v * 0.25 * dt, A.v * 0.25 * dt);
    // the flock converts each change as it passes over it
    if (cur && !A.landing && !A.leave) {
      const over = run.geese.filter((g) => g.mode === "air" && (g.alt ?? 0) > 0.4 && g.y >= cur.cy - 4);
      if (over.length) convertLine(cur, over.sort((a, b) => Math.abs(a.x - cur.cx) - Math.abs(b.x - cur.cx))[0]);
    }
    if (!A.landing && (A.t > A.dur || (A.toY != null && A.y >= A.toY))) { A.landing = true; A.landT = 0; }
    if (A.landing) { A.landT += dt; A.v = 20; }
    if (run.geese.every((g) => g.mode !== "air")) run.air = null;
  }

  function update(dt: number, now: number) {
    run.t += dt;
    if (run.stage < 5 && run.t > PRE[run.stage]) nextStage();
    if (run.stage === 6) { run.verifyT += dt; setStageText(); if (run.verifyT > 3.2) nextStage(); }
    if (run.stage === 7) {
      run.deliverT += dt;
      if (run.deliverT > 13 && run.phase !== "leave") { run.phase = "leave"; startAir(true); run.leaveT = 0; }
    }
    if (run.phase === "leave") {
      run.leaveT += dt;
      if (run.leaveT > 3.6) { start(PAIR_ORDER[(PAIR_ORDER.indexOf(run.key) + 1) % PAIR_ORDER.length]); return; }
    }
    // the flock alternates: walk a stretch, then fly a stretch (always over long runs of unchanged code)
    if (run.phase === "build") {
      const cur = run.changes[run.cur];
      const ground = run.geese.every((g) => g.mode === "ground");
      if (ground) run.walkT += dt;
      if (cur && ground && !run.air) {
        const minY = Math.min(...run.geese.map((g) => g.y));
        if (run.walkConv >= 3 || run.walkT > 8 || cur.y - minY > 6 * run.lh + 30) startAir(false);
      }
    }
    if (run.air) updateAirLead(dt);
    for (const g of run.geese) updateGoose(g, dt, now);
    // the camera follows the flock: the page scrolls up under the birds
    const focus = run.geese.reduce((a, g) => a + g.y, 0) / run.geese.length;
    const camT = clamp(focus - run.h * 0.3, 0, Math.max(0, run.contentH - run.h + 40));
    run.camY += (camT - run.camY) * Math.min(1, dt * 1.8);
    els.scroll.style.transform = `translateY(${(-run.camY).toFixed(1)}px)`;
  }

  function draw() {
    const { dpr, w, h } = run;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(0, -run.camY);
    for (const p of run.prints) if (p.y > run.camY - 30 && p.y < run.camY + h + 30) drawPrint(ctx, p.x, p.y, p.h, run.sc * 1.3, p.trail ? TRAIL : PRINT);
    for (const d of run.drops) drawDropping(ctx, d.x, d.y, run.sc * 1.2);
    const vis = run.geese.filter((g) => g.y > run.camY - 220 && g.y < run.camY + h + 220);
    for (const g of vis) drawGooseShadow(ctx, g, "rgba(70,52,34,0.26)");
    vis.sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0));
    for (const g of vis) drawGoose(ctx, g);
  }

  /** Reduced motion: show the finished file with the birds standing at the end of it. */
  function finishStatic() {
    run.changes.forEach((c, i) => {
      const g = run.geese[i % run.geese.length];
      g.mode = "ground"; g.x = c.cx; g.y = c.cy - 14; g.heading = DOWN;
      convertLine(c, g);
    });
    const last = run.lines[run.lines.length - 1];
    run.geese.forEach((g, i) => {
      Object.assign(g, { mode: "ground", alt: 0, sigma: 0, scale: run.sc * g.size, x: g.laneX, y: last.y + last.hgt + 30 - (i % 2) * 14, heading: DOWN });
    });
    while (run.stage < 7) nextStage();
    run.camY = 0;
    draw();
  }

  buildRun(run.key);

  return {
    start,
    measure,
    get started() { return run.started; },
    get key() { return run.key; },
    setVisible(v: boolean) { run.visible = v; },
    frame(dt: number, now: number) {
      if (run.visible && run.started && !reduceMotion) { update(dt, now); draw(); }
    },
    redraw() { if (run.started) draw(); },
  };
}
