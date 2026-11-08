/* The hero scene: five geese feed on dark water around the logo. Scrolling cues each bird's take-off;
   it then turns to face down, runs along the water, lifts and flies on down on its own line (never looping
   back), and stops above whatever text lies below it. When the visitor reaches the content, the birds
   peel off through the right side one after another. Back at the top they return to the water.

   The canvas is fixed over the whole page, so birds fly over the content as they leave. */
import { advanceFlap, drawGoose, type GoosePose } from "./draw";
import { DOWN, TAU, angDiff, bez, clamp, easeOut, fitCanvas, lerp, rnd, smooth, type Pt } from "./math";

type Seat = {
  /** Wide screens: offset from the centre (fraction of a capped span) and height (fraction of the viewport). */
  fx: number; fy: number;
  /** Phones, where the logo fills the width: two birds above it, three under the slogan. */
  nx: number; ny: number;
  /** Phones: cap on how far the bird travels, so the cruising birds end up staggered. */
  nd?: number;
  /** Scroll progress that cues the take-off, heading offset from straight down, bow direction. */
  ps: number; dev: number; cv: number;
  /** Wingbeats per second, idle heading, size. */
  hz: number; h0: number; size: number;
};

type SkyGoose = GoosePose & Seat & {
  // per-bird randomness
  a: number; b: number; c: number; k1: number; bo: number; bp: number; tko: number; preenSide: number; rip: number; dipped: boolean;
  // layout
  S: Pt; D: number; runLen: number; runShare: number; runExp: number;
  // take-off
  tau: number; q: number; R0?: Pt; h1: number; cruise0: number | null;
  // exit
  snapAlt?: number; snapSigma?: number; exDelay: number; exDur: number; v0: number; exSnap: Pt; exPath?: [Pt, Pt, Pt, Pt]; exitDone: boolean;
};

type Ripple = { x: number; y: number; t: number; life: number; r: number };

const SEATS: Seat[] = [
  { fx: -0.40, fy: 0.28, nx: -0.30, ny: 0.13, ps: 0.05, dev: 0.10, cv: 1, hz: 2.8, h0: -0.4, size: 1.16 },
  { fx: -0.31, fy: 0.62, nx: -0.17, ny: 0.565, nd: 0.08, ps: 0.16, dev: -0.06, cv: -1, hz: 3.3, h0: 2.6, size: 0.82 },
  { fx: 0.03, fy: 0.61, nx: 0.06, ny: 0.585, ps: 0.10, dev: 0.04, cv: 1, hz: 2.6, h0: -1.9, size: 1.24 },
  { fx: 0.33, fy: 0.57, nx: 0.28, ny: 0.6, nd: 0.11, ps: 0.23, dev: -0.08, cv: -1, hz: 3.1, h0: 3.4, size: 0.92 },
  { fx: 0.41, fy: 0.27, nx: 0.31, ny: 0.15, ps: 0.30, dev: 0.12, cv: 1, hz: 3.0, h0: 1.2, size: 1.04 },
];

/** Take-off progress (0..1) at which the bird has finished turning, and at which it starts to move. */
const TURN_END = 0.14, MOVE_START = 0.09;

export interface SkyElements {
  canvas: HTMLCanvasElement;
  /** The tall scroll container whose progress cues the take-offs. */
  hero: HTMLElement;
  /** The pinned frame inside it. */
  stage: HTMLElement;
  /** The description that fades in at the bottom, and the scroll cue that fades out. */
  desc: HTMLElement;
  cue: HTMLElement | null;
  /** Text the cruising birds must stop above (logo, slogan, description). */
  obstacles: HTMLElement[];
}

