// Plan checks against the actual original source, before any execution (lib/adaptive.ts sourcePreflight).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sourcePreflight } from "../../lib/adaptive";

test("missing protected paths (e.g. submodules) are dropped as limitations; negative controls must target one exact original substring", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "goose-preflight-"));
  try {
    fs.mkdirSync(path.join(src, "models")); fs.writeFileSync(path.join(src, "models/user.js"), "order: [['createdAt','DESC']]\n");
    fs.writeFileSync(path.join(src, "test.js"), "test");
    const base = { protected_paths: ["test.js", "realworld", "react-app"], limitations: ["existing"],
      mutations: [{ path: "models/user.js", find: "'DESC'", replace: "'ASC'", check_id: "p" }] };
    const ok = sourcePreflight(src, base);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.plan.protected_paths, ["test.js"]);
    assert.match(ok.plan.limitations.at(-1), /realworld, react-app/);
    assert.match(sourcePreflight(src, { ...base, mutations: [{ path: "models/user.ts", find: "x", replace: "y" }] }).problems[0], /ORIGINAL source/);
    assert.match(sourcePreflight(src, { ...base, mutations: [{ path: "models/user.js", find: "nope", replace: "y" }] }).problems[0], /exactly once/);
    assert.match(sourcePreflight(src, { ...base, protected_paths: ["gone"] }).problems[0], /exist in the supplied source/);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});
