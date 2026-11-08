// Pure rules for the growth agents: the guards every agent result must pass before it touches the prospect pipeline, and the
// deterministic versions used in local mode (or when an agent session fails). No database, no network: tested directly in
// tests/integration/growth-rules.test.ts.

/** The recipes Goose can carry out today (engine/goose_engine/plan.py RECIPES), as the qualification agent may name them. */
export const RECIPES: Record<string, string> = {
  "django-lts-upgrade": "Django below 5.2 upgraded in place to Django 5.2 LTS on Python 3.13, behaviour kept",
  "flask-inplace-upgrade": "Flask app upgraded in place to current Flask on Python 3.13, code and SQLite data kept",
  "flask-fastapi-postgres": "Flask + raw sqlite3 JSON API replaced with FastAPI on PostgreSQL, data moved (not Flask-SQLAlchemy, not templates)",
  "suitecrm-sales-workspace": "SuiteCRM 7.11 sales workflow moved to a new sales workspace; support stays in SuiteCRM (needs a database dump)",
  "agent-change": "Targeted code changes made by the implementation agent (bug fixes, APIs with no mechanical rewrite)",
  "agent-replatform": "Python, Node or Rust service migrations with explicit API and database acceptance contracts; existing adapters must support source and target",
  "workspace-change": "General repository engineering such as language migrations, algorithm changes and build modernization, conditional on a reproducible offline build and executable acceptance contract. Python, Node, Rust, Go and C++ are eligible when installed. ROS currently supports only the pinned rrt_exploration fixture. This is an assessment opportunity, not a guarantee of arbitrary project support",
};
export const FIT = ["High", "Medium", "Low"] as const;
export type Fit = (typeof FIT)[number];

