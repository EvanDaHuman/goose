"""Package checks: the delivered files are complete, install into a clean environment, start on an
empty database and do the core business task. The worker builds the clean environment and starts
the app; this module checks what it produced."""
import re
from pathlib import Path

from .common import http, read_json
from .datachecks import result

REQUIRED = ["README.md", "CHANGES.md", "RUNBOOK.md", "ROLLBACK.md", "requirements.txt", "migrations/001_schema.sql",
            "migrate/migrate_data.py", "migrate/plan.json", "migrate/apply_schema.py", "app/main.py"]


def seed_row(dsn, assessment, table, overrides):
    """Insert one row with plausible values for every required column (reference data the API has no endpoint for)."""
    import psycopg
    cols = assessment["tables"][table]["columns"]
    vals = {}
    for c in cols:
        if c.get("pk") or c["name"] in overrides:
            continue
        t = (c.get("decl_type") or "").upper()
        if c.get("notnull") and c.get("default") is None:
            vals[c["name"]] = 100 if "INT" in t else 10.0 if any(x in t for x in ("REAL", "NUM", "DEC", "FLOAT", "DOUBLE")) else f"test {c['name']}"
    vals.update(overrides)
    with psycopg.connect(dsn, autocommit=True) as conn:
        names = ", ".join(f'"{k}"' for k in vals)
        marks = ", ".join(["%s"] * len(vals))
        return conn.execute(f'INSERT INTO "{table}" ({names}) VALUES ({marks}) RETURNING id', list(vals.values())).fetchone()[0]


def run_fresh(vault, package_dir, fresh_url, install_log, unit_tests_xml, dsn=None):
    scope = read_json(f"{vault}/scope.json")
    scenario = read_json(f"{vault}/scenario.json")
    pkg = Path(package_dir)
    out = []
    missing = [f for f in REQUIRED if not (pkg / f).exists()]
    out.append(result("package.contents", "app_starts", "The delivery package has the code, migrations, run book "
                      "and rollback guide", not missing, "all present", missing or "all present"))
    reqs = (pkg / "requirements.txt").read_text().splitlines() if (pkg / "requirements.txt").exists() else []
    unpinned = [r for r in reqs if r.strip() and not r.startswith("#") and "==" not in r]
    out.append(result("package.pinned", "app_starts", "Every dependency is pinned to an exact version",
                      bool(reqs) and not unpinned, "all pinned", unpinned or [r.strip() for r in reqs]))
    leftovers = []
    for p in (pkg / "app").rglob("*.py"):
        text = p.read_text()
        if re.search(r"^\s*(import sqlite3|from flask\b|import flask\b)", text, re.M):
            leftovers.append(str(p.relative_to(pkg)))
    out.append(result("package.no_flask_sqlite", "app_starts", "The upgraded app no longer imports Flask or sqlite3",
                      not leftovers, "none", leftovers or "none"))
    ok_install = install_log is not None and Path(install_log).exists() and "INSTALL OK" in Path(install_log).read_text()
    out.append(result("package.clean_install", "app_starts",
                      "The app installs from requirements.txt into a new, empty Python environment",
                      ok_install, "INSTALL OK", "INSTALL OK" if ok_install else "install failed or not run",
                      {"log": str(install_log)}))
    if unit_tests_xml and Path(unit_tests_xml).exists():
        xml = Path(unit_tests_xml).read_text()
        m = re.search(r'tests="(\d+)"[^>]*?failures="(\d+)"|failures="(\d+)"[^>]*?tests="(\d+)"', xml)
        tests = fails = errors = None
        tm = re.search(r'\btests="(\d+)"', xml)
        fm = re.search(r'\bfailures="(\d+)"', xml)
        em = re.search(r'\berrors="(\d+)"', xml)
        tests, fails, errors = (int(tm.group(1)) if tm else 0), (int(fm.group(1)) if fm else 0), (int(em.group(1)) if em else 0)
        out.append(result("package.unit_tests", "app_starts", f"The delivered unit tests pass ({tests} tests)",
                          tests > 0 and fails == 0 and errors == 0, "all pass",
                          f"{tests} tests, {fails} failures, {errors} errors"))
    else:
        out.append(result("package.unit_tests", "app_starts", "The delivered unit tests pass", False, "all pass",
                          "no test results"))
    h = http(fresh_url, "GET", "/healthz")
    out.append(result("package.starts_empty_db", "app_starts",
                      "The app starts from the package on an empty database created by its own migrations",
                      h["status"] == 200, 200, h["status"] or h.get("error")))
    # core business task on the empty database: customer, product, order, cancel
    steps = {s["title"]: s for s in scenario["steps"]}
    cust = next((s for s in scenario["steps"] if s.get("check") == "new_customer"), None)
    prod = next((s for s in scenario["steps"] if s["title"].startswith("Create test product A")), None)
    order = next((s for s in scenario["steps"] if s.get("check") == "below_threshold"), None)
    cancel = next((s for s in scenario["steps"] if s.get("check") == "cancel"), None)
    if not order:
        out.append(result("package.business_task", "app_starts", "Core business task on an empty database", False, None, None,
                          {"reason": "the app has no endpoint that places an order"}, skipped=True, mandatory=False,
                          reason="the app has no endpoint that places an order, so there is no order flow to run"))
        return out
    seeded = []
    assessment = read_json(f"{vault}/assessment.json")
    roles = scope.get("roles") or {}
    if cust:
        c = http(fresh_url, "POST", cust["path"], cust["body"])
    elif dsn and roles.get("customer"):
        c = {"status": 201, "body": {"id": seed_row(dsn, assessment, roles["customer"], {})}}
        seeded.append(roles["customer"])
    else:
        c = {"status": 201, "body": {"id": None}}
    if prod:
        p = http(fresh_url, "POST", prod["path"], prod["body"])
    elif dsn and roles.get("product"):
        p = {"status": 201, "body": {"id": seed_row(dsn, assessment, roles["product"], {roles["stock_column"]: 100} if roles.get("stock_column") else {})}}
        seeded.append(roles["product"])
    else:
        out.append(result("package.business_task", "app_starts", "Core business task on an empty database", False, None, None,
                          {"reason": "no way to create a product: no endpoint and no database access"}, skipped=True))
        return out
    ok = c["status"] == 201 and p["status"] == 201
    o = None
    if ok:
        body = order["body"]
        ck = next(k for k, v in body.items() if not isinstance(v, list))
        lk = next(k for k, v in body.items() if isinstance(v, list))
        line = dict(body[lk][0])
        pk_ = next(k for k, v in line.items() if v == "{pA}")
        line[pk_] = p["body"]["id"]
        o = http(fresh_url, "POST", order["path"], {ck: c["body"]["id"], lk: [line]})
        ok = o["status"] == 201
    x = None
    if ok and cancel:
        path = re.sub(r"\{o1\}", str(o["body"]["id"]), cancel["path"])
        x = http(fresh_url, "POST", path)
        ok = x["status"] == 200
    out.append(result("package.business_task", "app_starts",
                      "On an empty database: create a customer and a product, place an order, cancel it", ok,
                      "201, 201, 201, 200", ", ".join(str(r["status"]) for r in (c, p, o, x) if r),
                      {"reference_data_loaded_directly": seeded} if seeded else None))
    return out
