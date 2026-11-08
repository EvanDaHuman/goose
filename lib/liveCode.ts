// What the geese walk on in a job's live run (components/job/JobRun.tsx).
//  - "replay": the latest build attempt's real change.diff, one changed file at a time. Unchanged stretches between
//    hunks fold to a single row; a hunk's removed lines pair up with its added lines so they can rewrite in place.
//  - "read": before any diff exists, the customer's own source files, untouched (the agent is still working).
// Rows are capped so even a very large change plays in a minute or two.
import fs from "node:fs";
import path from "node:path";
import { jobDir } from "./config";
import { q } from "./db";

export type LiveRow =
  | { k: "same"; t: string; n: number }
  | { k: "chg"; o: string; t: string; n: number }
  | { k: "del"; o: string; n: number }
  | { k: "add"; t: string; n: number }
  | { k: "fold"; count: number; what: "unchanged" | "added" | "removed" | "more" };
export type LiveFile = { path: string; rows: LiveRow[]; added: number; removed: number; isNew: boolean };
export type LiveCode = { mode: "replay" | "read"; attempt: number | null; files: LiveFile[]; moreFiles: string[]; totalChanged: number };
export type LiveSig = { sig: string; mode: "replay" | "read"; attempt: number | null };

const MAX_FILES = 10;
const MAX_ROWS_PER_FILE = 260;
const READ_FILES = 4;
const READ_LINES = 140;
const NOISE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|(^|\/)(node_modules|vendor|dist|build|\.git|__pycache__)\//;
const CODE = /\.(py|js|jsx|ts|tsx|mjs|cjs|rb|php|go|rs|java|kt|cs|cpp|cc|c|h|hpp|swift|scala|sql|html|vue|svelte|ex|exs|sh|yaml|yml|toml|cfg|ini|xml|launch|msg|srv|cmake|txt)$/i;
const SECRET = /((?:pass(?:word)?|secret|unique_key|api_key|token|private_key)[\w']*\s*(?:=>|=|:)\s*)(['"])(?!REDACTED\2)[^'"]+\2/i;

/** Never show a secret from a customer's file, even to the customer. Long lines are cut so the page stays readable. */
const clean = (s: string) => {
  const r = s.replace(/\t/g, "    ").replace(SECRET, "$1$2[redacted]$2");
  return r.length > 220 ? r.slice(0, 217) + "…" : r;
};

/** The path a file has inside the repository: the common tail of the two paths a diff names. */
function relPath(a: string, b: string) {
  const A = a.split("/").filter(Boolean), B = b.split("/").filter(Boolean);
  if (a === "/dev/null") return B.slice(-3).join("/");
  if (b === "/dev/null") return A.slice(-3).join("/");
  const out: string[] = [];
  while (A.length && B.length && A[A.length - 1] === B[B.length - 1]) { out.unshift(A.pop()!); B.pop(); }
  return out.join("/") || B.join("/");
}

/** Parse a unified diff (diff -ruN or git) into display rows per file. */
export function parseDiff(text: string) {
  const files: (LiveFile & { changed: number })[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.startsWith("--- ") || !lines[i + 1]?.startsWith("+++ ")) { i++; continue; }
    const a = l.slice(4).split("\t")[0].trim(), b = lines[i + 1].slice(4).split("\t")[0].trim();
    i += 2;
    const rows: LiveRow[] = [];
    let added = 0, removed = 0, oldNext = 1, isNew = true;
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      i++;
      if (!m) continue;
      const oStart = +m[1], oLen = m[2] == null ? 1 : +m[2];
      let nNo = +m[3];
      if (oLen > 0 || oStart > 0) isNew = false;
      const gap = oStart - oldNext;
      if (gap > 0) rows.push({ k: "fold", count: gap, what: "unchanged" });
      let dels: string[] = [], adds: string[] = [];
      const flush = () => {
        const pair = Math.min(dels.length, adds.length);
        for (let k = 0; k < pair; k++) rows.push({ k: "chg", o: clean(dels[k]), t: clean(adds[k]), n: nNo++ });
        for (let k = pair; k < dels.length; k++) rows.push({ k: "del", o: clean(dels[k]), n: nNo });
        for (let k = pair; k < adds.length; k++) rows.push({ k: "add", t: clean(adds[k]), n: nNo++ });
        removed += dels.length; added += adds.length;
        dels = []; adds = [];
      };
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff ") && !(lines[i].startsWith("--- ") && lines[i + 1]?.startsWith("+++ "))) {
        const s = lines[i];
        if (s.startsWith("-")) dels.push(s.slice(1));
        else if (s.startsWith("+")) adds.push(s.slice(1));
        else if (s.startsWith(" ") || s === "") {
          if (s === "" && i === lines.length - 1) { i++; break; }
          flush();
          rows.push({ k: "same", t: clean(s.slice(1)), n: nNo++ });
        }
        i++;
      }
      flush();
      oldNext = oStart + oLen;
    }
    const p = relPath(a, b);
    const changed = rows.filter((r) => r.k !== "same" && r.k !== "fold").length;
    if (!changed || NOISE.test(p)) continue;
    files.push({ path: p, rows: capRows(rows), added, removed, isNew, changed });
  }
  return files;
}

