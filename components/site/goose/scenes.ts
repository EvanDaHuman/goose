/* The job page's stage scenes: the same six geese as the code walk (components/site/goose/live.ts), on a different
   ground for each stage of the job. Everything is drawn on one canvas that covers the paper page.
     plan     night meadow with grass patches: graze, pace, stop and look up
     agree    meadow at dusk: rest and preen, one sentinel faces the banner above the run
     answer   meadow: everyone looks up at the question above the run
     founder  meadow: rest and preen, one keeps watch
     record   wet mud: walk in single file leaving deep prints, gold rings pressed into the mud
     freeze   ice: careful steps and the odd slip; a frost ring forms wherever a goose stands
     package  meadow with reeds: carry paper strips in their bills and weave them into a nest
     deliver  the finished nest with the package in it, guarded; one sentinel faces the banner
     complete night water like the homepage: they land and float, with ripples
     nofit    night water: the flock flies off the top of the page
   On each new scene the flock flies in from the top and lands, then goes about its business. */
import { advanceFlap, drawGoose, drawGooseShadow, drawPrint, type GoosePose } from "./draw";
import { DOWN, TAU, angDiff, clamp, fitCanvas, lerp, rnd, smooth } from "./math";

export type SceneKind = "plan" | "agree" | "answer" | "founder" | "record" | "freeze" | "package" | "deliver" | "complete" | "nofit";

const UP = -Math.PI / 2;

type Bird = GoosePose & {
  id: number; size: number; speed: number; hz: number; seed: number;
  mode: "enter" | "walk" | "graze" | "stand" | "sit" | "fly" | "swim" | "slip" | "gone";
  t: number; dur: number; tx: number; ty: number; face: number; carry: boolean; job: number;
  fx: number; fy: number; sx: number; sy: number; ft: number; fdur: number; landSwim: boolean;
};
type Print = { x: number; y: number; h: number; a: number; deep?: boolean };
type Patch = { x: number; y: number; rx: number; ry: number };
type Ring = { x: number; y: number; r: number; age: number; kind: "frost" | "gold" | "ripple" };

let seed = 1;
const srnd = (a = 0, b = 1) => { seed = (seed * 16807) % 2147483647; return a + (b - a) * ((seed - 1) / 2147483646); };

