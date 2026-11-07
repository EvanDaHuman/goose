"""A deliberately small SQL reader and SQLite -> PostgreSQL translator.

It understands the statement shapes found in small Flask + sqlite3 applications. Anything it
does not understand is reported rather than guessed, so the assessment can flag it.
"""
import re

KEYWORDS = re.compile(r"^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|CREATE|DROP|ALTER|PRAGMA)\b", re.I)


def looks_like_sql(text):
    return bool(text) and bool(KEYWORDS.match(text))


def split_top_level(text, sep=","):
    parts, depth, cur, quote = [], 0, [], None
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("'", '"'):
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def parse(sql):
    """Return a small description of one statement (kind, tables, set clauses, literals)."""
    s = " ".join(sql.split())
    out = {"kind": None, "table": None, "tables": [], "set": [], "insert_columns": [],
           "insert_values": [], "aggregate": False, "text": s}
    m = KEYWORDS.match(s)
    if not m:
        return out
    kind = m.group(1).upper()
    out["kind"] = kind
    if kind in ("INSERT", "REPLACE"):
        mm = re.match(r"^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)",
                      s, re.I)
        if mm:
            out["table"] = mm.group(1)
            out["insert_columns"] = [c.strip() for c in mm.group(2).split(",")]
            out["insert_values"] = split_top_level(mm.group(3))
        else:
            mm = re.match(r"^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)", s, re.I)
            out["table"] = mm.group(1) if mm else None
        out["tables"] = [out["table"]] if out["table"] else []
    elif kind == "UPDATE":
        mm = re.match(r"^\s*UPDATE\s+(\w+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$", s, re.I)
        if mm:
            out["table"] = mm.group(1)
            out["tables"] = [mm.group(1)]
            for clause in split_top_level(mm.group(2)):
                if "=" in clause:
                    col, expr = clause.split("=", 1)
                    out["set"].append((col.strip(), expr.strip()))
    elif kind == "DELETE":
        mm = re.match(r"^\s*DELETE\s+FROM\s+(\w+)", s, re.I)
        if mm:
            out["table"] = mm.group(1)
            out["tables"] = [mm.group(1)]
    elif kind in ("SELECT", "WITH"):
        flat = s
        while re.search(r"\([^()]*\)", flat):
            flat = re.sub(r"\([^()]*\)", " ", flat)
        tables = re.findall(r"\b(?:FROM|JOIN)\s+(\w+)", flat, re.I) or re.findall(r"\b(?:FROM|JOIN)\s+(\w+)", s, re.I)
        out["tables"] = [t for t in dict.fromkeys(tables) if t.upper() not in ("SELECT",)]
        out["table"] = out["tables"][0] if out["tables"] else None
        out["aggregate"] = bool(re.search(r"\b(COUNT|SUM|AVG|MIN|MAX)\s*\(", s, re.I))
    return out


def set_effect(col, expr):
    """Classify `col = expr` in an UPDATE: increment, decrement, literal or other."""
    e = expr.replace(" ", "")
    c = col.strip()
    if re.fullmatch(rf"{re.escape(c)}\+(\?|\d+)", e, re.I):
        return "increment"
    if re.fullmatch(rf"{re.escape(c)}-(\?|\d+)", e, re.I):
        return "decrement"
    if re.fullmatch(r"'[^']*'", expr.strip()):
        return "literal"
    if e == "?":
        return "param"
    return "other"


def literal_value(expr):
    m = re.fullmatch(r"\s*'([^']*)'\s*", expr)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- translation

FUNC_MAP = [
    (re.compile(r"\bIFNULL\s*\(", re.I), "COALESCE("),
    (re.compile(r"\bINSTR\s*\(", re.I), "STRPOS("),
    (re.compile(r"\bSUBSTR\s*\(", re.I), "SUBSTRING("),
]


