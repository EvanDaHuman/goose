"""Assessment: read the application and a copy of its database, decide whether the job fits
the supported upgrade, and list what was found, what is risky and what must be decided.

Usage:  python -m goose_engine.analyze --repo DIR [--db FILE] --timezone ZONE --out assessment.json
"""
import argparse
import ast
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zoneinfo import ZoneInfo

from . import codeinfo as ci
from . import sqltools
from .util import CENT, open_sqlite_readonly, sha256_file, write_json, emit

LIMITS = {"routes": 40, "tables": 25, "python_lines": 4000, "db_bytes": 2 * 1024 ** 3, "rows": 5_000_000}
MONEY_HINT = re.compile(r"(price|cost|amount|total|subtotal|discount|tax|fee|balance|paid|due|charge|gross|net)", re.I)
DATE_FORMATS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"]
EOL_PYTHON = {"2.7": "January 2020", "3.6": "December 2021", "3.7": "June 2023", "3.8": "October 2024", "3.9": "October 2025"}


# ----------------------------------------------------------------------------- code

def read_routes(modules):
    bp_prefix = {}
    for m in modules:
        bp_prefix.update(m.blueprints)
    routes = []
    for m in modules:
        if ci.is_test_file(m.rel):
            continue
        top = set(m.functions.values())
        for fn in [n for n in ast.walk(m.tree) if isinstance(n, ast.FunctionDef)]:
            decs = ci.route_decorators(fn, m, bp_prefix)
            for d in decs:
                path, params = ci.flask_path(d["path"])
                sql = []
                seen_fns = [fn.name] + ci.called_functions(fn, m)
                for name in seen_fns:
                    target = m.functions.get(name, fn)
                    for call, text, nodes in ci.execute_calls(target):
                        sql.append({"text": " ".join(text.split()) if text else None,
                                    "line": call.lineno, "function": name, "constant": text is not None})
                routes.append({
                    "id": f"{d['methods'][0].lower()} {path}",
                    "function": fn.name, "module": str(m.rel), "line": fn.lineno, "nested": fn not in top,
                    "methods": d["methods"], "path": path, "flask_path": d["path"], "path_params": params,
                    "sql": sql, "payload": ci.payload_info(fn), "query_args": ci.query_args(fn),
                    "responses": ci.responses(fn), "helpers": seen_fns[1:],
                })
    return routes


def classify(route, tables):
    stmts = [sqltools.parse(s["text"]) for s in route["sql"] if s["text"]]
    inserts = [s for s in stmts if s["kind"] in ("INSERT", "REPLACE")]
    updates = [s for s in stmts if s["kind"] == "UPDATE"]
    selects = [s for s in stmts if s["kind"] in ("SELECT", "WITH")]
    method = route["methods"][0]
    decrements, increments, literals = [], [], []
    for u in updates:
        for col, expr in u["set"]:
            eff = sqltools.set_effect(col, expr)
            if eff == "decrement":
                decrements.append((u["table"], col))
            elif eff == "increment":
                increments.append((u["table"], col))
            elif eff == "literal":
                literals.append((u["table"], col, sqltools.literal_value(expr)))
    info = {}
    if method == "POST" and len({i["table"] for i in inserts}) >= 2 and decrements:
        kind = "place_order"
        info = {"stock": decrements[0], "tables_inserted": [i["table"] for i in inserts]}
    elif method == "POST" and literals and increments:
        kind = "cancel_order"
        info = {"status": literals[0], "stock": increments[0]}
    elif method == "POST" and literals and not increments and not inserts:
        kind = "transition"
        info = {"status": literals[0]}
    elif method in ("POST", "PUT", "PATCH") and increments and not inserts and not literals:
        kind = "restock"
        info = {"stock": increments[0]}
    elif method == "POST" and inserts and not updates:
        kind = "create"
        info = {"table": inserts[0]["table"]}
    elif method == "GET" and not stmts:
        kind = "index"
    elif method == "GET" and selects and any(s["aggregate"] for s in selects) and not route["path_params"] \
            and all(s["aggregate"] for s in selects[:1]):
        kind = "report"
        info = {"table": selects[0]["table"]}
    elif method == "GET" and route["path_params"] and selects:
        kind = "get"
        info = {"table": selects[0]["table"]}
    elif method == "GET" and selects:
        kind = "list"
        info = {"table": selects[0]["table"]}
    else:
        kind = "other"
    return kind, info


