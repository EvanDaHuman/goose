import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const helper = path.resolve("scripts/processes.sh");

test("starting and stopping one checkout ignores another checkout's worker", { timeout: 15_000 }, async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goose-processes-")));
  const root = path.join(temp, "checkout [goose]");
  const other = path.join(temp, "another checkout");
  const showroom = path.join(root, "var", "jobs", "GS-1", "showroom", "app");
  for (const dir of [root, other, showroom]) fs.mkdirSync(dir, { recursive: true });
  const children: ChildProcess[] = [];
  const start = async (cwd: string, name: string) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", name], { cwd, stdio: "ignore" });
    children.push(child);
    await once(child, "spawn");
    return child;
  };
  const call = async (command: string, pattern: string) => (await exec("bash",
    ["-c", 'source "$1"; "$2" "$3"', "process-test", helper, command, pattern],
    { env: { ...process.env, ROOT: root }, timeout: 5000 })).stdout.trim();
  const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : once(child, "exit");

  try {
    const unrelated = await start(other, "worker/index.ts");
    assert.equal(await call("project_pids", "worker/index[.]ts"), "",
      "another checkout's worker must not prevent this checkout from starting");
    const worker = await start(root, "worker/index.ts");
    const preview = await start(showroom, "var/jobs/GS-1/showroom/server");
    assert.equal(await call("project_pids", "worker/index[.]ts"), String(worker.pid));
    assert.equal(await call("project_pids", "var/jobs/.*/showroom"), String(preview.pid));

    await call("stop_project_processes", "worker/index[.]ts|var/jobs/.*/showroom");
    await Promise.all([exited(worker), exited(preview)]);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), "the other checkout stays running");
    assert.equal(await call("project_pids", "worker/index[.]ts"), "");
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(exited));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
