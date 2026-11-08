/* The job page's stage scenes: the same six geese as the code walk (components/site/goose/live.ts), on a different
   ground for each stage of the job. Everything is drawn on one canvas that covers the paper page.
     plan     a lawn of grass at night: walk a little, stop and eat, look up, walk on; every so often they huddle to talk it over
     agree    meadow at dusk: rest and preen, one sentinel faces the banner above the run
     answer   meadow: lined up looking at the question above the run, heads tilting; now and then one paces aside and back
     founder  meadow: rest and preen, one keeps watch
     record   wet mud: walk in single file leaving deep prints that stay
     freeze   ice: careful steps and the odd slip; wherever a goose stands, the ice cracks under it (one crack per check)
     package  meadow with reeds: sheets of paper flutter down; each goose fetches one in its bill and drops it into the nest
     deliver  the finished nest with a big egg in it (the package), guarded; one sentinel faces the banner
     complete blue night water: they land and float, with ripples
     nofit    blue night water: the flock flies off the top of the page
   On each new scene the flock flies in from the top and lands, then goes about its business.
   Birds on the ground never overlap: they pick spots away from each other, steer round each other while walking,
   and are pushed apart if they ever get too close. */
import { advanceFlap, drawGoose, drawGooseShadow, drawPrint, type GoosePose } from "./draw";
import { DOWN, TAU, angDiff, clamp, fitCanvas, lerp, rnd, smooth } from "./math";

export type SceneKind = "plan" | "agree" | "answer" | "founder" | "record" | "freeze" | "package" | "deliver" | "complete" | "nofit";

const UP = -Math.PI / 2;

type Bird = GoosePose & {
  id: number; size: number; speed: number; hz: number; seed: number;
  mode: "enter" | "walk" | "graze" | "stand" | "sit" | "fly" | "swim" | "slip" | "gone";
  t: number; dur: number; tx: number; ty: number; face: number; carry: boolean; job: number;
  fx: number; fy: number; sx: number; sy: number; ft: number; fdur: number; landSwim: boolean;
  hx: number; hy: number; // answer: its place in the line
};
type Print = { x: number; y: number; h: number; a: number; deep?: boolean };
type Ring = { x: number; y: number; r: number; age: number; kind: "ripple" };
type Crack = { x: number; y: number; age: number; arms: { pts: [number, number][]; at: number }[] };
type Paper = { x: number; y: number; rot: number; claimed: Bird | null; age: number };
type Drop = { x0: number; y0: number; x1: number; y1: number; rot: number; t: number };
type Strand = { x0: number; y0: number; x1: number; y1: number; paper: boolean; c: string; w: number; age: number };

let seed = 1;
const srnd = (a = 0, b = 1) => { seed = (seed * 16807) % 2147483647; return a + (b - a) * ((seed - 1) / 2147483646); };

