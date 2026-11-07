// Contract tests get a disposable database, never the provisioned company's agent registry.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

const name = `goose_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
const filesRoot = fs.mkdtempSync(path.join(process.cwd(), "var", "integration-tests-"));
const adminUrl = process.env.PG_ADMIN_URL;
if (!adminUrl) throw new Error("PG_ADMIN_URL is required for isolated integration tests; run npm run setup");
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl); url.pathname = "/" + name;
  const testDb = new pg.Client({ connectionString: url.toString() });
  await testDb.connect();
  try {
    for (const f of fs.readdirSync("db/migrations").filter(f => f.endsWith(".sql")).sort())
      await testDb.query(fs.readFileSync(path.join("db/migrations", f), "utf8"));
  } finally { await testDb.end(); }
  const files = fs.readdirSync("tests/integration").filter(f => f.endsWith(".test.ts")).map(f => path.join("tests/integration", f));
  process.exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url.toString(), GOOSE_MODE: "local", GOOSE_JOBS_DIR: filesRoot } });
    child.on("error", reject); child.on("exit", code => resolve(code ?? 1));
  });
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  fs.rmSync(filesRoot, { recursive: true, force: true });
}
