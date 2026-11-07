// Apply db/migrations/*.sql to the company database (each statement file is idempotent).
import fs from "node:fs";
import path from "node:path";
import { pool, q } from "../lib/db";

const dir = path.join(process.cwd(), "db", "migrations");
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  await q(fs.readFileSync(path.join(dir, f), "utf8"));
  console.log(`applied ${f}`);
}
await pool.end();