def infer_roles(routes, tables, fks):
    roles = {}
    po = next((r for r in routes if r["kind"] == "place_order"), None)
    if po:
        prod_table, stock_col = po["kind_info"]["stock"]
        roles["product"], roles["stock_column"] = prod_table, stock_col
        inserted = po["kind_info"]["tables_inserted"]
        for t in inserted:
            for fk in fks.get(t, []):
                if fk["ref_table"] in inserted and fk["ref_table"] != t:
                    roles["order"], roles["order_item"] = fk["ref_table"], t
                    roles["item_order_fk"] = fk["column"]
        if "order" not in roles and len(inserted) >= 2:
            roles["order"], roles["order_item"] = inserted[0], inserted[1]
        for fk in fks.get(roles.get("order_item"), []):
            if fk["ref_table"] == prod_table:
                roles["item_product_fk"] = fk["column"]
        for fk in fks.get(roles.get("order"), []):
            if fk["ref_table"] not in (prod_table,):
                roles["customer"], roles["order_customer_fk"] = fk["ref_table"], fk["column"]
        pay = po["payload"]
        roles["order_payload"] = {"keys": pay["keys"], "list_key": pay["list_key"], "item_keys": pay["item_keys"]}
    co = next((r for r in routes if r["kind"] == "cancel_order"), None)
    if co:
        t, col, val = co["kind_info"]["status"]
        roles["status_column"], roles["cancelled_value"] = col, val
    for r in routes:
        if r["kind"] == "transition":
            roles.setdefault("transitions", []).append({"route": r["id"], "value": r["kind_info"]["status"][2]})
    # columns by role, matched on names in the role tables
    def pick(table, patterns):
        cols = tables.get(table, {}).get("columns", [])
        for p in patterns:
            for c in cols:
                if re.search(p, c["name"], re.I):
                    return c["name"]
        return None
    if roles.get("order_item"):
        roles["quantity_column"] = pick(roles["order_item"], [r"^qty$", r"quantity", r"qty"])
        roles["unit_price_column"] = pick(roles["order_item"], [r"unit_price", r"price", r"cost"])
    if roles.get("product"):
        roles["price_column"] = pick(roles["product"], [r"^price$", r"price", r"unit_cost", r"cost"])
        roles["sku_column"] = pick(roles["product"], [r"^sku$", r"code", r"sku"])
        roles["product_name_column"] = pick(roles["product"], [r"^name$", r"title", r"name"])
        roles["active_column"] = pick(roles["product"], [r"^active$", r"enabled", r"is_active"])
    if roles.get("customer"):
        roles["customer_name_column"] = pick(roles["customer"], [r"^name$", r"full_name", r"name"])
        roles["customer_email_column"] = pick(roles["customer"], [r"email"])
    if roles.get("order"):
        roles["order_created_column"] = pick(roles["order"], [r"created", r"placed", r"date", r"_at$", r"_on$"])
        roles["order_total_column"] = pick(roles["order"], [r"^total$", r"amount_due", r"total", r"net"])
        roles["order_subtotal_column"] = pick(roles["order"], [r"subtotal", r"gross"])
        roles["order_discount_column"] = pick(roles["order"], [r"discount"])
        if not roles.get("status_column"):
            roles["status_column"] = pick(roles["order"], [r"status", r"state"])
    return roles


def module_constants(mod):
    out = {}
    for n in mod.tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            v = n.value
            if isinstance(v, ast.Constant) and isinstance(v.value, (int, float)) and not isinstance(v.value, bool):
                out[n.targets[0].id] = {"value": v.value, "line": n.lineno, "comment": mod.comment_above(n.lineno)}
    return out


def _num(node, consts):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value, None
    if isinstance(node, ast.Name) and node.id in consts:
        return consts[node.id]["value"], node.id
    return None, None


def extract_discount_rules(modules):
    """Find threshold discounts written as if/elif chains: if base >= T: d = round(base * R, 2)."""
    rules = []
    for mod in modules:
        if ci.is_test_file(mod.rel):
            continue
        consts = module_constants(mod)
        for fn in mod.functions.values():
            for node in ast.walk(fn):
                if not isinstance(node, ast.If):
                    continue
                tiers, cur, base, dvar = [], node, None, None
                while isinstance(cur, ast.If):
                    t = cur.test
                    if not (isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.ops[0], (ast.GtE, ast.Gt))
                            and isinstance(t.left, ast.Name)):
                        break
                    thr, thr_name = _num(t.comparators[0], consts)
                    if thr is None:
                        break
                    found = None
                    for st in cur.body:
                        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                            v = st.value
                            rounded = False
                            if isinstance(v, ast.Call) and ci.dotted(v.func) == "round" and v.args:
                                rounded = len(v.args) > 1 and isinstance(v.args[1], ast.Constant) and v.args[1].value == 2
                                v = v.args[0]
                            if isinstance(v, ast.BinOp) and isinstance(v.op, ast.Mult):
                                a, b = v.left, v.right
                                rate, rate_name = _num(b, consts)
                                if rate is None:
                                    rate, rate_name = _num(a, consts)
                                    a = b
                                if rate is not None and isinstance(a, ast.Name) and a.id == t.left.id:
                                    found = (st.targets[0].id, rate, rate_name, rounded)
                    if not found:
                        break
                    base, dvar = t.left.id, found[0]
                    tiers.append({"min": str(thr), "min_name": thr_name, "rate": str(found[1]),
                                  "rate_name": found[2], "inclusive": isinstance(t.ops[0], ast.GtE),
                                  "rounded_to_cents": found[3]})
                    cur = cur.orelse[0] if len(cur.orelse) == 1 and isinstance(cur.orelse[0], ast.If) else None
                if tiers:
                    if any(r["function"] == fn.name and r["module"] == str(mod.rel) for r in rules):
                        continue
                    notes = []
                    for tier in tiers:
                        for key in ("rate_name", "min_name"):
                            nm = tier.get(key)
                            if nm and nm in consts:
                                for line in consts[nm]["comment"]:
                                    for pct in re.findall(r"(\d+(?:\.\d+)?)\s*%", line):
                                        if key == "rate_name" and abs(float(pct) - float(tier["rate"]) * 100) > 1e-9:
                                            notes.append({"kind": "stale_comment", "constant": nm,
                                                          "comment": line, "line": consts[nm]["line"],
                                                          "code_value_percent": round(float(tier["rate"]) * 100, 4),
                                                          "comment_percent": float(pct)})
                    rules.append({"id": f"R{len(rules) + 1}", "kind": "threshold_discount", "function": fn.name,
                                  "module": str(mod.rel), "line": node.lineno, "base_variable": base,
                                  "discount_variable": dvar, "tiers": sorted(tiers, key=lambda x: -float(x["min"])),
                                  "legacy_rounding": "python_round_on_binary_float", "notes": notes})
    return rules


