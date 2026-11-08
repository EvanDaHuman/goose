import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanEnv, run } from "../lib/proc";

test("Linux sandbox isolates trusted engine input, output, secrets and networking", {
  skip: process.platform !== "linux" || process.env.GOOSE_TEST_DOCKER !== "1",
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goose-sandbox-test-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  const vault = path.join(root, "vault");
  for (const dir of [input, output, vault]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(input, "source.txt"), "original");
  fs.writeFileSync(path.join(vault, "secret.txt"), "withheld");
  try {
    const result = await run({
      cmd: "/usr/bin/python3", args: ["-c", `
import os, pathlib, socket
root = pathlib.Path(${JSON.stringify(root)})
assert (root / 'input/source.txt').read_text() == 'original'
assert not (root / 'vault/secret.txt').exists()
assert not pathlib.Path('/etc/goose/runtime.env').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
try:
    (root / 'input/source.txt').write_text('changed')
except OSError:
    pass
else:
    raise AssertionError('input is writable')
(root / 'output/result.txt').write_text('verified')
try:
    socket.create_connection(('1.1.1.1', 443), timeout=0.2)
except OSError:
    pass
else:
    raise AssertionError('network is accessible')
assert not os.environ.get('DATABASE_URL')
`],
      cwd: root, env: cleanEnv(), timeoutMs: 5000,
      sandbox: { readAllow: [root], writeAllow: [output], readDeny: [vault], network: "none" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(input, "source.txt"), "utf8"), "original");
    assert.equal(fs.readFileSync(path.join(output, "result.txt"), "utf8"), "verified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
