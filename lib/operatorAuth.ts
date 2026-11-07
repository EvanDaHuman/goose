import crypto from "node:crypto";

export const OPERATOR_COOKIE = "goose_operator";
const secret = () => process.env.GOOSE_OPERATOR_TOKEN ?? "";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
export function validOperatorToken(value: string) {
  return secret().length >= 24 && crypto.timingSafeEqual(digest(value), digest(secret()));
}
export function operatorSession(now = Date.now()) {
  if (secret().length < 24) throw new Error("Configure GOOSE_OPERATOR_TOKEN with at least 24 characters");
  const expiry = String(Math.floor(now / 1000) + 12 * 60 * 60);
  return `${expiry}.${crypto.createHmac("sha256", secret()).update(`operator:${expiry}`).digest("hex")}`;
}
export function validOperatorSession(value: string, now = Date.now()) {
  if (secret().length < 24) return false;
  const [expiry, signature, extra] = value.split(".");
  if (extra || !/^\d+$/.test(expiry ?? "") || !/^[a-f0-9]{64}$/.test(signature ?? "")) return false;
  const remaining = Number(expiry) - Math.floor(now / 1000);
  if (remaining <= 0 || remaining > 12 * 60 * 60) return false;
  const expected = crypto.createHmac("sha256", secret()).update(`operator:${expiry}`).digest("hex");
  return crypto.timingSafeEqual(digest(signature), digest(expected));
}
export function isOperatorRequest(request: Request) {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (bearer && validOperatorToken(bearer)) return true;
  const cookie = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(`${OPERATOR_COOKIE}=`));
  return !!cookie && validOperatorSession(cookie.slice(OPERATOR_COOKIE.length + 1));
}
export function assertSameOrigin(request: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const origin = request.headers.get("origin");
  const allowed = new Set([new URL(request.url).origin]);
  if (process.env.APP_BASE_URL) allowed.add(new URL(process.env.APP_BASE_URL).origin);
  if (!origin || !allowed.has(origin)) return Response.json({ error: "A same-origin request is required" }, { status: 403 });
  return null;
}
export async function requireOperator(request: Request): Promise<Response | null> {
  if (!isOperatorRequest(request)) return Response.json({ error: "Operator authentication required" }, { status: 401 });
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  return bearer && validOperatorToken(bearer) ? null : assertSameOrigin(request);
}