# ----------------------------------------------------------------------------- data

def profile_database(db_path, timezone):
    conn = open_sqlite_readonly(db_path)
    tz = ZoneInfo(timezone) if timezone else None
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    names = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    tables, fks = {}, {}
    for t in names:
        cols = sqltools.sqlite_columns(conn, t)
        fks[t] = sqltools.sqlite_foreign_keys(conn, t)
        count = conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        prof = {}
        for c in cols:
            cn = c["name"]
            types = dict(conn.execute(f'SELECT typeof("{cn}"), COUNT(*) FROM "{t}" GROUP BY 1').fetchall())
            nulls = types.get("null", 0)
            distinct = conn.execute(f'SELECT COUNT(DISTINCT "{cn}") FROM "{t}"').fetchone()[0]
            p = {"types": types, "nulls": nulls, "distinct": distinct}
            if types.get("real") or (c["decl_type"] in ("REAL", "FLOAT", "DOUBLE", "NUMERIC") and count):
                vals = [r[0] for r in conn.execute(f'SELECT "{cn}" FROM "{t}" WHERE "{cn}" IS NOT NULL')]
                off = [v for v in vals if abs(float(v) * 100 - round(float(v) * 100)) > 1e-6]
                p["money_like"] = bool(MONEY_HINT.search(cn)) and not off
                p["values_with_more_than_2_decimals"] = len(off)
            if c["decl_type"].startswith(("TEXT", "VARCHAR", "CHAR", "DATE", "TIME")) or types.get("text"):
                textvals = [r[0] for r in conn.execute(
                    f'SELECT "{cn}" FROM "{t}" WHERE typeof("{cn}") = \'text\'')]
                fmt_counts, bad, parsed = Counter(), [], []
                for v in textvals:
                    for f in DATE_FORMATS:
                        try:
                            parsed.append((v, datetime.strptime(v, f)))
                            fmt_counts[f] += 1
                            break
                        except ValueError:
                            continue
                    else:
                        bad.append(v)
                if textvals and len(bad) <= max(0, int(len(textvals) * 0.0)) and fmt_counts:
                    p["date_like"] = True
                    p["date_formats"] = dict(fmt_counts)
                    p["date_only"] = set(fmt_counts) == {"%Y-%m-%d"}
                    p["utc_default"] = str(c["default"] or "").upper() in ("CURRENT_TIMESTAMP", "(DATETIME('NOW'))", "DATETIME('NOW')")
                    if tz and not p["date_only"] and not p["utc_default"]:
                        amb, gap = [], []
                        for raw, dt in parsed:
                            a = dt.replace(tzinfo=tz, fold=0).utcoffset()
                            b = dt.replace(tzinfo=tz, fold=1).utcoffset()
                            if a != b:
                                amb.append(raw)
                            else:
                                # a local time that does not exist (clocks jumped forward)
                                back = dt.replace(tzinfo=tz).astimezone(ZoneInfo("UTC")).astimezone(tz).replace(tzinfo=None)
                                if back != dt:
                                    gap.append(raw)
                        p["ambiguous_local_times"] = amb
                        p["nonexistent_local_times"] = gap
                elif textvals and fmt_counts and bad:
                    p["date_like_with_errors"] = {"parsed": sum(fmt_counts.values()), "unparsed_examples": bad[:5],
                                                  "unparsed": len(bad)}
                if distinct and distinct <= 12 and count >= 20 and not p.get("date_like"):
                    p["values"] = dict(conn.execute(
                        f'SELECT "{cn}", COUNT(*) FROM "{t}" GROUP BY 1 ORDER BY 2 DESC').fetchall())
            prof[cn] = p
        orphan = []
        for fk in fks[t]:
            q = (f'SELECT "{fk["column"]}" AS v, COUNT(*) AS n FROM "{t}" WHERE "{fk["column"]}" IS NOT NULL AND '
                 f'"{fk["column"]}" NOT IN (SELECT "{fk["ref_column"]}" FROM "{fk["ref_table"]}") GROUP BY 1')
            rows = conn.execute(q).fetchall()
            if rows:
                orphan.append({"column": fk["column"], "references": f'{fk["ref_table"]}.{fk["ref_column"]}',
                               "missing_ids": [r[0] for r in rows], "rows": sum(r[1] for r in rows)})
        indexes = sqltools.sqlite_indexes(conn, t)
        tables[t] = {"name": t, "columns": cols, "row_count": count, "profile": prof,
                     "foreign_keys": fks[t], "orphans": orphan, "indexes": indexes,
                     "max_id": conn.execute(f'SELECT MAX(rowid) FROM "{t}"').fetchone()[0]}
    try:
        for name, seq in conn.execute("SELECT name, seq FROM sqlite_sequence"):
            if name in tables:
                tables[name]["sqlite_sequence"] = seq
    except Exception:
        pass
    sql_rows = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall()
    conn.close()
    return {"integrity": integrity, "tables": tables, "fks": fks,
            "ddl": [dict(r) for r in sql_rows]}


