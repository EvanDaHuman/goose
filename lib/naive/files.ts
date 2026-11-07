// Moving files between this company and an agent's Naive computer. Sessions take no attachments: upload, then put the
// fil_ id in the session's first message and let the agent call fetch_file; outputs come back through publish_file and
// files.downloadBytes (files.download returns text and would corrupt a zip).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VettaClient } from "@usenaive-sdk/vetta";
import { one, q } from "../db";

const DIRECT_LIMIT = 25 * 1024 * 1024;

export async function uploadFile(client: VettaClient, jobId: string, filePath: string, name: string, tags: string[] = []) {
  const bytes = fs.readFileSync(filePath);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  // the same bytes for the same job reuse the earlier upload, so a restarted task sends the same message (same idempotency key)
  const known = await one<{ file_id: string }>("SELECT file_id FROM naive_files WHERE job_id = $1 AND sha256 = $2 AND direction = 'uploaded' AND deleted_at IS NULL",
    [jobId, sha]);
  if (known) return { id: known.file_id, sha256: sha, bytes: bytes.length };
  const type = name.endsWith(".zip") ? "application/zip" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
  let id: string;
  if (bytes.length <= DIRECT_LIMIT) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    form.append("name", name);
    form.append("tags", ["goose", jobId, ...tags].join(","));
    id = (await client.files.upload(form)).id;
  } else {
    const up = await client.files.createUpload({ name, content_type: type, size_bytes: bytes.length } as any);
    const r = await fetch(up.upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": type, "Content-Length": String(bytes.length) } });
    if (!r.ok) throw new Error(`upload of ${name} failed: ${r.status}`);
    id = up.file_id;
  }
  await q("INSERT INTO naive_files (file_id, job_id, direction, name, size_bytes, sha256) VALUES ($1,$2,'uploaded',$3,$4,$5) ON CONFLICT DO NOTHING",
    [id, jobId, name, bytes.length, sha]);
  return { id, sha256: sha, bytes: bytes.length };
}

export async function downloadFile(client: VettaClient, jobId: string, fileId: string, dest: string) {
  const bytes = await client.files.downloadBytes(fileId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  await q("INSERT INTO naive_files (file_id, job_id, direction, name, size_bytes, sha256) VALUES ($1,$2,'published_by_agent',$3,$4,$5) ON CONFLICT DO NOTHING",
    [fileId, jobId, path.basename(dest), bytes.length, sha]);
  return { path: dest, sha256: sha, bytes: bytes.length };
}

/** Remove a job's files from the Naive library after delivery (customer code should not stay there). */
export async function deleteJobFiles(client: VettaClient, jobId: string) {
  const rows = await q<{ file_id: string }>("SELECT file_id FROM naive_files WHERE job_id = $1 AND deleted_at IS NULL", [jobId]);
  for (const r of rows) {
    try {
      await client.files.delete(r.file_id);
      await q("UPDATE naive_files SET deleted_at = now() WHERE file_id = $1", [r.file_id]);
    } catch { /* left for the next clean-up */ }
  }
  return rows.length;
}
