// GitHub intake: read a customer's repository with read-only access and turn it into the same .zip the
// pipeline already takes from an upload (the engine unwraps GitHub's single top-level folder).
//
// Private repositories go through a GitHub App that the customer installs on just the repositories they
// choose. The App asks for two read-only permissions (Contents, Metadata), and every token we mint is
// narrowed to read-only again and lives about an hour; tokens are never stored. Public repositories work
// from a plain link, without the App.
//
// Who may read what: GitHub's installation redirect carries an installation id that anyone could edit,
// so we never trust it. The App must have "Request user authorization (OAuth) during installation" on;
// the callback exchanges the one-time code for the customer's own user token, asks GitHub which
// installations of this App that person can access, and keeps only those ids, in a signed cookie.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config";
import {readPublicRefs,resolvePublicRef} from "./publicGitRefs";

const API = "https://api.github.com";
export const SESSION_COOKIE = "goose_gh";
export const STATE_COOKIE = "goose_gh_state";
const SESSION_SECONDS = 8 * 60 * 60;
export const MAX_REPO_ZIP_BYTES = 150 * 1024 * 1024;

export type RepoRef = { owner: string; repo: string };
export type GithubSession = { ids: number[]; login: string; exp: number };
export type RepoSource = {
  provider: "github"; repo: string; url: string; ref: string; commit: string; private: boolean; access: "app" | "public"; fetchedAt: string;
};

export class GithubError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// ------------------------------------------------------------------ configuration

function privateKey(): string {
  const g = config.github;
  if (g.privateKey) return g.privateKey.includes("\\n") ? g.privateKey.replace(/\\n/g, "\n") : g.privateKey;
  if (g.privateKeyPath && fs.existsSync(g.privateKeyPath)) return fs.readFileSync(g.privateKeyPath, "utf8");
  return "";
}

/** True when the GitHub App is set up, so private repositories can be connected. */
export function githubAppConfigured() {
  const g = config.github;
  return Boolean(g.appId && g.slug && g.clientId && g.clientSecret && privateKey());
}

// ------------------------------------------------------------------ parsing and validation

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Accepts https://github.com/owner/repo(.git)(/tree/branch), git@github.com:owner/repo.git, or owner/repo. */
export function parseRepoInput(input: string): (RepoRef & { branch?: string }) | null {
  const s = input.trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^\s#?]+))?\/?(?:[#?].*)?$/i)
    ?? s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
    ?? s.match(/^([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) return null;
  const [, owner, repo, branch] = m;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  if (branch !== undefined && !isValidRef(branch)) return null;
  return branch ? { owner, repo, branch } : { owner, repo };
}

/** A conservative subset of git's branch-name rules (enough for real branches, safe in a URL path). */
export function isValidRef(ref: string) {
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(ref) && !ref.includes("..") && !ref.startsWith("/") && !ref.endsWith("/")
    && !ref.endsWith(".lock") && !ref.includes("//");
}

const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

// ------------------------------------------------------------------ signed session cookie

function sessionKey() {
  return crypto.createHash("sha256").update(`goose-github-session:${config.github.clientSecret}`).digest();
}

export function signSession(s: GithubSession): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  const mac = crypto.createHmac("sha256", sessionKey()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(value: string | undefined | null, now = Date.now()): GithubSession | null {
  if (!value || !config.github.clientSecret) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", sessionKey()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GithubSession;
    if (!Array.isArray(s.ids) || typeof s.exp !== "number" || s.exp * 1000 < now) return null;
    return { ids: s.ids.filter((n) => Number.isInteger(n)), login: String(s.login ?? ""), exp: s.exp };
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionFrom(req: Request) {
  return verifySession(readCookie(req, SESSION_COOKIE));
}

export function cookie(req: Request, name: string, value: string, maxAge: number) {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const secure = https ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function newSessionCookie(req: Request, ids: number[], login: string) {
  return cookie(req, SESSION_COOKIE, signSession({ ids, login, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }), SESSION_SECONDS);
}

// ------------------------------------------------------------------ GitHub API

/** A short-lived JWT that authenticates as the App itself (RS256, valid 9 minutes, issued 1 minute in the past). */
export function appJwt(now = Math.floor(Date.now() / 1000)): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iat: now - 60, exp: now + 540, iss: String(config.github.appId) });
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey()).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function gh<T>(pathname: string, token: string | null, init: RequestInit = {}): Promise<{ status: number; data: T | null; rateLimited: boolean }> {
  const r = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "goose-intake",
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}),
    },
    redirect: "follow",
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data: T | null = null;
  try { data = text ? (JSON.parse(text) as T) : null; } catch { data = null; }
  const rateLimited = r.status === 429 || (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0");
  return { status: r.status, data, rateLimited };
}