def status_variants(values, preferred):
    def norm(v):
        return re.sub(r"(.)\1+", r"\1", re.sub(r"[^a-z]", "", str(v).lower()))
    groups = defaultdict(list)
    for v in values:
        groups[norm(v)].append(v)
    mapping = {}
    for vs in groups.values():
        if len(vs) > 1:
            canon = next((v for v in vs if v in preferred), max(vs, key=lambda x: values[x]))
            for v in vs:
                if v != canon:
                    mapping[v] = canon
    return mapping


def history_check(db_path, rule, roles):
    """Re-run the discount rule on every stored order and compare with what was stored."""
    order, sub, disc = roles.get("order"), roles.get("order_subtotal_column"), roles.get("order_discount_column")
    if not (order and sub and disc):
        return {"checked": 0, "note": "Could not match the rule's variables to stored columns."}
    conn = open_sqlite_readonly(db_path)
    rows = conn.execute(f'SELECT "{sub}", "{disc}" FROM "{order}" WHERE "{sub}" IS NOT NULL').fetchall()
    conn.close()
    matches_legacy = differ_half_up = 0
    examples = []
    for s, d in rows:
        s = float(s)
        legacy = 0.0
        exact = Decimal("0")
        for tier in rule["tiers"]:
            hit = s >= float(tier["min"]) if tier["inclusive"] else s > float(tier["min"])
            if hit:
                legacy = round(s * float(tier["rate"]), 2) if tier["rounded_to_cents"] else s * float(tier["rate"])
                exact = (Decimal(repr(s)) * Decimal(tier["rate"])).quantize(CENT, rounding=ROUND_HALF_UP)
                break
        if abs(legacy - float(d or 0)) < 1e-9:
            matches_legacy += 1
        if exact != Decimal(repr(float(d or 0))).quantize(CENT, rounding=ROUND_HALF_UP):
            differ_half_up += 1
            if len(examples) < 5:
                examples.append({"subtotal": s, "stored_discount": d, "half_up_discount": str(exact)})
    return {"checked": len(rows), "consistent_with_code": matches_legacy,
            "differ_from_half_up": differ_half_up, "half_up_examples": examples}


def order_total_consistency(db_path, roles):
    o, it = roles.get("order"), roles.get("order_item")
    sub, total, disc = roles.get("order_subtotal_column"), roles.get("order_total_column"), roles.get("order_discount_column")
    fk, qty, up = roles.get("item_order_fk"), roles.get("quantity_column"), roles.get("unit_price_column")
    if not all([o, it, sub, total, fk, qty, up]):
        return None
    conn = open_sqlite_readonly(db_path)
    out = []
    q = (f'SELECT o.id, o."{sub}", o."{total}", {f"o.{disc}" if disc else "0"}, '
         f'(SELECT SUM(i."{qty}" * i."{up}") FROM "{it}" i WHERE i."{fk}" = o.id) FROM "{o}" o')
    for oid, s, t, d, lines in conn.execute(q):
        if lines is None or s is None or t is None:
            continue
        if abs(round(lines, 2) - s) > 0.005 or abs(round(s - (d or 0), 2) - t) > 0.005:
            out.append({"id": oid, "subtotal": s, "discount": d, "total": t, "items_sum": round(lines, 2)})
    conn.close()
    return out


# ----------------------------------------------------------------------------- inventory

def read_requirements(repo):
    pins = {}
    for name in ("requirements.txt", "requirements/base.txt", "requirements/prod.txt"):
        p = repo / name
        if p.exists():
            for line in p.read_text().splitlines():
                m = re.match(r"^\s*([A-Za-z0-9_.\-\[\]]+)\s*==\s*([\w.\-]+)", line)
                if m:
                    pins[m.group(1).split("[")[0].lower()] = m.group(2)
    py = None
    for name in ("runtime.txt", ".python-version"):
        p = repo / name
        if p.exists():
            m = re.search(r"(\d+\.\d+)", p.read_text())
            if m:
                py = m.group(1)
    dockerfile = repo / "Dockerfile"
    if not py and dockerfile.exists():
        m = re.search(r"FROM\s+python:(\d+\.\d+)", dockerfile.read_text(), re.I)
        if m:
            py = m.group(1)
    return pins, py


def launch_target(app_modules):
    """The module that exposes the Flask app: a module-level `app = Flask(...)` or `app = create_app()` wins."""
    best = None
    for m in app_modules:
        for n in m.tree.body:
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ("app", "application") for t in n.targets) \
                    and isinstance(n.value, ast.Call):
                return str(m.rel)
        if best is None and any(isinstance(n, ast.FunctionDef) and n.name == "create_app" for n in m.tree.body):
            best = str(m.rel)
    return best or (str(app_modules[0].rel) if app_modules else None)


