// Public, reviewable migration specification. Execution checks are frozen separately before implementation.
export type Runtime = "rust" | "node" | "python";
export type RequestStep = {
  id: string; method: string; path: string; body?: unknown; headers?: Record<string, string>;
  save?: Record<string, string>; expect?: { status: number; body?: unknown; array_match?: "contains" };
};
export type MigrationContract = {
  version: 1; id: string; target: Runtime; source: { runtime: "flask" | "python" | "node"; entry: string; database_env: string };
  data_changes: any[]; legacy_requests: RequestStep[]; new_requests: RequestStep[];
  persistence_requests: RequestStep[];
  data_assertions: { table: string; where: Record<string, unknown>; values: Record<string, unknown> }[];
  limitations: string[];
};

export const RUNTIME_NAMES: Record<Runtime, string> = { rust: "Rust", node: "Node.js", python: "Python" };
export const RUST_MANIFEST = `[package]
name = "goose-app"
version = "0.1.0"
edition = "2021"
autobins = false
autotests = false
autoexamples = false
autobenches = false
build = false

[[bin]]
name = "goose-app"
path = "src/main.rs"

[dependencies]
tiny_http = "=0.12.0"
rusqlite = { version = "=0.37.0", features = ["bundled"] }
serde_json = "=1.0.145"
`;

export function targetFromGoal(goal: string) {
  const m = goal.match(/\b(?:to|in|using)\s+(rust|node(?:\.js|js)?|javascript|typescript|python|golang|go|java|c\+\+|c#|cpp|\.net|ruby|elixir|kotlin|swift|php|scala|haskell|zig|deno|bun)(?=$|[\s.,;:!?])/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return ["node.js", "nodejs", "javascript"].includes(name) ? "node" : name;
}

export function contractProblems(c: any, target: string, insp?: any): string[] {
  const p: string[] = [];
  if (!c || typeof c !== "object") return ["Contract must be an object"];
  if (!["data_changes", "legacy_requests", "new_requests", "persistence_requests", "data_assertions", "limitations"].every(k => Array.isArray(c[k])))
    return ["The contract's changes, request groups, data assertions and limitations must be arrays"];
  if ([...c.legacy_requests, ...c.new_requests, ...c.persistence_requests, ...c.data_changes, ...c.data_assertions].some(x => !x || typeof x !== "object"))
    return ["Contract entries must be objects"];
  if (c.version !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id ?? "")) p.push("Invalid contract version or id");
  if (!(target in RUNTIME_NAMES) || c.target !== target) p.push("Contract must use the requested, executable target runtime");
  if (!["flask", "python", "node"].includes(c.source?.runtime)) p.push("No executable source runtime adapter");
  if (!/^[\w./-]+\.(py|m?js)$/.test(c.source?.entry ?? "") || c.source.entry.startsWith("/") || c.source.entry.split("/").includes("..")) p.push("Source entry must be a relative Python or JavaScript file");
  if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(c.source?.database_env ?? "") || /^(PATH|HOME|PYTHON|NODE|LD_|DYLD_|RUST|CARGO)/.test(c.source?.database_env ?? "") || ["PORT", "HOST", "APP_ROOT", "TZ"].includes(c.source?.database_env)) p.push("Invalid database environment variable");
  const ids = new Set<string>();
  for (const group of ["legacy_requests", "new_requests", "persistence_requests"] as const) {
    const steps = c[group];
    if (!Array.isArray(steps) || !steps.length || steps.length > 150) { p.push(`${group} must contain 1 to 150 checks`); continue; }
    for (const s of steps) {
      if (typeof s.id !== "string" || !/^[\w.-]{1,80}$/.test(s.id) || ids.has(s.id)) p.push("Every check needs a unique id");
      ids.add(s.id);
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(s.method)) p.push(`Unsupported method for ${s.id}`);
      if (typeof s.path !== "string" || !s.path.startsWith("/") || s.path.startsWith("//") || /[\\\r\n]/.test(s.path)) p.push(`Invalid local path for ${s.id}`);
      if (group !== "legacy_requests" && (!Number.isInteger(s.expect?.status) || s.expect.status < 200 || s.expect.status > 499 || !("body" in s.expect))) p.push(`${s.id} needs an explicit response status and body expectation`);
      if (s.expect?.array_match !== undefined && s.expect.array_match !== "contains") p.push(`${s.id} has an unsupported collection matcher`);
      if (group !== "legacy_requests" && Array.isArray(s.expect?.body) && /\{[A-Za-z]\w*\}/.test(JSON.stringify(s.expect.body)) && s.expect.array_match !== "contains")
        p.push(`${s.id}: a collection of newly created records cannot predict all existing records. Use array_match:"contains" or individual record reads.`);
      if (group === "persistence_requests" && s.method !== "GET") p.push("Restart checks must be reads");
      if (s.save && Object.entries(s.save).some(([k, v]) => !/^[A-Za-z][\w]*$/.test(k) || typeof v !== "string" || !v.startsWith("/"))) p.push("Saved values use names and JSON pointers");
      if (s.headers && Object.keys(s.headers).some(k => /^(host|connection|content-length|transfer-encoding)$/i.test(k))) p.push("Transport headers are managed by the verifier");
    }
  }
  if (!c.new_requests.some((s: any) => s.method === "POST" && s.expect?.status >= 200 && s.expect?.status < 300 && Object.keys(s.save ?? {}).length)) p.push("A successful new-record creation must save its identifier for later checks");
  if (!c.persistence_requests.some((s: any) => /\{[A-Za-z]\w*\}/.test(s.path ?? ""))) p.push("Restart checks must read a record created during verification");
  if (!Array.isArray(c.data_changes) || c.data_changes.length > 50) p.push("Data changes must be a bounded list");
  else for (const d of c.data_changes) {
    if (!["add_column", "rename_column", "create_table", "insert_rows"].includes(d.op)) p.push(`Unimplemented data operation ${d.op}`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(d.table ?? "")) p.push("Invalid table name");
  }
  if (!Array.isArray(c.data_assertions) || !c.data_assertions.length) p.push("New writes need independent database assertions");
  else for (const a of c.data_assertions) if (!a.table || !a.where || !Object.keys(a.where).length || !a.values || !Object.keys(a.values).length) p.push("Data assertions need a table, record selector and expected values");
  if (!Array.isArray(c.limitations)) p.push("List the contract's coverage limits");
  // At least one actual request for each discovered route/method. A declared route id alone proves nothing.
  for (const r of insp?.components?.filter((x: any) => x.kind === "route") ?? []) {
    const route = r.attrs?.path ?? r.name?.slice(r.name.indexOf(" ") + 1);
    if (!route?.startsWith("/")) continue;
    const pattern = new RegExp("^" + route.split(/(<[^>]+>|\{[^}]+\})/g).map((part: string) => /^[<{]/.test(part) ? "[^/?]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "(?:\\?.*)?$");
    for (const method of (r.attrs?.methods ?? [r.name?.split(" ")[0]]).filter((m: string) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m))) {
      if (!c.legacy_requests?.some((s: RequestStep) => s.method === method && pattern.test(s.path))) p.push(`Missing baseline coverage for ${method} ${route}`);
    }
  }
  return [...new Set(p)];
}

