// Running engine tools and customer code in isolation.
//
// Every process gets a scrubbed environment (no API keys, no company database URL) and runs under
// a macOS sandbox profile or a rootless Linux container: no outbound network, no reading the home folder except
// the paths it needs, and writes only to its own job folders. Profiles differ by role: only the
// verifier may read a job's frozen checks ("vault").
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { config } from "./config";
import { linuxSandboxArgs } from "./linuxSandbox";

export type SandboxSpec = {
  readAllow: string[];      // folders inside the home folder this process may read
  writeAllow: string[];     // folders it may write
  readDeny?: string[];      // always denied, even inside readAllow (e.g. the vault)
  network?: "none" | "loopback";
  strictFilesystem?: boolean; // untrusted repository commands get only explicit files and toolchains
};

function sbString(p: string) {
  return JSON.stringify(path.resolve(p));
}

export function profileText(spec: SandboxSpec) {
  const venvs = path.join(config.varDir, "venvs");
  const resolvedVenvs = fs.existsSync(venvs) ? fs.realpathSync(venvs) : venvs;
  if (spec.strictFilesystem) {
    // Do not inherit the legacy service adapter's shared temporary-directory access.
    // Homebrew's var/ contains databases, so permit its immutable toolchain trees only.
    const systemRead = ["/System", "/usr/lib", "/usr/share", "/usr/bin", "/usr/sbin", "/bin", "/sbin",
      "/Library/Apple", "/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer",
      "/opt/homebrew/Cellar", "/opt/homebrew/opt", "/opt/homebrew/bin", "/opt/homebrew/lib", "/opt/homebrew/share",
      "/usr/local/bin", "/usr/local/lib", "/private/var/db/timezone", "/dev/fd"];
    return ["(version 1)", "(allow default)", "(deny network-outbound)", "(deny network-inbound)",
      "(deny process-info*)", "(allow process-info* (target self))", "(deny signal)", "(allow signal (target self))",
      "(deny file-read*)", "(allow file-read-metadata)", "(deny file-write*)",
      // dyld reads the root directory during startup. This does not grant its children.
      '(allow file-read* (literal "/") (literal "/opt/homebrew/etc/openssl@3/openssl.cnf"))',
      ...[...systemRead, ...spec.readAllow, ...spec.writeAllow].map(p => `(allow file-read* (subpath ${sbString(p)}))`),
      '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))',
      ...spec.writeAllow.map(p => `(allow file-write* (subpath ${sbString(p)}))`),
      '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
      ...(spec.readDeny ?? []).flatMap(p => [`(deny file-read* (subpath ${sbString(p)}))`, `(deny file-write* (subpath ${sbString(p)}))`]),
    ].join("\n") + "\n";
  }
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network-outbound)",
    ...(spec.network === "none" ? ["(deny network-inbound)"] : ['(allow network-outbound (remote ip "localhost:*"))']),
    `(deny file-read* (subpath ${sbString(config.home)}))`,
    `(allow file-read-metadata (subpath ${sbString(config.home)}))`,
    `(allow file-read* (subpath ${sbString(path.join(config.varDir, "venvs"))}))`,
    `(allow file-read* (subpath ${sbString(resolvedVenvs)}))`,
    ...spec.readAllow.map((p) => `(allow file-read* (subpath ${sbString(p)}))`),
    ...spec.writeAllow.map((p) => `(allow file-read* (subpath ${sbString(p)}))`),
    `(deny file-write* (subpath ${sbString(config.home)}))`,
    ...spec.writeAllow.map((p) => `(allow file-write* (subpath ${sbString(p)}))`),
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null"))',
    ...(spec.readDeny ?? []).flatMap((p) => [`(deny file-read* (subpath ${sbString(p)}))`,
      `(deny file-write* (subpath ${sbString(p)}))`]),
  ];
  return lines.join("\n") + "\n";
}

export function cleanEnv(extra: Record<string, string> = {}, home?: string) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home ?? "/tmp",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    ...extra,
  };
}

