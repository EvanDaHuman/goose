"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandIcon } from "./BrandIcon";
import { GOALS } from "./samples";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin",
  "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney", "UTC"];
const CONSTRAINTS: [string, string][] = [["keep_framework", "Keep the current web framework"], ["keep_database", "Keep the current database"],
  ["keep_api", "Pages and API responses must not change"], ["keep_connections", "Existing connections (clients, scripts) must keep working"],
  ["no_data", "Our data cannot be shared"]];
const FROM_IDEAS = ["C++", "Flask", "Flask + SQLite", "ROS", "Django 3.2", "Java 8", "MySQL"];
const TO_IDEAS = ["Rust", "React", "FastAPI + PostgreSQL", "ROS 2", "Django 5.2", "Java 21", "PostgreSQL"];
const DRAFT_KEY = "goose:start-draft";
const OTHER = "__other__";
// mirrors lib/github.ts parseRepoInput closely enough to decide when to ask the server for branches
const REPO_RE = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?(?:\.git)?(?:\/tree\/[^\s#?]+)?\/?$/i;

const NOTICES: Record<string, [string, "good" | "bad"]> = {
  connected: ["GitHub is connected. Pick the repository below.", "good"],
  denied: ["GitHub didn't finish connecting. Try again, or paste the link of a public repository.", "bad"],
  expired: ["That GitHub sign-in expired. Please connect again.", "bad"],
  noaccess: ["Your GitHub account hasn't given Goose access to any repository yet. Install the Goose app on the repositories you want migrated, then come back.", "bad"],
  error: ["GitHub didn't answer. Please try connecting again in a moment.", "bad"],
  unavailable: ["Connecting private repositories isn't set up on this server yet. Paste a public repository link, or upload a .zip.", "bad"],
};

type Repo = { repo: string; private: boolean; defaultBranch: string };
type GhState = { loaded: boolean; configured: boolean; connected: boolean; login?: string; repos: Repo[]; error?: string };
type Branches = { state: "idle" | "loading" | "ok" | "error"; list: string[]; defaultBranch?: string; isPrivate?: boolean; message?: string };

export function BeginForm({ prefill, githubStatus, inquiryId, repositoryOnly }: { prefill?: { from: string; to: string; goal: string }; githubStatus?: string; inquiryId?: string; repositoryOnly?: boolean }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [from, setFrom] = useState(prefill?.from ?? "");
  const [to, setTo] = useState(prefill?.to ?? "");
  const [goal, setGoal] = useState(prefill?.goal ?? "");
  const [mode, setMode] = useState<"github" | "zip">("github");
  const [jobType, setJobType] = useState("workspace");
  const [gh, setGh] = useState<GhState>({ loaded: false, configured: false, connected: false, repos: [] });
  const [choice, setChoice] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branches, setBranches] = useState<Branches>({ state: "idle", list: [] });
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<{ zip?: string; db?: string; docs?: string }>({});
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const repo = gh.connected && gh.repos.length && choice !== OTHER ? choice : repoUrl.trim();

  // what GitHub access this browser has: whether the App is set up here, and the repositories it may read
  const loadGithub = useCallback(async () => {
    const r = await fetch("/api/github/repos", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    const s: GhState = { loaded: true, configured: !!r?.configured, connected: !!r?.connected, login: r?.login, repos: r?.repos ?? [], error: r?.error };
    setGh(s);
    if (s.connected && s.repos.length) setChoice((c) => c || s.repos[0].repo);
  }, []);
  useEffect(() => { void loadGithub(); }, [loadGithub]);

  // coming back from GitHub: restore what the customer had typed before leaving
  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(DRAFT_KEY); sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    if (!raw || !form.current) return;
    try {
      const d = JSON.parse(raw) as Record<string, string | string[]>;
      const one = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
      setFrom(one("move_from")); setTo(one("move_to")); setGoal(one("goal")); setRepoUrl(one("repo_url"));
      for (const k of ["business", "title", "contact", "email", "timezone", "notes"]) {
        const el = form.current.elements.namedItem(k) as HTMLInputElement | null;
        if (el && one(k)) el.value = one(k);
      }
      const picked = new Set(Array.isArray(d.constraints) ? d.constraints : d.constraints ? [d.constraints as string] : []);
      form.current.querySelectorAll<HTMLInputElement>("input[name=constraints]").forEach((c) => { c.checked = picked.has(c.value); });
      const demo = form.current.elements.namedItem("demo") as HTMLInputElement | null;
      if (demo) demo.checked = d.demo === "on";
    } catch { /* ignore a malformed draft */ }
  }, []);

  // branches of the chosen repository (through the App when connected, otherwise as a public repository)
  useEffect(() => {
    if (mode !== "github" || !REPO_RE.test(repo)) { setBranches({ state: "idle", list: [] }); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBranches({ state: "loading", list: [] });
      try {
        const r = await fetch(`/api/github/branches?repo=${encodeURIComponent(repo)}`, { signal: ctl.signal, cache: "no-store" });
        const j = await r.json();
        if (!r.ok) { setBranches({ state: "error", list: [], message: j.error ?? "Couldn't read that repository." }); return; }
        const fromLink = repo.match(/\/tree\/([^\s#?]+)/)?.[1];
        setBranches({ state: "ok", list: j.branches, defaultBranch: j.defaultBranch, isPrivate: j.private });
        setBranch(fromLink && j.branches.includes(fromLink) ? fromLink : j.defaultBranch);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setBranches({ state: "error", list: [], message: "GitHub didn't answer. Try again in a moment." });
      }
    }, 450);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [repo, mode]);

  function saveDraft() {
    if (!form.current) return;
    const fd = new FormData(form.current);
    const d: Record<string, string | string[]> = { repo_url: repoUrl };
    for (const [k, v] of fd.entries()) {
      if (typeof v !== "string") continue;
      if (k === "constraints") d[k] = [...((d[k] as string[]) ?? []), v];
      else d[k] = v;
    }
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
  }

  async function disconnect() {
    await fetch("/api/github/disconnect", { method: "POST" }).catch(() => null);
    setChoice("");
    await loadGithub();
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const f = e.currentTarget;
    if (!f.checkValidity()) { f.reportValidity(); return; }
    if (mode === "github" && !REPO_RE.test(repo)) { setErr("Give us the GitHub repository to work on, or upload a .zip instead."); return; }
    if (mode === "github" && branches.state === "error") { setErr(branches.message ?? "Goose can't read that repository yet."); return; }
    if (mode === "zip" && !files.zip) { setErr("Attach the source code as a .zip file."); return; }
    setBusy(true);
    const r = await fetch("/api/jobs", { method: "POST", body: new FormData(f) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r || !r.ok) { setErr(j.error ?? "Could not create the job. Please try again."); return; }
    router.push(`/jobs/${j.id}?t=${j.t}`);
  }

  const notice = githubStatus ? NOTICES[githubStatus] : undefined;
  const fileName = (list: FileList | null) => Array.from(list ?? []).map((x) => x.name).join(", ");

  return (
    <form className="begin" ref={form} onSubmit={submit} noValidate>
      {notice && <p className={`notice ${notice[1]}`} role="status">{notice[0]}</p>}
      {inquiryId && <input type="hidden" name="inquiry_id" value={inquiryId} />}

      <fieldset>
        <legend><span>1</span>The objective</legend>
        <div className="move">
          <div className="s-field"><label htmlFor="f-from">Migrating from</label>
            <input type="text" id="f-from" name="move_from" list="l-from" placeholder="e.g. C++" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="move-arrow" aria-hidden="true">→</div>
          <div className="s-field"><label htmlFor="f-to">Migrating to</label>
            <input type="text" id="f-to" name="move_to" list="l-to" placeholder="e.g. Rust" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <datalist id="l-from">{FROM_IDEAS.map((x) => <option key={x} value={x} />)}</datalist>
        <datalist id="l-to">{TO_IDEAS.map((x) => <option key={x} value={x} />)}</datalist>
        <div className="s-field"><label htmlFor="f-goal">Your goal, in your own words</label>
          <textarea id="f-goal" name="goal" rows={3} required value={goal} onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Update this application while keeping its current behaviour." /></div>
        <div className="goals" aria-label="Example goals">
          {GOALS.map((x) => <button key={x} type="button" onClick={() => setGoal(x)}>{x}</button>)}
        </div>
        <div className="s-field"><label htmlFor="f-job-type">Type of engineering work</label>
          <select id="f-job-type" name="job_type" value={jobType} onChange={(e) => setJobType(e.target.value)}>
            {!repositoryOnly && <option value="service">Service, framework, or data migration</option>}
            <option value="workspace">Autonomous repository engineering</option>
          </select>
          <span className="hint">{jobType === "workspace"
            ? "Share a repository and an objective. Naïve discovers dependencies and tests, reproduces an isolated environment, and proposes verified acceptance checks. No Goose-specific configuration is required."
            : "Upgrade a supported application or choose a new runtime with a reviewed data contract."}</span></div>
        {jobType === "service" && <div className="row2">
            <div className="s-field"><label htmlFor="f-target">Target runtime (optional)</label>
              <select id="f-target" name="target_runtime" defaultValue="">
                <option value="">Let the goal and inspection guide the plan</option>
                <option value="rust">Rust</option><option value="node">Node.js</option><option value="python">Python</option>
              </select>
              <span className="hint">Rewrites use the live Naive team. The plan must pass capability and data checks before work begins.</span></div>
            <div className="s-field"><label htmlFor="f-data-changes">Requested data changes (optional)</label>
              <textarea id="f-data-changes" name="data_changes" rows={3} placeholder="Add a customer tier defaulting to standard for existing customers." />
              <span className="hint">New fields, defaults, renamed fields or tables. Needs a target runtime; you review the exact transformations in the proposal.</span></div>
        </div>}
      </fieldset>

      <fieldset>
        <legend><span>2</span>Your repository</legend>
        {mode === "github" ? (
          <>
            {gh.connected && (
              <div className="connected">
                <div className="gh-who">
                  <BrandIcon name="github" />
                  <b>{gh.login ? `@${gh.login}` : "GitHub"}</b>
                  <span className="gh-ok">● Read-only access</span>
                  <button type="button" className="linkish" onClick={disconnect}>Disconnect</button>
                </div>
                {gh.repos.length > 0 ? (
                  <div className="s-field"><label htmlFor="f-repo-pick">Repository</label>
                    <select id="f-repo-pick" value={choice} onChange={(e) => setChoice(e.target.value)}>
                      {gh.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo}{r.private ? " (private)" : ""}</option>)}
                      <option value={OTHER}>Another repository (paste a link)</option>
                    </select>
                  </div>
                ) : (
                  <p className="hint">{gh.error ?? "The Goose app can't see any repositories yet. Add them in the app's settings on GitHub, or paste a public link."}</p>
                )}
              </div>
            )}
            {(!gh.connected || !gh.repos.length || choice === OTHER) && (
              <div className="repo-row">
                <div className="s-field"><label htmlFor="f-repo">GitHub repository</label>
                  <input type="text" inputMode="url" id="f-repo" placeholder="https://github.com/your-org/your-app" autoComplete="off" spellCheck={false}
                    value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} /></div>
                {gh.configured && !gh.connected && (
                  <a className="s-btn gh-btn" href="/api/github/connect" onClick={saveDraft}><BrandIcon name="github" />Connect GitHub (read-only)</a>
                )}
              </div>
            )}
            <input type="hidden" name="github_repo" value={repo} />
            {branches.state === "ok" && (
              <div className="s-field"><label htmlFor="f-branch">Branch to use</label>
                <select id="f-branch" name="github_branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  {branches.list.map((b) => <option key={b} value={b}>{b === branches.defaultBranch ? `${b} (default)` : b}</option>)}
                </select></div>
            )}
            <p className={`hint${branches.state === "error" ? " err" : ""}`} aria-live="polite">
              {branches.state === "loading" ? "Checking the repository…"
                : branches.state === "error" ? branches.message
                : branches.state === "ok" ? `Goose reads ${branches.isPrivate ? "this private repository through your GitHub connection" : "this public repository"} with read-only access. It never pushes to it.`
                : gh.configured
                  ? "Public repositories work with just the link. For a private one, connect GitHub and choose which repositories Goose may read; access is read-only."
                  : "Paste the link to a public repository; Goose reads it with read-only access."}
            </p>
            {gh.loaded && gh.configured && !gh.connected && (
              <p className="hint">Already installed the Goose app on GitHub? <a href="/api/github/connect?mode=signin" onClick={saveDraft}>Sign in with GitHub</a> instead.</p>
            )}
            <p className="hint">Code not on GitHub? <button type="button" className="linkish" onClick={() => setMode("zip")}>Upload a .zip instead</button></p>
          </>
        ) : (
          <>
            <label className="drop" htmlFor="f-zip">
              <input type="file" id="f-zip" name="repository" accept=".zip" onChange={(e) => setFiles((f) => ({ ...f, zip: fileName(e.target.files) }))} />
              <b>Upload your code as a .zip</b><small>Up to 150 MB · the application or repository folder</small>
              {files.zip && <span className="file">{files.zip}</span>}
            </label>
            <p className="hint">Is it on GitHub? <button type="button" className="linkish" onClick={() => { setMode("github"); setFiles((f) => ({ ...f, zip: undefined })); }}>Use the repository instead</button></p>
          </>
        )}
        <label className="drop" htmlFor="f-db">
          <input type="file" id="f-db" name="database" onChange={(e) => setFiles((f) => ({ ...f, db: fileName(e.target.files) }))} />
          <b>Upload a copy of your data</b><small>Optional · SQLite file or database dump, only if the move touches data. The plan will say if it&apos;s needed.</small>
          {files.db && <span className="file">{files.db}</span>}
        </label>
        <label className="drop compact" htmlFor="f-docs">
          <input type="file" id="f-docs" name="documents" multiple onChange={(e) => setFiles((f) => ({ ...f, docs: fileName(e.target.files) }))} />
          <b>Add documentation</b><small>Optional · up to 5 files</small>
          {files.docs && <span className="file">{files.docs}</span>}
        </label>
      </fieldset>

      <fieldset>
        <legend><span>3</span>About you</legend>
        <div className="row2">
          <div className="s-field"><label htmlFor="f-business">Business name</label><input type="text" id="f-business" name="business" autoComplete="organization" required /></div>
          <div className="s-field"><label htmlFor="f-title">Application name</label><input type="text" id="f-title" name="title" placeholder="e.g. Order service" required /></div>
          <div className="s-field"><label htmlFor="f-contact">Your name</label><input type="text" id="f-contact" name="contact" autoComplete="name" required /></div>
          <div className="s-field"><label htmlFor="f-email">Email</label><input type="email" id="f-email" name="email" autoComplete="email" required /></div>
        </div>
        <div className="s-field"><label htmlFor="f-tz">Business time zone (how the app&apos;s dates should be read)</label>
          <select id="f-tz" name="timezone" defaultValue="America/Chicago">{ZONES.map((z) => <option key={z}>{z}</option>)}</select></div>
      </fieldset>

      <fieldset>
        <legend><span>4</span>What must not change</legend>
        <div className="checks">
          {CONSTRAINTS.map(([k, label]) => (
            <label key={k} className="s-check"><input type="checkbox" name="constraints" value={k} /><span>{label}</span></label>
          ))}
        </div>
        <div className="s-field"><label htmlFor="f-notes">Anything else we should know (optional)</label>
          <textarea id="f-notes" name="notes" rows={2} placeholder="e.g. A kiosk reads /api/slots.json every minute; no downtime on Mondays." /></div>
      </fieldset>

      <div className="checks">
        <label className="s-check"><input type="checkbox" name="demo" /><span>This is a test with a made-up business and synthetic data (labelled as a demonstration everywhere, never invoiced).</span></label>
        <label className="s-check"><input type="checkbox" name="authorized" onChange={(e) => setAuthorized(e.target.checked)} />
          <span>I own this code and its data, or I am authorized to share them. Goose works on copies and will not change my live systems.</span></label>
      </div>
      <div className="submit-row">
        <button className="s-btn primary" type="submit" disabled={busy || !authorized}>
          {busy ? (mode === "github" ? "Reading your repository…" : "Uploading…") : "Start engineering job"}
        </button>
        {err && <p className="form-err" role="alert">{err}</p>}
      </div>
    </form>
  );
}