export function createSky(els: SkyElements) {
  const ctx = els.canvas.getContext("2d")!;
  const geese: SkyGoose[] = SEATS.map((s, i) => ({
    ...s, x: 0, y: 0, heading: s.h0, scale: 1,
    a: rnd(0, TAU), b: rnd(0, TAU), c: rnd(0, TAU), k1: rnd(0.8, 1.25), bo: rnd(0, 10), bp: rnd(9, 13), tko: rnd(4.2, 5.0),
    preenSide: i % 2 ? 1 : -1, flapT: rnd(0, TAU), rip: rnd(0, 2), dipped: false,
    S: { x: 0, y: 0 }, D: 1, runLen: 1, runShare: 0.36, runExp: 2,
    tau: 0, q: 0, h1: 0, cruise0: null, exDelay: 0, exDur: 3, v0: 0, exSnap: { x: 0, y: 0 }, exitDone: false,
  }));
  const sky = {
    w: 1, h: 1, dpr: 1, u: 1, p: 0, pT: 0, alpha: 1, exitT0: 0,
    phase: "scrub" as "scrub" | "exit" | "gone",
    seen: false, fading: false, resetting: false, ripples: [] as Ripple[],
  };
  let cleared = false;

  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    const f = fitCanvas(els.canvas, w, h);
    sky.w = f.w; sky.h = f.h; sky.dpr = f.dpr;
    const u = clamp(Math.min(w / 1200, h / 820), 0.5, 1);
    sky.u = u;
    const narrow = w < 760;
    const st = els.stage.getBoundingClientRect();
    const obstacles = els.obstacles.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - st.top, left: r.left - st.left, right: r.right - st.left };
    });
    for (const g of geese) {
      const span = Math.min(w * 1.05, 1150);
      const fx = narrow ? g.nx : g.fx, fy = narrow ? g.ny : g.fy;
      g.S = { x: clamp(w / 2 + fx * span, 50, w - 50), y: fy * h };
      g.scale = Math.max(0.55, 0.95 * u) * g.size;
      // a bird finishes its take-off above whichever piece of text lies below it
      const wing = 108 * g.scale + 10, half = 56 * g.scale;
      let floor = h - half - 24;
      for (const o of obstacles) if (o.top > g.S.y && g.S.x + wing > o.left && g.S.x - wing < o.right) floor = Math.min(floor, o.top - half - 12);
      floor -= 22 * u; // kept for the slow cruise drift
      g.D = clamp(floor - g.S.y - 10 * u, 70 * u, 0.34 * h); // total distance down from the water
      if (narrow && g.nd) g.D = Math.min(g.D, g.nd * h);
      g.runLen = clamp(g.D * 0.36, 30 * u, 100 * u);
      const r = clamp(g.runLen / g.D, 0.22, 0.5);
      g.runShare = r;
      g.runExp = (2 * (1 - r) * 0.4) / (r * 0.6); // matches the run's end speed to the climb's start speed
      g.R0 = undefined;
    }
  }

  function idlePose(g: SkyGoose, t: number) {
    const u = sky.u;
    const x = g.S.x + Math.sin(t * 0.11 * g.k1 + g.a) * 16 * u + Math.sin(t * 0.05 + g.b) * 9 * u;
    const y = g.S.y + Math.cos(t * 0.09 * g.k1 + g.c) * 8 * u;
    const heading = g.h0 + Math.sin(t * 0.07 + g.a) * 0.9;
    const c = ((t + g.bo) % g.bp) / g.bp;
    let neckYaw = Math.sin(t * 0.5 + g.a) * 0.45;
    const feed = smooth(0.3, 0.34, c) * (1 - smooth(0.51, 0.55, c));
    const reach = feed * Math.pow(0.5 + 0.5 * Math.sin(t * 3.6 + g.a), 2);
    const preen = smooth(0.62, 0.67, c) * (1 - smooth(0.79, 0.84, c));
    neckYaw = lerp(neckYaw, g.preenSide * 2.5, preen);
    return { x, y, heading, neckYaw, reach };
  }

  /* Distance travelled down from the water at take-off progress q. One continuous ease:
     accelerate through the run, carry that speed into the climb, settle softly into cruise. */
  function takeoffDist(g: SkyGoose, q: number) {
    const x = clamp((q - MOVE_START) / (1 - MOVE_START), 0, 1), r = g.runShare;
    const f = x < 0.4 ? r * Math.pow(x / 0.4, g.runExp) : r + (1 - r) * (1 - Math.pow(1 - (x - 0.4) / 0.6, 2));
    return g.D * f;
  }
  function takeoffPos(g: SkyGoose, q: number) {
    const s = takeoffDist(g, q), d = DOWN + g.dev, R0 = g.R0!;
    const k = s / g.D;
    const lat = g.cv * 14 * sky.u * Math.sin(Math.PI * k) * k; // a gentle bow, never a loop
    return { x: R0.x + Math.cos(d) * s - Math.sin(d) * lat, y: R0.y + Math.sin(d) * s + Math.cos(d) * lat, s };
  }

  function scrubPose(g: SkyGoose, now: number, dt: number) {
    const u = sky.u;
    if (sky.p >= g.ps && !sky.resetting) g.tau = Math.min(1, g.tau + dt / g.tko);
    const q = g.tau;
    g.q = q;
    const idle = idlePose(g, now);
    if (q <= 0) {
      Object.assign(g, idle, { swim: true, sigma: 0, alt: 0, walking: 0, flapAmp: 0 });
      g.R0 = undefined;
      if (idle.reach > 0.85 && !g.dipped) {
        g.dipped = true;
        sky.ripples.push({ x: g.x + Math.cos(g.heading) * 34 * g.scale, y: g.y + Math.sin(g.heading) * 34 * g.scale, t: now, life: 1.8, r: 22 * g.scale });
      }
      if (idle.reach < 0.5) g.dipped = false;
      return;
    }
    if (!g.R0) { g.R0 = { x: idle.x, y: idle.y }; g.h1 = idle.heading; g.cruise0 = null; }
    const d = DOWN + g.dev;
    const P = takeoffPos(g, q);
    let pos: Pt = P;
    if (q >= 1) {
      // cruising: drift on down very slowly, with a little sway
      if (g.cruise0 == null) g.cruise0 = now;
      const since = now - g.cruise0;
      const wgt = smooth(0, 2, since);
      pos = { x: P.x + Math.sin(now * 0.55 + g.b) * 8 * u * wgt, y: P.y + Math.min(since, 8) * 2.6 * u + Math.sin(now * 0.8 + g.a) * 4 * u * wgt };
    }
    g.x = pos.x; g.y = pos.y;
    // heading: turn on the water to face down, then follow the path (never past ±0.5 rad of straight down)
    const turn = smooth(0, TURN_END, q);
    const ahead = q < 1 ? takeoffPos(g, Math.min(1, q + 0.01)) : null;
    let want = d;
    if (ahead && Math.hypot(ahead.x - P.x, ahead.y - P.y) > 0.3) want = clamp(Math.atan2(ahead.y - P.y, ahead.x - P.x), DOWN - 0.5, DOWN + 0.5);
    if (q < TURN_END) g.heading = g.h1 + angDiff(g.h1, want) * smooth(0, 1, turn);
    else g.heading += angDiff(g.heading, want) * Math.min(1, dt * 6);
    const k = P.s / g.runLen; // > 1 once the bird has left the water
    g.walking = smooth(0, 0.15, k) * (1 - smooth(0.8, 1.1, k));
    g.sigma = smooth(TURN_END * 0.6, TURN_END + 0.08, q); // wings open as it starts to run
    g.alt = smooth(0.85, 1 + (g.D / g.runLen - 1) * 0.55, k);
    g.swim = k < 0.05;
    g.gait = (P.s / (34 * g.scale)) % 1;
    g.neckYaw = idle.neckYaw * (1 - turn);
    g.reach = idle.reach * (1 - turn);
    const glide = q >= 1 ? smooth(0.55, 0.9, Math.sin(now * 0.45 + g.a * 3)) : 0;
    g.flapAmp = g.sigma * (k < 1.2 ? 0.95 : lerp(0.95, 0.75, smooth(1.2, 2.2, k))) * (1 - 0.75 * glide);
  }

  /* Exit: each bird keeps flying down, then peels off to the right on its own curve, one after another. */
  function startExit(now: number) {
    sky.phase = "exit";
    sky.exitT0 = now;
    const u = sky.u, w = sky.w;
    const order = geese.slice().sort((a, b) => b.x - a.x); // rightmost birds peel off first
    order.forEach((g, k) => {
      g.snapAlt = g.alt;
      g.snapSigma = g.sigma;
      g.exDelay = k * 0.28 + rnd(0, 0.15);
      g.exDur = rnd(3.0, 3.6);
      g.v0 = 26 * u;
      const P0 = { x: g.x, y: g.y + g.v0 * g.exDelay };
      g.exSnap = { x: g.x, y: g.y };
      g.exPath = [P0, { x: P0.x + Math.cos(g.heading) * 4, y: P0.y + 120 * u }, { x: P0.x + 0.2 * w + 60 * u, y: P0.y + 165 * u },
        { x: w + 260 * u, y: P0.y + 70 * u + rnd(-30, 30) * u }];
    });
  }
  function exitPose(g: SkyGoose, now: number, dt: number) {
    const t = now - sky.exitT0;
    let pos: Pt, hd = g.heading;
    if (t < g.exDelay) {
      pos = { x: g.exSnap.x, y: g.exSnap.y + g.v0 * t };
      hd = DOWN;
    } else {
      const ti = clamp((t - g.exDelay) / g.exDur, 0, 1), s = 0.3 * ti + 0.7 * ti * ti;
      pos = bez(g.exPath!, s);
      const q = bez(g.exPath!, Math.min(1, s + 0.01));
      hd = Math.atan2(q.y - pos.y, q.x - pos.x);
      g.exitDone = ti >= 1;
    }
    g.x = pos.x; g.y = pos.y;
    g.heading += angDiff(g.heading, hd) * Math.min(1, dt * 4);
    g.alt = lerp(g.snapAlt ?? 1, 1, smooth(0, 1, t));
    g.sigma = lerp(g.snapSigma ?? 1, 1, smooth(0, 0.4, t));
    g.swim = false;
    g.walking = 0;
    const glide = smooth(0.55, 0.9, Math.sin(now * 0.5 + g.a * 3));
    g.flapAmp = 0.8 * (1 - 0.65 * glide);
  }

  function park() {
    for (const g of geese) { g.tau = 1; g.R0 = undefined; }
  }

  function update(dt: number, now: number) {
    const r = els.hero.getBoundingClientRect();
    const span = Math.max(1, r.height - window.innerHeight);
    sky.pT = clamp(-r.top / span, 0, 1);
    if (!sky.seen || r.bottom < 0) sky.p = sky.pT; // first frame (or hero long gone): no catch-up glide
    else sky.p += (sky.pT - sky.p) * Math.min(1, dt * 7);
    if (Math.abs(sky.pT - sky.p) < 0.0005) sky.p = sky.pT;
    const p = sky.p;
    els.desc.style.opacity = smooth(0.32, 0.46, p).toFixed(3);
    if (els.cue) els.cue.style.opacity = (1 - smooth(0, 0.05, p)).toFixed(3);
    const ready = geese.every((g) => g.tau > 0.7);
    const maxTau = Math.max(...geese.map((g) => g.tau));
    const past = r.bottom < 0; // the whole hero has scrolled away
    if (sky.phase === "scrub" && past && maxTau < 0.15) {
      // the birds never really got going (a deep link, or a very fast scroll): don't fly them over the content
      if (!sky.seen) { sky.phase = "gone"; park(); }
      else sky.fading = true;
    }
    if (sky.fading) {
      sky.alpha = Math.max(0, sky.alpha - dt * 4);
      if (sky.alpha <= 0) { sky.fading = false; sky.phase = "gone"; park(); }
    }
    sky.seen = true;
    if (sky.phase === "scrub" && !sky.fading && p >= 0.88 && (ready || past)) startExit(now);
    if (sky.phase !== "scrub" && p < 0.8) {
      sky.fading = false;
      sky.phase = "scrub";
      sky.alpha = 0;
      for (const g of geese) { g.exitDone = false; g.cruise0 = null; }
    }
    // back at the top: fade out, put everyone back on the water, fade in
    if (sky.phase === "scrub" && p < 0.03 && !sky.resetting && geese.some((g) => g.tau > 0)) sky.resetting = true;
    if (sky.resetting) {
      sky.alpha = Math.max(0, sky.alpha - dt * 3);
      if (sky.alpha <= 0) {
        for (const g of geese) { g.tau = 0; g.R0 = undefined; }
        sky.resetting = false;
      }
    } else if (!sky.fading) sky.alpha = Math.min(1, sky.alpha + dt * 1.6);
    for (const g of geese) {
      if ((g.sigma ?? 0) > 0.01) advanceFlap(g, dt, g.hz);
      if (sky.phase === "scrub") scrubPose(g, now, dt);
      else if (sky.phase === "exit") exitPose(g, now, dt);
      if (sky.phase === "scrub" && g.q <= 0.02) {
        g.rip -= dt;
        if (g.rip <= 0) { sky.ripples.push({ x: g.x, y: g.y, t: now, life: 3, r: 58 * g.scale }); g.rip = rnd(1.6, 2.6); }
      }
    }
    if (sky.phase === "exit" && geese.every((g) => g.exitDone)) sky.phase = "gone";
    sky.ripples = sky.ripples.filter((rr) => now - rr.t < rr.life);
  }

  function draw(now: number) {
    const { dpr, w, h } = sky;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (sky.phase === "gone") return;
    ctx.globalAlpha = sky.alpha;
    if (sky.phase === "scrub") {
      ctx.lineWidth = 1.1;
      for (const r of sky.ripples) {
        const k = (now - r.t) / r.life, rr = 10 * sky.u + r.r * easeOut(k);
        ctx.strokeStyle = `rgba(236,204,154,${(0.3 * (1 - k)).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rr, rr * 0.9, 0, 0, TAU);
        ctx.stroke();
      }
      // splashes from the feet as each bird runs along the water
      for (const g of geese) {
        if (g.q <= MOVE_START || !g.R0) continue;
        const d = DOWN + g.dev;
        for (let qk = MOVE_START + 0.02, n = 0; qk < g.q; qk += 0.02, n++) {
          const pk = takeoffPos(g, qk);
          if (pk.s > g.runLen * 0.95) break;
          const a = (g.q - qk) / 0.22;
          if (a > 1) continue;
          const side = n % 2 ? 1 : -1;
          const ox = -Math.sin(d) * side * 8 * g.scale, oy = Math.cos(d) * side * 8 * g.scale;
          const rr = 4 * sky.u + a * 36 * sky.u;
          ctx.strokeStyle = `rgba(236,204,154,${(0.5 * (1 - a)).toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(pk.x + ox, pk.y + oy, rr, rr * 0.9, 0, 0, TAU);
          ctx.stroke();
        }
      }
      // the faint wake around a swimming bird
      for (const g of geese) {
        if (!g.swim) continue;
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.heading);
        ctx.strokeStyle = "rgba(236,204,154,0.16)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(-3 * g.scale, 0, 36 * g.scale, 20 * g.scale, 0, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
    for (const g of geese.slice().sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0))) drawGoose(ctx, g);
    ctx.globalAlpha = 1;
  }

  return {
    layout,
    /** One animation frame. Returns quickly (after clearing once) when the scene is off screen. */
    frame(dt: number, now: number) {
      const heroNear = els.hero.getBoundingClientRect().bottom > -window.innerHeight;
      if (heroNear || sky.phase === "exit" || (sky.phase === "scrub" && sky.seen)) {
        update(dt, now);
        draw(now);
        cleared = false;
      } else if (!cleared) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
        cleared = true;
      }
    },
    /** Reduced motion: the birds sit still on the water. */
    drawStill() {
      for (const g of geese) Object.assign(g, idlePose(g, 0), { swim: true, sigma: 0, alt: 0, walking: 0 });
      draw(0);
    },
  };
}