const tokenCache = new Map<string, { token: string; until: number }>();

/** An installation token narrowed to read-only Contents and Metadata (optionally to one repository). */
export async function installationToken(installationId: number, repo?: string): Promise<string> {
  const key = `${installationId}:${repo ?? "*"}`;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const body: Record<string, unknown> = { permissions: { contents: "read", metadata: "read" } };
  if (repo) body.repositories = [repo];
  const r = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, appJwt(), {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
  if (r.status !== 201 || !r.data?.token) throw new GithubError("GitHub did not grant read access for this installation.", 502);
  // refresh five minutes before GitHub's expiry
  tokenCache.set(key, { token: r.data.token, until: Date.parse(r.data.expires_at) - 5 * 60_000 });
  return r.data.token;
}

/** The App installation covering this repository, if the App is installed there. */
async function repoInstallation({ owner, repo }: RepoRef): Promise<number | null> {
  if (!githubAppConfigured()) return null;
  const r = await gh<{ id: number }>(`/repos/${owner}/${repo}/installation`, appJwt());
  return r.status === 200 && r.data ? r.data.id : null;
}

/** A read-only token for this repository if the signed-in customer installed the App on it; otherwise null. */
async function tokenFor(ref: RepoRef, session: GithubSession | null): Promise<string | null> {
  if (!session?.ids.length) return null;
  const id = await repoInstallation(ref);
  if (id == null || !session.ids.includes(id)) return null;
  return await installationToken(id, ref.repo);
}

type RepoInfo = { full_name: string; private: boolean; default_branch: string; html_url: string };

async function repoInfo(ref: RepoRef, session: GithubSession | null, publicReader=readPublicRefs) {
  const token = await tokenFor(ref, session);
  const r = await gh<RepoInfo>(`/repos/${ref.owner}/${ref.repo}`, token);
  if (r.status === 200 && r.data) return { info: r.data, token };
  if(r.rateLimited&&!token){
    try{const git=await publicReader(ref);return {info:{full_name:`${ref.owner}/${ref.repo}`,private:false,default_branch:git.defaultBranch,html_url:`https://github.com/${ref.owner}/${ref.repo}`},token:null,git};}catch{/* Preserve an actionable provider error if public Git is unavailable. */}
  }
  if (r.rateLimited) throw new GithubError("GitHub is rate-limiting requests right now. Connect GitHub, or try again in a few minutes.", 429);
  throw new GithubError(
    githubAppConfigured()
      ? `Goose can't see ${ref.owner}/${ref.repo}. If it's private, connect GitHub and give Goose access to it.`
      : `Goose can't see ${ref.owner}/${ref.repo}. Check the link; private repositories need the GitHub App, which isn't set up here.`,
    404);
}

export async function listBranches(ref: RepoRef, session: GithubSession | null, publicReader=readPublicRefs) {
  const { info, token, git } = await repoInfo(ref, session,publicReader);
  if(git)return {repo:info.full_name,private:false,defaultBranch:git.defaultBranch,branches:Object.keys(git.refs).filter(r=>r.startsWith("refs/heads/")).map(r=>r.slice(11))};
  const branches: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const r = await gh<{ name: string }[]>(`/repos/${ref.owner}/${ref.repo}/branches?per_page=100&page=${page}`, token);
    if (r.status !== 200 || !r.data) break;
    branches.push(...r.data.map((b) => b.name));
    if (r.data.length < 100) break;
  }
  if (!branches.includes(info.default_branch)) branches.unshift(info.default_branch);
  return { repo: info.full_name, private: info.private, defaultBranch: info.default_branch, branches };
}