export type Evidence = { text: string; url: string };
export type Candidate = { name: string; url: string; category: "a" | "b" | "c"; summary: string; evidence: Evidence[]; contact_channel: string };
export type Qualification = { fit_score: Fit; recipe: string; scope_fit: string; blockers: string[]; reasons: Evidence[] };
export type Draft = { subject: string; body: string };

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// a phone number: a run of digits and separators holding 10 or more digits (an ISO date holds 8, a version number fewer)
const PHONE_RUN = /\+?\(?\d[\d\s().-]{7,}\d/g;
const hasPhone = (s: string) => [...s.matchAll(PHONE_RUN)].some((m) => (m[0].match(/\d/g) ?? []).length >= 10);
const isHttps = (u: unknown) => typeof u === "string" && /^https:\/\/[^\s/]+\.[^\s]+$/i.test(u) && u.length <= 500;
export const normUrl = (u: string) => u.trim().replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
const personal = (s: string) => EMAIL.test(s) || hasPhone(s);

// ------------------------------------------------------------------ research

/** Keep only candidates with public evidence, no personal contact details, and a URL the pipeline does not already have. */
export function guardCandidates(raw: unknown, known: string[], max: number): { kept: Candidate[]; rejected: { name: string; why: string }[] } {
  const seen = new Set(known.map(normUrl));
  const kept: Candidate[] = [];
  const rejected: { name: string; why: string }[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    const why = (() => {
      if (name.length < 2 || name.length > 120) return "no usable name";
      if (!isHttps(c.url)) return "main URL is not an https link";
      if (seen.has(normUrl(c.url))) return "already in the pipeline";
      if (!["a", "b", "c"].includes(c.category)) return "unknown category";
      const ev = Array.isArray(c.evidence) ? c.evidence : [];
      if (!ev.length || ev.length > 5) return "needs 1 to 5 pieces of evidence";
      if (!ev.every((e: any) => isHttps(e?.url) && typeof e?.text === "string" && e.text.length > 0 && e.text.length <= 300)) return "evidence without a public https source";
      const text = [name, c.summary, c.contact_channel, ...ev.map((e: any) => e.text)].join(" ");
      if (personal(text)) return "contains a personal e-mail address or phone number";
      if (typeof c.summary !== "string" || !c.summary.trim() || c.summary.length > 600) return "no usable summary";
      if (typeof c.contact_channel !== "string" || !c.contact_channel.trim()) return "no public contact channel";
      return null;
    })();
    if (why) { rejected.push({ name: name || "(unnamed)", why }); continue; }
    if (kept.length >= max) { rejected.push({ name, why: `over this cycle's limit of ${max}` }); continue; }
    seen.add(normUrl(c.url));
    kept.push({ name, url: c.url.trim(), category: c.category, summary: c.summary.trim(), contact_channel: c.contact_channel.trim(),
      evidence: c.evidence.map((e: any) => ({ text: e.text.trim(), url: e.url.trim() })) });
  }
  return { kept, rejected };
}

// ------------------------------------------------------------------ qualification

export function guardQualification(raw: any, sources: string[]): { ok: true; q: Qualification } | { ok: false; why: string } {
  if (!raw || !FIT.includes(raw.fit_score)) return { ok: false, why: "fit_score must be High, Medium or Low" };
  if (raw.recipe !== "none" && !(raw.recipe in RECIPES)) return { ok: false, why: `unknown recipe ${JSON.stringify(raw.recipe)}` };
  if (raw.recipe === "none" && raw.fit_score !== "Low") return { ok: false, why: "a prospect no recipe applies to cannot be a High or Medium fit" };
  if (typeof raw.scope_fit !== "string" || !raw.scope_fit.trim()) return { ok: false, why: "scope_fit is empty" };
  const reasons = Array.isArray(raw.reasons) ? raw.reasons : [];
  if (!reasons.length || !reasons.every((r: any) => typeof r?.text === "string" && isHttps(r?.url))) return { ok: false, why: "every reason needs a public https source" };
  const allowed = new Set(sources.map(normUrl));
  const hosts = new Set(sources.map((u) => { try { return new URL(u).host; } catch { return ""; } }));
  // a reason may cite the prospect's own pages (same host as its evidence), so a fetched requirements file counts
  if (!reasons.every((r: any) => allowed.has(normUrl(r.url)) || hosts.has(new URL(r.url).host))) return { ok: false, why: "a reason cites a source outside the prospect's public pages" };
  return { ok: true, q: { fit_score: raw.fit_score, recipe: raw.recipe, scope_fit: raw.scope_fit.trim().slice(0, 600),
    blockers: (Array.isArray(raw.blockers) ? raw.blockers : []).map(String).slice(0, 8), reasons: reasons.slice(0, 6) } };
}

/** Local mode: read the stack and versions from the prospect's own evidence text and match them to a recipe. */
export function qualifyByRules(p: { summary?: string | null; evidence?: Evidence[] | null; url: string }): Qualification {
  const ev = p.evidence ?? [];
  const text = [p.summary ?? "", ...ev.map((e) => e.text)].join(" ");
  const cite = (re: RegExp) => ev.filter((e) => re.test(e.text)).slice(0, 3);
  const urgent = /security|vulnerab|CVE|end[- ]of[- ]life|\bEOL\b|unsupported|dependabot/i.test(text);
  const blockers: string[] = [];
  let recipe = "none";
  let scope = "No supported stack was found in the public evidence.";
  let reasons: Evidence[] = [];
  const django = text.match(/Django[=\s]*v?([1-4])\.(\d+)/i);
  const flask = text.match(/Flask[=\s]*v?([12])\.(\d+)/i);
  if (/SuiteCRM\s*7/i.test(text)) {
    recipe = "suitecrm-sales-workspace"; scope = "SuiteCRM 7: the sales workflow can move to a new workspace; needs a database dump.";
    reasons = cite(/SuiteCRM/i);
    if (!/7\.11/.test(text)) blockers.push("only SuiteCRM 7.11.23 is tested");
  } else if (django) {
    recipe = "django-lts-upgrade"; scope = `Django ${django[1]}.${django[2]} can be upgraded in place to Django 5.2 LTS.`;
    reasons = cite(/Django/i);
  } else if (flask) {
    const orm = /SQLAlchemy/i.test(text);
    recipe = "flask-inplace-upgrade";
    scope = `Flask ${flask[1]}.${flask[2]} can be upgraded in place to current Flask.` + (orm ? " Replacing it with FastAPI is not offered (Flask-SQLAlchemy)." : "");
    reasons = cite(/Flask/i);
    if (/Flask-(Classy|Script)/i.test(text)) blockers.push("uses unmaintained Flask extensions (Flask-Classy / Flask-Script) with no mechanical replacement");
  }
  if (!reasons.length) reasons = ev.slice(0, 1).length ? ev.slice(0, 1) : [{ text: "Prospect's main page", url: p.url }];
  const fit: Fit = recipe === "none" ? "Low" : blockers.length ? "Medium" : urgent ? "High" : "Medium";
  return { fit_score: fit, recipe, scope_fit: scope, blockers, reasons };
}

// ------------------------------------------------------------------ outreach

const OVERCLAIM = /guarantee|100\s?%|risk[- ]free|trusted by|our (?:clients|customers) (?:have|include|say)|we(?:'ve| have) (?:helped|worked with|delivered for)|case stud|award|industry[- ]leading|world[- ]class|happy (?:users|customers|clients)|many (?:customers|clients)/i;

export function guardDraft(raw: any, p: { name: string; url: string; evidence?: Evidence[] | null }, priceUsd: number | null):
  { ok: true; d: Draft } | { ok: false; why: string } {
  const subject = typeof raw?.subject === "string" ? raw.subject.trim() : "";
  const body = typeof raw?.body === "string" ? raw.body.trim() : "";
  if (!subject || subject.length > 120) return { ok: false, why: "subject missing or over 120 characters" };
  if (body.length < 200 || body.length > 2500) return { ok: false, why: "body must be 200 to 2,500 characters" };
  if (personal(subject + " " + body)) return { ok: false, why: "contains an e-mail address or phone number" };
  if (OVERCLAIM.test(body) || OVERCLAIM.test(subject)) return { ok: false, why: "claims Goose cannot back up (guarantees, past customers, awards)" };
  if (!/no (?:past |previous |existing )?(?:customers|clients)|(?:our|the) first customers?/i.test(body)) return { ok: false, why: "does not say Goose has no past customers" };
  const amounts = [...body.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  if (amounts.some((a) => priceUsd === null || a !== priceUsd)) return { ok: false, why: priceUsd === null ? "mentions a price, but none was given" : `mentions a price other than $${priceUsd}` };
  const allowed = new Set([p.url, ...(p.evidence ?? []).map((e) => e.url)].map(normUrl));
  const links = [...body.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  if (links.some((l) => !allowed.has(normUrl(l)))) return { ok: false, why: "links to a page that is not part of the prospect's evidence" };
  // the organisation must be recognisable: at least one distinctive word of its name ("Bethel" for "Bethel University: Classifieds")
  const GENERIC = new Set(["university", "college", "labs", "group", "team", "company", "gmbh", "inc", "ltd", "llc", "the", "and", "app", "apps", "service", "services", "book", "exchange"]);
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));
  if (words.length && !words.some((w) => body.toLowerCase().includes(w))) return { ok: false, why: "does not name the organisation" };
  return { ok: true, d: { subject, body } };
}

/** Local mode: the fixed template, filled from the evidence and the qualification. */
export function draftByTemplate(p: { name: string; evidence?: Evidence[] | null; blockers?: string[] | null; found_by?: string | null }, q: Qualification | null, priceUsd: number): Draft {
  const ev = (p.evidence ?? [])[0];
  if(p.found_by === "Naive assessment of host-fetched evidence"){
    return {subject:`Engineering assessment for ${p.name}`.slice(0,120),body:[
      "Hello,", "",
      `I found ${p.name} through public repository research.`+(ev?` One source declares: ${ev.text} (${ev.url}).`:""),
      "The current deployed version is unknown. A dependency declaration alone does not establish the running software or an upgrade requirement.", "",
      `Goose is a new company run mostly by AI agents, with a founder reviewing exceptions. ${q?.scope_fit ?? "We assess engineering changes against a reproducible build and executable checks."}`,
      "We would begin with a written assessment, confirm the runtime and dependencies, agree the scope, and freeze the checks before implementation. Any proposal would depend on that assessment; no purchasing intent or project access is assumed.", "",
      "We have no past customers to point to yet. Would an assessment of the public code be useful?", "", "[Founder name], Goose",
    ].join("\n")};
  }
  // lead with what is outdated: pinned old versions, security fixes, end-of-life or unmaintained dependencies
  const OUTDATED = /security|CVE|vulnerab|dependabot|end[- ]of[- ]life|\bEOL\b|unmaintained|deprecated|unsupported|pins?\b|==\s*\d|\b\d+\.\d+/i;
  const score = (e: Evidence) => (/security|CVE|vulnerab|end[- ]of[- ]life|\bEOL\b/i.test(e.text) ? 2 : 0) + (OUTDATED.test(e.text) ? 1 : 0);
  const outdated = [...(p.evidence ?? [])].map((e, i) => ({ e, i, s: score(e) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 2).map((x) => x.e);
  const lead = outdated.length ? outdated : ev ? [ev] : [];
  const blockers = q?.blockers?.length ? q.blockers : p.blockers ?? [];
  const what = q && q.recipe !== "none" ? RECIPES[q.recipe] : "verified changes to existing software, including runtime upgrades, language migrations and behavior-preserving engineering";
  const body = [
    "Hello,",
    "",
    `I came across ${p.name} while looking for business applications that run on older software versions.` +
      (lead.length ? ` What stood out: ${lead.map((e) => `${e.text.replace(/\.$/, "")} (${e.url})`).join("; ")}.` : ""),
    "",
    `Goose is a new company run mostly by AI agents, with a founder reviewing exceptions. The work that would apply here: ${what}. ` +
      "Before anything changes we record how your current app behaves and freeze the checks the new one must pass; you get the code, " +
      "a full test report and a rollback guide.",
    "",
    blockers.length
      ? `To be upfront: parts of your app are outside what we support today (${blockers.slice(0, 2).join("; ")}). ` +
        "We would start with a free written assessment of your public code and tell you plainly what we can and cannot do."
      : `We would start with a free written assessment of your public code. If it fits, the pilot is a fixed $${priceUsd.toLocaleString("en-US")}, ` +
        "paid only when the agreed checks pass.",
    "",
    "We have no past customers to point to yet. Would a free assessment be useful?",
    "",
    "[Founder name], Goose",
  ].join("\n");
  return { subject: `Upgrading ${p.name.split(":")[0].trim()} to a maintained stack`, body };
}
