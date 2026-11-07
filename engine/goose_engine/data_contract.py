"""Declarative SQLite changes, applied transactionally to a copy. No customer SQL is executed.

This file is also shipped as migrate.py in replatform deliveries (standard library only).
Re-running the same contract is a no-op; a different contract cannot reuse its migration id.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile


def ident(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,62}", value):
        raise ValueError(f"Invalid SQL identifier: {value!r}")
    return '"' + value + '"'


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, (int, float)):
        if not __import__('math').isfinite(value):
            raise ValueError("Non-finite default")
        return str(value)
    if isinstance(value, str) and len(value) <= 10000:
        return "'" + value.replace("'", "''") + "'"
    raise ValueError("Defaults must be scalar values")


def column(c, added=False):
    name = ident(c["name"])
    typ = c["type"]
    if typ not in ("TEXT", "INTEGER", "REAL", "BLOB"):
        raise ValueError("Column type must be TEXT, INTEGER, REAL or BLOB")
    sql = f"{name} {typ}"
    if c.get("primary_key"):
        if added or typ != "INTEGER":
            raise ValueError("Only new INTEGER primary keys are supported")
        sql += " PRIMARY KEY AUTOINCREMENT"
    if c.get("required"):
        sql += " NOT NULL"
        if added and c.get("default") is None:
            raise ValueError("An added required field needs a non-null backfill/default")
    if "default" in c:
        sql += " DEFAULT " + literal(c["default"])
    if c.get("unique"):
        if added:
            raise ValueError("Adding unique fields needs a separately reviewed backfill")
        sql += " UNIQUE"
    if c.get("references"):
        r = c["references"]
        sql += f" REFERENCES {ident(r['table'])}({ident(r['column'])})"
    return sql


def apply(db, contract):
    changes = contract.get("data_changes", [])
    digest = hashlib.sha256(json.dumps(changes, sort_keys=True, allow_nan=False).encode()).hexdigest()
    migration_id = contract["id"]
    if not isinstance(migration_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", migration_id):
        raise ValueError("Invalid migration id")
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("CREATE TABLE IF NOT EXISTS _goose_migrations (id TEXT PRIMARY KEY, digest TEXT NOT NULL)")
        prior = db.execute("SELECT digest FROM _goose_migrations WHERE id=?", (migration_id,)).fetchone()
        if prior:
            if prior[0] != digest:
                raise ValueError("Migration id already used by a different contract")
            db.rollback()
            return {"applied": False, "id": migration_id, "digest": digest}
        for change in changes:
            table = ident(change["table"])
            op = change["op"]
            if op == "add_column":
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column(change['column'], added=True)}")
            elif op == "rename_column":
                db.execute(f"ALTER TABLE {table} RENAME COLUMN {ident(change['from'])} TO {ident(change['to'])}")
            elif op == "create_table":
                cols = change["columns"]
                if not cols or len(cols) > 100 or sum(bool(c.get('primary_key')) for c in cols) != 1:
                    raise ValueError("New tables need exactly one INTEGER primary key")
                db.execute(f"CREATE TABLE {table} ({', '.join(column(c) for c in cols)})")
            elif op == "insert_rows":
                for row in change["rows"]:
                    if not row:
                        raise ValueError("Empty seed row")
                    cols = ', '.join(ident(k) for k in row)
                    db.execute(f"INSERT INTO {table} ({cols}) VALUES ({', '.join('?' for _ in row)})", list(row.values()))
            else:
                raise ValueError(f"Unsupported data operation: {op}")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Migration broke a foreign key")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Migration failed SQLite integrity checks")
        db.execute("INSERT INTO _goose_migrations VALUES (?, ?)", (migration_id, digest))
        db.commit()
        return {"applied": True, "id": migration_id, "digest": digest}
    except Exception:
        db.rollback()
        raise


def migrate(source, output, contract):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output or output.exists():
        raise ValueError("Output must be a new file; the source and existing destinations are never overwritten")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".migration-", dir=output.parent)
    os.close(fd)
    try:
        # SQLite backup includes committed WAL content and takes a consistent snapshot.
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(tmp) as dst:
            src.backup(dst)
            result = apply(dst, contract)
        # Hard-link publication fails if another writer created output while we were working.
        os.link(tmp, output)
        return result
    finally:
        os.unlink(tmp)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--contract", required=True)
    a = p.parse_args()
    print(json.dumps(migrate(a.source, a.out, json.loads(Path(a.contract).read_text()))))


if __name__ == "__main__":
    main()
