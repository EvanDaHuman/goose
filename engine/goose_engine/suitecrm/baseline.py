"""Build the reference baseline of a pristine SuiteCRM install (no customizations, no data), so inspection can tell
what the customer added from what SuiteCRM's installer creates.

    python -m goose_engine.suitecrm.baseline --root PRISTINE_DIR --meta pristine-meta.json --db pw_baseline_7_11_23 --out baseline.json
"""
import argparse
import hashlib
import json
from pathlib import Path

from . import db as D


def md5(p):
    return hashlib.md5(p.read_bytes()).hexdigest()


def build(root, meta, dbname):
    root = Path(root)
    custom = {str(p.relative_to(root)): md5(p) for p in sorted((root / "custom").rglob("*")) if p.is_file()}
    # every PHP file of the release source outside vendor/ and custom/ (the GitHub source has a few files that files.md5 omits)
    source = sorted(str(p.relative_to(root)) for p in root.rglob("*.php")
                    if not str(p.relative_to(root)).startswith(("vendor/", "custom/", "cache/", "upload/")))
    conn = D.connect(dbname)
    fmd = sorted(r["id"] for r in D.rows(conn, "SELECT id FROM fields_meta_data WHERE deleted = 0"))
    cols = {}
    for r in D.rows(conn, "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = %s", (dbname,)):
        cols.setdefault(r["t"], []).append(r["c"])
    rel = sorted(r["relationship_name"] for r in D.rows(conn, "SELECT relationship_name FROM relationships WHERE deleted = 0"))
    acl = D.scalar(conn, "SELECT COUNT(*) FROM acl_actions WHERE deleted = 0")
    return {
        "suitecrm_version": meta["suitecrm_version"],
        "custom_files": custom,
        "source_files": source,
        "hooks": sorted({f"{h['module']}|{h['event']}|{h['label']}|{h['file']}" for h in meta["hooks"]}),
        "fields_meta_data": fmd,
        "tables": {k: sorted(v) for k, v in sorted(cols.items())},
        "relationships": rel,
        "acl_actions": acl,
        "lists": meta["lists"],
        "config": meta["config"],
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--meta", required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    b = build(a.root, json.loads(Path(a.meta).read_text()), a.db)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(b, indent=1, sort_keys=True))
    print(json.dumps({"custom_files": len(b["custom_files"]), "hooks": len(b["hooks"]), "fields": len(b["fields_meta_data"]),
                      "tables": len(b["tables"]), "relationships": len(b["relationships"])}))


if __name__ == "__main__":
    main()