export function resolveRefs(value: any, saved: Record<string, any>): any {
  if (typeof value === "string") {
    const whole = value.match(/^\{([A-Za-z]\w*)\}$/);
    if (whole) {
      if (!(whole[1] in saved)) throw new Error(`Unresolved reference ${whole[1]}`);
      return saved[whole[1]];
    }
    return value.replace(/\{([A-Za-z]\w*)\}/g, (_, k) => {
      if (!(k in saved)) throw new Error(`Unresolved reference ${k}`);
      return encodeURIComponent(String(saved[k]));
    });
  }
  if (Array.isArray(value)) return value.map(x => resolveRefs(x, saved));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, saved)]));
  return value;
}

export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

export function checkJsonNumbers(value: any): void {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
    throw new Error("Unsafe JSON number: large integers must use an explicit string representation in the API contract");
  if (value && typeof value === "object") for (const v of Object.values(value)) checkJsonNumbers(v);
}

// New-feature expectations match the explicitly specified fields. Legacy responses use exact equality.
export function contains(actual: any, expected: any, subsetArrays = false): boolean {
  if (subsetArrays && Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    // Match distinct elements in order. One actual record cannot satisfy two expected records.
    let index = 0;
    for (const item of expected) {
      while (index < actual.length && !contains(actual[index], item, true)) index++;
      if (index === actual.length) return false;
      index++;
    }
    return true;
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected))
    return actual !== null && typeof actual === "object" && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && contains(actual[k], v, subsetArrays));
  return canonical(actual) === canonical(expected);
}

// Repair agents receive structural shapes, never row values from the customer's snapshot.
export function repairEvidence(failed: any[]) {
  const shape = (value: any, depth = 0): any => {
    if (value === null) return "null";
    if (depth > 6) return typeof value;
    if (Array.isArray(value)) return { type: "array", length: value.length, items: value.slice(0, 3).map(v => shape(v, depth + 1)) };
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
    return typeof value;
  };
  return failed.map(f => ({ id: f.id, title: f.title, category: f.category,
    expected_shape: shape(f.expected), actual_shape: shape(f.actual),
    guidance: "Values are withheld. Reproduce with synthetic records, compare with the original source, and preserve all existing records. Never hide existing records or hardcode fixture identifiers to satisfy a check. Escalate contradictory requirements." }));
}

export async function replay(base: string, steps: RequestStep[], saved: Record<string, any> = {}) {
  const results = [];
  for (const s of steps) {
    const requestPath = resolveRefs(s.path, saved);
    const url = new URL(requestPath, base);
    if (url.origin !== new URL(base).origin) throw new Error("A check tried to leave the isolated application");
    const res = await fetch(url, { method: s.method, headers: { "content-type": "application/json", ...resolveRefs(s.headers ?? {}, saved) },
      body: s.body === undefined ? undefined : JSON.stringify(resolveRefs(s.body, saved)), redirect: "error", signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    checkJsonNumbers(body);
    for (const [key, ptr] of Object.entries(s.save ?? {})) {
      let v = body;
      for (const part of ptr.slice(1).split("/")) v = v?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      if (v === undefined || v === null || typeof v === "object") throw new Error(`${s.id}: could not save ${key} from ${ptr}`);
      saved[key] = v;
    }
    results.push({ id: s.id, status: res.status, body, expected: s.expect ? resolveRefs(s.expect, saved) : null });
  }
  return { results, saved };
}
