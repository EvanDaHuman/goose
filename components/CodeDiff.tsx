import fs from "node:fs";
import path from "node:path";
import { jobDir } from "@/lib/config";
import { hunks, lineDiff, pyFunction } from "@/lib/diff";

/** One function from the original code next to the same function in the upgraded code. */
export function CodeDiff({ jobId, attempt, module, fn, title }: { jobId: string; attempt: number; module: string; fn: string; title: string }) {
  const orig = fs.existsSync(jobDir(jobId, "source", module)) ? fs.readFileSync(jobDir(jobId, "source", module), "utf8") : "";
  const routes = jobDir(jobId, "build", `attempt-${attempt}`, "upgraded", "app", "routes");
  let upgraded = "";
  let file = "";
  if (fs.existsSync(routes)) {
    for (const f of fs.readdirSync(routes)) {
      const text = fs.readFileSync(path.join(routes, f), "utf8");
      if (new RegExp(`^def ${fn}\\(`, "m").test(text)) { upgraded = text; file = `app/routes/${f}`; break; }
    }
  }
  const a = pyFunction(orig, fn);
  const b = pyFunction(upgraded, fn);
  if (!a || !b) return null;
  const lines = hunks(lineDiff(a, b), 50);
  return (
    <div className="card section">
      <div className="card-head"><h3>{title}</h3><span className="small muted"><code>{module}</code> &rarr; <code>{file}</code></span></div>
      <pre className="diff">{lines.map((l, i) => l === null ? <div key={i} className="faint">...</div> :
        <div key={i} className={l.kind === "+" ? "add" : l.kind === "-" ? "del" : ""}>{l.kind} {l.text}</div>)}</pre>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>Red lines were removed, green lines added. The owner's own logic and comments are kept;
        the framework, the database calls and the agreed fixes changed.</p>
    </div>
  );
}
