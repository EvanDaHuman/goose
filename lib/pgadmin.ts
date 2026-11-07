// One PostgreSQL database and one login role per job copy. Customer code only ever gets the
// credentials of its own database; it never sees the company database or the admin login.
import crypto from "node:crypto";
import pg from "pg";
import { config } from "./config";

const g = globalThis as unknown as { __pwAdmin?: pg.Pool };
const admin = () => g.__pwAdmin ?? (g.__pwAdmin = new pg.Pool({ connectionString: config.pgAdminUrl, max: 3 }));

function ident(s: string) {
  if (!/^[a-z0-9_]+$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return s;
}

export function dbName(jobId: string, label: string) {
  return ident(`job_${jobId.toLowerCase().replace(/[^a-z0-9]/g, "")}_${label}`);
}

export async function dropDb(name: string) {
  const a = admin();
  await a.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [name]);
  await a.query(`DROP DATABASE IF EXISTS ${ident(name)}`);
  await a.query(`DROP ROLE IF EXISTS ${ident(name)}`);
}

export async function exists(name: string) {
  const r = await admin().query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return r.rowCount === 1;
}

/** Create (or, with keep=true, reuse) a database owned by its own role; returns its connection URL. */
export async function createDb(name: string, opts: { keep?: boolean; passwordFile?: string } = {}) {
  const a = admin();
  const u = new URL(config.pgAdminUrl);
  const fs = await import("node:fs");
  if (opts.keep && opts.passwordFile && fs.existsSync(opts.passwordFile) && (await exists(name))) {
    const pw = fs.readFileSync(opts.passwordFile, "utf8").trim();
    return `postgresql://${name}:${pw}@${u.hostname}:${u.port}/${name}`;
  }
  await dropDb(name);
  const pw = crypto.randomBytes(18).toString("base64url");
  await a.query(`CREATE ROLE ${ident(name)} LOGIN PASSWORD '${pw}'`);
  await a.query(`CREATE DATABASE ${ident(name)} OWNER ${ident(name)}`);
  await a.query(`REVOKE ALL ON DATABASE ${ident(name)} FROM PUBLIC`);
  if (opts.passwordFile) fs.writeFileSync(opts.passwordFile, pw, { mode: 0o600 });
  return `postgresql://${name}:${pw}@${u.hostname}:${u.port}/${name}`;
}

export async function dropJobDatabases(jobId: string) {
  const prefix = `job_${jobId.toLowerCase().replace(/[^a-z0-9]/g, "")}_`;
  const r = await admin().query("SELECT datname FROM pg_database WHERE datname LIKE $1", [prefix + "%"]);
  for (const row of r.rows) await dropDb(row.datname);
}
