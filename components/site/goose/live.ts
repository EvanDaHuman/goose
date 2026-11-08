/* A job's live run: the same six geese as the homepage demo, working down the customer's real code on a paper page.
   - replay: the latest real diff, one changed file at a time. Walking, the geese leave footprints and step on the
     exact characters that change, which rewrite in place; added lines appear, removed lines are struck through.
     Every so often they take off one after another and fly a stretch in a loose V, leaving droppings; a change
     they fly over is converted and marked with a dropping. Folded stretches of unchanged code are always flown over.
     When a file is done they fly off the bottom of the page and come in again on the next one.
   - read: before any diff exists, the geese walk the customer's source untouched, looking and pecking, file after file.
   They always move down the page and never get ahead of the change being made; the page scrolls up under them.
   Movement and drawing follow components/site/goose/run.ts (the homepage demo). */
import type { LiveCode, LiveFile, LiveRow } from "@/lib/liveCode";
import { advanceFlap, drawDropping, drawGoose, drawGooseShadow, drawPrint, type GoosePose } from "./draw";
import { DOWN, TAU, angDiff, clamp, easeInOut, fitCanvas, lerp, rnd, smooth } from "./math";

export interface LiveElements {
  page: HTMLElement;
  scroll: HTMLElement;
  code: HTMLOListElement;
  canvas: HTMLCanvasElement;
}
export interface LiveEvents {
  /** A new file is on the page. */
  file(index: number): void;
  /** Lines converted so far, on this file and across the whole change. */
  progress(p: { file: number; fileDone: number; fileTotal: number; done: number; total: number }): void;
  /** One change was made (replay only). */
  change(c: { path: string; line: number; kind: "chg" | "add" | "del"; lines: number; text: string }): void;
  /** The last file is done (replay only). */
  finish(): void;
}

type Row = {
  r: LiveRow; li: HTMLLIElement; tx: HTMLElement; c: HTMLElement | null; p: HTMLElement | null;
  parts: { pre: string; oldMid: string; newMid: string; suf: string } | null;
};
type Unit = {
  rows: Row[]; kind: "chg" | "add" | "del" | "read"; done: boolean; lines: number;
  y: number; hgt: number; cy: number; sx0: number; sx1: number; cx: number; owner?: LiveGoose;
};
type Flight = { sx: number; sy: number; x: number; y: number; t: number; dur: number };
type LiveGoose = GoosePose & {
  id: number; size: number; speed: number; hz: number; seed: number; peckT: number;
  mode: "fly" | "land" | "ground" | "air"; fl: Flight | null; landT: number;
  laneX: number; queue: Unit[]; rankF: number; tailY: number | null;
  airT: number; dropT: number; dx: number; rk: number; side: number;
};
type Air = {
  x: number; y: number; v: number; t: number; dur: number; landing: boolean; landT: number; leave: boolean; wave: number;
  minDx: number; maxDx: number; toY?: number;
};
type Mark = { x: number; y: number; h: number; trail?: boolean };

const PRINT = "rgba(92,66,40,0.6)";
const TRAIL = "rgba(92,66,40,0.38)";
/** About this many stops for the whole change, however big it is: big diffs convert a few lines per stop. */
const TARGET_UNITS = 70;

