/* A realistic Canada goose, always seen from directly above, drawn with the Canvas 2D API.
   Local frame: +x = forward (bill), +y = the bird's right. About 95 units from bill tip to tail. */
import { TAU, lerp, smooth } from "./math";

/** What the renderer needs to know about a bird. Scenes keep more state on their own bird objects. */
export interface GoosePose {
  x: number;
  y: number;
  heading: number;
  scale: number;
  /** 0 on the ground or water, 1 high in the air (bigger, softer shadow). */
  alt?: number;
  /** How far the wings are open, 0 folded to 1 spread. */
  sigma?: number;
  /** Wingbeat phase (radians) and amplitude. */
  flapT?: number;
  flapAmp?: number;
  /** Walk cycle phase (0..1) and how much the bird is walking (0..1). */
  gait?: number;
  walking?: number;
  /** Floating on water: no feet drawn. */
  swim?: boolean;
  /** Head turned to one side (radians) and how far the bill reaches down to feed (0..1). */
  neckYaw?: number;
  reach?: number;
  /** Optional rim colour, so birds read on a light page as well as on dark water. */
  outline?: string;
}

type Palette = typeof GOOSE_PAL;

const GOOSE_PAL = {
  body: "#7a6855", bodyDark: "#4a3d31", bodyLight: "#94806a", breast: "#c4b498",
  wing: "#665544", wingDark: "#4b3f33", edge: "rgba(214,198,172,0.30)", flight: "#3d332b", primary: "#2a231e",
  neck: "#181614", cheek: "#efeae0", rump: "#f1ede5", tail: "#191612", foot: "#3a342e", rim: "rgba(255,238,212,0.20)",
};

function featherRows(ctx: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, step: number, color: string, lw: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  let row = 0;
  for (let x = x0; x > x1; x -= step * 0.8, row++) {
    for (let y = y0 + (row % 2 ? step * 0.5 : 0); y < y1; y += step) {
      ctx.moveTo(x, y - step * 0.4);
      ctx.quadraticCurveTo(x - step * 0.5, y, x, y + step * 0.4);
    }
  }
  ctx.stroke();
}

function bodyPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(26, 0);
  ctx.bezierCurveTo(26, 8, 16, 13.5, 3, 15.2);
  ctx.bezierCurveTo(-11, 16.8, -25, 12.5, -31, 5.4);
  ctx.bezierCurveTo(-33.5, 2, -33.5, -2, -31, -5.4);
  ctx.bezierCurveTo(-25, -12.5, -11, -16.8, 3, -15.2);
  ctx.bezierCurveTo(16, -13.5, 26, -8, 26, 0);
  ctx.closePath();
}

function drawFoot(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, lift: number, pal: Palette) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(side * 0.12);
  const k = 1 + lift * 0.1;
  ctx.scale(k, k);
  ctx.beginPath();
  ctx.moveTo(-1.5, 0);
  ctx.quadraticCurveTo(3, -3, 7.4, -4.8);
  ctx.quadraticCurveTo(7, -1.7, 9.6, -0.6);
  ctx.lineTo(9.6, 0.6);
  ctx.quadraticCurveTo(7, 1.7, 7.4, 4.8);
  ctx.quadraticCurveTo(3, 3, -1.5, 0);
  ctx.closePath();
  ctx.fillStyle = pal.foot;
  ctx.fill();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();
}

function drawFoldedWing(ctx: CanvasRenderingContext2D, side: number, pal: Palette, alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.scale(1, side);
  ctx.beginPath();
  ctx.moveTo(16, 12);
  ctx.bezierCurveTo(5, 15.6, -14, 14.2, -26, 9.4);
  ctx.bezierCurveTo(-34, 6.4, -40, 3, -45, -0.6);
  ctx.bezierCurveTo(-37, -1.4, -26, -1.1, -12, 0.4);
  ctx.bezierCurveTo(0, 2, 9, 5.4, 16, 12);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 1, 0, 15);
  g.addColorStop(0, pal.wing);
  g.addColorStop(1, pal.wingDark);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = pal.primary;
  ctx.fillRect(-50, -2, 26, 20);
  ctx.fillStyle = pal.flight;
  ctx.fillRect(-25, -2, 7, 20);
  featherRows(ctx, 13, -25, 1, 16, 4.4, pal.edge, 0.8);
  ctx.restore();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