export function createScenes(canvas: HTMLCanvasElement, reduceMotion: boolean) {
  const ctx = canvas.getContext("2d")!;
  const ground = document.createElement("canvas");
  const gctx = ground.getContext("2d")!;
  const S = {
    kind: null as SceneKind | null, w: 1, h: 1, dpr: 1, sc: 0.6, t: 0, visible: false,
    birds: [] as Bird[], prints: [] as Print[], rings: [] as Ring[], grazed: [] as { x: number; y: number; r: number }[],
    nest: { x: 0, y: 0, r: 60, strands: [] as Strand[] },
    cracks: [] as Crack[], papers: [] as Paper[], paperT: 0, drops: [] as Drop[],
    huddle: false, huddleT: 0, // plan: the flock gathers in a ring now and then
    sentinel: 0, track: 0,
  };

  // ------------------------------------------------------------------ grounds (pre-rendered on resize)

  function paintGround() {
    const { w, h, dpr } = S;
    ground.width = Math.round(w * dpr); ground.height = Math.round(h * dpr);
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed = 11;
    const k = S.kind;
    if (k === "record") paintMud(w, h);
    else if (k === "freeze") paintIce(w, h);
    else if (k === "complete" || k === "nofit") paintWater(w, h);
    else paintMeadow(w, h, k === "agree" || k === "deliver" || k === "founder");
    if (k === "package" || k === "deliver") paintReeds(w);
  }
  /** A whole lawn at night: dark soil, soft lighter and darker drifts, and dense short blades everywhere. */
  function paintMeadow(w: number, h: number, dusk: boolean) {
    gctx.fillStyle = dusk ? "#1A1D12" : "#18200F"; gctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) { // drifts, so the lawn isn't flat
      const x = srnd(0, w), y = srnd(0, h), r = srnd(80, 220);
      const g = gctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, srnd() < 0.55 ? "rgba(70,86,40,0.28)" : "rgba(8,10,5,0.35)"); g.addColorStop(1, "rgba(0,0,0,0)");
      gctx.fillStyle = g; gctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    gctx.lineCap = "round";
    const n = (w * h) / 26;
    for (let i = 0; i < n; i++) {
      const x = srnd(0, w), y = srnd(0, h), l = srnd(4, 9), lean = srnd(-2.5, 2.5);
      const lit = srnd();
      gctx.strokeStyle = lit > 0.9 ? `rgba(150,168,92,${srnd(0.35, 0.6)})` : `rgba(${74 + srnd(0, 40)},${92 + srnd(0, 36)},${40 + srnd(0, 22)},${srnd(0.25, 0.55)})`;
      gctx.lineWidth = srnd(0.7, 1.3);
      gctx.beginPath(); gctx.moveTo(x, y); gctx.quadraticCurveTo(x + lean * 0.4, y - l * 0.6, x + lean, y - l); gctx.stroke();
    }
    const v = gctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, dusk ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.35)");
    gctx.fillStyle = v; gctx.fillRect(0, 0, w, h);
  }
  function paintReeds(w: number) {
    for (let i = 0; i < w / 18; i++) {
      const x = srnd(0, w), y = srnd(0, 40);
      gctx.strokeStyle = `rgba(160,150,90,${srnd(0.2, 0.4)})`; gctx.lineWidth = 1.5;
      gctx.beginPath(); gctx.moveTo(x, y + 44); gctx.quadraticCurveTo(x + 4, y + 22, x + srnd(-6, 6), y); gctx.stroke();
    }
  }
  function paintMud(w: number, h: number) {
    const g = gctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#4B3C2C"); g.addColorStop(1, "#382C20");
    gctx.fillStyle = g; gctx.fillRect(0, 0, w, h);
    for (let i = 0; i < (w * h) / 4000; i++) {
      gctx.strokeStyle = `rgba(236,204,154,${srnd(0.03, 0.08)})`; gctx.lineWidth = 1;
      const x = srnd(0, w), y = srnd(0, h), ww = srnd(20, 90);
      gctx.beginPath(); gctx.moveTo(x, y); gctx.quadraticCurveTo(x + ww / 2, y + srnd(-3, 3), x + ww, y); gctx.stroke();
    }
    for (let i = 0; i < 10; i++) { gctx.fillStyle = `rgba(160,140,110,${srnd(0.04, 0.09)})`; gctx.beginPath(); gctx.ellipse(srnd(0, w), srnd(0, h), srnd(30, 90), srnd(8, 18), 0, 0, TAU); gctx.fill(); }
  }
  function paintIce(w: number, h: number) {
    const g = gctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#DDE7EB"); g.addColorStop(0.55, "#C7D6DD"); g.addColorStop(1, "#AFC3CC");
    gctx.fillStyle = g; gctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) { gctx.fillStyle = `rgba(255,255,255,${srnd(0.08, 0.22)})`; gctx.beginPath(); gctx.ellipse(srnd(0, w), srnd(0, h), srnd(40, 140), srnd(6, 20), srnd(-0.4, 0.4), 0, TAU); gctx.fill(); }
    gctx.lineCap = "round";
    for (let c = 0; c < 9; c++) {
      let x = srnd(0, w), y = srnd(0, h), a = srnd(0, TAU);
      gctx.beginPath(); gctx.moveTo(x, y);
      for (let s = 0; s < 9; s++) { a += srnd(-0.7, 0.7); x += Math.cos(a) * srnd(12, 30); y += Math.sin(a) * srnd(12, 30); gctx.lineTo(x, y); }
      gctx.strokeStyle = `rgba(255,255,255,${srnd(0.5, 0.85)})`; gctx.lineWidth = srnd(0.8, 1.4); gctx.stroke();
      gctx.strokeStyle = "rgba(70,100,115,0.18)"; gctx.lineWidth = 0.8; gctx.stroke();
    }
  }
  function paintWater(w: number, h: number) {
    const g = gctx.createRadialGradient(w * 0.5, h * 0.35, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    g.addColorStop(0, "#1F4766"); g.addColorStop(0.5, "#123049"); g.addColorStop(1, "#08182A");
    gctx.fillStyle = g; gctx.fillRect(0, 0, w, h);
    gctx.lineCap = "round";
    for (let i = 0; i < (w * h) / 3500; i++) { // faint swells catching the light
      const x = srnd(0, w), y = srnd(0, h), ww = srnd(18, 70);
      gctx.strokeStyle = `rgba(170,210,235,${srnd(0.04, 0.12)})`; gctx.lineWidth = srnd(0.8, 1.6);
      gctx.beginPath(); gctx.moveTo(x, y); gctx.quadraticCurveTo(x + ww / 2, y - srnd(1, 4), x + ww, y); gctx.stroke();
    }
  }

  // ------------------------------------------------------------------ birds

  function spawn() {
    const sizes = [1.14, 0.84, 1.0, 0.92, 1.2, 0.88];
    S.birds = sizes.map((size, id) => ({
      id, size, x: 0, y: -100, heading: DOWN, scale: S.sc * size, speed: 0, hz: rnd(2.6, 3.3) / Math.sqrt(size), seed: rnd(0, 100),
      alt: 0, sigma: 0, flapT: rnd(0, TAU), flapAmp: 0.7, gait: rnd(0, 1), walking: 0, neckYaw: 0, reach: 0, swim: false,
      mode: "stand", t: 0, dur: 1, tx: 0, ty: 0, face: DOWN, carry: false, job: 0, fx: 0, fy: 0, sx: 0, sy: 0, ft: 0, fdur: 1, landSwim: false, hx: 0, hy: 0,
    }));
  }
  /** Fly in from above the page and land at (x, y). */
  function flyIn(b: Bird, x: number, y: number, delay: number, swim = false) {
    b.sx = clamp(x + rnd(-60, 60), 20, S.w - 20); b.sy = -80 - rnd(0, 60);
    b.x = b.sx; b.y = b.sy; b.fx = x; b.fy = y; b.ft = -delay; b.fdur = clamp(Math.hypot(x - b.sx, y - b.sy) / 160, 1.6, 3.2);
    b.mode = "enter"; b.alt = 1; b.sigma = 1; b.swim = false; b.landSwim = swim; b.heading = DOWN; b.carry = false;
  }
  function setMode(b: Bird, mode: Bird["mode"], dur = 1) { b.mode = mode; b.t = 0; b.dur = dur; }
  function goTo(b: Bird, x: number, y: number) { b.tx = clamp(x, 24, S.w - 24); b.ty = clamp(y, 24, S.h - 24); setMode(b, "walk", 99); }

  function stepWalk(b: Bird, dt: number, pace: number, printDeep = false, printColor?: string) {
    const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy);
    if (d < 6) { b.speed *= Math.pow(0.02, dt); b.walking = (b.walking ?? 0) * (1 - Math.min(1, dt * 6)); return true; }
    let want = Math.atan2(dy, dx);
    // steer round any bird ahead instead of walking into it
    for (const o of S.birds) {
      if (o === b || o.mode === "gone" || o.mode === "enter" || (o.alt ?? 0) > 0.3) continue;
      const ox = o.x - b.x, oy = o.y - b.y, od = Math.hypot(ox, oy);
      if (od > 74 * S.sc * 1.8 || od < 0.01) continue;
      const rel = angDiff(want, Math.atan2(oy, ox));
      if (Math.abs(rel) < 1.1) want += (rel > 0 ? -1 : 1) * (1.1 - Math.abs(rel)) * (1 - od / (74 * S.sc * 1.8)) * 1.4;
    }
    b.heading += clamp(angDiff(b.heading, want), -2.2 * dt, 2.2 * dt);
    b.speed += (pace * (b.scale / 0.6) * (d < 30 ? 0.5 : 1) - b.speed) * Math.min(1, dt * 3);
    const dist = b.speed * dt;
    b.x += Math.cos(b.heading) * dist; b.y += Math.sin(b.heading) * dist;
    const before = b.gait ?? 0;
    b.gait = before + dist / (36 * b.scale);
    b.walking = (b.walking ?? 0) + (1 - (b.walking ?? 0)) * Math.min(1, dt * 6);
    b.reach = (b.reach ?? 0) * 0.9; b.neckYaw = (b.neckYaw ?? 0) * 0.92;
    if (printColor !== undefined && Math.floor(before * 2) !== Math.floor(b.gait * 2)) {
      const side = Math.floor(b.gait * 2) % 2 ? 1 : -1, c = Math.cos(b.heading), s = Math.sin(b.heading);
      const lx = 18 * b.scale, ly = side * 9 * b.scale;
      S.prints.push({ x: b.x + lx * c - ly * s, y: b.y + lx * s + ly * c, h: b.heading + side * 0.1, a: 1, deep: printDeep });
      if (S.prints.length > 700) S.prints.splice(0, 100);
    }
    return false;
  }
  function idle(b: Bird, dt: number, look = 0.5) {
    b.speed *= Math.pow(0.02, dt);
    b.walking = (b.walking ?? 0) * (1 - Math.min(1, dt * 6));
    b.neckYaw = (b.neckYaw ?? 0) + (Math.sin(S.t * 0.55 + b.seed) * look - (b.neckYaw ?? 0)) * Math.min(1, dt * 2);
    b.reach = (b.reach ?? 0) * 0.9;
  }
  function turnTo(b: Bird, h: number, dt: number) { b.heading += clamp(angDiff(b.heading, h), -1.5 * dt, 1.5 * dt); }

  function updateEnter(b: Bird, dt: number) {
    b.ft += dt;
    const u = clamp(b.ft / b.fdur, 0, 1);
    if (b.ft < 0) return;
    const s = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const x = lerp(b.sx, b.fx, s), y = lerp(b.sy, b.fy, s);
    const vx = x - b.x, vy = y - b.y;
    if (Math.hypot(vx, vy) > 0.2) b.heading += angDiff(b.heading, Math.atan2(vy, vx)) * Math.min(1, dt * 5);
    b.x = x; b.y = y;
    b.alt = 0.8 * (1 - smooth(0.7, 1, u));
    b.sigma = 1 - smooth(0.92, 1, u);
    b.flapAmp = lerp(0.85, 0.3, smooth(0.2, 0.5, u)); if (u > 0.7) b.flapAmp = 0.8;
    b.walking = 0;
    if (u >= 1) { b.alt = 0; b.sigma = 0; b.swim = b.landSwim; arrive(b); }
  }

  // ------------------------------------------------------------------ scenes

  function layoutPatches() {
    const { w, h } = S;
    S.grazed = [];
    S.nest = { x: w * 0.5, y: h * 0.52, r: Math.min(70, w * 0.1), strands: [] };
  }
  function restSpots() {
    const cx = S.w * 0.5, cy = S.h * 0.58;
    return [[-90, -10], [-30, 30], [40, -14], [100, 26], [-5, -90], [150, -40]].map(([dx, dy]) => [cx + dx * (S.sc / 0.6), cy + dy * (S.sc / 0.6)]);
  }

  /** Where each bird lands when the scene starts, and what it does then. */
  function startScene() {
    S.prints = []; S.rings = []; S.cracks = []; S.track = 0; S.t = 0; S.paperT = 0;
    S.papers = []; S.drops = []; S.huddle = false; S.huddleT = rnd(14, 20);
    if (S.kind === "package") for (let i = 0; i < 10; i++) dropPaper(99);
    const k = S.kind!;
    const n = S.birds.length;
    S.sentinel = 4;
    S.birds.forEach((b, i) => {
      let x = S.w * (0.2 + 0.6 * (i / (n - 1))), y = S.h * (0.35 + 0.3 * ((i % 2) ? 1 : 0)), swim = false;
      if (k === "plan" || k === "package") { const c = [[0.22, 0.3], [0.5, 0.25], [0.78, 0.32], [0.3, 0.68], [0.62, 0.72], [0.85, 0.62]][i]; x = S.w * c[0] + rnd(-25, 25); y = S.h * c[1] + rnd(-20, 20); }
      if (k === "agree" || k === "founder" || k === "deliver") { const s = k === "deliver" ? guardSpot(i) : restSpots()[i]; x = s[0]; y = s[1]; }
      if (k === "answer") { x = S.w * (0.16 + 0.68 * (i / (n - 1))); y = S.h * 0.34 + (i % 2) * 10; b.hx = x; b.hy = y; b.job = 0; }
      if (k === "record") { x = S.w * 0.08 + i * 40 * (S.sc / 0.6); y = trackY(0) + (i % 2) * 3; b.job = 0; }
      if (k === "complete" || k === "nofit") { x = S.w * (0.2 + 0.6 * ((i * 0.37) % 1)); y = S.h * (0.32 + 0.45 * ((i * 0.61) % 1)); swim = true; }
      if (k === "nofit") { b.x = x; b.y = y; b.swim = true; b.mode = "swim"; b.alt = 0; b.sigma = 0; b.t = -1.2 - i * 0.25; return; }
      if (reduceMotion) { b.x = x; b.y = y; b.alt = 0; b.sigma = 0; b.swim = swim; arrive(b); return; }
      flyIn(b, x, y, i * 0.18, swim);
    });
  }
  const guardSpot = (i: number) => {
    const a = (i / S.birds.length) * TAU + 0.4, r = S.nest.r + 46 * (S.sc / 0.6);
    return [S.nest.x + Math.cos(a) * r, S.nest.y + Math.sin(a) * r * 0.8];
  };
  const trackY = (t: number) => S.h * (0.22 + 0.28 * (t % 3));

  /** A bird has landed (or finished a task): decide what it does next for this scene. */
  function arrive(b: Bird) {
    const k = S.kind!;
    if (k === "plan") return S.huddle ? setMode(b, "stand", 99) : setMode(b, Math.random() < 0.75 ? "graze" : "stand", rnd(3, 7));
    if (k === "agree" || k === "founder") return setMode(b, b.id === S.sentinel ? "stand" : "sit", 99);
    if (k === "answer") return setMode(b, "stand", b.job === 1 ? rnd(1.5, 2.5) : rnd(5, 12)); // job 1: stepped aside, about to go back
    if (k === "deliver") return setMode(b, "stand", 99);
    if (k === "record") { goTo(b, S.w - 30 - b.id * 6, b.y); return; }
    if (k === "freeze") return setMode(b, "stand", rnd(1.2, 2.4));
    if (k === "package") { b.job = 0; return setMode(b, "stand", rnd(0.4, 1.6)); }
    if (k === "complete") { b.swim = true; return setMode(b, "swim", 99); }
  }

  function updateBird(b: Bird, dt: number) {
    if ((b.sigma ?? 0) > 0.01) advanceFlap(b, dt, b.hz);
    if (b.mode === "enter") return updateEnter(b, dt);
    if (b.mode === "gone") return;
    const k = S.kind!;
    b.t += dt;
    if (b.mode === "fly") { // leaving: straight up and out (nofit)
      b.sigma = Math.min(1, (b.sigma ?? 0) + dt * 3); b.alt = Math.min(0.8, (b.alt ?? 0) + dt * 0.6); b.swim = false;
      b.flapAmp = 0.85; turnTo(b, UP, dt); b.speed = Math.min(140, b.speed + dt * 80);
      b.x += Math.cos(b.heading) * b.speed * dt; b.y += Math.sin(b.heading) * b.speed * dt;
      if (b.y < -120) b.mode = "gone";
      return;
    }
    if (b.mode === "swim") {
      b.walking = 0; b.reach = 0;
      b.neckYaw = (b.neckYaw ?? 0) + (Math.sin(S.t * 0.4 + b.seed) * 0.6 - (b.neckYaw ?? 0)) * Math.min(1, dt);
      b.heading += Math.sin(S.t * 0.2 + b.seed) * 0.08 * dt;
      b.x += Math.cos(b.heading) * 4 * dt; b.y += Math.sin(b.heading) * 4 * dt;
      b.x = clamp(b.x, 40, S.w - 40); b.y = clamp(b.y, 40, S.h - 40);
      if (Math.random() < dt * 0.35) S.rings.push({ x: b.x, y: b.y, r: 10, age: 0, kind: "ripple" });
      if (k === "nofit" && b.t > 0) { b.mode = "fly"; b.speed = 30; }
      return;
    }
    if (b.mode === "walk") {
      const pace = k === "freeze" ? 26 : k === "record" ? 44 : 38;
      // a bird that can't quite reach its spot (someone else is near it) settles where it is after a while
      const done = b.t > 12 || stepWalk(b, dt, pace, k === "record", k === "plan" || k === "package" || k === "freeze" || k === "record" ? "" : undefined);
      if (k === "freeze" && Math.random() < dt * 0.25) { setMode(b, "slip", 0.7); return; }
      if (k === "record" && b.x > S.w - 60) { hopBack(b); return; }
      if (done) {
        if (k === "package" && b.job === 1) { // at the rim: let the sheet fall into the nest
          const c = Math.cos(b.heading), s = Math.sin(b.heading), bx = b.x + c * 46 * b.scale, by = b.y + s * 46 * b.scale;
          const a = Math.atan2((by - S.nest.y) / 0.78, bx - S.nest.x), rr = S.nest.r * 0.72;
          S.drops.push({ x0: bx, y0: by, x1: S.nest.x + Math.cos(a) * rr, y1: S.nest.y + Math.sin(a) * rr * 0.78, rot: b.heading + 1.2, t: 0 });
          b.carry = false; b.job = 2; return setMode(b, "stand", rnd(0.8, 1.4));
        }
        if (k === "package" && b.job === 0) { // at the sheet: pick it up and take it to the nest
          const paper = S.papers.find((pp) => pp.claimed === b);
          if (paper) S.papers.splice(S.papers.indexOf(paper), 1);
          b.carry = true; b.job = 1;
          const a = Math.atan2(b.y - S.nest.y, b.x - S.nest.x) + rnd(-0.4, 0.4);
          goTo(b, S.nest.x + Math.cos(a) * (S.nest.r + 34 * b.scale), S.nest.y + Math.sin(a) * (S.nest.r * 0.78 + 34 * b.scale));
          return;
        }
        if (k === "package" && b.job === 3) return setMode(b, "graze", rnd(1.5, 3));
        arrive(b);
      }
      return;
    }
    if (b.mode === "slip") { // a little skid on the ice, wings out for balance
      b.sigma = 0.35 * Math.sin(Math.PI * clamp(b.t / b.dur, 0, 1)); b.flapAmp = 0.25;
      b.x += Math.cos(b.heading + 0.9) * 22 * dt; b.y += Math.sin(b.heading + 0.9) * 22 * dt;
      b.walking = 0.3;
      if (b.t > b.dur) { b.sigma = 0; setMode(b, "walk", 99); }
      return;
    }
    if (b.mode === "graze") {
      b.speed *= Math.pow(0.02, dt); b.walking = (b.walking ?? 0) * 0.9;
      b.reach = 0.55 + 0.45 * Math.sin(b.t * 5 + b.seed);
      b.neckYaw = Math.sin(b.t * 0.8 + b.seed) * 0.35;
      if (k === "plan" && Math.random() < dt * 0.6) {
        const hx = b.x + Math.cos(b.heading) * 34 * b.scale, hy = b.y + Math.sin(b.heading) * 34 * b.scale;
        if (S.grazed.length < 120) S.grazed.push({ x: hx + rnd(-4, 4), y: hy + rnd(-3, 3), r: rnd(3, 6) });
      }
      if (b.t > b.dur) next(b);
      return;
    }
    if (b.mode === "sit") { // resting: head swings back to preen now and then
      b.speed = 0; b.walking = 0; b.reach = 0;
      const pre = 0.5 + 0.5 * Math.sin(S.t * 0.25 + b.seed);
      b.neckYaw = (b.neckYaw ?? 0) + ((pre > 0.6 ? 2.5 * Math.sign(Math.sin(b.seed)) : 0.3 * Math.sin(S.t * 0.5 + b.seed)) - (b.neckYaw ?? 0)) * Math.min(1, dt * 1.2);
      return;
    }
    // stand
    if (k === "answer") { // looking up at the question, heads tilting as if puzzling it out
      turnTo(b, UP + Math.sin(S.t * 0.3 + b.seed) * 0.08, dt); idle(b, dt, 0);
      const tilt = Math.sin(S.t * 0.9 + b.seed * 3) > 0.55 ? Math.sign(Math.sin(b.seed * 7)) * 0.7 : 0;
      b.neckYaw = (b.neckYaw ?? 0) + (tilt - (b.neckYaw ?? 0)) * Math.min(1, dt * 4);
      if (b.t > b.dur) {
        if (b.job === 1) { b.job = 0; goTo(b, b.hx, b.hy); }
        else if (!S.birds.some((o) => o !== b && o.job === 1)) { b.job = 1; goTo(b, b.hx + (Math.random() < 0.5 ? -1 : 1) * rnd(40, 70), b.hy + rnd(50, 90)); }
        else b.t = 0;
      }
      return;
    }
    if (k === "plan" && S.huddle) { // in the huddle: face the middle, heads bobbing as they talk
      const c = huddleCentre(); turnTo(b, Math.atan2(c[1] - b.y, c[0] - b.x), dt); idle(b, dt, 0);
      const talk = Math.sin(S.t * 2.2 + b.seed * 5);
      b.reach = talk > 0.6 ? 0.25 * (talk - 0.6) / 0.4 : 0;
      b.neckYaw = Math.sin(S.t * 0.7 + b.seed) * 0.25;
      return;
    }
    if ((k === "agree" || k === "deliver" || k === "founder") && b.id === S.sentinel) { turnTo(b, UP + Math.sin(S.t * 0.3 + b.seed) * 0.1, dt); idle(b, dt, 0.25); return; }
    if (k === "deliver") { const a = Math.atan2(b.y - S.nest.y, b.x - S.nest.x); turnTo(b, a, dt); idle(b, dt, 0.5); return; }
    idle(b, dt, 0.6);
    if (k === "freeze" && b.t > 0.5) { // the ice cracks under its feet
      const near = S.cracks.some((c) => Math.hypot(c.x - b.x, c.y - b.y) < 70 * S.sc);
      if (!near) S.cracks.push(makeCrack(b.x, b.y));
      if (S.cracks.length > 36) S.cracks.shift();
    }
    if (b.t > b.dur) next(b);
  }

  /** Room each bird keeps around itself on the ground (about a body length). */
  const room = () => 74 * S.sc;
  /** A spot a short walk away that no other bird is standing at or heading to. */
  function freeSpot(b: Bird, min: number, max: number, ok: (x: number, y: number) => boolean = () => true): [number, number] {
    let best: [number, number] = [b.x, b.y], bestD = -1;
    for (let tries = 0; tries < 24; tries++) {
      const a = rnd(0, TAU), d = rnd(min, max);
      const x = clamp(b.x + Math.cos(a) * d, 40, S.w - 40), y = clamp(b.y + Math.sin(a) * d, 40, S.h - 40);
      if (!ok(x, y)) continue;
      let near = Infinity;
      for (const o of S.birds) {
        if (o === b || o.mode === "gone") continue;
        near = Math.min(near, Math.hypot(o.x - x, o.y - y), o.mode === "walk" ? Math.hypot(o.tx - x, o.ty - y) : Infinity);
      }
      if (near > room() * 1.6) return [x, y];
      if (near > bestD) { bestD = near; best = [x, y]; }
    }
    return best;
  }
  /** Birds on the ground (or water) never overlap: any two closer than a body length are eased apart. */
  function separate(dt: number) {
    const R = room();
    const onGround = S.birds.filter((b) => b.mode !== "gone" && b.mode !== "enter" && b.mode !== "fly" && (b.alt ?? 0) < 0.3);
    for (let i = 0; i < onGround.length; i++) for (let j = i + 1; j < onGround.length; j++) {
      const a = onGround[i], c = onGround[j];
      let dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy);
      if (d >= R) continue;
      if (d < 0.01) { dx = 1; dy = 0; d = 1; }
      const push = Math.min((R - d) / 2, 60 * dt + (R - d) * 0.15), nx = dx / d, ny = dy / d;
      // a resting bird gives way less than a walking one
      const wa = a.mode === "sit" || a.mode === "stand" ? 0.35 : 1, wc = c.mode === "sit" || c.mode === "stand" ? 0.35 : 1, sum = wa + wc;
      a.x -= nx * push * 2 * (wa / sum); a.y -= ny * push * 2 * (wa / sum);
      c.x += nx * push * 2 * (wc / sum); c.y += ny * push * 2 * (wc / sum);
      a.x = clamp(a.x, 20, S.w - 20); a.y = clamp(a.y, 20, S.h - 20); c.x = clamp(c.x, 20, S.w - 20); c.y = clamp(c.y, 20, S.h - 20);
    }
  }

  let hc: [number, number] = [0, 0];
  const huddleCentre = () => hc;
  /** Plan: every 18-28 s the flock gathers in a ring to talk it over for 6-9 s, then goes back to grazing. */
  function planHuddle(dt: number) {
    S.huddleT -= dt;
    if (S.huddleT > 0) return;
    const ground = S.birds.filter((b) => b.mode !== "enter" && b.mode !== "gone");
    if (ground.length < S.birds.length) { S.huddleT = 1; return; }
    if (!S.huddle) {
      const R = room() * 1.18;
      let cx = 0, cy = 0; for (const b of ground) { cx += b.x; cy += b.y; }
      cx = clamp(cx / ground.length, R + 50, S.w - R - 50); cy = clamp(cy / ground.length, R + 50, S.h - R - 50);
      hc = [cx, cy];
      // keep their order round the ring so nobody has to cross through the middle
      const sorted = [...ground].sort((a, c) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(c.y - cy, c.x - cx));
      const a0 = Math.atan2(sorted[0].y - cy, sorted[0].x - cx);
      sorted.forEach((b, i) => { const a = a0 + (i / sorted.length) * TAU; goTo(b, cx + Math.cos(a) * R, cy + Math.sin(a) * R * 0.9); });
      S.huddle = true; S.huddleT = rnd(6, 9) + 5; // time to walk over plus the talk itself
    } else {
      S.huddle = false; S.huddleT = rnd(18, 28);
      for (const b of ground) setMode(b, "stand", rnd(0.2, 1.4)); // they drift off one by one (next() sends each to a free spot)
    }
  }

  /** Pick the bird's next task in the scenes where they keep moving. */
  function next(b: Bird) {
    const k = S.kind!;
    if (k === "plan") {
      if (b.mode === "graze" && Math.random() < 0.35) return setMode(b, "stand", rnd(1.2, 2.6)); // look up for a moment
      const [x, y] = freeSpot(b, 70, 200);
      return goTo(b, x, y);
    }
    if (k === "freeze") { const [x, y] = freeSpot(b, 80, 260); return goTo(b, x, y); }
    if (k === "package") { // off to fetch the nearest sheet nobody else is after
      b.job = 0;
      const free = S.papers.filter((pp) => !pp.claimed).sort((p1, p2) => Math.hypot(p1.x - b.x, p1.y - b.y) - Math.hypot(p2.x - b.x, p2.y - b.y));
      if (!free.length) { const [x, y] = freeSpot(b, 60, 160); goTo(b, x, y); b.job = 3; return; }
      const pp = free[0];
      pp.claimed = b;
      // stop with the bill on the sheet, not standing on it
      const d = Math.max(1, Math.hypot(pp.x - b.x, pp.y - b.y)), reach = 40 * b.scale;
      return goTo(b, pp.x - ((pp.x - b.x) / d) * reach, pp.y - ((pp.y - b.y) / d) * reach);
    }
    setMode(b, "stand", 99);
  }
  function hopBack(b: Bird) { // record: at the far edge, back to the left on the next track
    b.job = (b.job + 1) % 3;
    b.sx = b.x; b.sy = b.y; b.fx = S.w * 0.08 + rnd(0, 30); b.fy = trackY(b.job) + (b.id % 2) * 4;
    b.ft = -b.id * 0.15; b.fdur = 2.2; b.mode = "enter"; b.alt = 0.6; b.sigma = 1; b.landSwim = false;
  }
  /** A sheet of paper somewhere on the grass, away from the nest and the edges. */
  function dropPaper(age = 0) {
    for (let t = 0; t < 40; t++) {
      const x = rnd(60, S.w - 60), y = rnd(60, S.h - 70);
      if (Math.hypot(x - S.nest.x, (y - S.nest.y) * 1.2) < S.nest.r + 80) continue;
      if (S.papers.some((pp) => Math.hypot(pp.x - x, pp.y - y) < 70)) continue;
      if (age < 1 && S.birds.some((b) => b.mode !== "gone" && Math.hypot(b.x - x, b.y - y) < room() * 1.3)) continue; // not under a goose
      S.papers.push({ x, y, rot: rnd(-0.8, 0.8), claimed: null, age });
      return;
    }
  }
  /** Cracks radiating from where a goose stands, growing over a second or so. */
  function makeCrack(x: number, y: number): Crack {
    const arms: Crack["arms"] = [];
    const n = 3 + Math.floor(rnd(0, 3));
    for (let i = 0; i < n; i++) {
      let a = (i / n) * TAU + rnd(-0.4, 0.4), px = x, py = y;
      const pts: [number, number][] = [[px, py]];
      const len = rnd(28, 70) * (S.sc / 0.6);
      for (let d = 0; d < len; d += 7) { a += rnd(-0.45, 0.45); px += Math.cos(a) * 7; py += Math.sin(a) * 7; pts.push([px, py]); }
      arms.push({ pts, at: rnd(0, 0.3) });
      if (Math.random() < 0.6) { // a side branch
        const k = Math.floor(pts.length * rnd(0.3, 0.7));
        let [bx, by] = pts[k], ba = a + (Math.random() < 0.5 ? 1 : -1) * rnd(0.6, 1.1);
        const side: [number, number][] = [[bx, by]];
        for (let d = 0; d < len * 0.45; d += 6) { ba += rnd(-0.4, 0.4); bx += Math.cos(ba) * 6; by += Math.sin(ba) * 6; side.push([bx, by]); }
        arms.push({ pts: side, at: 0.35 + rnd(0, 0.3) });
      }
    }
    return { x, y, age: 0, arms };
  }
  function addStrands(n: number, paperMostly = false) {
    const N = S.nest;
    for (let i = 0; i < n && N.strands.length < 320; i++) {
      const a = rnd(0, TAU), rr = N.r * rnd(0.55, 1), len = rnd(14, 30), t = a + DOWN + rnd(-0.5, 0.5);
      const px = N.x + Math.cos(a) * rr, py = N.y + Math.sin(a) * rr * 0.78, paper = Math.random() < (paperMostly ? 0.45 : 0.2);
      N.strands.push({ x0: px - Math.cos(t) * len / 2, y0: py - Math.sin(t) * len / 2 * 0.78, x1: px + Math.cos(t) * len / 2, y1: py + Math.sin(t) * len / 2 * 0.78,
        paper, c: `rgba(${110 + rnd(0, 50)},${84 + rnd(0, 40)},${50 + rnd(0, 25)},0.9)`, w: paper ? 3 : rnd(1, 2), age: 99 });
    }
  }
  /** A dropped sheet settles into the nest where it fell: a few paper and twig strands there, fading in. */
  function addStrandsAt(x: number, y: number, n: number) {
    const N = S.nest, a0 = Math.atan2((y - N.y) / 0.78, x - N.x);
    for (let i = 0; i < n; i++) {
      if (N.strands.length >= 320) N.strands.splice(0, 1);
      const a = a0 + rnd(-0.35, 0.35), rr = N.r * rnd(0.6, 0.95), len = rnd(14, 26), t = a + DOWN + rnd(-0.5, 0.5);
      const px = N.x + Math.cos(a) * rr, py = N.y + Math.sin(a) * rr * 0.78, paper = i < 2 || Math.random() < 0.3;
      N.strands.push({ x0: px - Math.cos(t) * len / 2, y0: py - Math.sin(t) * len / 2 * 0.78, x1: px + Math.cos(t) * len / 2, y1: py + Math.sin(t) * len / 2 * 0.78,
        paper, c: `rgba(${110 + rnd(0, 50)},${84 + rnd(0, 40)},${50 + rnd(0, 25)},0.9)`, w: paper ? 3 : rnd(1, 2), age: -i * 0.06 });
    }
  }

  // ------------------------------------------------------------------ drawing

  function drawRing(r: Ring) {
    const a = 0.28 * (1 - r.age / 3);
    if (a <= 0) return;
    ctx.strokeStyle = `rgba(190,220,240,${a * 1.4})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.62, 0, 0, TAU); ctx.stroke();
  }
  function drawCrack(c: Crack) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const arm of c.arms) {
      const grow = clamp((c.age - arm.at) / 0.9, 0, 1);
      if (grow <= 0) continue;
      const n = Math.max(2, Math.ceil(arm.pts.length * grow));
      for (const [style, w, off] of [["rgba(64,94,108,0.35)", 2.2, 0.8], ["rgba(255,255,255,0.92)", 1.1, 0]] as const) {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(arm.pts[0][0] + off, arm.pts[0][1] + off);
        for (let i = 1; i < n; i++) ctx.lineTo(arm.pts[i][0] + off, arm.pts[i][1] + off);
        ctx.stroke();
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.beginPath(); ctx.arc(c.x, c.y, 5 * (S.sc / 0.6), 0, TAU); ctx.fill();
  }
  function drawPaper(pp: Paper) {
    const k = S.sc / 0.6, u = smooth(0, 1, clamp(pp.age / 0.9, 0, 1)); // flutters down and settles
    const lift = (1 - u) * 26, sway = Math.sin(pp.age * 9) * (1 - u) * 0.5;
    ctx.save(); ctx.globalAlpha = clamp(pp.age / 0.35, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.save(); ctx.translate(pp.x, pp.y); ctx.rotate(pp.rot); ctx.scale(k * (0.7 + 0.3 * u), k * (0.7 + 0.3 * u)); ctx.fillRect(-9, -11, 20, 25); ctx.restore();
    ctx.translate(pp.x, pp.y - lift); ctx.rotate(pp.rot + sway); ctx.scale(k, k);
    ctx.fillStyle = "#F2ECE1"; ctx.fillRect(-10, -13, 20, 25);
    ctx.fillStyle = "rgba(42,36,29,0.4)"; for (let i = -9; i < 10; i += 3.5) ctx.fillRect(-7, i, i % 7 ? 11 : 14, 1.1);
    ctx.restore();
  }
  /** A sheet falling from a goose's bill into the nest: it tips, shrinks a little and lands on the rim. */
  function drawDrop(d: Drop) {
    const u = smooth(0, 1, clamp(d.t / 0.5, 0, 1)), k = S.sc / 0.6;
    const x = lerp(d.x0, d.x1, u), y = lerp(d.y0, d.y1, u) - Math.sin(Math.PI * u) * 10;
    ctx.save(); ctx.translate(x, y); ctx.rotate(d.rot + u * 0.9); ctx.scale(k * (1 - 0.25 * u), k * (1 - 0.25 * u));
    ctx.fillStyle = "#F2ECE1"; ctx.fillRect(-11, -4 - 5 * u, 22, 8 + 10 * u); // opens out as it falls
    ctx.fillStyle = "rgba(42,36,29,0.45)"; for (let i = -8; i < 9; i += 4) ctx.fillRect(i, -1, 2.4, 2);
    ctx.restore();
  }
  function drawEgg(x: number, y: number, r: number) {
    const rx = r * 0.36, ry = r * 0.5;
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(x + 4, y + 5, rx, ry, -0.25, 0, TAU); ctx.fill();
    const g = ctx.createRadialGradient(x - rx * 0.35, y - ry * 0.4, r * 0.05, x, y, ry * 1.1);
    g.addColorStop(0, "#FBF7EE"); g.addColorStop(0.55, "#EDE3D0"); g.addColorStop(1, "#C9B99C");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, -0.25, 0, TAU); ctx.fill();
    ctx.strokeStyle = "rgba(210,160,105,0.55)"; ctx.lineWidth = 1.2; ctx.stroke(); // a thin gold edge in the light
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.beginPath(); ctx.ellipse(x - rx * 0.35, y - ry * 0.45, rx * 0.22, ry * 0.14, -0.25, 0, TAU); ctx.fill();
  }
  function drawNest(done: boolean) {
    const N = S.nest;
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(N.x + 4, N.y + 6, N.r * 1.05, N.r * 0.8, 0, 0, TAU); ctx.fill();
    ctx.lineCap = "round";
    for (const s of N.strands) {
      if (s.age <= 0) continue;
      ctx.globalAlpha = Math.min(1, s.age / 0.5);
      ctx.strokeStyle = s.paper ? "rgba(242,236,225,0.9)" : s.c; ctx.lineWidth = s.w; ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#2A2014"; ctx.beginPath(); ctx.ellipse(N.x, N.y, N.r * 0.5, N.r * 0.38, 0, 0, TAU); ctx.fill();
    if (done) drawEgg(N.x, N.y, N.r); // the package: a big egg in the finished nest
  }
  function drawCarry(b: Bird) {
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.heading); ctx.scale(b.scale, b.scale);
    ctx.translate(46, 0); ctx.rotate(1.2);
    ctx.fillStyle = "#F2ECE1"; ctx.fillRect(-16, -3, 32, 6);
    ctx.fillStyle = "rgba(42,36,29,0.55)"; for (let i = -13; i < 13; i += 4) ctx.fillRect(i, -1, 2.4, 2);
    ctx.restore();
  }

  function draw() {
    const { dpr, w, h } = S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(ground, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = S.kind;
    if (k === "plan") { ctx.fillStyle = "rgba(30,26,14,0.35)"; for (const g of S.grazed) { ctx.beginPath(); ctx.ellipse(g.x, g.y, g.r, g.r * 0.7, 0, 0, TAU); ctx.fill(); } }
    const light = k === "freeze";
    const color = k === "record" ? "rgba(26,19,12,0.78)" : light ? "rgba(70,100,115,0.45)" : "rgba(222,206,170,0.22)";
    for (const p of S.prints) { ctx.globalAlpha = p.a; drawPrint(ctx, p.x, p.y, p.h, S.sc * (p.deep ? 1.5 : 1.25), color); }
    ctx.globalAlpha = 1;
    for (const r of S.rings) drawRing(r);
    for (const c of S.cracks) drawCrack(c);
    for (const pp of S.papers) drawPaper(pp);
    if (k === "package" || k === "deliver") drawNest(k === "deliver");
    for (const d of S.drops) drawDrop(d);
    const shade = light ? "rgba(60,90,104,0.22)" : k === "record" ? "rgba(20,14,8,0.4)" : k === "complete" || k === "nofit" ? "rgba(2,12,24,0.45)" : "rgba(0,0,0,0.35)";
    const vis = S.birds.filter((b) => b.mode !== "gone").sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0));
    for (const b of vis) drawGooseShadow(ctx, b, shade);
    for (const b of vis) { drawGoose(ctx, b); if (b.carry) drawCarry(b); }
    void w; void h;
  }

  function update(dt: number) {
    S.t += dt;
    const k = S.kind;
    if (k === "plan") planHuddle(dt);
    for (const b of S.birds) updateBird(b, dt);
    separate(dt);
    // prints fade on grass and ice; the mud keeps them
    if (k !== "record") for (const p of S.prints) p.a -= dt * (k === "freeze" ? 0.05 : 0.08);
    S.prints = S.prints.filter((p) => p.a > 0.02);
    for (const r of S.rings) {
      r.age += dt;
      r.r += dt * 9;
    }
    S.rings = S.rings.filter((r) => r.age < 3);
    for (const c of S.cracks) c.age += dt;
    if (k === "package") { // more sheets flutter onto the grass as the old ones are taken
      for (const pp of S.papers) pp.age += dt;
      for (const st of S.nest.strands) if (st.age < 99) st.age += dt;
      for (const d of S.drops) { d.t += dt; if (d.t >= 0.5) addStrandsAt(d.x1, d.y1, 5); }
      S.drops = S.drops.filter((d) => d.t < 0.5);
      S.paperT += dt;
      if (S.paperT > 1.8 && S.papers.filter((pp) => !pp.claimed).length < 7) { S.paperT = 0; dropPaper(); }
    }
  }

  function resize() {
    const f = fitCanvas(canvas);
    const changed = f.w !== S.w || f.h !== S.h;
    S.w = f.w; S.h = f.h; S.dpr = f.dpr;
    S.sc = S.w < 520 ? 0.5 : 0.7;
    for (const b of S.birds) b.scale = S.sc * b.size;
    if (changed && S.kind) { layoutPatches(); if (S.kind === "deliver") addStrands(260); paintGround(); }
    return changed;
  }

  return {
    get kind() { return S.kind; },
    /** Switch to a scene (no-op if it's already showing). */
    show(kind: SceneKind) {
      if (kind === S.kind) return;
      S.kind = kind;
      resize();
      layoutPatches();
      if (kind === "deliver") addStrands(260);
      if (kind === "package") addStrands(30);
      paintGround();
      if (!S.birds.length) spawn();
      for (const b of S.birds) b.scale = S.sc * b.size;
      startScene();
      if (reduceMotion) draw();
    },
    measure() { if (resize() || reduceMotion) { if (S.kind) draw(); } },
    setVisible(v: boolean) { S.visible = v; },
    frame(dt: number) {
      if (!S.kind || !S.visible || reduceMotion) return;
      update(dt);
      draw();
    },
  };
}
