// GitHub intake without a live GitHub: lib/github.ts talks to a fake fetch that answers in the REST API's shapes.
// Covers link parsing, the signed session cookie, the App's JWT, who may read a private repository, read-only token
// scoping, and downloading a branch as a .zip with the size cap. It does NOT prove the live service behaves the same.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { beforeEach, test } from "node:test";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  GITHUB_APP_ID: "4242", GITHUB_APP_SLUG: "goose-test", GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_CLIENT_SECRET: "s3cret",
  // stored on one line with \n escapes, the way .env holds it
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n"),
});
const gh = await import("../../lib/github");

type Call = { method: string; url: string; auth: string | null; body: any };
let calls: Call[] = [];
let routes: [RegExp, (c: Call) => Response][] = [];
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const h = new Headers(init?.headers);
  const call: Call = { method: init?.method ?? "GET", url, auth: h.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null };
  calls.push(call);
  const hit = routes.find(([re]) => re.test(`${call.method} ${url}`));
  return hit ? hit[1](call) : json({ message: "Not Found" }, 404);
}) as typeof fetch;

beforeEach(() => { calls = []; routes = []; });

test("repository links: the forms people paste are accepted; anything else is refused", () => {
  assert.deepEqual(gh.parseRepoInput("https://github.com/acme/order-service"), { owner: "acme", repo: "order-service" });
  assert.deepEqual(gh.parseRepoInput("github.com/acme/order-service.git"), { owner: "acme", repo: "order-service" });
  assert.deepEqual(gh.parseRepoInput("https://github.com/acme/order-service/tree/release/2026-11"), { owner: "acme", repo: "order-service", branch: "release/2026-11" });
  assert.deepEqual(gh.parseRepoInput("git@github.com:acme/order-service.git"), { owner: "acme", repo: "order-service" });
  assert.deepEqual(gh.parseRepoInput("  acme/order.service  "), { owner: "acme", repo: "order.service" });
  for (const bad of ["https://gitlab.com/acme/app", "acme", "acme/..", "-acme/app", "acme/app with space", "https://github.com/acme/app/tree/a..b",
    "https://evil.example/github.com/acme/app", "file:///etc/passwd"]) {
    assert.equal(gh.parseRepoInput(bad), null, bad);
  }
  assert.ok(gh.isValidRef("main") && gh.isValidRef("release/2026-11") && gh.isValidRef("feat_x.1"));
  for (const bad of ["a..b", "/main", "main/", "x.lock", "a//b", "has space", "semi;colon"]) assert.equal(gh.isValidRef(bad), false, bad);
});

test("the session cookie is signed: a valid one round-trips; tampered or expired ones are rejected", () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const v = gh.signSession({ ids: [7, 9], login: "marcus", exp });
  assert.deepEqual(gh.verifySession(v), { ids: [7, 9], login: "marcus", exp });
  const [body, mac] = v.split(".");
  const forged = Buffer.from(JSON.stringify({ ids: [7, 9, 1234], login: "marcus", exp })).toString("base64url");
  assert.equal(gh.verifySession(`${forged}.${mac}`), null);
  assert.equal(gh.verifySession(`${body}.${mac.slice(0, -2)}xx`), null);
  assert.equal(gh.verifySession(gh.signSession({ ids: [7], login: "m", exp: Math.floor(Date.now() / 1000) - 1 })), null);
  assert.equal(gh.verifySession("garbage"), null);
});

test("the App's JWT is RS256, issued by the App, short-lived, and verifies with its public key", () => {
  const now = 1_800_000_000;
  const [h, b, s] = gh.appJwt(now).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url").toString()), { iat: now - 60, exp: now + 540, iss: "4242" });
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")));
});