type WingPt = { s: number; k: number; le: { x: number; y: number }; te: { x: number; y: number } };

/* Open wing: arm and hand hinge about the body axis, projected from above with gentle perspective.
   sweep folds the hand back on the upstroke. */
function wingGeom(side: number, sigma: number, th1: number, th2: number, sweep: number): WingPt[] {
  const span = 74 * sigma, dW = span * 0.42, root = 10.5;
  const pts: WingPt[] = [], N = 18;
  for (let i = 0; i <= N; i++) {
    const s = i / N, d = s * span;
    const hand = Math.max(0, (s - 0.42) / 0.58);
    const xle = s <= 0.42 ? 13 - 6 * (s / 0.42) : 7 - hand * (8 + 12 * sweep);
    const chord = (s <= 0.42 ? 25 - 4 * (s / 0.42) : 21 - 14 * Math.pow(hand, 1.2)) * (0.5 + 0.5 * sigma);
    let y: number, z: number;
    if (d <= dW) {
      y = root + d * Math.cos(th1);
      z = d * Math.sin(th1);
    } else {
      y = root + dW * Math.cos(th1) + (d - dW) * Math.cos(th2);
      z = dW * Math.sin(th1) + (d - dW) * Math.sin(th2);
    }
    const k = 1 / (1 - z * 0.0035);
    // slotted primaries: a slight saw-tooth on the outer trailing edge
    const notch = hand > 0.55 ? (i % 2 ? 1.6 : 0) * hand : 0;
    pts.push({ s, k, le: { x: xle * k, y: side * y * k }, te: { x: (xle - chord + notch) * k, y: side * y * k } });
  }
  return pts;
}

function drawOpenWing(ctx: CanvasRenderingContext2D, side: number, sigma: number, th1: number, th2: number, sweep: number, pal: Palette) {
  if (sigma <= 0.02) return;
  const P = wingGeom(side, sigma, th1, th2, sweep);
  const tip = P[P.length - 1];
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(P[0].le.x, P[0].le.y);
    for (const p of P) ctx.lineTo(p.le.x, p.le.y);
    ctx.quadraticCurveTo(tip.le.x - 3, tip.le.y + side * 2.5, tip.te.x, tip.te.y);
    for (let i = P.length - 1; i >= 0; i--) ctx.lineTo(P[i].te.x, P[i].te.y);
    ctx.closePath();
  };
  ctx.save();
  outline();
  ctx.fillStyle = pal.wing;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // secondaries: a darker band along the arm's trailing edge
  ctx.beginPath();
  for (const p of P) ctx.lineTo(lerp(p.te.x, p.le.x, 0.42), lerp(p.te.y, p.le.y, 0.42));
  for (let i = P.length - 1; i >= 0; i--) ctx.lineTo(P[i].te.x - 3, P[i].te.y);
  ctx.closePath();
  ctx.fillStyle = pal.flight;
  ctx.fill();
  // primaries: the dark outer hand
  const h0 = Math.round(P.length * 0.58);
  ctx.beginPath();
  for (let i = h0; i < P.length; i++) ctx.lineTo(P[i].le.x + 2, P[i].le.y);
  ctx.lineTo(tip.te.x - 4, tip.te.y + side * 4);
  for (let i = P.length - 1; i >= h0; i--) ctx.lineTo(P[i].te.x - 3, P[i].te.y);
  ctx.closePath();
  ctx.fillStyle = pal.primary;
  ctx.fill();
  // coverts texture and feather separations
  ctx.strokeStyle = pal.edge;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let i = 1; i < P.length; i += 2) {
    const p = P[i];
    ctx.moveTo(p.te.x, p.te.y);
    ctx.lineTo(lerp(p.te.x, p.le.x, 0.3), lerp(p.te.y, p.le.y, 0.3));
  }
  ctx.stroke();
  // light falls off as the wing tilts away from flat
  const shade = (1 - Math.cos(th1)) * 0.55;
  if (shade > 0.01) {
    ctx.fillStyle = `rgba(0,0,0,${shade.toFixed(3)})`;
    ctx.fillRect(-80, -120, 160, 240);
  }
  ctx.restore();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.8;
  outline();
  ctx.stroke();
  ctx.strokeStyle = "rgba(226,210,184,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P[0].le.x, P[0].le.y);
  for (let i = 1; i < P.length - 2; i++) ctx.lineTo(P[i].le.x, P[i].le.y);
  ctx.stroke();
  ctx.restore();
}

