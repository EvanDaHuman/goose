// Prospect outreach rules (lib/outreachRules.ts). Pure functions: no database, no AgentMail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftByTemplate } from "../../lib/growthRules";
import {
  autoReplyKind, chooseBusinessEmail, composeOutreach, extractEmails, identityProblems, isOptOut, OPT_OUT_LINE, parseDraft, publicWebsite, usableProfileEmail,
} from "../../lib/outreachRules";

const id = { signer: "Gavin You", websiteUrl: "https://goose.example.org", postalAddress: "548 Market St #12345, San Francisco, CA 94104" };
const prospect = { name: "Acme Co: order service", evidence: [{ text: "requirements.txt pins Flask==1.1.4", url: "https://github.com/acme/orders/blob/main/requirements.txt" }] };
const qual = { fit_score: "High" as const, recipe: "flask-inplace-upgrade", scope_fit: "Flask 1.1 to current Flask.", blockers: [], reasons: [] };

test("the composed email is signed, links to the site, and carries a postal address and opt-out", () => {
  const d = draftByTemplate(prospect, qual, 1500);
  const c = composeOutreach(`Subject: ${d.subject}\n\n${d.body}`, id);
  assert.equal(c.subject, d.subject);
  assert.doesNotMatch(c.body, /\[Founder name\]/);
  assert.match(c.body, /Gavin You, Goose/);
  assert.match(c.body, /https:\/\/goose\.example\.org/);
  assert.ok(c.body.indexOf("goose.example.org") < c.body.indexOf("Gavin You, Goose"), "site link comes before the sign-off");
  assert.match(c.body, /548 Market St/);
  assert.ok(c.body.endsWith(OPT_OUT_LINE));
  assert.match(c.body, /Flask==1\.1\.4/, "says what is outdated");
  assert.match(c.body, /upgraded in place to current Flask/, "says how it would be fixed");
});

test("drafts must parse and real sends need a public site, signer and postal address", () => {
  assert.equal(parseDraft("no subject here"), null);
  assert.deepEqual(parseDraft("Subject: Hi\n\nBody"), { subject: "Hi", body: "Body" });
  assert.equal(publicWebsite("http://localhost:3100"), null);
  assert.equal(publicWebsite("https://localhost:3100"), null);
  assert.equal(publicWebsite("https://goose.example.org/"), "https://goose.example.org");
  assert.deepEqual(identityProblems(id), []);
  assert.equal(identityProblems({ signer: "", websiteUrl: "http://localhost:3100", postalAddress: "" }).length, 3);
});

test("contact choice: own-domain role addresses only, never no-reply/legal, placeholders rejected", () => {
  const html = `<a href="mailto:privacy@acme.io">p</a> write to hello [at] acme.io, jane@acme.io, sales@gmail.com, logo@2x.png, noreply@acme.io`;
  const found = extractEmails(html);
  assert.ok(found.includes("hello@acme.io"));
  assert.ok(!found.some((e) => e.endsWith(".png")));
  assert.equal(chooseBusinessEmail(found, "www.acme.io"), "hello@acme.io");
  assert.equal(chooseBusinessEmail(["jane@acme.io", "info@other.com"], "acme.io"), "jane@acme.io");
  assert.equal(chooseBusinessEmail(["privacy@acme.io", "noreply@acme.io"], "acme.io"), null);
  assert.equal(usableProfileEmail("12345+bob@users.noreply.github.com"), null);
  assert.equal(usableProfileEmail(" Bob@Example.dev "), "bob@example.dev");
  assert.equal(usableProfileEmail(null), null);
  assert.deepEqual(extractEmails('dsn: "https://6f5550e684e4421aacf26ae17045a8d2@sentry.webarchiv.cz/3"'), []);
});

test("opt-outs are read from the reply, not the quoted footer; bounces and auto-replies are recognised", () => {
  assert.equal(isOptOut(`Thanks, tell me more about pricing.\n\nOn Mon, 9 Nov 2026 at 10:00, Goose wrote:\n> ${OPT_OUT_LINE}`), false);
  assert.equal(isOptOut("Please unsubscribe me."), true);
  assert.equal(isOptOut("Not interested, thanks"), true);
  assert.equal(isOptOut("Sounds useful - can we talk Thursday?"), false);
  assert.equal(autoReplyKind("Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)"), "bounce");
  assert.equal(autoReplyKind("Jane <jane@acme.io>", "Automatic reply: Upgrading Acme"), "auto");
  assert.equal(autoReplyKind("Jane <jane@acme.io>", "Re: Upgrading Acme"), null);
});
