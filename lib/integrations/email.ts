import { digest } from "./webhooks";
export type OutboundMessage = { id: number; recipient: string; subject: string; body: string; is_test: boolean; content_sha256: string };
export function emailStatus() {
  const provider = process.env.GOOSE_EMAIL_PROVIDER ?? "disabled";
  const ready = provider === "agentmail" ? !!(process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID)
    : provider === "webhook" ? !!(process.env.GOOSE_EMAIL_WEBHOOK_URL && process.env.GOOSE_EMAIL_WEBHOOK_TOKEN) : false;
  const required = provider === "agentmail" ? ["AGENTMAIL_API_KEY","AGENTMAIL_INBOX_ID"] : provider === "webhook" ? ["GOOSE_EMAIL_WEBHOOK_URL","GOOSE_EMAIL_WEBHOOK_TOKEN"] : ["GOOSE_EMAIL_PROVIDER"];
  const missing = required.filter(name => name === "GOOSE_EMAIL_PROVIDER" || !process.env[name]);
  return { provider, ready, missing, detail: ready ? "Real email requires authorization of the exact stored message."
    : "Configure AgentMail or an authenticated delivery webhook. Test messages use a local receipt and send nothing." };
}
export async function deliverEmail(m: OutboundMessage) {
  if (digest(`${m.recipient}\n${m.subject}\n${m.body}`) !== m.content_sha256) throw new Error("Message content changed; authorization is invalid");
  if (m.is_test) return { provider: "local_test", id: `test-email-${m.id}`, detail: "TEST receipt. No email was sent." };
  const state = emailStatus();
  if (!state.ready) throw new Error(state.detail);
  let url: string, body: unknown, token: string;
  if (state.provider === "agentmail") {
    url = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(process.env.AGENTMAIL_INBOX_ID!)}/messages/send`;
    token = process.env.AGENTMAIL_API_KEY!;
    body = { to: [m.recipient], subject: m.subject, text: m.body };
  } else {
    url = process.env.GOOSE_EMAIL_WEBHOOK_URL!; token = process.env.GOOSE_EMAIL_WEBHOOK_TOKEN!;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Email delivery webhook must use HTTPS");
    body = { idempotency_key: `goose-email-${m.id}`, to: m.recipient, subject: m.subject, text: m.body };
  }
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": `goose-email-${m.id}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
  const result = await response.json() as any;
  const id = result.message_id ?? result.id;
  if (typeof id !== "string" || !id) throw new Error("Email provider did not return a delivery receipt; reconcile before retrying");
  return { provider: state.provider, id, detail: "Provider accepted the message; inbox delivery is not guaranteed." };
}