def database_location(app_modules):
    """Where the app opens its SQLite file: env var names and the default path, if they can be read."""
    env_vars, defaults = [], []

    def resolve(node, consts):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            defaults.append(node.value)
        elif isinstance(node, ast.Name) and node.id in consts:
            resolve(consts[node.id], consts)
        elif isinstance(node, ast.Call) and ci.dotted(node.func) in ("os.environ.get", "os.getenv", "environ.get"):
            if node.args and ci.const_str(node.args[0]):
                env_vars.append(ci.const_str(node.args[0]))
            if len(node.args) > 1:
                resolve(node.args[1], consts)
        elif isinstance(node, ast.Subscript) and ci.dotted(node.value) in ("os.environ",):
            if ci.const_str(node.slice):
                env_vars.append(ci.const_str(node.slice))
        elif isinstance(node, ast.Call) and ci.dotted(node.func) in ("os.path.join",):
            parts = [ci.const_str(a) for a in node.args]
            if parts and all(parts):
                defaults.append("/".join(parts))
        elif isinstance(node, ast.Subscript) and ci.dotted(node.value).endswith("config"):
            key = ci.const_str(node.slice)
            if key:
                env_vars.append(f"config:{key}")

    for m in app_modules:
        consts = {}
        for n in m.tree.body:
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                consts[n.targets[0].id] = n.value
        for n in ast.walk(m.tree):
            if isinstance(n, ast.Call) and ci.dotted(n.func) == "sqlite3.connect" and n.args:
                resolve(n.args[0], consts)
            # app.config.from_mapping(DATABASE=os.environ.get("X", ...)) and app.config["DATABASE"] = ...
            if isinstance(n, ast.Call) and ci.dotted(n.func).endswith(("from_mapping", "config.update")):
                for kw in n.keywords:
                    if kw.arg and re.search(r"DB|DATABASE|SQLITE", kw.arg, re.I):
                        resolve(kw.value, consts)
            if isinstance(n, ast.Call) and ci.dotted(n.func) in ("os.environ.get", "os.getenv") and n.args:
                name = ci.const_str(n.args[0]) or ""
                if re.search(r"DB|DATABASE|SQLITE", name, re.I) and name not in env_vars:
                    env_vars.append(name)
    return {"env_vars": list(dict.fromkeys(v for v in env_vars if not v.startswith("config:"))),
            "config_keys": [v.split(":", 1)[1] for v in env_vars if v.startswith("config:")],
            "default_path": defaults[0] if defaults else None}


