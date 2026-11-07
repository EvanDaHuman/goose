"""Freeze the acceptance checks before any code is changed.

The vault holds: the accepted scope, the scenario, the original application's recorded answers,
the expected data computed from the untouched database snapshot, the list of checks, and a
manifest of SHA-256 hashes of every vault file and of the verifier's own source files. The
company database keeps the manifest's hash; verification refuses to run if anything changed.
"""
import shutil
from datetime import datetime, timezone
from pathlib import Path

from .common import cents, local_to_utc, sha256_file, sqlite_ro, write_json, read_json

VERIFIER_DIR = Path(__file__).resolve().parent


def normalise_source(value, conv, scope, col_full):
    if value is None:
        return None
    if conv == "money":
        return str(cents(value))
    if conv == "timestamp":
        zone = (scope.get("timestamp_zones") or {}).get(col_full, scope["timezone"])
        return local_to_utc(value, zone, scope["datetime_input_formats"], scope["ambiguous_time_rule"])
    if conv == "date":
        return str(value)[:10]
    if conv == "int":
        return int(value)
    if conv == "float":
        return float(value)
    v = str(value) if not isinstance(value, bytes) else value.hex()
    mp = scope["status_mappings"].get(col_full)
    return mp.get(v, v) if mp else v


def column_kind(table, col, scope):
    full = f"{table}.{col['name']}"
    if full in scope["money_columns"]:
        return "money"
    if full in scope["timestamp_columns"]:
        return "timestamp"
    if full in scope["date_columns"]:
        return "date"
    t = col["decl_type"]
    if "INT" in t or t in ("BOOLEAN", "BOOL"):
        return "int"
    if t in ("REAL", "FLOAT", "DOUBLE"):
        return "float"
    return "text"


def expected_data(assessment, scope, source_db):
    conn = sqlite_ro(source_db)
    roles = scope["roles"]
    out = {"tables": {}, "relationships": [], "same_name": [], "status_counts": {}, "ambiguous": [],
           "placeholders": [], "removed": []}
    removed = {(o["table"], o["column"]): set(o["missing_ids"]) for o in scope["orphan_decisions"]
               if o["decision"] == "remove"}
    for t, info in assessment["tables"].items():
        pk = next((c["name"] for c in info["columns"] if c["pk"]), None)
        kinds = {c["name"]: column_kind(t, c, scope) for c in info["columns"]}
        rows = {}
        for r in conn.execute(f'SELECT * FROM "{t}"'):
            d = dict(r)
            if any(d.get(col) in ids for (tt, col), ids in removed.items() if tt == t):
                out["removed"].append({"table": t, "pk": d.get(pk)})
                continue
            rows[str(d[pk])] = {c: normalise_source(d[c], kinds[c], scope, f"{t}.{c}") for c in d}
        out["tables"][t] = {"pk": pk, "kinds": kinds, "count": len(rows), "rows": rows,
                            "sequence_floor": max(info.get("sqlite_sequence") or 0, info.get("max_id") or 0),
                            "notnull": [c["name"] for c in info["columns"] if c["notnull"] and not c["pk"]],
                            "unique": [ix["columns"] for ix in info.get("indexes", []) if ix["unique"]]}
        for fk in info["foreign_keys"]:
            unlinked = any(o["table"] == t and o["column"] == fk["column"] and o["decision"] == "keep_unlinked"
                           for o in scope["orphan_decisions"])
            out["relationships"].append({"child": t, "column": fk["column"], "parent": fk["ref_table"],
                                         "parent_column": fk["ref_column"], "enforced": not unlinked})
    for o in scope["orphan_decisions"]:
        if o["decision"] == "placeholder":
            ref_table = o["references"].split(".")[0]
            for p in o["placeholders"]:
                kinds = out["tables"][ref_table]["kinds"]
                norm = {k: (str(cents(v)) if kinds.get(k) == "money" else v) for k, v in p.items()}
                out["placeholders"].append({"table": ref_table, "values": norm})
                out["tables"][ref_table]["count"] += 1
    if roles.get("customer") and roles.get("customer_name_column"):
        name_col, email_col = roles["customer_name_column"], roles.get("customer_email_column")
        for d in roles.get("same_name_customers", []):
            people = []
            for r in conn.execute(f'SELECT * FROM "{roles["customer"]}" WHERE "{name_col}" = ? ORDER BY id', (d["name"],)):
                orders = []
                if roles.get("order") and roles.get("order_customer_fk"):
                    orders = [x[0] for x in conn.execute(
                        f'SELECT id FROM "{roles["order"]}" WHERE "{roles["order_customer_fk"]}" = ? ORDER BY id', (r["id"],))]
                people.append({"id": r["id"], "email": r[email_col] if email_col else None, "orders": orders})
            out["same_name"].append({"name": d["name"], "customers": people})
    for col, mp in scope["status_mappings"].items():
        t, c = col.split(".")
        counts = {}
        for v, n in conn.execute(f'SELECT "{c}", COUNT(*) FROM "{t}" GROUP BY 1'):
            counts[mp.get(v, v)] = counts.get(mp.get(v, v), 0) + n
        out["status_counts"][col] = counts
    for a in assessment.get("ambiguous_times", []):
        t, c = a["column"].split(".")
        for r in conn.execute(f'SELECT id FROM "{t}" WHERE "{c}" = ?', (a["value"],)):
            out["ambiguous"].append({"table": t, "id": r[0], "column": c, "local": a["value"],
                                     "rule": scope["ambiguous_time_rule"],
                                     "utc": local_to_utc(a["value"], scope["timezone"], scope["datetime_input_formats"],
                                                         scope["ambiguous_time_rule"])})
    conn.close()
    return out


