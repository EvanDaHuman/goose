"""Move the data from the old SQLite file into PostgreSQL. Safe to run more than once.

    python migrate/migrate_data.py --sqlite /path/to/old.db --database-url postgresql://...

What it does
  1. Reads migrate/plan.json: the tables in dependency order and how each column is converted.
  2. Copies rows in primary-key order, in batches. Each batch is saved together with a ledger
     row in one transaction, so a run that is interrupted resumes after the last saved batch and
     never copies a row twice. Running it again after it finished changes nothing.
  3. Moves the id counters past every id the old database ever handed out, so new records never
     reuse an old id.
  4. Prints a JSON summary with row counts.

It opens the SQLite file read-only and refuses to resume from a different SQLite file than the
one the first run used.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
from psycopg.types.json import Jsonb

PLAN = json.loads((Path(__file__).resolve().parent / "plan.json").read_text())
CENT = Decimal("0.01")
ZONE = ZoneInfo(PLAN["timezone"])
FOLD = 1 if PLAN.get("ambiguous_time_rule", "later") == "later" else 0


def to_money(value):
    """REAL money to exact cents, rounding half up (19.989999999999998 -> 19.99)."""
    if value is None:
        return None
    return Decimal(repr(float(value))).quantize(CENT, rounding=ROUND_HALF_UP)


def to_local_timestamp(value, zone=None):
    """Text in shop time ('2021-03-04 10:22:31' or '2021-03-04T10:22:31') to an exact instant.
    A column SQLite filled with CURRENT_TIMESTAMP is UTC; the plan says so with "zone": "UTC"."""
    if value is None:
        return None
    if zone:
        naive = datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S") if " " in str(value) else datetime.fromisoformat(str(value))
        return naive.replace(tzinfo=ZoneInfo(zone))
    for fmt in PLAN["datetime_formats"]:
        try:
            naive = datetime.strptime(value, fmt)
            break
        except ValueError:
            continue
    else:
        raise ValueError(f"unreadable timestamp: {value!r}")
    return naive.replace(tzinfo=ZONE, fold=FOLD)


def to_local_date(value):
    if value is None:
        return None
    return datetime.strptime(value[:10], "%Y-%m-%d").date()


CONVERTERS = {
    "int": lambda v: None if v is None else int(v),
    "float": lambda v: None if v is None else float(v),
    "text": lambda v: None if v is None else str(v),
    "bytes": lambda v: None if v is None else bytes(v),
    "money": to_money,
    "local_timestamp": to_local_timestamp,
    "local_date": to_local_date,
}


def convert(column, value):
    if column["convert"] == "local_timestamp" and column.get("zone"):
        value = to_local_timestamp(value, column["zone"])
    else:
        value = CONVERTERS[column["convert"]](value)
    mapping = column.get("map")
    if mapping and value in mapping:
        value = mapping[value]
    return value


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def log(**fields):
    print(json.dumps(fields, default=str), flush=True)


def ensure_ledger(pg):
    pg.execute("""
        CREATE TABLE IF NOT EXISTS goose_migration_batches (
            table_name TEXT NOT NULL,
            batch_no INTEGER NOT NULL,
            first_key BIGINT,
            last_key BIGINT,
            row_count INTEGER NOT NULL,
            checksum TEXT NOT NULL,
            migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (table_name, batch_no)
        )""")
    pg.execute("""
        CREATE TABLE IF NOT EXISTS goose_migration_runs (
            run_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at TIMESTAMPTZ,
            source_sha256 TEXT NOT NULL,
            status TEXT NOT NULL,
            summary JSONB
        )""")
    pg.commit()


def migrate(sqlite_path, database_url, batch_size):
    source_sha = sha256_file(sqlite_path)
    src = sqlite3.connect(f"file:{Path(sqlite_path).resolve()}?mode=ro", uri=True)
    pg = psycopg.connect(database_url)
    pg.execute("SELECT set_config('TimeZone', %s, false)", (PLAN["timezone"],))
    ensure_ledger(pg)
    first = pg.execute("SELECT source_sha256 FROM goose_migration_runs ORDER BY run_id LIMIT 1").fetchone()
    if first and first[0] != source_sha and not os.environ.get("GOOSE_ALLOW_CHANGED_SOURCE"):
        log(event="refused", reason="This database already holds data from a different SQLite file.",
            first_source_sha256=first[0], this_source_sha256=source_sha)
        return 2
    run_id = pg.execute("INSERT INTO goose_migration_runs (source_sha256, status) VALUES (%s, 'running') "
                        "RETURNING run_id", (source_sha,)).fetchone()[0]
    pg.commit()
    throttle = int(os.environ.get("GOOSE_TEST_THROTTLE_MS", "0")) / 1000.0   # test hook only
    stop_after = os.environ.get("GOOSE_TEST_STOP_AFTER_TABLE")                 # test hook only
    summary = {"run_id": run_id, "tables": {}, "placeholders": 0}

    for t in PLAN["tables"]:
        name, pk = t["name"], t.get("pk")
        cols = t["columns"]
        col_names = [c["name"] for c in cols]
        done = pg.execute("SELECT batch_no, last_key FROM goose_migration_batches WHERE table_name = %s "
                          "ORDER BY batch_no DESC LIMIT 1", (name,)).fetchone()
        batch_no = done[0] + 1 if done else 0
        last_key = done[1] if done else None
        skipped = batch_no
        placeholder_rows = [p for p in PLAN.get("placeholders", []) if p["table"] == name]
        if placeholder_rows:
            for p in placeholder_rows:
                keys = list(p["values"])
                pg.execute(
                    f'INSERT INTO "{name}" ({", ".join(chr(34) + k + chr(34) for k in keys)}) '
                    f'VALUES ({", ".join(["%s"] * len(keys))}) ON CONFLICT DO NOTHING',
                    [p["values"][k] for k in keys])
            pg.commit()
            summary["placeholders"] += len(placeholder_rows)
        order_col = pk or "rowid"
        insert_sql = (f'INSERT INTO "{name}" ({", ".join(chr(34) + c + chr(34) for c in col_names)}) '
                      f'VALUES ({", ".join(["%s"] * len(col_names))})'
                      + (f' ON CONFLICT ("{pk}") DO NOTHING' if pk else ""))
        copied = 0
        while True:
            where = f'WHERE "{order_col}" > ?' if last_key is not None else ""
            rows = src.execute(
                f'SELECT {", ".join(chr(34) + c + chr(34) for c in col_names)}, "{order_col}" FROM "{name}" '
                f'{where} ORDER BY "{order_col}" LIMIT ?',
                ([last_key] if last_key is not None else []) + [batch_size]).fetchall()
            if not rows:
                break
            skip = t.get("skip_values") or {}
            kept = [r for r in rows
                    if not any(r[col_names.index(k)] in vs for k, vs in skip.items())]
            values = [[convert(c, r[i]) for i, c in enumerate(cols)] for r in kept]
            digest = hashlib.sha256(json.dumps(values, default=str).encode("utf-8")).hexdigest()
            with pg.cursor() as cur:
                if values:
                    cur.executemany(insert_sql, values)
                cur.execute("INSERT INTO goose_migration_batches (table_name, batch_no, first_key, last_key, "
                            "row_count, checksum) VALUES (%s, %s, %s, %s, %s, %s)",
                            (name, batch_no, rows[0][-1], rows[-1][-1], len(values), digest))
            pg.commit()
            copied += len(values)
            last_key = rows[-1][-1]
            batch_no += 1
            if throttle:
                time.sleep(throttle)
        source_rows = src.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        target_rows = pg.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        summary["tables"][name] = {"source_rows": source_rows, "target_rows": target_rows,
                                   "copied_this_run": copied, "batches_already_done": skipped}
        log(event="table.done", table=name, **summary["tables"][name])
        if stop_after == name:
            log(event="test.stop", after_table=name)
            os._exit(75)

    for t in PLAN["tables"]:
        if not t.get("identity"):
            continue
        name, pk = t["name"], t["pk"]
        floor = t.get("sequence_floor") or 0
        pg.execute(f"""SELECT setval(pg_get_serial_sequence('"{name}"', '{pk}'),
                       GREATEST(COALESCE((SELECT MAX("{pk}") FROM "{name}"), 0), %s, 1), true)""", (floor,))
    pg.commit()
    pg.execute("ANALYZE")
    pg.commit()
    summary["status"] = "complete"
    pg.execute("UPDATE goose_migration_runs SET finished_at = now(), status = 'complete', summary = %s "
               "WHERE run_id = %s", (Jsonb(summary), run_id))
    pg.commit()
    log(event="migration.complete", **summary)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sqlite", required=True, help="path to the old SQLite database file")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"), help="PostgreSQL connection URL")
    ap.add_argument("--batch-size", type=int, default=500)
    a = ap.parse_args()
    if not a.database_url:
        ap.error("--database-url or DATABASE_URL is required")
    sys.exit(migrate(a.sqlite, a.database_url, a.batch_size))


if __name__ == "__main__":
    main()
