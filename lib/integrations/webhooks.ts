import crypto from "node:crypto";

export const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
/** Stripe-style t=...,v1=... signatures. Authenticate raw bytes, reject stale and future replay. */
export function verifySignature(raw: string, signature: string | null, secret: string, now = Date.now()) {
  if (!secret) throw new Error("Webhook signing secret is not configured");
  if (!signature) throw new Error("Missing webhook signature");
  const parts = signature.split(",").map(p => p.trim().split("="));
  const times = parts.filter(([k]) => k === "t");
  if (times.length !== 1 || !/^\d+$/.test(times[0][1] ?? "")) throw new Error("Invalid webhook timestamp");
  const stamp = Number(times[0][1]);
  if (!Number.isSafeInteger(stamp) || Math.abs(now / 1000 - stamp) > 300) throw new Error("Expired webhook signature");
  const want = crypto.createHmac("sha256", secret).update(`${stamp}.${raw}`).digest("hex");
  if (!parts.some(([k, v]) => k === "v1" && /^[a-f0-9]{64}$/.test(v ?? "") && sameSecret(v, want)))
    throw new Error("Invalid webhook signature");
}