CHECKS = [
    # phase, id prefix, category, plain-English title
    ("data", "records.count", "records", "Every table has the expected number of rows"),
    ("data", "records.fields", "records", "Every row's fields match the original after the agreed conversions"),
    ("data", "records.placeholders", "records", "Agreed placeholder records exist"),
    ("data", "relationships", "relationships", "Links between records are unchanged and enforced"),
    ("data", "customers.same_name", "same_name", "Customers who share a name stay separate with their own orders"),
    ("data", "statuses.meaning", "dates_statuses", "Status counts keep their meaning"),
    ("data", "dates.ambiguous_rule", "dates_statuses", "Daylight-saving timestamps follow the agreed rule"),
    ("data", "sequences.next_ids", "read_update", "New records will get ids above every id the old app used"),
    ("data", "schema.constraints", "records", "Primary keys, required fields and unique codes are enforced"),
    ("data", "migration.ledger", "migration_retry", "The data move finished and recorded every batch"),
    ("retry", "migration.retry", "migration_retry", "Running the data move again changes nothing"),
    ("behavior", "app.starts", "app_starts", "The upgraded app starts and answers"),
    ("behavior", "compat", "compatibility", "Old and new app give the same answers to the same requests"),
    ("behavior", "money", "money", "Totals follow the agreed discount and rounding rule"),
    ("behavior", "stock", "stock", "Stock moves correctly when orders are placed, refused and cancelled"),
    ("behavior", "retries", "retries", "Repeated requests do not create duplicates or restore stock twice"),
    ("behavior", "read_update", "read_update", "Records that came across can be read and changed"),
    ("behavior", "concurrency", "stock", "Orders arriving at the same time cannot oversell stock"),
    ("behavior", "dates.api_format", "dates_statuses", "Dates in responses use the agreed format and shop time"),
    ("fresh", "package", "app_starts", "The delivered package installs, starts on an empty database and works"),
]


def freeze(vault, assessment_path, scope_path, scenario_path, baseline_path, source_db, job_id):
    vault = Path(vault)
    vault.mkdir(parents=True, exist_ok=True)
    assessment, scope = read_json(assessment_path), read_json(scope_path)
    shutil.copy(scope_path, vault / "scope.json")
    shutil.copy(scenario_path, vault / "scenario.json")
    shutil.copy(baseline_path, vault / "baseline.json")
    write_json(vault / "assessment.json", assessment)
    write_json(vault / "expected_data.json", expected_data(assessment, scope, source_db))
    write_json(vault / "checks.json", [{"phase": p, "id": i, "category": c, "title": t} for p, i, c, t in CHECKS])
    files = {p.name: sha256_file(p) for p in sorted(vault.glob("*.json")) if p.name != "MANIFEST.json"}
    code = {p.name: sha256_file(p) for p in sorted(VERIFIER_DIR.glob("*.py"))}
    manifest = {"job_id": job_id, "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source_db_sha256": sha256_file(source_db), "files": files, "verifier_code": code}
    write_json(vault / "MANIFEST.json", manifest)
    for p in vault.glob("*.json"):
        p.chmod(0o444)
    return sha256_file(vault / "MANIFEST.json"), manifest


def check_integrity(vault, expected_manifest_sha):
    """Recompute every hash. Returns (ok, problems)."""
    vault = Path(vault)
    problems = []
    mpath = vault / "MANIFEST.json"
    if not mpath.exists():
        return False, ["MANIFEST.json is missing"]
    actual = sha256_file(mpath)
    if expected_manifest_sha and actual != expected_manifest_sha:
        problems.append(f"MANIFEST.json changed: recorded {expected_manifest_sha[:12]}..., found {actual[:12]}...")
    manifest = read_json(mpath)
    for name, sha in manifest["files"].items():
        p = vault / name
        if not p.exists():
            problems.append(f"{name} is missing")
        elif sha256_file(p) != sha:
            problems.append(f"{name} was modified after the checks were frozen")
    for name, sha in manifest["verifier_code"].items():
        p = VERIFIER_DIR / name
        if not p.exists() or sha256_file(p) != sha:
            problems.append(f"verifier source {name} differs from the frozen version")
    extra = {p.name for p in vault.glob("*.json")} - set(manifest["files"]) - {"MANIFEST.json"}
    if extra:
        problems.append(f"unexpected files in the vault: {sorted(extra)}")
    return not problems, problems