/** Repositories the signed-in customer gave the App access to. */
export async function listConnectedRepos(session: GithubSession) {
  const out: { repo: string; private: boolean; defaultBranch: string }[] = [];
  for (const id of session.ids.slice(0, 10)) {
    const token = await installationToken(id);
    for (let page = 1; page <= 3; page++) {
      const r = await gh<{ repositories: RepoInfo[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
      if (r.status !== 200 || !r.data) break;
      out.push(...r.data.repositories.map((x) => ({ repo: x.full_name, private: x.private, defaultBranch: x.default_branch })));
      if (r.data.repositories.length < 100) break;
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

/** OAuth callback: swap the one-time code for the customer's token, then list the installations they can access. */
export async function installationsForCode(code: string) {
  const g = config.github;
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "goose-intake" },
    body: JSON.stringify({ client_id: g.clientId, client_secret: g.clientSecret, code }),
    signal: AbortSignal.timeout(20_000),
  });
  const tok = (await r.json().catch(() => ({}))) as { access_token?: string };
  if (!tok.access_token) throw new GithubError("GitHub did not confirm the sign-in. Please try connecting again.", 401);
  const user = await gh<{ login: string }>("/user", tok.access_token);
  const inst = await gh<{ installations: { id: number; app_id: number }[] }>("/user/installations?per_page=100", tok.access_token);
  const ids = (inst.data?.installations ?? []).filter((i) => String(i.app_id) === String(g.appId)).map((i) => i.id);
  return { login: user.data?.login ?? "", ids };
}

// ------------------------------------------------------------------ fetching the code

/** Download the branch (default branch if none) at its current commit as a .zip, read-only. */
export async function fetchRepoZip(input: string, branch: string | null, session: GithubSession | null, publicReader=readPublicRefs) {
  const parsed = parseRepoInput(input);
  if (!parsed) throw new GithubError("Paste a GitHub repository address, like https://github.com/your-org/your-app.");
  const ref: RepoRef = { owner: parsed.owner, repo: parsed.repo };
  const wanted = branch || parsed.branch || null;
  if (wanted && !isValidRef(wanted)) throw new GithubError("That branch name doesn't look right.");
  const { info, token, git } = await repoInfo(ref, session,publicReader);
  const name = wanted || info.default_branch;
  let sha=git?resolvePublicRef(git,name):null;
  if(!git){
    const c = await gh<{ sha: string }>(`/repos/${ref.owner}/${ref.repo}/commits/${refPath(name)}`, token);
    if(c.status===200)sha=c.data?.sha??null;
    else if(c.rateLimited&&!token)sha=resolvePublicRef(await publicReader(ref),name);
  }
  if(!sha||!(/^[a-f0-9]{40}$/).test(sha))throw new GithubError(`Couldn't find the branch "${name}" in ${info.full_name}.`,404);

  const archiveUrl=token?`${API}/repos/${ref.owner}/${ref.repo}/zipball/${sha}`:`https://codeload.github.com/${ref.owner}/${ref.repo}/zip/${sha}`;
  const r = await fetch(archiveUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": "goose-intake", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!r.ok || !r.body) throw new GithubError(`GitHub would not send the code for ${info.full_name} (HTTP ${r.status}).`, 502);
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > MAX_REPO_ZIP_BYTES) throw new GithubError("This repository is larger than 150 MB as a .zip.", 413);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-github-"));
  const zipPath = path.join(dir, "upload.bin");
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > MAX_REPO_ZIP_BYTES) done(new GithubError("This repository is larger than 150 MB as a .zip.", 413));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), limit, fs.createWriteStream(zipPath, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const source: RepoSource = {
    provider: "github", repo: info.full_name, url: info.html_url, ref: name, commit: sha, private: info.private,
    access: token ? "app" : "public", fetchedAt: new Date().toISOString(),
  };
  return { zipPath, source, fileName: `${info.full_name.replace("/", "-")}-${sha.slice(0, 7)}.zip` };
}