/** Split a changed line into the common prefix, the old and new middle, and the common suffix. */
function splitLine(o: string, n: string) {
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

const changedRows = (f: LiveFile) => f.rows.filter((r) => r.k === "chg" || r.k === "add" || r.k === "del").length;
const foldText = (r: Extract<LiveRow, { k: "fold" }>) => {
  const n = r.count.toLocaleString("en-US");
  if (r.what === "added") return `… ${n} more new lines`;
  if (r.what === "removed") return `… ${n} more removed lines`;
  if (r.what === "more") return `… ${n} more changed lines in this file`;
  return `… ${n} unchanged line${r.count === 1 ? "" : "s"}`;
};

export function createLive(els: LiveElements, ev: LiveEvents, reduceMotion: boolean) {
  const ctx = els.canvas.getContext("2d")!;
  const run = {
    data: null as LiveCode | null, fi: 0, perStop: 1,
    started: false, visible: false, finished: false,
    rows: [] as Row[], units: [] as Unit[], folds: [] as number[], geese: [] as LiveGoose[], prints: [] as Mark[], drops: [] as { x: number; y: number }[],
    w: 1, h: 1, dpr: 1, lh: 26, sc: 0.68, contentH: 0, camY: 0, camV: 0, camDraw: 0,
    survey: false, cur: 0, fileDone: 0, fileTotal: 0, doneBefore: 0, total: 0, walkT: 0, walkConv: 0, tailT: 0, leaveT: 0,
    phase: "build" as "build" | "tail" | "leave" | "rest",
    air: null as Air | null,
  };
  const replay = () => run.data?.mode === "replay";

  // ------------------------------------------------------------------ the page

  function buildFile(i: number) {
    const f = run.data!.files[i];
    run.fi = i;
    els.code.textContent = "";
    run.rows = f.rows.map((r) => {
      const li = document.createElement("li");
      const tx = span("tx");
      let c: HTMLElement | null = null, p: HTMLElement | null = null, parts: Row["parts"] = null, no = "";
      if (r.k === "fold") {
        li.className = "fold";
        tx.textContent = foldText(r);
      } else if (r.k === "same") {
        li.className = "same";
        tx.textContent = r.t || " ";
        no = String(r.n);
      } else if (r.k === "chg") {
        li.className = "chg todo";
        parts = splitLine(r.o, r.t);
        p = span("p", parts.pre);
        c = span("c", parts.oldMid);
        tx.append(p, c, span("s", parts.suf));
        if (!r.o && !r.t) tx.textContent = " ";
        no = String(r.n);
      } else if (r.k === "add") {
        li.className = "add todo";
        c = span("c", r.t || " ");
        tx.append(c);
        no = String(r.n);
      } else {
        li.className = "del todo";
        c = span("c", r.o || " ");
        tx.append(c);
      }
      li.append(span("no", no), span("mk"), tx);
      els.code.appendChild(li);
      return { r, li, tx, c, p, parts };
    });
    // stops: runs of changed lines, a few lines per stop on a big change; in read mode, a look every few lines
    run.units = [];
    if (replay()) {
      for (let s = 0; s < run.rows.length;) {
        const k = run.rows[s].r.k;
        if (k !== "chg" && k !== "add" && k !== "del") { s++; continue; }
        let e = s;
        while (e < run.rows.length && e - s < run.perStop && run.rows[e].r.k === k) e++;
        const rows = run.rows.slice(s, e);
        run.units.push({ rows, kind: k, done: false, lines: rows.length, y: 0, hgt: 0, cy: 0, sx0: 0, sx1: 0, cx: 0 });
        s = e;
      }
    } else {
      const lines = run.rows.filter((r) => r.r.k === "same" && (r.r as { t: string }).t.trim().length > 3);
      const step = Math.max(4, Math.round(lines.length / 18));
      for (let k = Math.floor(step / 2); k < lines.length; k += step)
        run.units.push({ rows: [lines[k]], kind: "read", done: false, lines: 0, y: 0, hgt: 0, cy: 0, sx0: 0, sx1: 0, cx: 0 });
    }
    run.fileDone = 0;
    run.fileTotal = replay() ? changedRows(f) : 0;
    run.doneBefore = replay() ? run.data!.files.slice(0, i).reduce((a, x) => a + changedRows(x), 0) : 0;
    Object.assign(run, { cur: 0, prints: [], drops: [], air: null, walkT: 0, walkConv: 0, tailT: 0, leaveT: 0, phase: "build" });
    run.camY = 0; run.camV = 0; run.camDraw = 0;
    els.scroll.style.transform = "translate3d(0, 0, 0)";
    measure();
    ev.file(i);
    emitProgress();
  }

  function emitProgress() {
    ev.progress({ file: run.fi, fileDone: run.fileDone, fileTotal: run.fileTotal, done: run.doneBefore + run.fileDone, total: run.total });
  }

  /** Where every stop sits on the page, in the page's own coordinates. */
  function measure() {
    if (!els.page.isConnected) return;
    const f = fitCanvas(els.canvas);
    run.w = f.w; run.h = f.h; run.dpr = f.dpr;
    const S = els.scroll.getBoundingClientRect();
    run.lh = parseFloat(getComputedStyle(els.code).lineHeight) || 26;
    for (const u of run.units) {
      const row = u.rows[0];
      const r = row.li.getBoundingClientRect();
      u.y = r.top - S.top;
      u.hgt = Math.max(r.height, run.lh);
      u.cy = u.y + run.lh / 2;
      const tr = row.tx.getBoundingClientRect();
      const x0 = tr.left - S.left;
      const rects = row.c?.getClientRects();
      if (rects && rects.length === 1 && rects[0].width > 0) { u.sx0 = rects[0].left - S.left; u.sx1 = rects[0].right - S.left; }
      else if (rects && rects.length > 1) { u.sx0 = x0; u.sx1 = x0 + Math.min(tr.width, 360); }
      else if (u.kind === "read") {
        // the words on the line, not the whole column
        const range = document.createRange();
        range.selectNodeContents(row.tx);
        const rr = range.getBoundingClientRect();
        u.sx0 = rr.left - S.left; u.sx1 = Math.min(rr.right - S.left, u.sx0 + 360);
      } else {
        const pr = row.p?.getClientRects();
        const x = pr && pr.length ? pr[pr.length - 1].right - S.left : x0;
        u.sx0 = x - 8; u.sx1 = x + 8;
      }
      if (u.sx1 - u.sx0 < 14) { const m = (u.sx0 + u.sx1) / 2; u.sx0 = m - 7; u.sx1 = m + 7; }
      u.cx = clamp((u.sx0 + u.sx1) / 2, 30, run.w - 24);
    }
    run.folds = run.rows.filter((r) => r.r.k === "fold" && r.r.count >= 6).map((r) => r.li.getBoundingClientRect().top - S.top);
    run.contentH = els.scroll.offsetHeight;
    run.sc = run.w < 520 ? 0.5 : 0.68;
    for (const g of run.geese) g.scale = run.sc * g.size;
  }

  function codeLeft() {
    const first = run.rows.find((r) => r.r.k !== "fold") ?? run.rows[0];
    if (!first) return 60;
    return first.tx.getBoundingClientRect().left - els.scroll.getBoundingClientRect().left;
  }

  /** Each bird gets a lane across the page and the stops nearest it, spread fairly. */
  function assignOwners() {
    const n = run.geese.length;
    const left = codeLeft(), right = Math.min(run.w - 28, left + 600);
    run.geese.forEach((g, i) => { g.laneX = left + ((i + 0.5) / n) * (right - left); g.queue = []; });
    const expect = run.geese.map((g) => g.laneX), count = run.geese.map(() => 0);
    let prev = -1;
    for (const c of run.units) {
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
  const nextOwn = (g: LiveGoose) => g.queue.find((c) => !c.done);

  function spawnGeese() {
    const sizes = [1.14, 0.84, 1.0, 0.92, 1.2, 0.88];
    run.geese = sizes.map((size, id) => ({
      id, size, x: 0, y: -200, heading: DOWN, speed: 0, alt: 1, sigma: 1, flapT: rnd(0, TAU), flapAmp: 0.6, hz: rnd(2.6, 3.3) / Math.sqrt(size),
      gait: rnd(0, 1), walking: 0, neckYaw: 0, reach: 0, scale: run.sc * size, seed: rnd(0, 100), mode: "fly", fl: null, landT: 0,
      peckT: rnd(1, 4), outline: "rgba(46,34,22,0.42)", laneX: 0, queue: [], rankF: 0, tailY: null, airT: 0, dropT: 1, dx: 0, rk: 0, side: 0,
    }));
  }

  // ------------------------------------------------------------------ movement

  function flyTo(g: LiveGoose, x: number, y: number, delay: number) {
    const dist = Math.hypot(x - g.x, y - g.y);
    g.mode = "fly";
    g.fl = { sx: g.x, sy: g.y, x, y, t: -delay, dur: clamp(dist / 150, 1.4, 3.4) };
  }
  /** The flock flies in from above the page and lands just above the first stop. */
  function flyIn(target: Unit | null) {
    const lead = target?.owner;
    const order = run.geese.slice().sort((a, b) => (a === lead ? -1 : b === lead ? 1 : Math.abs(a.laneX - (lead ? lead.laneX : 0)) - Math.abs(b.laneX - (lead ? lead.laneX : 0))));
    order.forEach((g, r) => {
      g.rankF = r;
      const own = nextOwn(g);
      const tx = own ? own.cx : g.laneX;
      const ty = target ? (g === lead ? target.y - 24 : target.y - 30 - (r % 2 ? 10 : 2)) : Math.min(run.contentH, run.h) * 0.4;
      g.x = clamp(tx + rnd(-30, 30), 30, run.w - 30);
      g.y = run.camY - 120 - r * 50;
      g.alt = 1; g.sigma = 1; g.heading = DOWN; g.tailY = null;
      flyTo(g, clamp(tx, 30, run.w - 24), Math.max(14, ty), r * 0.12 + rnd(0, 0.08));
    });
  }

  function steerDown(g: LiveGoose, tx: number, ty: number, dt: number, now: number) {
    let want = Math.atan2(ty - g.y, tx - g.x);
    if (ty <= g.y) want = DOWN;
    want = clamp(want, DOWN - 0.5, DOWN + 0.5) + Math.sin(now * 0.9 + g.seed) * 0.05;
    g.heading += clamp(angDiff(g.heading, want), -1.1 * dt, 1.1 * dt);
  }

  function noteFor(u: Unit) {
    const r = u.rows[0].r as { n: number; t?: string; o?: string };
    // the line as it now reads (or, for removed code, as it read)
    const text = ((u.kind === "del" ? r.o : r.t) ?? "").trim();
    return { path: run.data!.files[run.fi].path, line: r.n, kind: u.kind as "chg" | "add" | "del", lines: u.lines, text: text.length > 60 ? text.slice(0, 59) + "…" : text };
  }

  function convert(u: Unit | undefined, g: LiveGoose | null) {
    if (!u || u.done) return;
    u.done = true;
    run.cur++;
    if (u.kind === "read") {
      for (const row of u.rows) row.li.classList.add("seen");
    } else {
      for (const row of u.rows) {
        if (u.kind === "chg" && row.c && row.parts) row.c.textContent = row.parts.newMid;
        row.li.className = `${u.kind} done`;
      }
      run.fileDone += u.lines;
    }
    if (g && g.mode === "air") {
      // from the air the mark is a dropping, landing on the characters that change
      if (u.kind !== "read") run.drops.push({ x: clamp(g.x, u.sx0 + 4, u.sx1 - 4), y: u.cy + 1 });
    } else if (g) {
      run.walkConv++;
      // footsteps on the exact characters that change (or anywhere on the line if the bird is too far off)
      const footX = g.x + Math.cos(g.heading) * 13 * g.scale;
      const near = footX > u.sx0 - 45 && footX < u.sx1 + 45;
      const perp = 7.5 * g.scale;
      const xs = [footX - perp, footX + perp].map((x) => (near ? clamp(x, u.sx0 + 3, u.sx1 - 3) : x));
      run.prints.push({ x: xs[0], y: u.cy - 2, h: g.heading - 0.1 }, { x: xs[1], y: u.cy + 3, h: g.heading + 0.1 });
      if (u.sx1 - u.sx0 > 120 && near) run.prints.push({ x: clamp(footX + (footX < (u.sx0 + u.sx1) / 2 ? 34 : -34), u.sx0 + 3, u.sx1 - 3), y: u.cy, h: g.heading });
      // removed code is marked with a dropping too
      if (u.kind === "del") run.drops.push({ x: Math.min(u.sx1 + 12, run.w - 20), y: u.cy + 1 });
    }
    if (u.kind !== "read") { ev.change(noteFor(u)); emitProgress(); }
    measure();
    if (run.cur >= run.units.length) { run.phase = "tail"; run.tailT = 0; startTail(); }
  }

  function startTail() {
    const last = run.rows[run.rows.length - 1]?.li;
    const S = els.scroll.getBoundingClientRect();
    const ty = last ? last.getBoundingClientRect().bottom - S.top + 34 : run.h * 0.5;
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

  function startFile(i: number) {
    buildFile(i);
    if (!run.geese.length) spawnGeese();
    for (const g of run.geese) { g.scale = run.sc * g.size; g.tailY = null; }
    assignOwners();
    flyIn(run.units[0] ?? null);
  }

  function start() {
    if (!run.data) return;
    run.started = true;
    if (run.survey && replay()) { run.total = run.data.files.reduce((a, f) => a + changedRows(f), 0); run.perStop = 1; startSurvey(0); return; }
    run.finished = false;
    run.total = replay() ? run.data.files.reduce((a, f) => a + changedRows(f), 0) : 0;
    run.perStop = Math.max(1, Math.ceil(run.total / TARGET_UNITS));
    if (reduceMotion) { finishStatic(); return; }
    startFile(0);
  }

  function updateGoose(g: LiveGoose, dt: number, now: number) {
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
    // on the ground: walk down toward the bird's next stop, but never past the current one
    const cur = run.units[run.cur];
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
    } else if ((run.phase === "tail" || run.phase === "rest") && g.tailY != null) ty = g.tailY;
    const moving = ty > g.y + 3;
    const pace = replay() ? 58 : 40; // reading is a slower walk
    if (moving) {
      steerDown(g, tx, ty, dt, now);
      g.speed += (pace * (g.scale / 0.68) - g.speed) * Math.min(1, dt * 3);
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
    if (owner && cur && g.y + Math.sin(g.heading) * 13 * g.scale >= cur.cy - 1) convert(cur, g);
  }

  /* Flock flight. Places in the V keep each bird's order across the page, so nobody crosses another's path,
     opened out just enough that wings don't touch. The lead is the middle bird nearest the work. */
  function startAir(leave: boolean) {
    const cur = leave ? undefined : run.units[run.cur];
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
    run.air = { x: xs[li], y: front, v: 78, t: 0, dur: leave ? Infinity : rnd(2.6, 3.8), landing: false, landT: 0, leave, wave: rnd(0, TAU),
      minDx: Math.min(...byX.map((g) => g.dx)), maxDx: Math.max(...byX.map((g) => g.dx)) };
    for (const g of run.geese) {
      g.rankF = g.rk;
      g.mode = "air";
      g.airT = -(g.rk * rnd(0.35, 0.75) + rnd(0, 0.7)); // one after another, lead first, each in its own time
      g.dropT = rnd(0.5, 1.2);
    }
    run.walkT = 0;
    run.walkConv = 0;
  }

  function updateAir(g: LiveGoose, dt: number, now: number) {
    const A = run.air!;
    g.airT += dt;
    if (g.airT < 0) { g.speed *= Math.pow(0.05, dt); return; } // waiting for its turn to go
    const wob = g.rk ? 1 : 0.4;
    const sx = clamp(A.x + g.dx + Math.sin(now * 0.8 + g.seed) * 16 * wob, 30, run.w - 24);
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
    // droppings while flying (replay only: reading leaves the customer's code clean)
    if (g.alt > 0.4 && replay() && !run.survey) {
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
    const cur = run.units[run.cur];
    const near = cur && cur.cy - A.y < 2.5 * run.lh;
    A.v = A.leave ? Math.min(110, 60 + A.t * 30) : near ? 42 : 78;
    A.y += A.v * dt;
    // keep the whole V on the page; the V drifts over gently toward the work
    const tx = clamp(cur && !A.leave ? cur.cx : run.w / 2, 30 - A.minDx, Math.max(30 - A.minDx, run.w - 24 - A.maxDx));
    A.x += clamp(tx - A.x, -A.v * 0.25 * dt, A.v * 0.25 * dt);
    // a gentle, unhurried meander so the flight never runs dead straight
    A.x = clamp(A.x + Math.sin(A.t * 0.7 + A.wave) * 22 * dt, 30 - A.minDx, Math.max(30 - A.minDx, run.w - 24 - A.maxDx));
    // the flock converts each stop as it passes over it
    if (cur && !A.landing && !A.leave && run.phase === "build") {
      const over = run.geese.filter((g) => g.mode === "air" && (g.alt ?? 0) > 0.4 && g.y >= cur.cy - 4);
      if (over.length) convert(cur, over.sort((a, b) => Math.abs(a.x - cur.cx) - Math.abs(b.x - cur.cx))[0]);
    }
    if (!A.landing && !A.leave && (A.t > A.dur || (A.toY != null && A.y >= A.toY))) { A.landing = true; A.landT = 0; }
    if (A.landing) { A.landT += dt; A.v = 20; }
    if (run.geese.every((g) => g.mode !== "air")) run.air = null;
  }

  /** A folded stretch of unchanged code between the flock and the next stop: always fly over it. */
  function foldAhead(fromY: number, toY: number) {
    return run.folds.some((y) => y > fromY && y < toY);
  }

  /** Verify: a file shown finished, and the flock flying a slow, low V down it; each changed line it passes gets a ✓. */
  function startSurvey(i: number) {
    buildFile(i);
    for (const u of run.units) {
      if (u.kind === "read") continue;
      u.done = true;
      for (const row of u.rows) {
        if (u.kind === "chg" && row.c && row.parts) row.c.textContent = row.parts.newMid;
        row.li.className = `${u.kind} done`;
      }
      run.fileDone += u.lines;
    }
    run.cur = run.units.length;
    measure();
    emitProgress();
    if (!run.geese.length) spawnGeese();
    const left = codeLeft(), right = Math.min(run.w - 28, left + 600), n = run.geese.length;
    run.geese.forEach((g, k) => Object.assign(g, { x: left + ((k + 0.5) / n) * (right - left), y: -60 - Math.abs(k - (n >> 1)) * 40, heading: DOWN,
      mode: "ground", alt: 0, sigma: 0, fl: null, scale: run.sc * g.size, tailY: null }));
    startAir(true);
    run.air!.y = -40;
    for (const g of run.geese) { g.airT = 0.6; g.alt = 0.5; g.sigma = 1; g.speed = 52; }
    run.phase = "rest";
  }

  function updateSurvey(dt: number, now: number) {
    const A = run.air;
    if (!A) { startSurvey(run.fi); return; }
    A.t += dt; A.v = 52; A.y += A.v * dt;
    A.x += clamp(run.w / 2 - A.x, -14 * dt, 14 * dt);
    for (const g of run.geese) { updateAir(g, dt, now); g.alt = Math.min(g.alt ?? 0, 0.45); }
    for (const r of run.rows) {
      if ((r.r.k === "chg" || r.r.k === "add") && !r.li.classList.contains("checked") && r.li.offsetTop < A.y - 40) r.li.classList.add("checked");
    }
    if (A.y > run.contentH + 220) { startSurvey((run.fi + 1) % run.data!.files.length); return; }
    moveCamera(dt, A.y - 60, 0.35);
  }

  function update(dt: number, now: number) {
    if (run.survey) { updateSurvey(dt, now); return; }
    if (run.phase === "build" && run.cur >= run.units.length && run.geese.every((g) => g.mode === "ground")) { run.phase = "tail"; run.tailT = 0; startTail(); }
    // the flock alternates: walk a stretch, then fly a stretch (always over long runs of unchanged code)
    if (run.phase === "build") {
      const cur = run.units[run.cur];
      const ground = run.geese.every((g) => g.mode === "ground");
      if (ground) run.walkT += dt;
      if (cur && ground && !run.air) {
        const minY = Math.min(...run.geese.map((g) => g.y));
        const [stops, secs, gap] = replay() ? [5, 14, 10] : [7, 22, 14];
        if (run.walkConv >= stops || run.walkT > secs || cur.y - minY > gap * run.lh + 30 || foldAhead(minY, cur.y)) startAir(false);
      }
    }
    if (run.phase === "tail" && !run.air && run.geese.every((g) => g.mode === "ground")) {
      run.tailT += dt;
      const lastFile = run.fi >= run.data!.files.length - 1;
      if (replay() && lastFile) { run.phase = "rest"; if (!run.finished) { run.finished = true; ev.finish(); } }
      else if (run.tailT > (replay() ? 1.8 : 4.5)) { run.phase = "leave"; run.leaveT = 0; startAir(true); }
    }
    if (run.phase === "leave") {
      run.leaveT += dt;
      if (run.leaveT > 3.4) { startFile((run.fi + 1) % run.data!.files.length); return; }
    }
    if (run.air) updateAirLead(dt);
    for (const g of run.geese) updateGoose(g, dt, now);
    // the camera follows the flock: the page scrolls up under the birds (birds still arriving from above don't pull it back)
    const seen = run.geese.filter((g) => g.y > run.camY - 40);
    if (seen.length) moveCamera(dt, seen.reduce((a, g) => a + g.y, 0) / seen.length, 0.3);
  }

  /** A critically damped spring: the page starts and stops scrolling smoothly and never jumps, even when a frame is late. */
  function moveCamera(dt: number, focus: number, lead: number) {
    const camT = clamp(focus - run.h * lead, 0, Math.max(0, run.contentH - run.h + 40));
    const k = 5, c = 2 * Math.sqrt(k);
    run.camV += ((camT - run.camY) * k - run.camV * c) * dt;
    run.camY += run.camV * dt;
    setCam();
  }
  function setCam() {
    run.camDraw = Math.round(run.camY * run.dpr) / run.dpr;
    els.scroll.style.transform = `translate3d(0, ${-run.camDraw}px, 0)`;
  }

  function draw() {
    const { dpr, w, h } = run;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(0, -run.camDraw);
    for (const p of run.prints) if (p.y > run.camY - 30 && p.y < run.camY + h + 30) drawPrint(ctx, p.x, p.y, p.h, run.sc * 1.3, p.trail ? TRAIL : PRINT);
    for (const d of run.drops) drawDropping(ctx, d.x, d.y, run.sc * 1.2);
    const vis = run.geese.filter((g) => g.y > run.camY - 220 && g.y < run.camY + h + 220);
    for (const g of vis) drawGooseShadow(ctx, g, "rgba(70,52,34,0.26)");
    vis.sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0));
    for (const g of vis) drawGoose(ctx, g);
  }

  /** Reduced motion, or "skip to the end": the last file finished, with the birds standing at the end of it. */
  function finishStatic() {
    if (!run.data) return;
    const files = run.data.files;
    const last = files.length - 1;
    buildFile(replay() ? last : 0);
    if (!run.geese.length) spawnGeese();
    for (const u of run.units) {
      if (u.kind === "read") continue;
      u.done = true;
      for (const row of u.rows) {
        if (u.kind === "chg" && row.c && row.parts) row.c.textContent = row.parts.newMid;
        row.li.className = `${u.kind} done`;
      }
      run.fileDone += u.lines;
      ev.change(noteFor(u));
    }
    run.cur = run.units.length;
    measure();
    emitProgress();
    const S = els.scroll.getBoundingClientRect();
    const bottom = (run.rows[run.rows.length - 1]?.li.getBoundingClientRect().bottom ?? S.top + 200) - S.top;
    const left = codeLeft(), right = Math.min(run.w - 28, left + 600);
    run.geese.forEach((g, i) => {
      Object.assign(g, { mode: "ground", alt: 0, sigma: 0, fl: null, scale: run.sc * g.size, speed: 0, walking: 0,
        x: left + ((i + 0.5) / run.geese.length) * (right - left), y: bottom + 30 - (i % 2) * 14, heading: DOWN });
      g.tailY = g.y;
    });
    run.air = null;
    run.phase = replay() ? "rest" : "build";
    run.camY = clamp(bottom + 60 - run.h * 0.7, 0, Math.max(0, run.contentH - run.h + 40)); run.camV = 0;
    setCam();
    if (replay() && !run.finished) { run.finished = true; ev.finish(); }
    draw();
  }

  return {
    /** New code to show (from /api/jobs/[id]/live). Starts again from the first file. */
    load(data: LiveCode) {
      run.data = data;
      run.started = false;
      if (run.visible) start();
    },
    replay() { if (run.data) { run.survey = false; start(); } },
    /** Switch between walking the change (build) and flying over the finished code (verify). */
    setSurvey(on: boolean) {
      if (on === run.survey) return;
      run.survey = on;
      run.air = null;
      if (run.data && run.started) start();
    },
    skip() { if (run.data) { run.started = true; finishStatic(); } },
    measure,
    get started() { return run.started; },
    setVisible(v: boolean) {
      run.visible = v;
      if (v && run.data && !run.started) { measure(); start(); }
    },
    frame(dt: number, now: number) {
      if (run.visible && run.started && !reduceMotion && run.data) { update(dt, now); draw(); }
    },
    redraw() { if (run.started) draw(); },
  };
}
