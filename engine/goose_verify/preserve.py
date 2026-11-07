"""Checks for upgrades that must keep behaviour exactly.

The same requests go to the original app and to the upgraded app, each on its own copy of the same data. The answers
must match, the data each leaves behind must match, the app's own tests must still pass, and outside scripts that
use the database must still work. Only differences the customer approved in the plan are allowed. Every check is
mandatory or optional; a skipped mandatory check fails the run.

Self-contained on purpose: imports nothing from goose_engine, the code that makes the changes.
"""
import html.parser
import http.cookiejar
import json
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .common import diff, read_json, sha256_file, write_json

VERIFIER_DIR = Path(__file__).resolve().parent
DATEISH = ("start", "date", "day", "from", "since", "on")
SAMPLE = {"name": "Test Visitor", "phone": "555-0199", "email": "test.visitor@example.org", "notes": "Goose check"}


# ------------------------------------------------------------------------------------------------ scenario

def _route_path(c):
    return c["name"].split(" ", 1)[1] if " " in c["name"] else c["name"]


def _rows(db, sql, args=()):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return c.execute(sql, args).fetchall()
    finally:
        c.close()


def web_scenario(insp, repo, db, today=None):
    """Requests for every page, form and JSON endpoint in the application map, with values taken from the data."""
    today = today or date.today()
    comps = {c["id"]: c for c in insp["components"]}
    routes = [c for c in insp["components"] if c["kind"] == "route"]
    handled = {e["from"]: e["to"] for e in insp["edges"] if e["kind"] == "handled by"}
    touches = {}
    for e in insp["edges"]:
        if e["kind"] in ("reads", "writes"):
            touches.setdefault(e["from"], set()).add(e["to"])
    tables = {c["id"]: c for c in insp["components"] if c["kind"] == "table"}
    children = {}
    for e in insp["edges"]:
        m = re.match(r"refers to \((\w+)\)", e["kind"])
        if m and e["from"] in tables and e["to"] in tables:
            children.setdefault(e["to"], []).append((tables[e["from"]]["attrs"].get("model") or "", e["from"][6:], m.group(1) + "_id"))
    steps, coverage, notes = [], {}, []

    def table_for(param, route):
        base = param[:-3] if param.endswith("_id") else param
        cands = [comps[t] for t in touches.get(handled.get(route["id"]), set()) if t in tables] or list(tables.values())
        for t in cands:
            if (t["attrs"].get("model") or "").lower() == base or t["id"].endswith("_" + base):
                return t["id"][6:]
        return None

    parents = {}
    for e in insp["edges"]:
        if e["kind"].startswith("refers to") and e["from"] in tables:
            parents.setdefault(e["from"], []).append(e["to"])

    def date_values(route):
        mine = [t for t in touches.get(handled.get(route["id"]), set()) if t in tables]
        for t in mine + [p for t in mine for p in parents.get(t, [])]:
            if t not in tables:
                continue
            name = t[6:]
            cols = [r[1] for r in _rows(db, f'PRAGMA table_info("{name}")') if re.search(r"date|time|_at$", r[1], re.I) and r[1] != "created_at"]
            for col in cols:
                days = [r[0] for r in _rows(db, f'SELECT DISTINCT substr("{col}", 1, 10) FROM "{name}" WHERE "{col}" IS NOT NULL ORDER BY 1')]
                if days:
                    future = [d for d in days if d >= today.isoformat()]
                    past = [d for d in days if d < today.isoformat()]
                    return [x for x in [(future or days)[0], (past or days)[-1]] if x][:2]
        return []

    def id_values(table):
        ids = [r[0] for r in _rows(db, f'SELECT id FROM "{table}" ORDER BY id')]
        if not ids:
            return {}
        out = {"first": ids[0], "missing": ids[-1] + 1000}
        kids = children.get(f"table:{table}", [])
        if kids:
            _, kid_table, fk = kids[0]
            used = {r[0] for r in _rows(db, f'SELECT DISTINCT "{fk}" FROM "{kid_table}"')}
            free = [i for i in ids if i not in used]
            taken = [i for i in ids if i in used]
            if free:
                out["free"] = free[len(free) // 2]
            if taken:
                out["taken"] = taken[len(taken) // 2]
        cols = [r[1] for r in _rows(db, f'PRAGMA table_info("{table}")')]
        if "status" in cols:
            for (val,) in _rows(db, f'SELECT DISTINCT status FROM "{table}" ORDER BY 1'):
                row = _rows(db, f'SELECT id FROM "{table}" WHERE status = ? ORDER BY id LIMIT 1', (val,))
                if row:
                    out[f"status:{val}"] = row[0][0]
        return out

    def query_args(route):
        fn = comps.get(handled.get(route["id"]))
        if not fn or not fn.get("file"):
            return []
        src = (Path(repo) / fn["file"]).read_text(errors="replace")
        return sorted(set(re.findall(r"request\.GET\.get\(\s*[\"'](\w+)[\"']", src)))

    for r in routes:
        path = _route_path(r)
        params = re.findall(r"\{(\w+)\}", path)
        if "GET" not in r["attrs"].get("methods", ["GET"]):
            continue
        variants = [{}]
        for p in params:
            if p.endswith("_id") or p in ("id", "pk"):
                t = table_for(p, r)
                vals = id_values(t) if t else {}
                picks = [vals[k] for k in ("free", "taken", "first") if k in vals][:2] + ([vals["missing"]] if "missing" in vals else [])
                picks += [v for k, v in vals.items() if k.startswith("status:") and v not in picks][:2]
                variants = [{**v, p: x} for v in variants for x in dict.fromkeys(picks)] or variants
            elif p in ("day", "date") or re.search(r"\\d\{4\}", r["attrs"].get("pattern") or ""):
                variants = [{**v, p: d} for v in variants for d in date_values(r)] or variants
        for v in variants:
            if any("{" + p + "}" not in path or p not in v for p in params):
                continue
            url = path
            for k, x in v.items():
                url = url.replace("{" + k + "}", str(x))
            steps.append({"id": f"s{len(steps) + 1}", "type": "get", "path": url, "route": r["id"]})
            coverage.setdefault(r["id"], 0)
            coverage[r["id"]] += 1
        for qa in query_args(r):
            if qa in DATEISH and not params:
                for d in date_values(r) or [today.isoformat()]:
                    steps.append({"id": f"s{len(steps) + 1}", "type": "get", "path": f"{path}?{qa}={d}", "route": r["id"]})
    # forms: submit each POST route once from the page that carries its form, then follow the redirect
    for r in routes:
        if "POST" not in r["attrs"].get("methods", []):
            continue
        path = _route_path(r)
        action = "^" + re.sub(r"\\\{\w+\\\}", r"[^/]+", re.escape(path)) + "$"
        if "GET" in r["attrs"]["methods"]:
            params = re.findall(r"\{(\w+)\}", path)
            t = table_for(params[0], r) if params else None
            vals = id_values(t) if t else {}
            for which in ("free", "taken"):
                if which not in vals and which == "taken":
                    continue
                pid = vals.get(which) or vals.get("first")
                page = re.sub(r"\{\w+\}", str(pid), path)
                sid = f"s{len(steps) + 1}"
                steps.append({"id": sid, "type": "get", "path": page, "route": r["id"]})
                steps.append({"id": f"s{len(steps) + 1}", "type": "form", "page": sid, "action": action, "route": r["id"],
                              "note": f"submit the form on a {which} record", "save_from_location": "created"})
                coverage[r["id"]] = coverage.get(r["id"], 0) + 1
        else:
            prev = next((s for s in reversed(steps) if s["type"] == "form"), None)
            if prev:
                steps.append({"id": f"s{len(steps) + 1}", "type": "form", "page": prev["id"] + ".then", "action": action, "route": r["id"],
                              "note": "submit the form found on the page the previous form led to"})
                coverage[r["id"]] = coverage.get(r["id"], 0) + 1
            else:
                notes.append(f"{r['name']}: no page with its form was reached")
    for r in routes:
        if "GET" in r["attrs"].get("methods", []) and "{created}" not in json.dumps(steps):
            path = _route_path(r)
            params = re.findall(r"\{(\w+)\}", path)
            if len(params) == 1 and params[0].endswith("_id") and r["attrs"].get("json"):
                steps.append({"id": f"s{len(steps) + 1}", "type": "get", "path": path.replace("{" + params[0] + "}", "{created}"),
                              "route": r["id"], "note": "the record the form created"})
    total = len(routes)
    covered = [k for k, n in coverage.items() if n]
    return {"kind": "web", "built_on": today.isoformat(), "steps": steps,
            "coverage": {"routes_total": total, "routes_covered": len(covered), "uncovered": [r["name"] for r in routes if r["id"] not in covered],
                         "notes": notes}}


# ------------------------------------------------------------------------------------------------ recording

class Forms(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms, self.cur = [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self.cur = {"action": a.get("action") or "", "method": (a.get("method") or "get").lower(), "fields": []}
            self.forms.append(self.cur)
        elif self.cur is not None and tag in ("input", "textarea", "select") and a.get("name"):
            self.cur["fields"].append({"name": a["name"], "type": (a.get("type") or tag).lower(), "value": a.get("value") or ""})

    def handle_endtag(self, tag):
        if tag == "form":
            self.cur = None


def _client():
    jar = http.cookiejar.CookieJar()

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect), jar


def _send(opener, base, method, path, form=None):
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"} if data else {})
    try:
        r = opener.open(req, timeout=20)
        status, raw, hdrs = r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        status, raw, hdrs = e.code, e.read(), dict(e.headers)
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        return {"status": None, "error": str(e)}
    text = raw.decode("utf-8", errors="replace")
    ctype = (hdrs.get("Content-Type") or hdrs.get("content-type") or "").split(";")[0]
    body = None
    if ctype == "application/json":
        try:
            body = json.loads(text)
        except ValueError:
            body = text
    else:
        body = text
    loc = hdrs.get("Location") or hdrs.get("location")
    return {"status": status, "content_type": ctype, "body": body, "location": urllib.parse.urlparse(loc).path if loc else None}


def web_record(base, scenario, timezone):
    opener, _ = _client()
    zone = ZoneInfo(timezone)
    started = datetime.now(zone).replace(microsecond=0)
    saved, pages, results = {}, {}, []

    def resolve(p):
        return re.sub(r"\{(\w+)\}", lambda m: str(saved.get(m.group(1), m.group(0))), p)

    for s in scenario["steps"]:
        if s["type"] == "get":
            res = _send(opener, base, "GET", resolve(s["path"]))
            results.append({"step": s["id"], "method": "GET", "path": resolve(s["path"]), **res})
            pages[s["id"]] = res.get("body") if isinstance(res.get("body"), str) else ""
            continue
        page = pages.get(s["page"], "")
        parser = Forms()
        parser.feed(page or "")
        form = next((f for f in parser.forms if f["method"] == "post" and re.match(s["action"], urllib.parse.urlparse(f["action"]).path or "")), None)
        if not form:
            results.append({"step": s["id"], "method": "POST", "path": None, "status": None, "error": "no matching form on the page"})
            continue
        data = {}
        for f in form["fields"]:
            if f["type"] in ("hidden", "submit"):
                data[f["name"]] = f["value"]
            elif f["type"] in ("text", "email", "tel", "textarea", "number", "date", "input"):
                data[f["name"]] = SAMPLE.get(f["name"], "1" if f["type"] == "number" else "test")
        action = urllib.parse.urlparse(form["action"]).path
        res = _send(opener, base, "POST", action, data)
        sent = {k: v for k, v in data.items() if "csrf" not in k}
        results.append({"step": s["id"], "method": "POST", "path": action, "form": sent, **res})
        if s.get("save_from_location") and res.get("location"):
            nums = re.findall(r"\d+", res["location"])
            if nums:
                saved[s["save_from_location"]] = nums[-1]
        if res.get("location") and res.get("status") in (301, 302, 303):
            follow = _send(opener, base, "GET", res["location"])
            results.append({"step": s["id"] + ".then", "method": "GET", "path": res["location"], **follow})
            pages[s["id"] + ".then"] = follow.get("body") if isinstance(follow.get("body"), str) else ""
    finished = datetime.now(zone).replace(microsecond=0)
    return {"started": started.isoformat(), "finished": finished.isoformat(), "timezone": timezone, "base_url": base,
            "saved": saved, "results": results}


# ------------------------------------------------------------------------------------------------ data

def dump_sqlite(db, skip=("django_session", "django_migrations", "sqlite_sequence")):
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = {}
    for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        if name in skip:
            continue
        cols = [r[1] for r in c.execute(f'PRAGMA table_info("{name}")')]
        key = "id" if "id" in cols else cols[0]
        out[name] = {"columns": cols, "rows": {str(r[cols.index(key)]): list(r) for r in c.execute(f'SELECT * FROM "{name}"')}}
    c.close()
    return out


def compare_dumps(a, b, windows):
    problems = []
    for table in sorted(set(a) | set(b)):
        if table not in a or table not in b:
            problems.append({"table": table, "problem": "missing in " + ("the upgraded copy" if table not in b else "the original copy")})
            continue
        ra, rb = a[table]["rows"], b[table]["rows"]
        if set(ra) != set(rb):
            problems.append({"table": table, "problem": "different rows", "only_original": sorted(set(ra) - set(rb))[:5],
                             "only_upgraded": sorted(set(rb) - set(ra))[:5]})
        ca, cb = a[table]["columns"], b[table]["columns"]
        for k in sorted(set(ra) & set(rb), key=lambda x: (len(x), x)):
            ea = dict(zip(ca, ra[k]))
            eb = dict(zip(cb, rb[k]))
            d = diff(normal_row(ea), normal_row(eb), f"{table}[{k}]", windows=windows)
            if d:
                problems.append({"table": table, "row": k, "differences": d[:3]})
                if len(problems) > 40:
                    return problems
    return problems


def normal_row(r):
    out = {}
    for k, v in r.items():
        if isinstance(v, int) and not isinstance(v, bool) and k.endswith(("_sent", "_flag", "is_", "active")):
            v = bool(v)
        out[k] = v
    return out


# ------------------------------------------------------------------------------------------------ freeze / compare / report

def checks_for(plan, scenario, has_tests, scripts, kind):
    c = [("compat.coverage", "compatibility", "Every page and endpoint was exercised", True)]
    c += [(f"compat.{s['id']}", "compatibility", f"{s.get('method', 'GET')} {s['path']} answers as before", True)
          for s in scenario.get("steps", []) if s.get("type", "get") != "form"]
    c += [(f"compat.{s['id']}", "compatibility", f"Form on {s['page']} works as before", True) for s in scenario.get("steps", []) if s.get("type") == "form"]
    c.append(("records.after_scenario", "records", "Every row matches after the same requests", True))
    if any(d["id"] == "D-double-booking" for d in plan.get("intended_differences") or []):
        c.append(("fix.taken-slot", "fix", "Booking a slot that already has a booking is refused and saves nothing", True))
    if has_tests:
        c.append(("tests.own", "tests", "The application's own tests pass", True))
    for s in scripts:
        c.append((f"scripts.{s}", "connections", f"{s} still runs and changes the data the same way", True))
    if kind == "django":
        c += [("django.check", "framework", "Django system check passes", True),
              ("django.migrations", "framework", "Every model change has a migration", True),
              ("django.migrate_copy", "records", "Migrations apply cleanly to a copy of the data", True)]
    c += [("app.clean_install", "app_starts", "Installs from scratch from its requirements", True),
          ("app.empty_start", "app_starts", "Starts on an empty database", True)]
    approved = [d["id"] for d in plan.get("intended_differences") or []]
    return [{"id": i, "category": cat, "title": t, "mandatory": m} for i, cat, t, m in c], approved


def freeze_preserve(vault, plan_path, scenario_path, baseline_path, baseline_dump_path, tests_path, scripts_path, source_db, job_id, kind):
    vault = Path(vault)
    vault.mkdir(parents=True, exist_ok=True)
    plan, scenario = read_json(plan_path), read_json(scenario_path)
    tests = read_json(tests_path) if tests_path and Path(tests_path).exists() else None
    scripts = read_json(scripts_path) if scripts_path and Path(scripts_path).exists() else {}
    if scenario.get("kind") != "web":   # the order-domain scenario from scenario.py: steps are JSON requests
        scenario = {**scenario, "steps": [{**s, "type": "get" if s["method"] == "GET" else "json"} for s in scenario["steps"]]}
    checks, approved = checks_for(plan, scenario, bool(tests), list(scripts), kind)
    write_json(vault / "plan.json", {"intended_differences": plan.get("intended_differences") or [], "approved": approved,
                                     "recipe": plan.get("recommended"), "kind": kind})
    write_json(vault / "scenario.json", scenario)
    write_json(vault / "baseline.json", read_json(baseline_path))
    write_json(vault / "baseline_dump.json", read_json(baseline_dump_path))
    write_json(vault / "baseline_tests.json", tests or {})
    write_json(vault / "baseline_scripts.json", scripts)
    write_json(vault / "checks.json", checks)
    files = {p.name: sha256_file(p) for p in sorted(vault.glob("*.json")) if p.name != "MANIFEST.json"}
    code = {p.name: sha256_file(p) for p in sorted(VERIFIER_DIR.glob("*.py"))}
    manifest = {"job_id": job_id, "profile": "preserve", "frozen_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "source_db_sha256": sha256_file(source_db) if source_db and Path(source_db).exists() else None,
                "files": files, "verifier_code": code}
    write_json(vault / "MANIFEST.json", manifest)
    for p in vault.glob("*.json"):
        p.chmod(0o444)
    return sha256_file(vault / "MANIFEST.json"), {"files": list(files), "checks": len(checks)}


def _norm_html(text):
    text = re.sub(r'(name="csrfmiddlewaretoken"\s+value=")[^"]*"', r'\1"', text or "")
    text = re.sub(r'(value=")[^"]*("\s+name="csrfmiddlewaretoken")', r'\1\2', text)
    return re.sub(r">\s+<", "><", re.sub(r"\s+", " ", text)).strip()


def _windows(a, b, zone):
    def w(r):
        s, f = datetime.fromisoformat(r["started"]), datetime.fromisoformat(r["finished"])
        return (s - timedelta(minutes=1), f + timedelta(minutes=1), zone)
    return (w(a), w(b))


def compare(vault, recording_path, dump_path, tests_path, scripts_path, framework_path, app_path, timezone):
    vault = Path(vault)
    checks = {c["id"]: c for c in read_json(vault / "checks.json")}
    plan = read_json(vault / "plan.json")
    base, rec = read_json(vault / "baseline.json"), read_json(recording_path)
    windows = _windows(base, rec, timezone)
    approved = set(plan["approved"])
    res = []

    def add(cid, status, expected=None, actual=None, evidence=None, reason=None):
        c = checks.get(cid) or {"id": cid, "category": "other", "title": cid, "mandatory": True}
        res.append({"id": cid, "category": c["category"], "title": c["title"], "mandatory": c["mandatory"], "status": status,
                    "expected": expected, "actual": actual, "evidence": evidence or {}, **({"reason": reason} if reason else {})})

    by_a = {r["step"]: r for r in base["results"]}
    by_b = {r["step"]: r for r in rec["results"]}
    seen_routes = set()
    steps = {x["id"]: x for x in read_json(vault / "scenario.json").get("steps", [])}
    taken = set()
    if "D-double-booking" in approved:
        taken = {i for i, x in steps.items() if x.get("type") == "form" and "taken record" in (x.get("note") or "")}
        follow = {i for i, x in steps.items() if (x.get("page") or "").split(".")[0] in taken or "{created}" in (x.get("path") or "")}
        excluded = taken | follow
    else:
        excluded = set()
    for sid, ra in by_a.items():
        if sid.split(".")[0] in excluded:
            continue
        cid = f"compat.{sid.split('.')[0]}"
        if cid not in checks and not sid.endswith(".then"):
            continue
        rb = by_b.get(sid)
        if rb is None:
            add(cid, "fail", ra.get("status"), "<no answer>", {"path": ra.get("path")})
            continue
        problems = []
        if ra.get("status") != rb.get("status"):
            problems.append({"what": "status", "expected": ra.get("status"), "actual": rb.get("status")})
        if (ra.get("location") or None) != (rb.get("location") or None):
            problems.append({"what": "redirect", "expected": ra.get("location"), "actual": rb.get("location")})
        ba, bb = ra.get("body"), rb.get("body")
        if isinstance(ba, (dict, list)) or isinstance(bb, (dict, list)):
            d = diff(ba, bb, "$", windows=windows)
            if d:
                problems.append({"what": "json", "differences": d[:5]})
        elif _norm_html(ba) != _norm_html(bb):
            if (ra.get("status") or 0) >= 400 and ra.get("status") == rb.get("status") and "D-error-pages" in approved:
                pass
            else:
                problems.append({"what": "page", "expected": _norm_html(ba)[:300], "actual": _norm_html(bb)[:300]})
        if not sid.endswith(".then"):
            add(cid, "fail" if problems else "pass", ra.get("status"), rb.get("status"), {"path": ra.get("path"), "problems": problems})
        elif problems:
            for r in res:
                if r["id"] == cid:
                    r["status"] = "fail"
                    r["evidence"].setdefault("problems", []).extend(problems)
        if ra.get("status") and ra.get("status") < 500:
            seen_routes.add(sid)
    scen = read_json(vault / "scenario.json")
    cov = scen.get("coverage") or {}
    uncovered = cov.get("uncovered") or cov.get("uncovered_routes") or []
    short = (cov.get("routes_covered") or 0) < (cov.get("routes_total") or 0)
    add("compat.coverage", "fail" if uncovered or short else "pass", cov.get("routes_total"), cov.get("routes_covered"),
        {"uncovered": uncovered, "notes": cov.get("notes")})
    dump_a, dump_b = read_json(vault / "baseline_dump.json"), read_json(dump_path)
    if taken:
        # the original saved a second booking on the taken slot; the fixed app must not, and nothing else may differ
        ids = set()
        for i in taken:
            page = steps.get(steps[i].get("page") or "", {}).get("path") or ""
            ids |= set(re.findall(r"/(\d+)/", page))
        allowed, stray = [], []
        for t, data in dump_a.items():
            cols = data["columns"]
            for k, row in list(data["rows"].items()):
                if k in (dump_b.get(t) or {}).get("rows", {}):
                    continue
                r = dict(zip(cols, row))
                if any(c.endswith("slot_id") and str(v) in ids for c, v in r.items()):
                    allowed.append({"table": t, "row": k})
                    del data["rows"][k]
        for t, data in dump_b.items():
            cols = data["columns"]
            for k, row in data["rows"].items():
                if k not in (dump_a.get(t) or {}).get("rows", {}) and any(c.endswith("slot_id") and str(v) in ids for c, v in dict(zip(cols, row)).items()):
                    stray.append({"table": t, "row": k})
        answers = [by_b.get(i) or {} for i in taken]
        ok = bool(allowed) and not stray and all((x.get("status") or 500) < 500 for x in answers)
        add("fix.taken-slot", "pass" if ok else "fail", "the original saved a second booking; the fixed app saves none",
            f"{len(allowed)} booking(s) not saved, {len(stray)} new booking(s) on the taken slot",
            {"taken_slot": sorted(ids), "not_saved": allowed[:5], "saved_anyway": stray[:5],
             "answers": [{"status": x.get("status"), "location": x.get("location")} for x in answers]})
    problems = compare_dumps(dump_a, dump_b, windows)
    add("records.after_scenario", "fail" if problems else "pass", "same rows", f"{len(problems)} difference(s)", {"problems": problems[:10]})
    if "tests.own" in checks:
        ta, tb = read_json(vault / "baseline_tests.json"), read_json(tests_path) if tests_path and Path(tests_path).exists() else None
        if tb is None:
            add("tests.own", "skip", reason="the upgraded app's tests were not run")
        elif ta.get("exit") != 0:
            checks["tests.own"]["mandatory"] = False
            add("tests.own", "pass" if tb.get("exit") == 0 else "skip", "fails on the original app too", tb.get("summary"),
                reason="the tests already fail on the original app, so they cannot prove anything")
        else:
            add("tests.own", "pass" if tb.get("exit") == 0 else "fail", ta.get("summary"), tb.get("summary"), {"output": (tb.get("tail") or "")[-800:]})
    sa = read_json(vault / "baseline_scripts.json")
    sb = read_json(scripts_path) if scripts_path and Path(scripts_path).exists() else {}
    for name, r in sa.items():
        x = sb.get(name)
        if not x:
            add(f"scripts.{name}", "skip", reason="not run against the upgraded copy")
            continue
        d = compare_dumps(r["dump"], x["dump"], None) if r.get("dump") and x.get("dump") else []
        ok = r.get("exit") == x.get("exit") == 0 and not d
        add(f"scripts.{name}", "pass" if ok else "fail", r.get("exit"), x.get("exit"), {"differences": d[:5], "output": (x.get("tail") or "")[-400:]})
    fw = read_json(framework_path) if framework_path and Path(framework_path).exists() else {}
    for key in ("django.check", "django.migrations", "django.migrate_copy"):
        if key in checks:
            r = fw.get(key)
            add(key, "skip" if r is None else "pass" if r.get("exit") == 0 else "fail", 0, None if r is None else r.get("exit"),
                {"output": (r or {}).get("tail", "")[-600:]}, reason=None if r else "not run")
    app = read_json(app_path) if app_path and Path(app_path).exists() else {}
    for key in ("app.clean_install", "app.empty_start"):
        r = app.get(key)
        add(key, "skip" if r is None else "pass" if r.get("ok") else "fail", True, None if r is None else r.get("ok"),
            {"detail": (r or {}).get("detail")}, reason=None if r else "not run")
    return res


def report_preserve(vault, inputs, attempt, integrity):
    vault = Path(vault)
    manifest, plan, scen = read_json(vault / "MANIFEST.json"), read_json(vault / "plan.json"), read_json(vault / "scenario.json")
    results = []
    for f in inputs:
        results += read_json(f)
    mandatory_bad = [r for r in results if r.get("mandatory", True) and r["status"] != "pass"]
    failed = [r for r in results if r["status"] == "fail" or (r["status"] == "skip" and r.get("mandatory", True))]
    by_cat = {}
    for r in results:
        c = by_cat.setdefault(r["category"], {"pass": 0, "fail": 0, "skip": 0})
        c[r["status"]] += 1
    rep = {"generated_at": datetime.now().astimezone().isoformat(timespec="seconds"), "attempt": attempt, "integrity": integrity,
           "profile": "preserve", "frozen_manifest": {"frozen_at": manifest["frozen_at"], "source_db_sha256": manifest["source_db_sha256"]},
           "summary": {"total": len(results), "passed": sum(1 for r in results if r["status"] == "pass"), "failed": len(failed),
                       "skipped": sum(1 for r in results if r["status"] == "skip"),
                       "mandatory_total": sum(1 for r in results if r.get("mandatory", True)),
                       "optional_skipped": [{"id": r["id"], "reason": r.get("reason")} for r in results if r["status"] == "skip" and not r.get("mandatory", True)],
                       "verdict": "pass" if integrity["ok"] and not mandatory_bad and results else "fail"},
           "by_category": {k: {**v, "title": TITLES.get(k, k)} for k, v in by_cat.items()},
           "failed": failed, "results": results, "coverage": scen.get("coverage"),
           "intentional_differences": plan["intended_differences"],
           "not_tested": ["Requests the scenario does not send; only the recorded requests and the pages they reach are compared.",
                          "How the app behaves under load, and your hosting setup.",
                          "Passing these checks does not prove every possible behaviour is correct."]}
    return rep, markdown(rep)


TITLES = {"compatibility": "Old and new app give the same answers", "records": "The data is the same", "tests": "Your own tests",
          "connections": "Existing connections still work", "framework": "Framework checks", "app_starts": "The delivered app starts"}


def markdown(rep):
    s = rep["summary"]
    lines = [f"# Verification report (behaviour kept)", "", f"Attempt {rep['attempt']} - {rep['generated_at']}", "",
             f"**Verdict: {'PASS' if s['verdict'] == 'pass' else 'FAIL'}** - {s['passed']} of {s['total']} checks passed, "
             f"{s['failed']} failed or mandatory-skipped, {s['skipped']} skipped.", "",
             f"Frozen checks: integrity {'confirmed' if rep['integrity']['ok'] else 'FAILED'}.", "",
             "| Area | Passed | Failed | Skipped |", "| --- | --- | --- | --- |"]
    for k, v in rep["by_category"].items():
        lines.append(f"| {v['title']} | {v['pass']} | {v['fail']} | {v['skip']} |")
    if rep["intentional_differences"]:
        lines += ["", "## Approved differences", ""] + [f"- **{d['title']}** - {d.get('reason', '')}" for d in rep["intentional_differences"]]
    if s["optional_skipped"]:
        lines += ["", "## Optional checks skipped", ""] + [f"- {x['id']}: {x['reason']}" for x in s["optional_skipped"]]
    if rep["failed"]:
        lines += ["", "## Failed", ""] + [f"- {r['id']}: {r['title']} - {json.dumps(r.get('evidence'))[:300]}" for r in rep["failed"]]
    lines += ["", "## Not tested", ""] + [f"- {x}" for x in rep["not_tested"]]
    return "\n".join(lines) + "\n"