export function createScenes(canvas: HTMLCanvasElement, reduceMotion: boolean) {
  const ctx = canvas.getContext("2d")!;
  const ground = document.createElement("canvas");
  const gctx = ground.getContext("2d")!;
  const S = {
    kind: null as SceneKind | null, w: 1, h: 1, dpr: 1, sc: 0.6, t: 0, visible: false,
    birds: [] as Bird[], prints: [] as Print[], rings: [] as Ring[], patches: [] as Patch[], grazed: [] as { x: number; y: number; r: number }[],
    nest: { x: 0, y: 0, r: 60, strands: [] as { x0: number; y0: number; x1: number; y1: number; paper: boolean; c: string; w: number }[] },
    sentinel: 0, ringT: 0, track: 0,
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
  function paintMeadow(w: number, h: number, dusk: boolean) {
    const g = gctx.createRadialGradient(w * 0.5, h * 0.45, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
    g.addColorStop(0, dusk ? "#24261A" : "#202619"); g.addColorStop(1, dusk ? "#121310" : "#11140E");
    gctx.fillStyle = g; gctx.fillRect(0, 0, w, h);
    gctx.lineCap = "round";
    for (let i = 0; i < (w * h) / 220; i++) {
      const x = srnd(0, w), y = srnd(0, h), l = srnd(2, 5);
      gctx.strokeStyle = `rgba(${110 + srnd(0, 40)},${120 + srnd(0, 30)},${70 + srnd(0, 20)},${srnd(0.05, 0.16)})`;
      gctx.lineWidth = 1; gctx.beginPath(); gctx.moveTo(x, y); gctx.lineTo(x + srnd(-1.5, 1.5), y - l); gctx.stroke();
    }
    for (const p of S.patches) tuft(p);
  }
  function tuft(p: Patch) {
    const n = p.rx * p.ry * 0.45;
    for (let i = 0; i < n; i++) {
      const a = srnd(0, TAU), r = Math.sqrt(srnd(0, 1));
      const x = p.x + Math.cos(a) * p.rx * r, y = p.y + Math.sin(a) * p.ry * r;
      const l = srnd(5, 12) * (1 - r * 0.4), lean = srnd(-3, 3);
      gctx.strokeStyle = `rgba(${110 + srnd(0, 50)},${128 + srnd(0, 45)},${58 + srnd(0, 26)},${srnd(0.35, 0.7)})`;
      gctx.lineWidth = srnd(0.8, 1.5); gctx.beginPath(); gctx.moveTo(x, y); gctx.quadraticCurveTo(x + lean * 0.4, y - l * 0.6, x + lean, y - l); gctx.stroke();
    }
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
    const g = gctx.createRadialGradient(w * 0.5, h * 0.35, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    g.addColorStop(0, "#1D1912"); g.addColorStop(1, "#0C0D0C");
    gctx.fillStyle = g; gctx.fillRect(0, 0, w, h);
  }

  // ------------------------------------------------------------------ birds

  function spawn() {
    const sizes = [1.14, 0.84, 1.0, 0.92, 1.2, 0.88];
    S.birds = sizes.map((size, id) => ({
      id, size, x: 0, y: -100, heading: DOWN, scale: S.sc * size, speed: 0, hz: rnd(2.6, 3.3) / Math.sqrt(size), seed: rnd(0, 100),
      alt: 0, sigma: 0, flapT: rnd(0, TAU), flapAmp: 0.7, gait: rnd(0, 1), walking: 0, neckYaw: 0, reach: 0, swim: false,
      mode: "stand", t: 0, dur: 1, tx: 0, ty: 0, face: DOWN, carry: false, job: 0, fx: 0, fy: 0, sx: 0, sy: 0, ft: 0, fdur: 1, landSwim: false,
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
    const want = Math.atan2(dy, dx);
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
    seed = 23;
    const { w, h } = S;
    const n = Math.max(4, Math.round((w * h) / 70000));
    S.patches = Array.from({ length: n }, () => ({ x: srnd(w * 0.12, w * 0.88), y: srnd(h * 0.15, h * 0.85), rx: srnd(45, 85), ry: srnd(26, 46) }));
    S.grazed = [];
    S.nest = { x: w * 0.5, y: h * 0.52, r: Math.min(70, w * 0.1), strands: [] };
  }
  function restSpots() {
    const cx = S.w * 0.5, cy = S.h * 0.58;
    return [[-90, -10], [-30, 30], [40, -14], [100, 26], [-5, -90], [150, -40]].map(([dx, dy]) => [cx + dx * (S.sc / 0.6), cy + dy * (S.sc / 0.6)]);
  }

  /** Where each bird lands when the scene starts, and what it does then. */
  function startScene() {
    S.prints = []; S.rings = []; S.ringT = 0; S.track = 0; S.t = 0;
    const k = S.kind!;
    const n = S.birds.length;
    S.sentinel = 4;
    S.birds.forEach((b, i) => {
      let x = S.w * (0.2 + 0.6 * (i / (n - 1))), y = S.h * (0.35 + 0.3 * ((i % 2) ? 1 : 0)), swim = false;
      if (k === "plan" || k === "package") { const p = S.patches[i % S.patches.length]; x = p.x + rnd(-20, 20); y = p.y + rnd(-10, 10); }
      if (k === "agree" || k === "founder" || k === "deliver") { const s = k === "deliver" ? guardSpot(i) : restSpots()[i]; x = s[0]; y = s[1]; }
      if (k === "answer") { x = S.w * (0.18 + 0.64 * (i / (n - 1))); y = S.h * (0.55 + (i % 2) * 0.12); }
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
    if (k === "plan") return setMode(b, Math.random() < 0.6 ? "graze" : "stand", rnd(2.5, 6));
    if (k === "agree" || k === "founder") return setMode(b, b.id === S.sentinel ? "stand" : "sit", 99);
    if (k === "answer") return setMode(b, "stand", 99);
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
      const done = stepWalk(b, dt, pace, k === "record", k === "plan" || k === "package" || k === "freeze" || k === "record" ? "" : undefined);
      if (k === "freeze" && Math.random() < dt * 0.25) { setMode(b, "slip", 0.7); return; }
      if (k === "record" && b.x > S.w - 60) { hopBack(b); return; }
      if (done) {
        if (k === "package" && b.job === 1) { b.carry = false; addStrands(4); b.job = 2; return setMode(b, "graze", rnd(1, 2)); }
        if (k === "package" && b.job === 0) { b.carry = true; b.job = 1; const a = rnd(0, TAU); goTo(b, S.nest.x + Math.cos(a) * S.nest.r * 1.1, S.nest.y + Math.sin(a) * S.nest.r * 0.85); return; }
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
        if (S.grazed.length < 260) S.grazed.push({ x: hx + rnd(-4, 4), y: hy + rnd(-3, 3), r: rnd(3, 6) });
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
    if (k === "answer" || ((k === "agree" || k === "deliver" || k === "founder") && b.id === S.sentinel)) { turnTo(b, UP + Math.sin(S.t * 0.3 + b.seed) * 0.1, dt); idle(b, dt, 0.25); return; }
    if (k === "deliver") { const a = Math.atan2(b.y - S.nest.y, b.x - S.nest.x); turnTo(b, a, dt); idle(b, dt, 0.5); return; }
    idle(b, dt, 0.6);
    if (k === "freeze" && b.t > 0.4) { // a frost ring forms where it stands
      const near = S.rings.some((r) => r.kind === "frost" && Math.hypot(r.x - b.x, r.y - b.y) < 40);
      if (!near && S.rings.filter((r) => r.kind === "frost").length < 40) S.rings.push({ x: b.x, y: b.y, r: 0, age: 0, kind: "frost" });
    }
    if (b.t > b.dur) next(b);
  }

  /** Pick the bird's next task in the scenes where they keep moving. */
  function next(b: Bird) {
    const k = S.kind!;
    if (k === "plan") {
      if (b.mode === "graze" && Math.random() < 0.5) return setMode(b, "stand", rnd(1.2, 2.6)); // stop and think
      const p = S.patches[Math.floor(rnd(0, S.patches.length))];
      return goTo(b, p.x + rnd(-p.rx * 0.6, p.rx * 0.6), p.y + rnd(-p.ry * 0.6, p.ry * 0.6));
    }
    if (k === "freeze") return goTo(b, rnd(S.w * 0.1, S.w * 0.9), rnd(S.h * 0.15, S.h * 0.85));
    if (k === "package") { // off to fetch another strip
      b.job = 0;
      const edge = Math.random() < 0.5 ? rnd(30, S.w * 0.25) : rnd(S.w * 0.75, S.w - 30);
      return goTo(b, edge, rnd(S.h * 0.15, S.h * 0.85));
    }
    setMode(b, "stand", 99);
  }
  function hopBack(b: Bird) { // record: at the far edge, back to the left on the next track
    b.job = (b.job + 1) % 3;
    b.sx = b.x; b.sy = b.y; b.fx = S.w * 0.08 + rnd(0, 30); b.fy = trackY(b.job) + (b.id % 2) * 4;
    b.ft = -b.id * 0.15; b.fdur = 2.2; b.mode = "enter"; b.alt = 0.6; b.sigma = 1; b.landSwim = false;
  }
  function addStrands(n: number) {
    const N = S.nest;
    for (let i = 0; i < n && N.strands.length < 320; i++) {
      const a = rnd(0, TAU), rr = N.r * rnd(0.55, 1), len = rnd(14, 30), t = a + DOWN + rnd(-0.5, 0.5);
      const px = N.x + Math.cos(a) * rr, py = N.y + Math.sin(a) * rr * 0.78, paper = Math.random() < 0.2;
      N.strands.push({ x0: px - Math.cos(t) * len / 2, y0: py - Math.sin(t) * len / 2 * 0.78, x1: px + Math.cos(t) * len / 2, y1: py + Math.sin(t) * len / 2 * 0.78,
        paper, c: `rgba(${110 + rnd(0, 50)},${84 + rnd(0, 40)},${50 + rnd(0, 25)},0.9)`, w: paper ? 3 : rnd(1, 2) });
    }
  }

  // ------------------------------------------------------------------ drawing

  function drawRing(r: Ring) {
    if (r.kind === "ripple") {
      const a = 0.28 * (1 - r.age / 3);
      if (a <= 0) return;
      ctx.strokeStyle = `rgba(210,160,105,${a})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.62, 0, 0, TAU); ctx.stroke();
      return;
    }
    if (r.kind === "gold") {
      ctx.strokeStyle = `rgba(210,160,105,${Math.min(0.85, r.age * 2)})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(r.x, r.y, 16, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(r.x, r.y, 3, 0, TAU); ctx.fillStyle = "rgba(210,160,105,0.6)"; ctx.fill();
      return;
    }
    const R = r.r;
    for (let i = 0; i < 3; i++) { ctx.strokeStyle = `rgba(255,255,255,${0.9 - i * 0.25})`; ctx.lineWidth = 1.4 - i * 0.3; ctx.beginPath(); ctx.arc(r.x, r.y, R + i * 6, 0, TAU); ctx.stroke(); }
    ctx.fillStyle = "rgba(255,255,255,0.32)"; ctx.beginPath(); ctx.arc(r.x, r.y, R, 0, TAU); ctx.fill();
    for (let k = 0; k < 6; k++) { const a = k * TAU / 6; ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(r.x + Math.cos(a) * R * 0.25, r.y + Math.sin(a) * R * 0.25); ctx.lineTo(r.x + Math.cos(a) * R * 0.75, r.y + Math.sin(a) * R * 0.75); ctx.stroke(); }
  }
  function drawNest(done: boolean) {
    const N = S.nest;
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(N.x + 4, N.y + 6, N.r * 1.05, N.r * 0.8, 0, 0, TAU); ctx.fill();
    ctx.lineCap = "round";
    for (const s of N.strands) { ctx.strokeStyle = s.paper ? "rgba(242,236,225,0.9)" : s.c; ctx.lineWidth = s.w; ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke(); }
    ctx.fillStyle = "#2A2014"; ctx.beginPath(); ctx.ellipse(N.x, N.y, N.r * 0.5, N.r * 0.38, 0, 0, TAU); ctx.fill();
    if (done) {
      ctx.save(); ctx.translate(N.x, N.y); ctx.rotate(-0.15);
      ctx.fillStyle = "#F2ECE1"; ctx.fillRect(-20, -14, 40, 28);
      ctx.fillStyle = "rgba(42,36,29,0.35)"; for (let i = -9; i < 12; i += 5) ctx.fillRect(-15, i, 22, 1.6);
      ctx.fillStyle = "#D2A069"; ctx.fillRect(-20, -2, 40, 4); ctx.fillRect(-2, -14, 4, 28);
      ctx.restore();
    }
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
    if (k === "plan") { ctx.fillStyle = "rgba(48,40,26,0.5)"; for (const g of S.grazed) { ctx.beginPath(); ctx.ellipse(g.x, g.y, g.r, g.r * 0.7, 0, 0, TAU); ctx.fill(); } }
    const light = k === "freeze";
    const color = k === "record" ? "rgba(26,19,12,0.78)" : light ? "rgba(70,100,115,0.45)" : "rgba(222,206,170,0.22)";
    for (const p of S.prints) { ctx.globalAlpha = p.a; drawPrint(ctx, p.x, p.y, p.h, S.sc * (p.deep ? 1.5 : 1.25), color); }
    ctx.globalAlpha = 1;
    for (const r of S.rings) drawRing(r);
    if (k === "package" || k === "deliver") drawNest(k === "deliver");
    const shade = light ? "rgba(60,90,104,0.22)" : k === "record" ? "rgba(20,14,8,0.4)" : "rgba(0,0,0,0.35)";
    const vis = S.birds.filter((b) => b.mode !== "gone").sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0));
    for (const b of vis) drawGooseShadow(ctx, b, shade);
    for (const b of vis) { drawGoose(ctx, b); if (b.carry) drawCarry(b); }
    void w; void h;
  }

  function update(dt: number) {
    S.t += dt;
    const k = S.kind;
    for (const b of S.birds) updateBird(b, dt);
    // prints fade on grass and ice; the mud keeps them
    if (k !== "record") for (const p of S.prints) p.a -= dt * (k === "freeze" ? 0.05 : 0.08);
    S.prints = S.prints.filter((p) => p.a > 0.02);
    for (const r of S.rings) {
      r.age += dt;
      if (r.kind === "ripple") r.r += dt * 9;
      if (r.kind === "frost") r.r = Math.min(20 * (S.sc / 0.6), r.r + dt * 26);
    }
    S.rings = S.rings.filter((r) => r.kind !== "ripple" || r.age < 3);
    if (k === "record") { // a gold ring is pressed into the mud every so often along the leading bird's path
      S.ringT += dt;
      const lead = S.birds.find((b) => b.mode === "walk");
      if (lead && S.ringT > 2.2) { S.ringT = 0; S.rings.push({ x: lead.x - Math.cos(lead.heading) * 30, y: lead.y, r: 16, age: 0, kind: "gold" }); if (S.rings.length > 40) S.rings.shift(); }
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
