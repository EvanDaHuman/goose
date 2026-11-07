"""Data checks: compare every migrated row with what the untouched snapshot says it must be."""
import hashlib
import json
from datetime import date, datetime
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row

from .common import CENT, UTC, read_json


def norm_target(value, kind):
    if value is None:
        return None
    if kind == "money":
        return str(Decimal(value).quantize(CENT))
    if kind == "timestamp":
        if isinstance(value, datetime):
            return value.astimezone(UTC).isoformat()
        return str(value)
    if kind == "date":
        return value.isoformat() if isinstance(value, (date, datetime)) else str(value)[:10]
    if kind == "int":
        return int(value)
    if kind == "float":
        return float(value)
    if isinstance(value, (bytes, memoryview)):
        return bytes(value).hex()
    return str(value)


def result(check_id, category, title, passed, expected=None, actual=None, evidence=None, skipped=False, mandatory=True, reason=None):
    """One check's outcome. Every check is mandatory unless it says otherwise; a skipped mandatory check fails the run,
    and an optional skip must carry its reason."""
    r = {"id": check_id, "category": category, "title": title, "mandatory": mandatory,
         "status": "skip" if skipped else ("pass" if passed else "fail"),
         "expected": expected, "actual": actual, "evidence": evidence or {}}
    if reason:
        r["reason"] = reason
    return r


def _stable(v):
    if isinstance(v, datetime):
        return v.astimezone(UTC).isoformat() if v.tzinfo else v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (bytes, memoryview)):
        return bytes(v).hex()
    return v


def table_digest(conn, table, pk):
    """Row count and a hash of every row, independent of the session's time zone."""
    h = hashlib.sha256()
    n = 0
    with conn.cursor() as cur:
        cur.execute(f'SELECT * FROM "{table}" ORDER BY "{pk}"')
        for row in cur:
            h.update(json.dumps([_stable(v) for v in row], default=str).encode("utf-8"))
            n += 1
    return n, h.hexdigest()


