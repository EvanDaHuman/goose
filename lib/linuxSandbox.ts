import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { SandboxSpec } from "./proc";

// Rootless Docker mounts only the toolchain and the engine's explicit inputs/outputs.
export function linuxSandboxArgs(spec: SandboxSpec, cwd: string, cmd: string, args: string[], env: Record<string, string>, name: string) {
  if (spec.network === "loopback") throw new Error("Linux native service execution requires a shared isolated service environment. Use autonomous repository engineering.");
  const result = ["run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "1", "--memory", "768m", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m"];
  const reads = ["/usr", "/lib", "/lib64", "/etc/ld.so.cache", "/etc/localtime", path.join(config.varDir, "venvs"), ...spec.readAllow];
  for (const item of [...new Set(reads)]) {
    if (fs.existsSync(item)) result.push("--mount", `type=bind,src=${fs.realpathSync(item)},dst=${path.resolve(item)},readonly`);
  }
  for (const item of spec.writeAllow) {
    fs.mkdirSync(item, { recursive: true });
    result.push("--mount", `type=bind,src=${fs.realpathSync(item)},dst=${path.resolve(item)}`);
  }
  for (const item of spec.readDeny ?? []) {
    if (!fs.existsSync(item)) continue;
    if (!fs.statSync(item).isDirectory()) throw new Error("Linux sandbox exclusions must be directories");
    result.push("--mount", `type=tmpfs,dst=${path.resolve(item)},tmpfs-mode=000`);
  }
  for (const [key, value] of Object.entries(env)) result.push("--env", `${key}=${value}`);
  return [...result, "--workdir", cwd, "ubuntu:24.04", cmd, ...args];
}
