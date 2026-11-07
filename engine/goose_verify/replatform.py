"""Independent row oracle for a language migration. Does not import the migration engine.

Every cell is compared, including NULLs, blobs, Unicode, identifiers and relationships.
Expected values are projected in memory, never by running the delivery's migration SQL.
"""
import argparse
import base64
import json
from pathlib import Path
import sqlite3


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def cell(v):
    if isinstance(v, bytes):
        return {"blob_base64": base64.b64encode(v).decode()}
    if isinstance(v, int) and abs(v) > 9007199254740991:
        return {"integer_decimal": str(v)}
    return v


def snapshot(file):
    db = sqlite3.connect(Path(file).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        tables = {}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_goose_migrations' ORDER BY name"):
            tables[name] = {
                "columns": [dict(r) for r in db.execute(f"PRAGMA table_info({quote(name)})")],
                "foreign_keys": [dict(r) for r in db.execute(f"PRAGMA foreign_key_list({quote(name)})")],
                "unique_keys": sorted([list(x["name"] for x in db.execute(f"PRAGMA index_info({quote(idx['name'])})"))
                                       for idx in db.execute(f"PRAGMA index_list({quote(name)})") if idx["unique"]]),
                "rows": [{k: cell(v) for k, v in dict(r).items()} for r in db.execute(f"SELECT * FROM {quote(name)}")],
            }
        sequences = dict(db.execute("SELECT name,seq FROM sqlite_sequence")) if db.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else {}
        return {"tables": tables, "sequences": sequences, "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
                "foreign_key_errors": [list(r) for r in db.execute("PRAGMA foreign_key_check")]}
    finally:
        db.close()


def expected(source, changes):
    tables = json.loads(json.dumps(source["tables"]))
    def default_value(col):
        if "default" not in col:
            return None
        v = col["default"]
        if v is None:
            return "NULL"
        if isinstance(v, str):
            return "'" + v.replace("'", "''") + "'"
        return str(int(v)) if isinstance(v, bool) else str(v)
    for c in changes:
        op, name = c["op"], c["table"]
        if op == "create_table":
            if name in tables:
                raise ValueError("New table already exists")
            tables[name] = {"columns": [{"name": x["name"], "type": x["type"], "pk": int(x.get("primary_key", False)), "dflt_value": default_value(x),
                                        "notnull": int(x.get("required", False))} for x in c["columns"]], "rows": [], "foreign_keys": [],
                            "unique_keys": sorted([[x["name"]] for x in c["columns"] if x.get("unique")])}
            for x in c["columns"]:
                if x.get("references"):
                    tables[name]["foreign_keys"].append({"table": x["references"]["table"], "from": x["name"], "to": x["references"]["column"], "on_update": "NO ACTION", "on_delete": "NO ACTION", "match": "NONE"})
        elif op == "add_column":
            col = c["column"]
            if any(x["name"] == col["name"] for x in tables[name]["columns"]):
                raise ValueError("Added column already exists")
            tables[name]["columns"].append({"name": col["name"], "type": col["type"], "pk": 0, "notnull": int(col.get("required", False)), "dflt_value": default_value(col)})
            if col.get("references"):
                tables[name]["foreign_keys"].append({"table": col["references"]["table"], "from": col["name"], "to": col["references"]["column"], "on_update": "NO ACTION", "on_delete": "NO ACTION", "match": "NONE"})
            for row in tables[name]["rows"]:
                row[col["name"]] = col.get("default")
        elif op == "rename_column":
            for col in tables[name]["columns"]:
                if col["name"] == c["from"]:
                    col["name"] = c["to"]
            for row in tables[name]["rows"]:
                row[c["to"]] = row.pop(c["from"])
            tables[name]["unique_keys"] = sorted([[c["to"] if x == c["from"] else x for x in key] for key in tables[name]["unique_keys"]])
            for tn, t in tables.items():
                for fk in t["foreign_keys"]:
                    if tn == name and fk["from"] == c["from"]:
                        fk["from"] = c["to"]
                    if fk["table"] == name and fk["to"] == c["from"]:
                        fk["to"] = c["to"]
        elif op == "insert_rows":
            # Seed rows must give every field explicitly so their meaning is reviewable.
            names = {x["name"] for x in tables[name]["columns"]}
            for row in c["rows"]:
                if set(row) != names:
                    raise ValueError("Seed rows must specify every column, including their id")
                tables[name]["rows"].append(row)
        else:
            raise ValueError(f"Unknown operation {op}")
    return tables


def compare(source, target, changes):
    want = expected(source, changes)
    problems = []
    sequences = dict(source.get("sequences", {}))
    auto_tables = set(sequences)
    for c in changes:
        if c["op"] == "create_table":
            auto_tables.add(c["table"])
        if c["op"] == "insert_rows" and c["table"] in auto_tables:
            pk = next(x["name"] for x in want[c["table"]]["columns"] if x["pk"])
            for row in c["rows"]:
                sequences[c["table"]] = max(sequences.get(c["table"], 0), row[pk])
    if sequences != target.get("sequences", {}):
        problems.append("Auto-increment sequences differ; future record identifiers could be reused or changed")
    if target["integrity"] != "ok" or target["foreign_key_errors"]:
        problems.append("Target database integrity or foreign key check failed")
    if set(want) != set(target["tables"]):
        problems.append("Unexpected missing or extra tables")
    canonical = lambda rows: sorted(json.dumps(r, sort_keys=True, ensure_ascii=False) for r in rows)
    for name, table in want.items():
        got = target["tables"].get(name)
        if not got:
            problems.append(f"Missing table {name}")
            continue
        cols = lambda cs: [(x['name'], x['type'].upper(), x['pk'], x['notnull'], x.get('dflt_value')) for x in cs]
        if cols(table["columns"]) != cols(got["columns"]):
            problems.append(f"{name}: schema differs from the approved contract")
        if canonical(table["rows"]) != canonical(got["rows"]):
            problems.append(f"{name}: row values differ (expected {len(table['rows'])}, actual {len(got['rows'])})")
        fks = lambda fs: sorted(tuple(f[k] for k in ("table", "from", "to", "on_update", "on_delete", "match")) for f in fs)
        if fks(table["foreign_keys"]) != fks(got["foreign_keys"]):
            problems.append(f"{name}: foreign key definitions changed")
        if table["unique_keys"] != got["unique_keys"]:
            problems.append(f"{name}: unique constraints changed")
    return problems


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--source")
    p.add_argument("--contract")
    a = p.parse_args()
    result = snapshot(a.db)
    if a.source:
        c = json.loads(Path(a.contract).read_text())
        result = {"problems": compare(snapshot(a.source), result, c["data_changes"]), "tables": result["tables"]}
    Path(a.out).write_text(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
