// Pure rules for prospect outreach: composing the final email from a stored draft, choosing a published contact address,
// and reading replies for opt-outs. No database, no network: tested in tests/integration/outreach-rules.test.ts.

export type OutreachIdentity = { signer: string; websiteUrl: string; postalAddress: string };
export type ComposedOutreach = { subject: string; body: string };

/** Stored drafts are "Subject: ...\n\n<body>". */
export function parseDraft(draft: string | null | undefined): { subject: string; body: string } | null {
  const m = String(draft ?? "").match(/^Subject:[ \t]*(.+?)\r?\n\r?\n([\s\S]+)$/);
  if (!m) return null;
  const subject = m[1].trim(), body = m[2].trim();
  return subject && body ? { subject, body } : null;
}

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
/** The public site a prospect can visit. Real sends need a reachable https site, not a local development URL. */
export function publicWebsite(raw: string | null | undefined): string | null {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "https:" || LOCAL_HOST.test(u.hostname) || !u.hostname.includes(".")) return null;
    return u.toString().replace(/\/$/, "");
  } catch { return null; }
}

/** Problems that block a real (non-test) send. Test sends to the founder's own address only need a draft. */
export function identityProblems(id: Partial<OutreachIdentity>): string[] {
  const out: string[] = [];
  if (!id.signer?.trim() || /\[founder name\]/i.test(id.signer)) out.push("OUTREACH_SIGNER (the name that signs each email)");
  if (!publicWebsite(id.websiteUrl)) out.push("GOOSE_PUBLIC_URL must be the public https website, not localhost");
  if (!id.postalAddress?.trim() || id.postalAddress.trim().length < 10) out.push("OUTREACH_POSTAL_ADDRESS (a valid postal address is required in commercial email)");
  return out;
}

export const OPT_OUT_LINE = "If you would rather not hear from us, reply \"unsubscribe\" and we will not email you again.";

/**
 * The exact email sent to a prospect: the agent's or template's draft, signed by a real person, with a link to the site,
 * and a footer with the sender's postal address and a working opt-out.
 */
export function composeOutreach(draft: string, id: OutreachIdentity): ComposedOutreach {
  const d = parseDraft(draft);
  if (!d) throw new Error("The stored draft has no subject and body");
  const site = publicWebsite(id.websiteUrl) ?? id.websiteUrl;
  const signer = id.signer.trim() || "The Goose team";
  let body = d.body.replace(/\[Founder name\]/gi, signer);
  // the link to the site goes just before the closing question/sign-off block
  const visit = `You can see how Goose works, and request the free assessment, at ${site}`;
  if (!body.includes(site)) {
    const lines = body.split("\n");
    const signIdx = lines.findLastIndex((l) => l.includes(signer));
    if (signIdx > 0) lines.splice(signIdx, 0, visit, "");
    else lines.push("", visit);
    body = lines.join("\n");
  }
  const footer = ["--", `Goose · ${id.postalAddress.trim()}`, OPT_OUT_LINE].join("\n");
  return { subject: d.subject.replace(/[\r\n]+/g, " ").slice(0, 200), body: `${body.trim()}\n\n${footer}` };
}

// ------------------------------------------------------------------ contact addresses

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const ROLE = /^(hello|hi|info|contact|contactus|sales|team|business|enquiries|inquiries|office|partners|partnerships|bd|founders?|ceo|cto|engineering|dev|developers|it|its|webteam|web|support|help|helpdesk|admin)$/i;
const NEVER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|abuse|privacy|security|legal|gdpr|dpo|unsubscribe|bounce|careers|jobs|hr|press|media)$/i;
const JUNK_DOMAIN = /(example\.(com|org|net)|sentry\.io|wixpress\.com|users\.noreply\.github\.com|noreply\.github\.com|domain\.com|email\.com|yourdomain|sentry-next)/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

export function validEmail(s: string) {
  return s.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[A-Za-z]{2,}$/.test(s) && !ASSET.test(s);
}

/** Addresses published on a page: mailto links first, then plain text (with simple [at]/[dot] obfuscation undone). */
export function extractEmails(html: string): string[] {
  const text = html.replace(/&#64;|&commat;/gi, "@").replace(/&#46;/g, ".")
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  const mailto = [...text.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]));
  const plain = [...text.matchAll(EMAIL_RE)].map((m) => m[0]);
  return [...new Set([...mailto, ...plain].map((e) => e.trim().toLowerCase().replace(/[.,;:]+$/, "")))].filter(validEmail);
}

const baseDomain = (host: string) => host.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");

/**
 * Pick the address to write to from those published on an organisation's own site: it must be on the site's own domain,
 * never a no-reply, legal or security address. A role address (hello@, info@, sales@) is preferred to a person's address.
 */
export function chooseBusinessEmail(found: string[], siteHost: string): string | null {
  const site = baseDomain(siteHost);
  const ok = found.filter((e) => {
    const [local, domain] = e.split("@");
    return !NEVER.test(local) && !JUNK_DOMAIN.test(domain) && baseDomain(domain) === site;
  });
  const rank = (e: string) => {
    const local = e.split("@")[0];
    if (/^(hello|info|contact|contactus|sales|team|business|enquiries|inquiries|founders?)$/i.test(local)) return 0;
    if (ROLE.test(local)) return 1;
    return 2;
  };
  return ok.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** A GitHub profile's published email, if it is a deliverable non-placeholder address. */
export function usableProfileEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (!validEmail(e)) return null;
  const [local, domain] = e.split("@");
  return NEVER.test(local) || JUNK_DOMAIN.test(domain) ? null : e;
}

// ------------------------------------------------------------------ replies

/** The reply text above the quoted original, so a quoted footer ("reply unsubscribe") never reads as an opt-out. */
export function replyText(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^On .{4,200}wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

const OPT_OUT = /\b(unsubscribe|opt[- ]?out|remove me|take me off|stop (?:emailing|contacting|sending)|do not (?:email|contact)|don'?t (?:email|contact)|not interested|no thanks|no thank you)\b/i;
export function isOptOut(raw: string) {
  const t = replyText(raw).slice(0, 1000);
  return OPT_OUT.test(t);
}

/** Automated bounces and out-of-office notices: not a human reply, and a bounce suppresses the address. */
export function autoReplyKind(from: string, subject: string): "bounce" | "auto" | null {
  if (/mailer-daemon|postmaster/i.test(from) || /undeliverable|delivery status notification|delivery has failed|returned mail|failure notice/i.test(subject)) return "bounce";
  if (/out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on vacation/i.test(subject)) return "auto";
  return null;
}
