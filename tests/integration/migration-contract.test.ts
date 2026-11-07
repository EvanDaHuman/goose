import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { canonical, checkJsonNumbers, contains, contractProblems, repairEvidence, replay, resolveRefs, targetFromGoal } from "../../lib/migrationContract";

const fixture = () => JSON.parse(fs.readFileSync("demo/migration-ledger/repo/goose-migration.json", "utf8"));

test("a requested Rust target cannot silently become a framework upgrade", () => {
  assert.equal(targetFromGoal("Migrate our service to Rust and keep the API"), "rust");
  assert.equal(targetFromGoal("Rewrite in Go"), "go");
  assert.equal(targetFromGoal("Rewrite in C++"), "c++");
  assert.equal(targetFromGoal("Migrate to Node.js."), "node");
  assert.equal(targetFromGoal("Update Django while keeping behaviour"), null);
  const c = fixture();
  assert.deepEqual(contractProblems(c, "rust"), []);
  assert.ok(contractProblems(c, "go").length);
  c.target = "python";
  assert.ok(contractProblems(c, "rust").length);
});

test("contract gate requires real route coverage, new writes, persistence and database assertions", () => {
  const insp = { components: [{ kind: "route", name: "GET/PATCH /customers/{customer_id}", attrs: { methods: ["GET", "PATCH"] } }] };
  assert.deepEqual(contractProblems(fixture(), "rust", insp), []);
  for (const mutate of [
    (c: any) => { c.legacy_requests = c.legacy_requests.filter((r: any) => r.method !== "PATCH"); },
    (c: any) => { c.new_requests = c.new_requests.filter((r: any) => r.method !== "POST"); },
    (c: any) => { c.persistence_requests = []; },
    (c: any) => { c.data_assertions = []; },
    (c: any) => { c.data_changes.push({ op: "execute_sql", table: "customers", sql: "DROP TABLE customers" }); },
  ]) { const c = fixture(); mutate(c); assert.ok(contractProblems(c, "rust", insp).length); }
});

test("malformed contracts and unsafe paths fail closed", () => {
  for (const c of [null, {}, { ...fixture(), new_requests: {} }, { ...fixture(), legacy_requests: [null] }]) assert.ok(contractProblems(c, "rust").length);
  for (const field of ["//external.test/", "/\\external.test/", "https://external.test/", "/bad\r\npath"]) {
    const c = fixture(); c.new_requests[0].path = field; assert.ok(contractProblems(c, "rust").length);
  }
  const c = fixture(); c.source.database_env = "NODE_OPTIONS"; assert.ok(contractProblems(c, "rust").length);
});

test("reference resolution preserves JSON types and rejects missing values", () => {
  assert.equal(resolveRefs("{id}", { id: 103 }), 103);
  assert.equal(resolveRefs("/customers/{id}", { id: "a/b" }), "/customers/a%2Fb");
  assert.throws(() => resolveRefs("/customers/{missing}", {}), /Unresolved/);
  assert.equal(canonical({ b: 2, a: null }), canonical({ a: null, b: 2 }));
  assert.ok(!contains({ id: "103" }, { id: 103 }));
  assert.ok(!contains({}, { missing: null }));
  assert.throws(() => checkJsonNumbers({ id: 9223372036854775807 }), /Unsafe JSON number/);
});

test("HTTP replay exercises actual writes, saved ids and restart assertions without following redirects", async () => {
  let stored: any = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "https://example.com" }); res.end(); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let body = ""; for await (const part of req) body += part;
      stored = { id: 101, ...JSON.parse(body) }; res.statusCode = 201; res.end(JSON.stringify({ id: 101 }));
    } else res.end(JSON.stringify(stored));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const out = await replay(base, [
      { id: "write", method: "POST", path: "/customers", body: { name: "Zoë" }, save: { id: "/id" } },
      { id: "read", method: "GET", path: "/customers/{id}", expect: { status: 200, body: { id: "{id}", name: "Zoë" } } },
    ]);
    assert.deepEqual(out.results[1].body, { id: 101, name: "Zoë" });
    assert.deepEqual(out.results[1].body, out.results[1].expected?.body);
    await assert.rejects(replay(base, [{ id: "redirect", method: "GET", path: "/redirect" }]));
    await assert.rejects(replay(base, [{ id: "external", method: "GET", path: "//example.com" }]), /leave/);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test("collection checks preserve existing records and require explicit subset semantics for new identifiers", () => {
  const old = { id: 7, name: "Old customer" }, fresh = { id: 41, name: "New customer" };
  assert.equal(contains([old, fresh], [fresh]), false);
  assert.equal(contains([old, fresh], [fresh], true), true);
  assert.equal(contains([old], [fresh], true), false);
  assert.equal(contains([fresh], [fresh, fresh], true), false);
  assert.equal(contains([fresh, old], [old, fresh], true), false);
  const c = fixture();
  c.new_requests.push({ id: "collection", method: "GET", path: "/v2/customers", expect: { status: 200, body: [{ id: "{fresh_id}" }] } });
  assert.ok(contractProblems(c, "rust").some(p => p.includes("cannot predict all existing records")));
  c.new_requests.at(-1).expect.array_match = "contains";
  assert.deepEqual(contractProblems(c, "rust"), []);
});

test("repair diagnostics withhold original database values", () => {
  const evidence = repairEvidence([{ id: "legacy.read", title: "Legacy read", category: "compatibility",
    expected: { body: [{ id: 79812, name: "PRIVATE CUSTOMER", balance: 89231 }] }, actual: { body: [{ id: 79812, name: "PRIVATE CUSTOMER", balance: 0 }] } }]);
  const sent = JSON.stringify(evidence);
  assert.ok(!sent.includes("PRIVATE CUSTOMER")); assert.ok(!sent.includes("79812")); assert.ok(!sent.includes("89231"));
  assert.equal(evidence[0].expected_shape.body.length, 1);
  assert.equal(evidence[0].actual_shape.body.items[0].balance, "number");
});
