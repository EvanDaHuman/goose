import { createJob } from "@/lib/jobs";
import { fail, json, saveUpload, wrap } from "@/lib/http";

// A real customer submits a repository (and usually a database copy).
export async function POST(req: Request) {
  return wrap(async () => {
    const form = await req.formData();
    const repo = form.get("repository");
    const db = form.get("database");
    if (form.get("authorized") !== "on") return fail("Please confirm you are authorized to share this application and data.");
    if (!(repo instanceof File) || repo.size === 0) return fail("Please attach the source code as a .zip file.");
    const repoPath = await saveUpload(repo, 150 * 1024 * 1024);
    const demo = form.get("demo") === "on";
    const dbPath = db instanceof File && db.size > 0 ? await saveUpload(db, 500 * 1024 * 1024) : null;
    const title = String(form.get("title") ?? "Application").slice(0, 120);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
    const docs: { file: string; name: string }[] = [];
    for (const d of form.getAll("documents").slice(0, 5)) {
      if (d instanceof File && d.size > 0) docs.push({ file: await saveUpload(d, 20 * 1024 * 1024), name: d.name });
    }
    const goal = String(form.get("goal") ?? "").trim().slice(0, 2000);
    if (!goal) return fail("Please tell us what you want to improve.");
    const allowed = ["keep_framework", "keep_database", "keep_api", "keep_connections", "no_data"];
    const constraints = form.getAll("constraints").map(String).filter((c) => allowed.includes(c));
    const target = String(form.get("target_runtime") ?? "").trim().slice(0, 60).toLowerCase();
    const dataChanges = String(form.get("data_changes") ?? "").trim().slice(0, 4000);
    if (dataChanges && !target) return fail("Choose a target runtime for a migration with data changes.");
    const { id, token } = await createJob({
      accountName: String(form.get("business") ?? "").slice(0, 120) || "Unnamed business",
      contactName: String(form.get("contact") ?? "").slice(0, 120), contactEmail: String(form.get("email") ?? "").slice(0, 200),
      kind: demo ? "demo" : "real", acquiredVia: demo ? "Website form (demonstration, synthetic business)" : "Website form", title, slug,
      timezone: String(form.get("timezone") ?? "UTC"),
      repoZip: repoPath, dbFile: dbPath, goal, constraints, constraintNotes: String(form.get("notes") ?? "").slice(0, 2000) || null, documents: docs,
      migrationRequest: target ? { target, dataChanges } : undefined,
    });
    return json({ id, t: token });
  });
}