export type RunResult = { code: number | null; stdout: string; stderr: string; stdoutTruncated: boolean; ms: number; events: any[]; timedOut: boolean };

export async function run(opts: {
  cmd: string; args: string[]; cwd: string; env: Record<string, string>; sandbox?: SandboxSpec;
  timeoutMs?: number; logFile?: string; profileFile?: string;
  stdin?: string;
}): Promise<RunResult> {
  let cmd = opts.cmd;
  let args = opts.args;
  let containerName: string | undefined;
  let env = opts.env as unknown as NodeJS.ProcessEnv;
  if (opts.sandbox && process.platform === "linux") {
    containerName = `goose-engine-${randomUUID()}`;
    args = linuxSandboxArgs(opts.sandbox, opts.cwd, cmd, args, opts.env, containerName);
    env = { ...opts.env, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) } as unknown as NodeJS.ProcessEnv;
    cmd = "/usr/bin/docker";
  } else if (opts.sandbox) {
    const pf = opts.profileFile ?? path.join(opts.cwd, `.sandbox-${process.pid}-${Date.now()}.sb`);
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, profileText(opts.sandbox));
    args = ["-f", pf, cmd, ...args];
    cmd = "/usr/bin/sandbox-exec";
  }
  const started = Date.now();
  const result = await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true, stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (opts.stdin !== undefined && child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(opts.stdin); }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let timedOut = false;
    const log = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: "a" }) : null;
    child.stdout!.on("data", (d: Buffer) => { const combined = stdout + d; stdoutTruncated ||= combined.length > 2_000_000; stdout = combined.slice(-2_000_000); log?.write(d); });
    child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d).slice(-2_000_000); log?.write(d); });
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, opts.timeoutMs) : null;
    child.on("error", error => {
      if (timer) clearTimeout(timer);
      log?.end();
      resolve({ code: -1, stdout, stderr: String(error), stdoutTruncated, ms: Date.now() - started, events: [], timedOut: false });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      log?.end();
      const events: any[] = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (t.startsWith("{")) {
          try { events.push(JSON.parse(t)); } catch { /* not an event line */ }
        }
      }
      resolve({ code, stdout, stderr, stdoutTruncated, ms: Date.now() - started, events, timedOut });
    });
  });
  if (containerName) spawnSync("/usr/bin/docker", ["rm", "--force", containerName], { env, timeout: 10000, stdio: "ignore" });
  return result;
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export type Server = { pid: number; port: number; url: string; stop: () => Promise<void>; startedMs: number };

/** Start a server, wait until it answers, and make sure the answer comes from the process we started. */
export async function startServer(opts: {
  cmd: string; args: string[]; cwd: string; env: Record<string, string>; sandbox: SandboxSpec;
  port: number; healthPath: string; logFile: string; timeoutMs?: number;
}): Promise<Server> {
  const pf = path.join(path.dirname(opts.logFile), `.sandbox-server-${opts.port}.sb`);
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  fs.writeFileSync(pf, profileText(opts.sandbox));
  const out = fs.openSync(opts.logFile, "a");
  const started = Date.now();
  const child = spawn("/usr/bin/sandbox-exec", ["-f", pf, opts.cmd, ...opts.args],
    { cwd: opts.cwd, env: opts.env as unknown as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", out, out] });
  let exited: number | null = null;
  child.on("exit", (c: number | null) => { exited = c ?? -1; });
  const url = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  const stop = async () => {
    if (exited !== null) return;
    try { process.kill(-child.pid!, "SIGTERM"); } catch { return; }
    for (let i = 0; i < 40 && exited === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (exited === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  };
  while (Date.now() < deadline) {
    if (exited !== null) break;
    try {
      const r = await fetch(url + opts.healthPath, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500 && exited === null) {
        return { pid: child.pid!, port: opts.port, url, stop, startedMs: started };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  const tail = fs.existsSync(opts.logFile) ? fs.readFileSync(opts.logFile, "utf8").slice(-1500) : "";
  throw new Error(`server did not start (exit ${exited}) on port ${opts.port}: ${tail}`);
}
