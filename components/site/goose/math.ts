// Small numeric helpers shared by the goose renderer and the two scenes (hero sky, live run).

export const TAU = Math.PI * 2;
/** Heading that points straight down the page (canvas y grows downward). */
export const DOWN = Math.PI / 2;

export type Pt = { x: number; y: number };

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Smoothstep of v between edges a and b. */
export function smooth(a: number, b: number, v: number) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Signed shortest turn from angle a to angle b, in (-PI, PI]. */
export function angDiff(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Point on a cubic Bezier curve. */
export function bez(P: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * P[0].x + 3 * u * u * t * P[1].x + 3 * u * t * t * P[2].x + t * t * t * P[3].x,
    y: u * u * u * P[0].y + 3 * u * u * t * P[1].y + 3 * u * t * t * P[2].y + t * t * t * P[3].y,
  };
}

/** Size a canvas's backing store for the device pixel ratio (capped at 2) and return its CSS size. */
export function fitCanvas(cv: HTMLCanvasElement, w?: number, h?: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (w == null || h == null) {
    const r = cv.getBoundingClientRect();
    w = r.width;
    h = r.height;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}