def run_data(vault, dsn):
    exp = read_json(f"{vault}/expected_data.json")
    scope = read_json(f"{vault}/scope.json")
    out = []
    conn = psycopg.connect(dsn)
    conn.execute("SELECT set_config('TimeZone', %s, false)", (scope["timezone"],))
    existing = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")}
    for t, info in exp["tables"].items():
        if t not in existing:
            out.append(result(f"records.count.{t}", "records", f"{t}: table exists", False, t, "missing"))
            continue
        n = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        out.append(result(f"records.count.{t}", "records", f"{t}: {info['count']} rows arrived",
                          n == info["count"], info["count"], n))
        pk, kinds = info["pk"], info["kinds"]
        mismatches, missing = [], []
        target = {}
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(f'SELECT * FROM "{t}"')
            for row in cur:
                target[str(row[pk])] = row
        for key, expected_row in info["rows"].items():
            got = target.get(key)
            if got is None:
                missing.append(key)
                continue
            for col, ev in expected_row.items():
                av = norm_target(got.get(col), kinds[col])
                if ev != av:
                    mismatches.append({"pk": key, "column": col, "expected": ev, "actual": av})
        cols = len(next(iter(info["rows"].values()), {}))
        out.append(result(f"records.fields.{t}", "records",
                          f"{t}: every field of every row matches ({len(info['rows'])} rows x {cols} columns)",
                          not mismatches and not missing,
                          "0 differences", f"{len(mismatches)} differences, {len(missing)} rows missing",
                          {"examples": mismatches[:8], "missing_examples": missing[:8],
                           "by_column": _by_column(mismatches)}))
    for p in exp["placeholders"]:
        t = p["table"]
        pkcol = exp["tables"][t]["pk"]
        row = None
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(f'SELECT * FROM "{t}" WHERE "{pkcol}" = %s', (p["values"][pkcol],))
            row = cur.fetchone()
        ok = row is not None and all(norm_target(row.get(k), exp["tables"][t]["kinds"].get(k, "text")) ==
                                     (str(v) if exp["tables"][t]["kinds"].get(k) == "money" else v)
                                     for k, v in p["values"].items())
        out.append(result(f"records.placeholders.{t}.{p['values'][pkcol]}", "records",
                          f"Placeholder {t} #{p['values'][pkcol]} exists with the agreed values", ok,
                          p["values"], {k: str(v) for k, v in (row or {}).items()}))
    fks = {(r[0], r[1]): r[2] for r in conn.execute("""
        SELECT tc.table_name, kcu.column_name, ccu.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'""")}
    for rel in exp["relationships"]:
        child, col, parent = rel["child"], rel["column"], rel["parent"]
        src_pairs = {(k, r[col]) for k, r in exp["tables"][child]["rows"].items()}
        pk = exp["tables"][child]["pk"]
        tgt_pairs = {(str(a), b) for a, b in conn.execute(f'SELECT "{pk}", "{col}" FROM "{child}"')}
        missing_parent = conn.execute(
            f'SELECT COUNT(*) FROM "{child}" c WHERE c."{col}" IS NOT NULL AND NOT EXISTS '
            f'(SELECT 1 FROM "{parent}" p WHERE p."{rel["parent_column"]}" = c."{col}")').fetchone()[0]
        enforced = fks.get((child, col)) == parent
        ok = src_pairs == tgt_pairs and (enforced or not rel["enforced"]) and (missing_parent == 0 or not rel["enforced"])
        out.append(result(f"relationships.{child}.{col}", "relationships",
                          f"Every {child} row still points at the same {parent} record"
                          + (" and the link is enforced" if rel["enforced"] else " (link kept unenforced, as agreed)"),
                          ok, f"{len(src_pairs)} identical links", f"{len(src_pairs & tgt_pairs)} identical, "
                          f"{len(src_pairs ^ tgt_pairs)} different, {missing_parent} dangling, enforced={enforced}"))
    roles = scope["roles"]
    for group in exp["same_name"]:
        problems = []
        for person in group["customers"]:
            row = conn.execute(f'SELECT "{roles["customer_email_column"]}" FROM "{roles["customer"]}" WHERE id = %s',
                               (person["id"],)).fetchone() if roles.get("customer_email_column") else (None,)
            if row is None:
                problems.append(f"customer {person['id']} missing")
                continue
            if row[0] != person["email"]:
                problems.append(f"customer {person['id']} email {row[0]!r} != {person['email']!r}")
            orders = [r[0] for r in conn.execute(
                f'SELECT id FROM "{roles["order"]}" WHERE "{roles["order_customer_fk"]}" = %s ORDER BY id', (person["id"],))]
            if orders != person["orders"]:
                problems.append(f"customer {person['id']} orders {orders} != {person['orders']}")
        n = conn.execute(f'SELECT COUNT(*) FROM "{roles["customer"]}" WHERE "{roles["customer_name_column"]}" = %s',
                         (group["name"],)).fetchone()[0]
        if n != len(group["customers"]):
            problems.append(f"{n} records named {group['name']!r}, expected {len(group['customers'])}")
        out.append(result(f"customers.same_name.{group['name']}", "same_name",
                          f"The {len(group['customers'])} customers named {group['name']} are still separate, "
                          f"each with their own orders", not problems, "separate records", problems or "separate records"))
    for col, counts in exp["status_counts"].items():
        t, c = col.split(".")
        got = {v: n for v, n in conn.execute(f'SELECT "{c}", COUNT(*) FROM "{t}" GROUP BY 1')}
        out.append(result(f"statuses.meaning.{col}", "dates_statuses",
                          f"{col}: every status keeps its meaning (agreed spellings merged)", got == counts, counts, got))
    for a in exp["ambiguous"]:
        row = conn.execute(f'SELECT "{a["column"]}" FROM "{a["table"]}" WHERE id = %s', (a["id"],)).fetchone()
        actual = row[0].astimezone(UTC).isoformat() if row and row[0] else None
        out.append(result(f"dates.ambiguous_rule.{a['table']}.{a['id']}", "dates_statuses",
                          f"{a['table']} #{a['id']} at {a['local']} (repeated hour) stored as {a['rule']} of the two",
                          actual == a["utc"], a["utc"], actual))
    for t, info in exp["tables"].items():
        seq = conn.execute("SELECT pg_get_serial_sequence(%s, %s)", (f'"{t}"', info["pk"])).fetchone()[0]
        if not seq:
            continue
        last, called = conn.execute(f"SELECT last_value, is_called FROM {seq}").fetchone()
        nxt = last + 1 if called else last
        floor = info["sequence_floor"]
        out.append(result(f"sequences.next_ids.{t}", "read_update",
                          f"{t}: the next new id ({nxt}) is above every id the old app used ({floor})",
                          nxt > floor, f"> {floor}", nxt))
    cons = conn.execute("""SELECT tc.table_name, tc.constraint_type, kcu.column_name
        FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name WHERE tc.table_schema = 'public'""").fetchall()
    notnull = {(r[0], r[1]) for r in conn.execute(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND is_nullable='NO'")}
    problems = []
    for t, info in exp["tables"].items():
        if not any(c[0] == t and c[1] == "PRIMARY KEY" for c in cons):
            problems.append(f"{t}: no primary key")
        for col in info["notnull"]:
            if (t, col) not in notnull:
                problems.append(f"{t}.{col}: not required")
        for ucols in info["unique"]:
            if len(ucols) == 1 and not any(c[0] == t and c[1] in ("UNIQUE", "PRIMARY KEY") and c[2] == ucols[0] for c in cons):
                problems.append(f"{t}.{ucols[0]}: not unique")
    out.append(result("schema.constraints", "records", "Primary keys, required fields and unique codes are enforced",
                      not problems, "all enforced", problems or "all enforced"))
    run = conn.execute("SELECT status, summary FROM goose_migration_runs WHERE status = 'complete' "
                       "ORDER BY run_id DESC LIMIT 1").fetchone() if "goose_migration_runs" in existing else None
    out.append(result("migration.ledger", "migration_retry", "The data move finished and recorded every batch",
                      run is not None, "a complete run", run[0] if run else "no complete run"))
    digests = {t: table_digest(conn, t, info["pk"]) for t, info in exp["tables"].items() if t in existing}
    conn.close()
    return out, digests


def _by_column(mismatches):
    out = {}
    for m in mismatches:
        out[m["column"]] = out.get(m["column"], 0) + 1
    return out


def run_retry(vault, dsn, before_digests, rerun_log):
    exp = read_json(f"{vault}/expected_data.json")
    conn = psycopg.connect(dsn)
    out = []
    copied = None
    for line in (rerun_log or "").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("event") == "migration.complete":
            copied = sum(t.get("copied_this_run", 0) for t in ev.get("tables", {}).values())
    for t, info in exp["tables"].items():
        n, digest = table_digest(conn, t, info["pk"])
        b = before_digests.get(t)
        out.append(result(f"migration.retry.{t}", "migration_retry",
                          f"{t}: running the data move again left every row unchanged ({n} rows)",
                          b is not None and b[0] == n and b[1] == digest,
                          f"{b[0] if b else '?'} rows, digest {b[1][:12] if b else '?'}", f"{n} rows, digest {digest[:12]}"))
    out.append(result("migration.retry.copied", "migration_retry", "The second run copied no rows",
                      copied == 0, 0, copied))
    conn.close()
    return out