def assess(repo_dir, db_path, timezone, latest_versions=None):
    repo = Path(repo_dir)
    modules, parse_problems = ci.scan(repo)
    app_modules = [m for m in modules if not ci.is_test_file(m.rel)]
    test_modules = [m for m in modules if ci.is_test_file(m.rel)]
    imports = set().union(*[m.imports for m in app_modules]) if app_modules else set()
    py_lines = sum(len(m.lines) for m in app_modules)
    blockers, reasons, risks, findings, questions = [], [], [], [], []

    def finding(severity, title, detail, evidence=None, area="code"):
        findings.append({"id": f"F{len(findings) + 1}", "severity": severity, "area": area,
                         "title": title, "detail": detail, "evidence": evidence or []})
        return findings[-1]

    if not app_modules:
        blockers.append("No Python source files were found in the repository.")
    if app_modules and "flask" not in imports:
        blockers.append("The application does not use Flask.")
    for mod_name, why in UNSUPPORTED.items():
        if mod_name in imports:
            blockers.append(why)
    if (repo / "manage.py").exists() and "django" in (repo / "manage.py").read_text(errors="ignore"):
        if "Django project (v1 supports Flask only)" not in blockers:
            blockers.append("Django project (v1 supports Flask only)")
    uses_sqlite = "sqlite3" in imports
    if app_modules and "flask" in imports and not uses_sqlite:
        blockers.append("No sqlite3 database access was found (v1 upgrades SQLite applications only).")
    src = "\n".join(m.source for m in app_modules)
    parse_decltypes = bool(re.search(r"detect_types\s*=\s*sqlite3\.PARSE_DECLTYPES", src))
    if re.search(r"\brender_template(_string)?\s*\(", src):
        blockers.append("Server-rendered HTML pages (render_template). v1 upgrades JSON APIs only.")
    if re.search(r"\brequest\.files\b", src):
        blockers.append("File uploads (request.files) are not supported in v1.")
    if re.search(r"\bsession\s*\[", src) and "flask" in imports:
        blockers.append("Browser sessions (flask.session) are not supported in v1.")
    if parse_problems:
        blockers.extend(parse_problems)

    routes = read_routes(app_modules) if not blockers or app_modules else []
    if app_modules and not routes and "flask" in imports:
        blockers.append("No Flask routes were found.")

    profile = None
    db_info = {}
    if db_path:
        db_info = {"bytes": Path(db_path).stat().st_size, "sha256": sha256_file(db_path)}
        try:
            profile = profile_database(db_path, timezone)
        except Exception as e:  # not a readable SQLite file
            questions.append({"id": "Q-db", "to": "customer", "blocking": True,
                              "prompt": "We could not open the database file you sent. Please upload a fresh copy "
                                        "of the SQLite database (for example made with the sqlite3 .backup command).",
                              "fields": [{"type": "upload", "key": "database", "label": "Database copy"}],
                              "reason": f"Open failed: {e}"})
    else:
        questions.append({"id": "Q-db", "to": "customer", "blocking": True,
                          "prompt": "Please upload a copy of the application's SQLite database. We need it to "
                                    "check your data and to prove the move to PostgreSQL loses nothing.",
                          "fields": [{"type": "upload", "key": "database", "label": "Database copy"}],
                          "reason": "No database copy was provided with the job."})

    tables = profile["tables"] if profile else {}
    fks = profile["fks"] if profile else {}
    for r in routes:
        r["kind"], r["kind_info"] = classify(r, tables)
    roles = infer_roles(routes, tables, fks) if routes else {}

    # ---------------------------------------------------------------- findings: code
    dynamic = [(r, s) for r in routes for s in r["sql"] if not s["constant"]]
    for r, s in dynamic:
        risks.append(f"{r['module']}:{s['line']} builds SQL at run time; it cannot be translated automatically.")
    if dynamic:
        blockers.append(f"{len(dynamic)} database queries are built at run time and cannot be checked automatically.")
    sql_sites = sum(len(r["sql"]) for r in routes)
    test_fns = sum(1 for m in test_modules for n in ast.walk(m.tree)
                   if isinstance(n, ast.FunctionDef) and n.name.startswith("test"))
    rules = extract_discount_rules(app_modules)
    tested_names = set()
    for m in test_modules:
        tested_names |= {n.attr for n in ast.walk(m.tree) if isinstance(n, ast.Attribute)}
        tested_names |= {n.id for n in ast.walk(m.tree) if isinstance(n, ast.Name)}
    untested_rules = [r for r in rules if r["function"] not in tested_names]
    finding("medium" if test_fns < 5 else "low", "Few automated tests",
            f"{test_fns} test function(s) in {len(test_modules)} file(s). "
            f"{'No test covers the discount rule.' if untested_rules else ''}".strip(),
            [str(m.rel) for m in test_modules])
    conn_calls = len(re.findall(r"sqlite3\.connect\(", src))
    commits = len(re.findall(r"\.commit\(\)", src))
    if conn_calls:
        finding("medium", "Database handled by hand in every request",
                f"Each request opens its own SQLite connection ({conn_calls} connect call(s)) and calls commit() by hand "
                f"({commits} place(s)). There is no connection pool"
                + (", and stock checks and stock updates are separate statements with no lock, so two orders arriving "
                   "together could both pass the stock check." if any(r["kind"] == "place_order" for r in routes) else "."),
                [f"{r['module']}:{r['line']} {r['function']}" for r in routes if r["kind"] in ("place_order",)])
    if routes and sql_sites:
        finding("low", "Business rules mixed into request handlers",
                f"{len(routes)} routes in {len(app_modules)} module(s); SQL appears in {sql_sites} places inside "
                f"handlers and helpers." + (" Rules such as the discount live next to request parsing." if rules else ""), [])
    for rule in rules:
        for note in rule["notes"]:
            finding("medium", "A code comment disagrees with the code",
                    f"The comment above {note['constant']} says \"{note['comment']}\" but the code applies "
                    f"{note['code_value_percent']:g}%.", [f"{rule['module']}:{note['line']}"])

    cancel = next((r for r in routes if r["kind"] == "cancel_order"), None)
    if cancel:
        fn_src = ast.get_source_segment(
            next(m for m in app_modules if str(m.rel) == cancel["module"]).source,
            next(m for m in app_modules if str(m.rel) == cancel["module"]).functions[cancel["function"]]) or ""
        cv = roles.get("cancelled_value")
        guarded = bool(cv) and re.search(rf"==\s*['\"]{re.escape(cv)}['\"]", fn_src or "")
        if not guarded:
            finding("high", "Cancelling twice puts stock back twice",
                    f"{cancel['function']} restores stock without checking whether the order is already "
                    f"'{cv}'. A repeated cancel request (a double click, a retry) adds the stock again.",
                    [f"{cancel['module']}:{cancel['line']}"])
    po = next((r for r in routes if r["kind"] == "place_order"), None)
    if po:
        finding("medium", "Retried order requests create duplicate orders",
                "There is no request key. If the shop front-end retries after a timeout, a second order is "
                "created and stock is taken twice.", [f"{po['module']}:{po['line']}"])
    if any(sqltools.parse(s["text"])["text"] and re.search(r"\bLIKE\b", s["text"] or "", re.I)
           for r in routes for s in r["sql"]):
        finding("info", "Searches rely on SQLite's case-insensitive LIKE",
                "SQLite's LIKE ignores upper/lower case; PostgreSQL's LIKE does not. The upgrade must use ILIKE "
                "to keep search results the same.", [])
    if re.search(r"datetime\.now\(\)", src):
        finding("medium", "Times depend on the server clock's time zone",
                "Timestamps are written with datetime.now(), so they are only correct while the server clock is "
                "set to shop time. A cloud server on UTC would shift every new timestamp.", [])

    # ---------------------------------------------------------------- findings: data
    money_cols, date_cols, status_maps, ambiguous, nonexistent, orphan_list = [], [], {}, [], [], []
    preferred_values = set()
    for r in routes:
        for s in r["sql"]:
            if s["text"]:
                preferred_values |= set(re.findall(r"'([a-z_]+)'", s["text"]))
    if profile:
        if profile["integrity"] != "ok":
            questions.append({"id": "Q-integrity", "to": "customer", "blocking": True,
                              "prompt": "SQLite reports damage in the database copy. Please send a fresh copy.",
                              "fields": [{"type": "upload", "key": "database", "label": "Database copy"}],
                              "reason": profile["integrity"]})
        for t, tinfo in tables.items():
            for cn, p in tinfo["profile"].items():
                decl = next(c for c in tinfo["columns"] if c["name"] == cn)["decl_type"]
                if len([k for k in p["types"] if k != "null"]) > 1:
                    finding("high", f"Mixed value types in {t}.{cn}",
                            f"Stored types: {p['types']}. PostgreSQL enforces one type per column.", [], "data")
                    questions.append({"id": f"Q-types-{t}-{cn}", "to": "founder", "blocking": True,
                                      "prompt": f"{t}.{cn} mixes value types {p['types']}. Decide how to convert.",
                                      "fields": [{"type": "text", "key": "decision", "label": "Decision"}]})
                if p.get("money_like"):
                    money_cols.append(f"{t}.{cn}")
                if p.get("date_like"):
                    date_cols.append({"column": f"{t}.{cn}", "formats": p["date_formats"], "date_only": p["date_only"],
                                      "declared": decl, "zone": "UTC" if p.get("utc_default") else timezone})
                    if p.get("utc_default"):
                        finding("medium", f"{t}.{cn} is stored in UTC, not shop time",
                                f"The column is filled by SQLite's CURRENT_TIMESTAMP, which writes UTC. It will be moved as "
                                f"UTC, and reports that group by day keep using the UTC day, as they do today.", [], "data")
                    for raw in p.get("ambiguous_local_times", []):
                        ambiguous.append({"column": f"{t}.{cn}", "value": raw})
                    for raw in p.get("nonexistent_local_times", []):
                        nonexistent.append({"column": f"{t}.{cn}", "value": raw})
                if p.get("date_like_with_errors"):
                    e = p["date_like_with_errors"]
                    finding("high", f"Unreadable dates in {t}.{cn}",
                            f"{e['unparsed']} value(s) are not dates, for example {e['unparsed_examples'][:3]}.",
                            [], "data")
                if p.get("values"):
                    mp = status_variants(p["values"], preferred_values)
                    if mp:
                        status_maps[f"{t}.{cn}"] = mp
                        finding("medium", f"Two spellings of the same status in {t}.{cn}",
                                ", ".join(f"'{a}' ({p['values'][a]} rows) means '{b}' ({p['values'][b]} rows)"
                                          for a, b in mp.items()) + ". Reports already treat them as the same.",
                                [], "data")
                if decl in ("REAL", "FLOAT", "DOUBLE") and p.get("money_like"):
                    pass
            for o in tinfo["orphans"]:
                orphan_list.append({"table": t, **o})
        if money_cols:
            finding("medium", "Money is stored as binary floating point",
                    f"{len(money_cols)} money columns are REAL ({', '.join(money_cols)}). Values such as 19.99 are "
                    f"stored approximately; the upgrade stores exact cents (NUMERIC).", [], "data")
        if parse_decltypes and any(d["declared"].startswith(("TIMESTAMP", "DATETIME", "DATE")) for d in date_cols):
            finding("info", "Dates leave the old API as HTTP-date text",
                    "The app opens SQLite with PARSE_DECLTYPES, so TIMESTAMP columns arrive as datetime objects and Flask "
                    "sends them as e.g. 'Wed, 05 Feb 2025 14:03:00 GMT'. The upgrade keeps that format.", [], "code")
        if date_cols:
            fmts = Counter()
            for d in date_cols:
                fmts.update(d["formats"])
            if len(fmts) > 1:
                finding("medium", "Dates are stored as text in more than one format",
                        "; ".join(f"{f!s}: {n}" for f, n in fmts.most_common()) +
                        f". All are read as local time in {timezone}.", [], "data")
        if ambiguous:
            finding("medium", "Timestamps inside the repeated daylight-saving hour",
                    f"{len(ambiguous)} local time(s) happened twice when clocks went back "
                    f"({', '.join(a['value'] for a in ambiguous[:4])}). Text timestamps cannot say which.",
                    [f"{a['column']} = {a['value']}" for a in ambiguous], "data")
        if nonexistent:
            finding("high", "Timestamps that cannot exist in local time",
                    f"{len(nonexistent)} value(s) fall in the hour skipped when clocks went forward.",
                    [f"{a['column']} = {a['value']}" for a in nonexistent], "data")
        for o in orphan_list:
            finding("high", f"{o['rows']} rows in {o['table']} point at missing records",
                    f"{o['table']}.{o['column']} refers to {o['references']} values {o['missing_ids']} that no "
                    f"longer exist. SQLite never enforced this link; PostgreSQL will.", [], "data")
            questions.append({
                "id": f"Q-orphans-{o['table']}-{o['column']}", "to": "customer", "blocking": True,
                "prompt": f"{o['rows']} order line(s) refer to product record(s) {o['missing_ids']} that were deleted. "
                          f"How should we keep them?",
                "fields": [{"type": "choice", "key": "decision", "label": "Decision", "options": [
                    "placeholder", "keep_unlinked", "remove"]}],
                "options_help": {
                    "placeholder": "Recommended. Keep the lines and add an inactive placeholder record "
                                   "(\"Deleted product #ID\", stock 0) so every line points at a real record. "
                                   "Order history and totals stay exactly as they are.",
                    "keep_unlinked": "Keep the lines exactly as they are and do not enforce this link in "
                                     "PostgreSQL. Behaves like today, with less protection.",
                    "remove": "Delete the lines. Not recommended: order totals would no longer match their lines."},
                "recommended": "placeholder", "table": o["table"], "column": o["column"],
                "references": o["references"], "missing_ids": o["missing_ids"]})
        if roles.get("customer") and roles.get("customer_name_column"):
            conn = open_sqlite_readonly(db_path)
            dups = conn.execute(
                f'SELECT "{roles["customer_name_column"]}", COUNT(*) FROM "{roles["customer"]}" '
                f'GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC, 1').fetchall()
            conn.close()
            if dups:
                finding("info", "Different customers share a name",
                        f"{len(dups)} names belong to more than one customer (e.g. "
                        f"{', '.join(f'{n} x{c}' for n, c in dups[:4])}). They must stay separate records.",
                        [], "data")
                roles["same_name_customers"] = [{"name": n, "count": c} for n, c in dups]
        if roles.get("product") and roles.get("stock_column"):
            conn = open_sqlite_readonly(db_path)
            roles["stock_min"] = conn.execute(
                f'SELECT MIN("{roles["stock_column"]}") FROM "{roles["product"]}"').fetchone()[0]
            conn.close()
        for rule in rules:
            rule["history"] = history_check(db_path, rule, roles)
        mism = order_total_consistency(db_path, roles)
        if mism:
            finding("low", f"{len(mism)} stored order total(s) do not match their lines",
                    "Probably edited by hand after the order was placed (for example order "
                    f"#{mism[0]['id']}: lines add up to {mism[0]['items_sum']}, stored total {mism[0]['total']}). "
                    "History will be moved exactly as stored, not recalculated.", [], "data")
            roles["orders_not_matching_lines"] = [m["id"] for m in mism]

    # ---------------------------------------------------------------- dependencies
    pins, py = read_requirements(repo)
    outdated = []
    for name, ver in pins.items():
        latest = (latest_versions or {}).get(name)
        if latest and latest.split(".")[0] != ver.split(".")[0]:
            outdated.append({"package": name, "pinned": ver, "latest": latest})
    if outdated:
        finding("medium", "Pinned packages are several major versions behind",
                ", ".join(f"{o['package']} {o['pinned']} (latest {o['latest']})" for o in outdated) +
                ". Upstream fixes ship for the current releases; staying on old lines means back-porting any "
                "future fix yourself (versions checked on PyPI, 2026-11-04).", ["requirements.txt"], "dependencies")
    if py and py in EOL_PYTHON:
        finding("medium", f"Python {py} is past end of life",
                f"Python {py} reached end of life in {EOL_PYTHON[py]} and no longer receives security fixes.", [], "dependencies")

    # ---------------------------------------------------------------- fit
    size = {"routes": len(routes), "tables": len(tables), "python_lines": py_lines,
            "rows": sum(t["row_count"] for t in tables.values()), "db_bytes": db_info.get("bytes", 0),
            "modules": len(app_modules), "sql_sites": sql_sites}
    for k, lim in LIMITS.items():
        if size.get(k, 0) > lim:
            blockers.append(f"Too large for the pilot: {k} = {size[k]} (limit {lim}).")
    uncovered = [r for r in routes if r["kind"] == "other"]
    if uncovered:
        risks.append(f"{len(uncovered)} route(s) do not match a known pattern and will be checked only "
                     f"against recorded behaviour: " + ", ".join(r["id"] for r in uncovered))
    if not roles.get("order"):
        risks.append("No order-placing route was recognised; order checks will be limited.")
    blocking_q = [q for q in questions if q.get("blocking")]
    if blockers:
        decision = "unsupported"
        reasons = blockers
    elif blocking_q:
        decision = "needs_info"
        reasons = [q["prompt"] for q in blocking_q]
    else:
        decision = "supported"
        reasons = ["Flask application with hand-written sqlite3 queries, inside the pilot size limits."]

    return {
        "schema_version": 1,
        "assessed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "fit": {"decision": decision, "reasons": reasons, "blockers": blockers},
        "timezone": timezone,
        "app": {"modules": [str(m.rel) for m in app_modules], "test_modules": [str(m.rel) for m in test_modules],
                "entry_module": launch_target(app_modules),
                "parse_decltypes": parse_decltypes,
                "database_location": database_location(app_modules),
                "test_functions": test_fns, "python_lines": py_lines, "imports": sorted(imports),
                "pins": pins, "python_version": py},
        "database": {**db_info, "integrity": profile["integrity"] if profile else None},
        "size": size,
        "routes": routes,
        "tables": tables,
        "roles": roles,
        "rules": rules,
        "money_columns": money_cols,
        "date_columns": date_cols,
        "status_mappings": status_maps,
        "ambiguous_times": ambiguous,
        "nonexistent_times": nonexistent,
        "orphans": orphan_list,
        "findings": findings,
        "risks": risks,
        "questions": questions,
        "ddl": profile["ddl"] if profile else [],
    }


UNSUPPORTED = ci.UNSUPPORTED_IMPORTS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--db")
    ap.add_argument("--timezone", default=None)
    ap.add_argument("--latest", help="JSON file of latest package versions")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    latest = None
    if a.latest and Path(a.latest).exists():
        import json
        latest = json.loads(Path(a.latest).read_text())["versions"]
    result = assess(a.repo, a.db, a.timezone, latest)
    write_json(a.out, result)
    emit("assessment.done", decision=result["fit"]["decision"], findings=len(result["findings"]),
         questions=len(result["questions"]), routes=len(result["routes"]))


if __name__ == "__main__":
    main()