def translate_fragment(text, *, returning_pk=None, notes=None, zones=None):
    """Translate one SQL text fragment from SQLite to PostgreSQL.

    The fragment may be only part of a statement (when code builds SQL with +=), so every rule
    here is local. `?` placeholders become `%s` and literal `%` is doubled for psycopg.
    Returns (translated_text, list_of_rule_names_applied).
    """
    applied = []
    out = []
    i, n = 0, len(text)
    quote = None
    while i < n:
        ch = text[i]
        if quote:
            out.append("%%" if ch == "%" else ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif ch == "?":
            out.append("%s")
            if "placeholders" not in applied:
                applied.append("placeholders")
        elif ch == "%":
            out.append("%%")
        else:
            out.append(ch)
        i += 1
    s = "".join(out)
    for rx, rep in FUNC_MAP:
        if rx.search(s):
            s = rx.sub(rep, s)
            applied.append(rep.rstrip("(").lower())
    # SQLite LIKE ignores case for ASCII letters; PostgreSQL LIKE does not.
    if re.search(r"(?<![I\w])LIKE\b", s, re.I):
        s = re.sub(r"(?<![I\w])LIKE\b", "ILIKE", s, flags=re.I)
        applied.append("like_to_ilike")
    # date(x) -> (x)::date ; relies on the session time zone being the business time zone.
    # A column SQLite filled in UTC keeps its UTC day: ((x) AT TIME ZONE 'UTC')::date
    if re.search(r"\bdate\s*\(\s*[\w.]+\s*\)", s, re.I):
        def day(m):
            col = m.group(1)
            if (zones or {}).get(col.split(".")[-1]) == "UTC":
                return f"(({col}) AT TIME ZONE 'UTC')::date"
            return f"({col})::date"
        s = re.sub(r"\bdate\s*\(\s*([\w.]+)\s*\)", day, s, flags=re.I)
        applied.append("date_function")
    if re.search(r"datetime\s*\(\s*'now'\s*\)", s, re.I):
        s = re.sub(r"datetime\s*\(\s*'now'\s*\)", "now()", s, flags=re.I)
        applied.append("datetime_now")
    m = re.match(r"^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b", s, re.I)
    if m:
        s = re.sub(r"^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b", r"\1INSERT INTO", s, flags=re.I)
        s = s.rstrip() + " ON CONFLICT DO NOTHING"
        applied.append("insert_or_ignore")
    if returning_pk and re.match(r"^\s*INSERT\b", s, re.I) and not re.search(r"\bRETURNING\b", s, re.I):
        s = s.rstrip() + f" RETURNING {returning_pk}"
        applied.append("returning_pk")
    if notes is not None:
        notes.extend(applied)
    return s, applied


# --------------------------------------------------------------------------- DDL

def sqlite_columns(conn, table):
    cols = []
    for row in conn.execute(f'PRAGMA table_info("{table}")'):
        cols.append({"name": row[1], "decl_type": (row[2] or "").upper(), "notnull": bool(row[3]),
                     "default": row[4], "pk": int(row[5])})
    return cols


def sqlite_foreign_keys(conn, table):
    fks = []
    for row in conn.execute(f'PRAGMA foreign_key_list("{table}")'):
        fks.append({"column": row[3], "ref_table": row[2], "ref_column": row[4] or "id"})
    return fks


def sqlite_indexes(conn, table):
    out = []
    for row in conn.execute(f'PRAGMA index_list("{table}")'):
        name, unique, origin = row[1], bool(row[2]), row[3]
        cols = [r[2] for r in conn.execute(f'PRAGMA index_info("{name}")')]
        out.append({"name": name, "unique": unique, "origin": origin, "columns": cols})
    return out


def table_order(tables, fks_by_table):
    """Parents before children so foreign keys can be checked as rows arrive."""
    order, seen = [], set()

    def visit(t, stack=()):
        if t in seen or t in stack:
            return
        for fk in fks_by_table.get(t, []):
            if fk["ref_table"] in tables and fk["ref_table"] != t:
                visit(fk["ref_table"], stack + (t,))
        seen.add(t)
        order.append(t)

    for t in tables:
        visit(t)
    return order