/** Advance a bird's wingbeat; the downstroke is a little quicker than the upstroke. */
export function advanceFlap(g: { flapT?: number }, dt: number, hz: number) {
  const rate = TAU * hz * (1 - 0.22 * Math.cos(g.flapT || 0));
  g.flapT = (g.flapT || 0) + rate * dt;
}

export function drawGoose(ctx: CanvasRenderingContext2D, g: GoosePose) {
  const pal: Palette = g.outline ? { ...GOOSE_PAL, rim: g.outline } : GOOSE_PAL;
  const alt = g.alt || 0;
  const k = g.scale * (1 + alt * 0.4);
  const sigma = g.sigma || 0;
  const amp = g.flapAmp ?? 0.75;
  const ph = g.flapT || 0;
  const th1 = amp * Math.sin(ph) + 0.08;
  const th2 = th1 + amp * 0.55 * Math.sin(ph - 0.8);
  const sweep = Math.pow(0.5 + 0.5 * Math.cos(ph), 2) * Math.min(1, amp / 0.6);
  const gait = g.gait || 0, walk = g.walking || 0;
  const sway = Math.sin(gait * TAU) * walk;

  ctx.save();
  ctx.translate(g.x, g.y);
  ctx.rotate(g.heading + sway * 0.06);
  ctx.translate(0, sway * 1.1);
  ctx.scale(k, k);

  // wings go under the body so the roots never pop over it
  if (sigma > 0.02) {
    drawOpenWing(ctx, 1, sigma, th1, th2, sweep, pal);
    drawOpenWing(ctx, -1, sigma, th1, th2, sweep, pal);
  }

  if (!g.swim && alt < 0.1) {
    for (const side of [-1, 1]) {
      const p = (gait + (side > 0 ? 0.5 : 0)) % 1;
      let fx: number, lift = 0;
      if (walk < 0.05) fx = 4;
      else if (p < 0.5) fx = 10 - 20 * (p / 0.5) * walk;
      else {
        const u = (p - 0.5) / 0.5;
        fx = 10 - 20 * walk + 20 * walk * (u * u * (3 - 2 * u));
        lift = Math.sin(Math.PI * u) * walk;
      }
      ctx.strokeStyle = pal.foot;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(6, side * 6);
      ctx.lineTo(8 + fx, side * 9);
      ctx.stroke();
      drawFoot(ctx, 8 + fx, side * 9, side * 0.6, lift, pal);
    }
  }

  const slim = 1 - smooth(0.2, 0.8, sigma) * 0.1;
  ctx.save();
  ctx.scale(1, slim);
  // tail + white rump band (the U that shows from above)
  ctx.beginPath();
  ctx.moveTo(-28, -6.5);
  ctx.quadraticCurveTo(-40, -7.5, -41.5, 0);
  ctx.quadraticCurveTo(-40, 7.5, -28, 6.5);
  ctx.closePath();
  ctx.fillStyle = pal.tail;
  ctx.fill();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-30, 0, 3, 8, 0, 0, TAU);
  ctx.fillStyle = pal.rump;
  ctx.fill();
  // body
  bodyPath(ctx);
  const bg = ctx.createLinearGradient(0, -16, 0, 16);
  bg.addColorStop(0, pal.bodyLight);
  bg.addColorStop(0.4, pal.body);
  bg.addColorStop(0.75, pal.body);
  bg.addColorStop(1, pal.bodyDark);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.save();
  bodyPath(ctx);
  ctx.clip();
  const br = ctx.createLinearGradient(26, 0, 9, 0);
  br.addColorStop(0, pal.breast);
  br.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = br;
  ctx.fillRect(8, -17, 22, 34);
  featherRows(ctx, 14, -28, -15, 16, 4.6, pal.edge, 0.75);
  ctx.restore();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.8;
  bodyPath(ctx);
  ctx.stroke();
  const foldA = 1 - smooth(0, 0.35, sigma);
  drawFoldedWing(ctx, 1, pal, foldA);
  drawFoldedWing(ctx, -1, pal, foldA);
  ctx.restore();

  // neck + head
  const yaw = (g.neckYaw || 0) * (1 - smooth(0.2, 0.7, alt));
  const reach = g.reach || 0;
  const neckLen = 19 + smooth(0.3, 1, alt) * 7 + reach * 8 + Math.sin(gait * TAU * 2) * walk * 1.4;
  const bx = 21;
  const hx = bx + Math.cos(yaw) * neckLen, hy = Math.sin(yaw) * neckLen;
  const cx = bx + Math.cos(yaw * 0.45) * neckLen * 0.55, cy = Math.sin(yaw * 0.45) * neckLen * 0.55;
  ctx.lineCap = "round";
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 8.6;
  ctx.beginPath();
  ctx.moveTo(bx, 0);
  ctx.quadraticCurveTo(cx, cy, hx, hy);
  ctx.stroke();
  ctx.strokeStyle = pal.neck;
  ctx.lineWidth = 7.2;
  ctx.beginPath();
  ctx.moveTo(bx, 0);
  ctx.quadraticCurveTo(cx, cy, hx, hy);
  ctx.stroke();
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(Math.atan2(hy - cy, hx - cx));
  const hk = 1 - reach * 0.18; // the head drops toward the ground (or water) as it feeds
  ctx.scale(hk, hk);
  // the white chinstrap shows only as thin bands along the sides of the head from above
  ctx.fillStyle = pal.cheek;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(-1.6, s * 3.9, 4.4, 1.35, s * -0.12, 0, TAU);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(1, 0, 7.2, 4.35, 0, 0, TAU);
  ctx.fillStyle = pal.neck;
  ctx.fill();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(6.6, -2.2);
  ctx.quadraticCurveTo(13.2, -1.5, 13.6, 0);
  ctx.quadraticCurveTo(13.2, 1.5, 6.6, 2.2);
  ctx.closePath();
  ctx.fillStyle = pal.neck;
  ctx.fill();
  ctx.strokeStyle = pal.rim;
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

