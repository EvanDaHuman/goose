// Exercise the real runtime, database, restart and delivery gates with deterministic test implementations.
// These are adapter tests, not evidence of agent-written code. The live Rust proof has its own session history.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { config } from "../../lib/config";
import { pool, q } from "../../lib/db";
import { createJob, jobById } from "../../lib/jobs";
import { baseline, freeze, verify, packageStage } from "../../lib/replatform";
import { J, makeWritable } from "../../lib/stages";

const pythonApp = `import json,os,sqlite3
from http.server import BaseHTTPRequestHandler,HTTPServer
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_GET(self):
  with sqlite3.connect(os.environ['APP_DB']) as c:
   c.row_factory=sqlite3.Row
   body=[dict(r) for r in c.execute('SELECT id,name,tier FROM people ORDER BY id')]
  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(body).encode())
 def do_POST(self):
  b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with sqlite3.connect(os.environ['APP_DB']) as c:
   i=c.execute('INSERT INTO people(name) VALUES(?)',(b['name'],)).lastrowid
  self.send_response(201); self.end_headers(); self.wfile.write(json.dumps({'id':i}).encode())
HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()
`;
const nodeApp = `import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.env.APP_DB);
http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
if(req.method==='POST'){let body='';for await(const b of req) body+=b; const row=db.prepare('INSERT INTO people(name) VALUES(?)').run(JSON.parse(body).name); res.statusCode=201;res.end(JSON.stringify({id:Number(row.lastInsertRowid)}));}
else res.end(JSON.stringify(db.prepare('SELECT id,name,tier FROM people ORDER BY id').all()));
}).listen(Number(process.env.PORT),'127.0.0.1');
`;

after(async () => { await pool.end(); });

for (const target of ["python", "node"] as const) test(`${target} adapter preserves data, writes new records, restarts, detects tampering and blocks packaging`, async () => {
  const work = fs.mkdtempSync(path.join(config.varDir, "adapter-test-"));
  let job: any;
  try {
    fs.writeFileSync(path.join(work, "app.py"), pythonApp);
    execFileSync("/usr/bin/zip", ["-q", path.join(work, "repo.zip"), "app.py"], { cwd: work });
    const db = path.join(work, "source.sqlite");
    execFileSync(config.python.engine, ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(\"CREATE TABLE people(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,tier TEXT NOT NULL DEFAULT 'standard'); INSERT INTO people VALUES(7,'Zoë 李','standard');\"); c.commit()", db]);
    const created = await createJob({ accountName: "Adapter test", kind: "demo", title: "Adapter", slug: "adapter", timezone: "UTC", repoZip: path.join(work, "repo.zip"), dbFile: db });
    job = (await jobById(created.id))!;
    for (const d of ["source", "snapshot", "work", "build/attempt-1/upgraded"]) fs.mkdirSync(J(job, d), { recursive: true });
    fs.writeFileSync(J(job, "source", "app.py"), pythonApp);
    fs.copyFileSync(db, J(job, "snapshot", "database.sqlite"));
    fs.writeFileSync(J(job, "work", "inspection.json"), JSON.stringify({ stack: { python: "3.13" } }));
    const contract = { version: 1, id: "test-v1", target, source: { runtime: "python", entry: "app.py", database_env: "APP_DB" }, data_changes: [],
      legacy_requests: [{ id: "old", method: "GET", path: "/" }],
      new_requests: [{ id: "create", method: "POST", path: "/people", body: { name: "New 🪿" }, save: { fresh: "/id" }, expect: { status: 201, body: { id: "{fresh}" } } }],
      persistence_requests: [{ id: "persist", method: "GET", path: "/?id={fresh}", expect: { status: 200, array_match: "contains", body: [{ id: "{fresh}", name: "New 🪿", tier: "standard" }] } }],
      data_assertions: [{ table: "people", where: { id: "{fresh}" }, values: { name: "New 🪿", tier: "standard" } }], limitations: [] };
    await q("INSERT INTO plans(job_id,version,author_kind,author,plan) VALUES($1,1,'tool','test',$2)", [job.id, JSON.stringify({ migration_contract: contract })]);
    await baseline(job, 1);
    const locked = await freeze(job, 1); job.checks_manifest_sha = locked.patch!.checks_manifest_sha;
    fs.writeFileSync(J(job, "build", "attempt-1", "upgraded", target === "node" ? "server.mjs" : "app.py"), target === "node" ? nodeApp : pythonApp);
    let report = JSON.parse(fs.readFileSync((await verify(job, 1)) + ".json", "utf8"));
    assert.equal(report.summary.verdict, "pass", JSON.stringify(report.failed));
    assert.ok(report.checks.some((c: any) => c.id === "restart.persist"));
    const entry = J(job, "build", "attempt-1", "upgraded", target === "node" ? "server.mjs" : "app.py");
    fs.appendFileSync(entry, "\n");
    await assert.rejects(packageStage(job, 1), /changed after verification/);
    fs.writeFileSync(entry, target === "node" ? nodeApp : pythonApp);
    // A candidate that lies about persisted data cannot pass the independent database assertions.
    fs.writeFileSync(J(job, "build", "attempt-1", "upgraded", target === "node" ? "server.mjs" : "app.py"), target === "node" ? nodeApp.replace(".run(JSON.parse(body).name)", ".run('CORRUPTED')") : pythonApp.replace("(b['name'],)", "('CORRUPTED',)"));
    report = JSON.parse(fs.readFileSync((await verify(job, 1)) + ".json", "utf8"));
    assert.equal(report.summary.verdict, "fail");
    assert.ok(report.failed.some((c: any) => c.id === "data.write.0"));
    await assert.rejects(packageStage(job, 1), /passing independent verdict/);
    fs.chmodSync(J(job, "vault", "contract.json"), 0o600);
    fs.appendFileSync(J(job, "vault", "contract.json"), " ");
    report = JSON.parse(fs.readFileSync((await verify(job, 1)) + ".json", "utf8"));
    assert.equal(report.integrity.ok, false);
    assert.equal(report.summary.verdict, "fail");
  } finally {
    if (job) { makeWritable(J(job)); fs.rmSync(J(job), { recursive: true, force: true }); }
    fs.rmSync(work, { recursive: true, force: true });
  }
});
