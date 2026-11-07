// Small helpers for route handlers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobByToken } from "./jobs";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function customerJob(id: string, token: string | null | undefined) {
  if (!token) return null;
  return await jobByToken(id, token);
}

/** Write an uploaded File to a private temp file and return its path. */
export async function saveUpload(file: File, maxBytes: number) {
  if (file.size > maxBytes) throw new Error(`file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-upload-"));
  const p = path.join(dir, "upload.bin");
  fs.writeFileSync(p, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
  return p;
}

export function wrap(fn: () => Promise<Response>) {
  return fn().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e), 400));
}