function privateRepo(installationId: number) {
  routes.push(
    [/^GET https:\/\/api\.github\.com\/repos\/acme\/vault\/installation$/, (c) => (c.auth?.startsWith("Bearer ey") ? json({ id: installationId }) : json({}, 401))],
    [/^POST https:\/\/api\.github\.com\/app\/installations\/\d+\/access_tokens$/, () => json({ token: "ghs_readonly", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201)],
    [/^GET https:\/\/api\.github\.com\/repos\/acme\/vault$/, (c) => (c.auth === "Bearer ghs_readonly"
      ? json({ full_name: "acme/vault", private: true, default_branch: "main", html_url: "https://github.com/acme/vault" })
      : json({ message: "Not Found" }, 404))],
    [/^GET https:\/\/api\.github\.com\/repos\/acme\/vault\/branches/, () => json([{ name: "main" }, { name: "release/2026-11" }])],
  );
}

test("a private repository is read only through an installation the signed-in customer can access, with a read-only token", async () => {
  privateRepo(7);
  const mine = { ids: [7], login: "marcus", exp: Math.floor(Date.now() / 1000) + 60 };
  const r = await gh.listBranches({ owner: "acme", repo: "vault" }, mine);
  assert.deepEqual(r, { repo: "acme/vault", private: true, defaultBranch: "main", branches: ["main", "release/2026-11"] });
  const mint = calls.find((c) => c.method === "POST");
  assert.deepEqual(mint?.body, { permissions: { contents: "read", metadata: "read" }, repositories: ["vault"] });

  // someone else's installation id in the cookie (or none) gets no token, so the private repository stays invisible
  for (const session of [{ ids: [8], login: "eve", exp: mine.exp }, null]) {
    calls = [];
    await assert.rejects(gh.listBranches({ owner: "acme", repo: "vault" }, session), /can't see acme\/vault/);
    assert.equal(calls.some((c) => c.method === "POST"), false);
  }
});

test("a branch downloads as a .zip at its current commit; the job records where it came from", async () => {
  const zip = Buffer.from("PK\u0003\u0004 pretend zip bytes");
  routes.push(
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/shop$/, () => json({ full_name: "octo/shop", private: false, default_branch: "main", html_url: "https://github.com/octo/shop" })],
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/shop\/commits\/release\/2026-11$/, () => json({ sha: "0123456789abcdef0123456789abcdef01234567" })],
    [/^GET https:\/\/codeload\.github\.com\/octo\/shop\/zip\/0123456789abcdef/, () => new Response(zip, { status: 200, headers: { "content-length": String(zip.length) } })],
  );
  const r = await gh.fetchRepoZip("https://github.com/octo/shop/tree/release/2026-11", null, null);
  assert.deepEqual(fs.readFileSync(r.zipPath), zip);
  assert.equal(r.fileName, "octo-shop-0123456.zip");
  assert.deepEqual({ ...r.source, fetchedAt: "x" }, { provider: "github", repo: "octo/shop", url: "https://github.com/octo/shop", ref: "release/2026-11",
    commit: "0123456789abcdef0123456789abcdef01234567", private: false, access: "public", fetchedAt: "x" });
  assert.ok(calls.every((c) => c.auth === null), "a public repository is read without credentials");
  fs.rmSync(r.zipPath, { force: true });
});

test("downloads stop at 150 MB, and a missing branch or rate limit gives a plain answer", async () => {
  routes.push(
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/huge$/, () => json({ full_name: "octo/huge", private: false, default_branch: "main", html_url: "https://github.com/octo/huge" })],
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/huge\/commits\/main$/, () => json({ sha: "f".repeat(40) })],
    [/^GET https:\/\/codeload\.github\.com\/octo\/huge\/zip\//, () => new Response("x", { status: 200, headers: { "content-length": String(gh.MAX_REPO_ZIP_BYTES + 1) } })],
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/huge\/commits\/nope$/, () => json({ message: "No commit found" }, 422)],
    [/^GET https:\/\/api\.github\.com\/repos\/octo\/busy$/, () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })],
  );
  await assert.rejects(gh.fetchRepoZip("octo/huge", null, null), (e: any) => e.status === 413);
  await assert.rejects(gh.fetchRepoZip("octo/huge", "nope", null), /Couldn't find the branch "nope"/);
  await assert.rejects(gh.fetchRepoZip("octo/huge", "bad..ref", null), /branch name/);
  await assert.rejects(gh.fetchRepoZip("octo/busy", null, null,async()=>{throw new Error("Unavailable public Git");}), (e: any) => e.status === 429);
});

test("public GitHub intake works without credentials when REST is rate limited",async()=>{
 const sha="a".repeat(40),zip=Buffer.from("PK\u0003\u0004 public bytes");
 routes.push([/^GET https:\/\/api\.github\.com\/repos\/octo\/public$/,()=>json({},403,{"x-ratelimit-remaining":"0"})],[/^GET https:\/\/codeload\.github\.com\/octo\/public\/zip\//,()=>new Response(zip)]);
 const reader=async()=>({defaultBranch:"main",refs:{HEAD:sha,"refs/heads/main":sha,"refs/tags/v1^{}":sha}});
 const branches=await gh.listBranches({owner:"octo",repo:"public"},null,reader);assert.deepEqual(branches.branches,["main"]);
 const result=await gh.fetchRepoZip("octo/public","v1",null,reader);assert.equal(result.source.commit,sha);assert.equal(result.source.access,"public");assert.deepEqual(fs.readFileSync(result.zipPath),zip);assert.ok(calls.every(c=>c.auth===null));fs.rmSync(result.zipPath,{force:true});
});
