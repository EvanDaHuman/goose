import pg from "pg";
import { config } from "./config";

pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10)); // BIGINT -> number (our values stay small)

const g = globalThis as unknown as { __pwPool?: pg.Pool };

export const pool: pg.Pool =
  g.__pwPool ?? (g.__pwPool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 }));

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