/** Keep a file's rows under the cap: long runs of one kind of change fold into a single row. */
function capRows(rows: LiveRow[]): LiveRow[] {
  if (rows.length <= MAX_ROWS_PER_FILE) return rows;
  // first shorten long blocks of added or removed lines (a new file, a deleted module)
  const out: LiveRow[] = [];
  for (let s = 0; s < rows.length;) {
    const k = rows[s].k;
    let e = s;
    while (e < rows.length && rows[e].k === k) e++;
    const len = e - s;
    if ((k === "add" || k === "del") && len > 24) {
      out.push(...rows.slice(s, s + 16));
      out.push({ k: "fold", count: len - 16, what: k === "add" ? "added" : "removed" });
    } else out.push(...rows.slice(s, e));
    s = e;
  }
  if (out.length <= MAX_ROWS_PER_FILE) return out;
  const cut = out.slice(0, MAX_ROWS_PER_FILE - 1);
  const rest = out.slice(MAX_ROWS_PER_FILE - 1).filter((r) => r.k !== "same" && r.k !== "fold").length;
  cut.push({ k: "fold", count: rest, what: "more" });
  return cut;
}

async function latestDiff(id: string) {
  const a = (await q<{ attempt: number }>("SELECT attempt FROM artifacts WHERE job_id = $1 AND kind = 'change_diff' ORDER BY id DESC LIMIT 1", [id]))[0];
  if (!a) return null;
  const file = jobDir(id, "build", `attempt-${a.attempt}`, "change.diff");
  try { return { attempt: a.attempt, file, stat: fs.statSync(file) }; } catch { return null; }
}

/** A cheap fingerprint of what the live run would show, so the page only reloads the code when it changes. */
export async function liveSig(id: string): Promise<LiveSig | null> {
  const d = await latestDiff(id);
  if (d) return { sig: `replay:${d.attempt}:${d.stat.size}:${Math.round(d.stat.mtimeMs)}`, mode: "replay", attempt: d.attempt };
  const src = jobDir(id, "source");
  if (fs.existsSync(src)) return { sig: `read:${Math.round(fs.statSync(src).mtimeMs)}`, mode: "read", attempt: null };
  return null;
}

function walk(dir: string, base = dir, out: string[] = []) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__" || e.name === "vendor") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (out.length < 4000) walk(p, base, out); }
    else out.push(path.relative(base, p));
  }
  return out;
}

/** Source files worth reading: the ones the plan names first, then the larger code files. */
async function readFiles(id: string): Promise<LiveFile[]> {
  const root = jobDir(id, "source");
  const all = walk(root).filter((f) => CODE.test(f) && !NOISE.test(f));
  const plan = (await q<{ plan: unknown }>("SELECT plan FROM plans WHERE job_id = $1 ORDER BY version DESC LIMIT 1", [id]))[0]?.plan;
  const planText = plan ? JSON.stringify(plan) : "";
  const scored = all.map((f) => {
    let size = 0;
    try { size = fs.statSync(path.join(root, f)).size; } catch { /* gone */ }
    const named = planText.includes(f) ? 1 : 0;
    const depth = f.split("/").length;
    return { f, size, score: named * 1e7 + (size > 200 && size < 120_000 ? Math.min(size, 40_000) : 0) - depth * 500 };
  }).filter((x) => x.size > 0 && x.size < 400_000).sort((a, b) => b.score - a.score).slice(0, READ_FILES);
  return scored.map(({ f }) => {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    const ls = text.split("\n");
    const rows: LiveRow[] = ls.slice(0, READ_LINES).map((t, k) => ({ k: "same", t: clean(t), n: k + 1 }));
    if (ls.length > READ_LINES) rows.push({ k: "fold", count: ls.length - READ_LINES, what: "unchanged" });
    return { path: f, rows, added: 0, removed: 0, isNew: false };
  });
}

export async function liveCode(id: string): Promise<LiveCode | null> {
  const d = await latestDiff(id);
  if (d) {
    // edited files first (they show code being rewritten), then new files, then files that were only removed
    const group = (f: LiveFile) => (f.isNew ? 1 : f.added === 0 ? 2 : 0);
    const parsed = parseDiff(fs.readFileSync(d.file, "utf8")).map((f, i) => ({ f, i }))
      .sort((a, b) => group(a.f) - group(b.f) || a.i - b.i).map((x) => x.f);
    const files = parsed.slice(0, MAX_FILES);
    return {
      mode: "replay", attempt: d.attempt, files: files.map(({ changed: _c, ...f }) => f),
      moreFiles: parsed.slice(MAX_FILES).map((f) => f.path), totalChanged: parsed.reduce((a, f) => a + f.changed, 0),
    };
  }
  if (!fs.existsSync(jobDir(id, "source"))) return null;
  const files = await readFiles(id);
  return files.length ? { mode: "read", attempt: null, files, moreFiles: [], totalChanged: 0 } : null;
}