export function drawGooseShadow(ctx: CanvasRenderingContext2D, g: GoosePose, color: string) {
  const a = g.alt || 0;
  const off = a * 64 * g.scale;
  ctx.save();
  ctx.translate(g.x + off * 0.55, g.y + off * 0.85);
  ctx.rotate(g.heading);
  ctx.scale(g.scale, g.scale);
  ctx.globalAlpha = 1 - a * 0.55;
  ctx.fillStyle = color;
  if ("filter" in ctx) ctx.filter = `blur(${(2 + a * 4) * g.scale}px)`;
  ctx.beginPath();
  ctx.ellipse(-4, 0, 31, 15, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(30, 0, 13, 4.5, 0, 0, TAU);
  ctx.fill();
  const sigma = g.sigma || 0;
  if (sigma > 0.05) {
    const th = (g.flapAmp ?? 0.75) * Math.sin(g.flapT || 0) + 0.08;
    const span = 74 * sigma * Math.cos(th);
    ctx.beginPath();
    ctx.ellipse(2, 0, 11, 11 + span, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** One webbed footprint: three toes and a faint web. */
export function drawPrint(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.scale(size, size);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(7.6, -4.8);
  ctx.moveTo(0, 0);
  ctx.lineTo(9.2, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(7.6, 4.8);
  ctx.stroke();
  ctx.globalAlpha *= 0.4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(7, -4.3);
  ctx.quadraticCurveTo(5.2, 0, 7, 4.3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawDropping(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(78,64,46,0.85)";
  ctx.beginPath();
  ctx.ellipse(0, 0, 4.6, 2.6, 0.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(112,94,70,0.9)";
  ctx.beginPath();
  ctx.ellipse(-0.8, -0.6, 2.6, 1.5, 0.4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "rgba(236,230,218,0.95)";
  ctx.beginPath();
  ctx.ellipse(-1.4, -1.1, 1.1, 0.65, 0.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}
