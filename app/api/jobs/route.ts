import fs from "node:fs";
import path from "node:path";
import { createJob } from "@/lib/jobs";
import { fail, json, saveUpload, wrap } from "@/lib/http";
import { assertSameOrigin } from "@/lib/operatorAuth";

// A real customer submits a repository (and usually a database copy).
export async function POST(req: Request) {
  const denied = assertSameOrigin(req); if (denied) return denied;
  return wrap(async () => {
    const form = await req.formData();
    const field = (key: string, max: number, fallback = "") => {
      const value = String(form.get(key) ?? fallback).trim();
      if (value.length > max) throw new Error(`${key} must be no longer than ${max} characters; nothing has been submitted`);
      return value;
    };
    const goal = field("goal", 20000);
    if (!goal) return fail("Please tell us what you want to improve.");
    const email = field("email", 254).toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return fail("Enter a valid customer email address.");
    const title = field("title", 120, "Application") || "Application";
    const business = field("business", 200) || "Unnamed business", contact = field("contact", 160);
    const notes = field("notes", 10000), timezone = field("timezone", 100, "UTC");
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { return fail("Choose a valid business time zone."); }
    const jobType = field("job_type", 30, "service");
    if (!["service", "workspace"].includes(jobType)) return fail("Choose a supported type of engineering work.");
    const target = field("target_runtime", 60).toLowerCase(), dataChanges = field("data_changes", 10000);
    if (target && !["rust", "node", "python"].includes(target)) return fail("Choose a supported target runtime.");
    if (jobType === "workspace" && (target || dataChanges)) return fail("Repository engineering changes use the stated objective and executable contract; submit service migration fields only with a service migration.");
    if (dataChanges && !target) return fail("Choose a target runtime for a migration with data changes.");
    const inquiry = field("inquiry_id", 36);
    if (inquiry && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(inquiry)) return fail("The inquiry reference is invalid.");
    const repo = form.get("repository");
    const db = form.get("database");
    const documents = form.getAll("documents").filter(d => d instanceof File && d.size > 0) as File[];
    if (documents.length > 5) return fail("Attach up to five documents; none have been submitted.");
    if (form.get("authorized") !== "on") return fail("Please confirm you are authorized to share this application and data.");
    if (!(repo instanceof File) || repo.size === 0) return fail("Please attach the source code as a .zip file.");
    const uploaded: string[] = [];
    const save = async (file: File, max: number) => { const saved = await saveUpload(file, max); uploaded.push(saved); return saved; };
    try {
    const repoPath = await save(repo, 150 * 1024 * 1024);
    const demo = form.get("demo") === "on";
    const dbPath = db instanceof File && db.size > 0 ? await save(db, 500 * 1024 * 1024) : null;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
    const docs: { file: string; name: string }[] = [];
    for (const d of documents) {
      if (d instanceof File && d.size > 0) docs.push({ file: await save(d, 20 * 1024 * 1024), name: d.name });
    }
    const allowed = ["keep_framework", "keep_database", "keep_api", "keep_connections", "no_data"];
    const constraints = form.getAll("constraints").map(String).filter((c) => allowed.includes(c));
    const { id, token } = await createJob({
      accountName: business, contactName: contact, contactEmail: email,
      kind: demo ? "demo" : "real", acquiredVia: demo ? "Website form (demonstration, synthetic business)" : "Website form", title, slug,
      timezone,
      repoZip: repoPath, dbFile: dbPath, goal, constraints, constraintNotes: notes || null, documents: docs,
      migrationRequest: target ? { target, dataChanges } : undefined,
      workspaceRequest: jobType === "workspace", inquiryPublicId: inquiry || undefined,
    });
    return json({ id, t: token });
    } finally {
      for (const file of uploaded) fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
}
