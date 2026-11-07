// The guards and local rules of the growth agents (lib/growthRules.ts). Pure functions: no database, no Naive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftByTemplate, guardCandidates, guardDraft, guardQualification, qualifyByRules } from "../../lib/growthRules";

const ev = (text: string, url = "https://github.com/acme-co/orders/blob/main/requirements.txt") => ({ text, url });
const good = {
  name: "Acme Co: order service", url: "https://github.com/acme-co/orders", category: "c",
  summary: "Internal order service run by Acme's IT team.", contact_channel: "GitHub issues on the repository",
  evidence: [ev("requirements.txt pins Flask==1.1.4 and Werkzeug==1.0.1."), ev("Dependabot security PR to bump Flask, open since October.", "https://github.com/acme-co/orders/pull/12")],
};

test("research guard keeps evidenced candidates and rejects duplicates, personal details and unsourced claims", () => {
  const raw = [
    good,
    { ...good, name: "Duplicate", url: "https://github.com/acme-co/orders/" },
    { ...good, name: "Has an e-mail", url: "https://github.com/b/b", contact_channel: "write to jane.doe@gmail.com" },
    { ...good, name: "Has a phone", url: "https://github.com/c/c", summary: "Call +1 (612) 555-0199 for details." },
    { ...good, name: "No source", url: "https://github.com/d/d", evidence: [{ text: "pins Flask 1.x", url: "not a link" }] },
    { ...good, name: "Plain http", url: "http://example.org/app" },
    { ...good, name: "Known already", url: "https://github.com/known/app" },
  ];
  const { kept, rejected } = guardCandidates(raw, ["https://github.com/known/app"], 5);
  assert.deepEqual(kept.map((c) => c.name), ["Acme Co: order service"]);
  const why = Object.fromEntries(rejected.map((r) => [r.name, r.why]));
  assert.match(why["Duplicate"], /already/);
  assert.match(why["Has an e-mail"], /personal/);
  assert.match(why["Has a phone"], /personal/);
  assert.match(why["No source"], /https source/);
  assert.match(why["Plain http"], /https/);
  assert.match(why["Known already"], /already/);
});

test("research guard enforces the cycle's limit", () => {
  const many = [1, 2, 3].map((i) => ({ ...good, name: `Org ${i}`, url: `https://github.com/org${i}/app` }));
  const { kept, rejected } = guardCandidates(many, [], 2);
  assert.equal(kept.length, 2);
  assert.match(rejected[0].why, /limit/);
});

test("qualification guard: known recipe, consistent score, reasons sourced on the prospect's own pages", () => {
  const sources = [good.url, ...good.evidence.map((e) => e.url)];
  const base = { fit_score: "High", recipe: "flask-inplace-upgrade", scope_fit: "Flask 1.1 in place.", blockers: [],
    reasons: [{ text: "pins Flask 1.1.4", url: "https://github.com/acme-co/orders/blob/main/setup.cfg" }] };
  assert.equal(guardQualification(base, sources).ok, true);   // same host as the evidence: a fetched file counts
  assert.equal(guardQualification({ ...base, recipe: "rails-upgrade" }, sources).ok, false);
  assert.equal(guardQualification({ ...base, recipe: "none" }, sources).ok, false);   // no recipe cannot be High
  assert.equal(guardQualification({ ...base, fit_score: "Great" }, sources).ok, false);
  assert.equal(guardQualification({ ...base, reasons: [{ text: "a blog said so", url: "https://someblog.example/post" }] }, sources).ok, false);
});

test("local qualification reads the stack from the evidence", () => {
  const flask = qualifyByRules(good);
  assert.equal(flask.recipe, "flask-inplace-upgrade");
  assert.equal(flask.fit_score, "High");   // a security PR is open
  const django = qualifyByRules({ url: "https://x.org", summary: "Booking site", evidence: [ev("settings show Django 3.2")] });
  assert.equal(django.recipe, "django-lts-upgrade");
  const classy = qualifyByRules({ url: "https://x.org", evidence: [ev("pins Flask==1.1.4 and Flask-Classy")] });
  assert.equal(classy.fit_score, "Medium");
  assert.ok(classy.blockers.length);
  const rails = qualifyByRules({ url: "https://x.org", evidence: [ev("A Rails 4 app")] });
  assert.deepEqual([rails.recipe, rails.fit_score], ["none", "Low"]);
});

test("outreach guard rejects invented prices, past-customer claims, outside links and missing honesty", () => {
  const p = { name: good.name, url: good.url, evidence: good.evidence };
  const body = `Hello, I noticed ${good.name} pins Flask 1.1.4 (${good.evidence[0].url}). Goose upgrades Flask apps in place and checks the ` +
    "new app against the old one before you pay. We are a new company with no past customers, so we would start with a free written " +
    "assessment of your public code. If it fits, the pilot is a fixed $1,500. [Founder name], Goose";
  assert.equal(guardDraft({ subject: "Upgrading Acme's order service", body }, p, 1500).ok, true);
  const no = (b: string, price: number | null = 1500) => guardDraft({ subject: "Hi", body: b }, p, price);
  assert.match((no(body.replace("$1,500", "$900")) as any).why, /price other than/);
  assert.match((no(body, null) as any).why, /none was given/);
  assert.match((no(body.replace("a new company with no past customers", "a small team")) as any).why, /no past customers/);
  assert.match((no(body.replace("no past customers", "many happy users")) as any).why, /claims/);
  assert.match((no(body + " We have helped dozens of firms like yours.") as any).why, /claims/);
  assert.match((no(body + " See https://goose.example/cases") as any).why, /not part of the prospect's evidence/);
  assert.match((no(body + " Reply to founder@goose.example") as any).why, /e-mail/);
  // the organisation's distinctive name is enough ("Acme"), but a message to nobody in particular is not
  assert.equal(no(body.replace(`${good.name} pins`, "Acme's order service pins")).ok, true);
  assert.match((no(body.replace(`${good.name} pins`, "your app pins").replace(` (${good.evidence[0].url})`, "")) as any).why, /name the organisation/);
});

test("the template draft always passes the outreach guard", () => {
  const q = qualifyByRules(good);
  const d = draftByTemplate(good, q, 1500);
  assert.equal(guardDraft(d, good, 1500).ok, true);
  const blocked = qualifyByRules({ ...good, evidence: [ev("pins Flask==1.1.4 and Flask-Script")] });
  const d2 = draftByTemplate({ ...good, evidence: [ev("pins Flask==1.1.4 and Flask-Script")] }, blocked, 1500);
  assert.equal(guardDraft(d2, { ...good, evidence: [ev("pins Flask==1.1.4 and Flask-Script")] }, null).ok, true);   // upfront about blockers, no price
});
