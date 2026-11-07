"""Inspect a submitted application: what it is built with, what it is made of, what it connects to, and what is
wrong with it. Produces the application map that plans are built on. Facts only, each tied to a file and line or
to an observation in the data; no decisions. Never imports or runs the customer's code.

Usage:  python -m goose_engine.inspect_app --repo DIR [--db FILE] [--timezone TZ] [--latest JSON] --out inspection.json
"""
import argparse
import ast
import datetime
import re
import sqlite3
from pathlib import Path

from . import analyze, codeinfo, sqltools
from .util import emit, read_json, write_json

SKIP_DIRS = {".git", "__pycache__", "venv", ".venv", "env", "node_modules", "site-packages", ".mypy_cache"}
LANGS = {".rs": "Rust", ".py": "Python", ".php": "PHP", ".js": "JavaScript", ".ts": "TypeScript", ".rb": "Ruby", ".java": "Java",
         ".cs": "C#", ".go": "Go", ".html": "HTML templates", ".sql": "SQL"}
# end of upstream support (month), from the projects' published release policies
PYTHON_EOL = {"3.8": "2024-10", "3.9": "2025-10", "3.10": "2026-10", "3.11": "2027-10", "3.12": "2028-10", "3.13": "2029-10"}
DJANGO_EOL = {"2.2": "2022-04", "3.0": "2021-04", "3.1": "2021-12", "3.2": "2024-04", "4.0": "2023-04", "4.1": "2023-12",
              "4.2": "2026-04", "5.0": "2025-04", "5.1": "2025-12", "5.2": "2028-04", "6.0": "2027-04", "6.1": "2027-12"}
# Django APIs removed between 3.2 and 5.2 that a code base may still use (Django release notes)
DJANGO_REMOVALS = [
    (r"from django\.conf\.urls import [^\n]*\burl\b|\burl\(r?[\"']", "url() for URL patterns", "4.0", True),
    (r"\bugettext(_lazy|_noop)?\b|\bungettext(_lazy)?\b", "ugettext / ungettext translation functions", "4.0", True),
    (r"\bNullBooleanField\b", "NullBooleanField", "4.0", True),
    (r"\bforce_text\b|\bsmart_text\b", "force_text / smart_text", "4.0", True),
    (r"\.is_ajax\(\)", "request.is_ajax()", "4.0", False),
    (r"^default_app_config\s*=", "default_app_config", "4.1", True),
    (r"(?<!datetime\.)\btimezone\.utc\b", "django.utils.timezone.utc", "5.0", True),
    (r"\bindex_together\b", "Meta.index_together", "5.1", True),
    (r"\bis_dst\s*=", "is_dst arguments (pytz)", "5.0", False),
]


def rel(p, repo):
    return str(Path(p).relative_to(repo))


def source_files(repo):
    out = []
    for p in sorted(repo.rglob("*")):
        r = p.relative_to(repo)
        if p.is_file() and not any(part in SKIP_DIRS or part.startswith(".") for part in r.parts):
            out.append(p)
    return out


def line_of(text, pattern, flags=re.M):
    m = re.search(pattern, text, flags)
    return text.count("\n", 0, m.start()) + 1 if m else None


class Map:
    def __init__(self):
        self.components, self.edges, self.findings = {}, [], []

    def add(self, cid, kind, name, summary="", file=None, line=None, group=None, **attrs):
        if cid not in self.components:
            self.components[cid] = {"id": cid, "kind": kind, "name": name, "summary": summary, "file": file,
                                    "line": line, "group": group or kind, "attrs": attrs}
        return cid

    def link(self, a, b, kind):
        if a in self.components and b in self.components and (a, b, kind) not in {(e["from"], e["to"], e["kind"]) for e in self.edges}:
            self.edges.append({"from": a, "to": b, "kind": kind})

    def find(self, severity, area, title, detail, evidence=(), components=(), fid=None, **extra):
        self.findings.append({"id": fid or f"F{len(self.findings) + 1}", "severity": severity, "area": area, "title": title,
                              "detail": detail, "evidence": list(evidence), "component_ids": [c for c in components if c], **extra})


# ------------------------------------------------------------------------------------------------ shared facts

def pins_and_python(repo):
    pins, py = {}, None
    for name in ("requirements.txt", "requirements/base.txt", "requirements/prod.txt"):
        p = repo / name
        if p.exists():
            for i, line in enumerate(p.read_text().splitlines(), 1):
                m = re.match(r"^\s*([A-Za-z0-9_.\-\[\]]+)\s*==\s*([\w.\-]+)", line)
                if m:
                    pins[m.group(1).split("[")[0].lower()] = {"version": m.group(2), "file": name, "line": i}
    for name in ("runtime.txt", ".python-version"):
        p = repo / name
        if p.exists():
            m = re.search(r"(\d+\.\d+)", p.read_text())
            if m:
                py = {"version": m.group(1), "file": name, "line": 1}
    return pins, py


def env_vars(modules, repo):
    found = {}
    for m in modules:
        for i, line in enumerate(m.lines, 1):
            for v in re.findall(r"os\.(?:environ\.get|getenv)\(\s*[\"']([A-Z0-9_]+)[\"']|os\.environ\[\s*[\"']([A-Z0-9_]+)[\"']", line):
                name = v[0] or v[1]
                found.setdefault(name, {"file": str(m.rel), "line": i, "text": line.strip()})
    return found


def documented_clients(repo, files):
    """Sentences in the docs or comments saying who else uses this application."""
    out = []
    pat = re.compile(r"(call[s]? (it|this)|poll[s]?|read[s]? by|used by|run[s]? by cron|from cron|kiosk|front-end|frontend|"
                     r"warehouse scripts|webhook|integration)", re.I)
    for p in files:
        if p.suffix.lower() not in (".md", ".txt", ".rst") or p.stat().st_size > 200_000:
            continue
        lines = p.read_text(errors="replace").splitlines()
        para, start = [], 1
        for i, line in enumerate(lines + [""], 1):
            if line.strip() and not line.lstrip().startswith(("#", ">", "    ", "-", "|")):
                if not para:
                    start = i
                para.append(line.strip())
                continue
            for sentence in re.split(r"(?<=[.!?])\s+", " ".join(para)):
                if pat.search(sentence) and len(sentence) < 260:
                    out.append({"file": rel(p, repo), "line": start, "text": sentence})
            para = []
    return out


def sqlite_tables(db):
    if not db:
        return {}
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    out = {}
    for (name,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        cols = [{"name": r[1], "type": r[2], "notnull": bool(r[3]), "pk": bool(r[5])} for r in c.execute(f'PRAGMA table_info("{name}")')]
        fks = [{"column": r[3], "table": r[2], "to": r[4]} for r in c.execute(f'PRAGMA foreign_key_list("{name}")')]
        out[name] = {"rows": c.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0], "columns": cols, "foreign_keys": fks}
    c.close()
    return out


def outside_scripts(m, repo, modules, app_modules, tables):
    """Python files that are not part of the web app but open the database directly (cron jobs, one-off tools)."""
    for mod in modules:
        if str(mod.rel) in app_modules or codeinfo.is_test_file(mod.rel) or "migrations" in mod.rel.parts:
            continue
        if "sqlite3" not in mod.imports:
            continue
        cid = m.add(f"script:{mod.rel}", "script", str(mod.rel), first_doc(mod) or "Script that opens the database directly",
                    str(mod.rel), 1, group="connections")
        m.link(cid, "db:main", "connects")
        for fn in [n for n in ast.walk(mod.tree) if isinstance(n, ast.Call)]:
            if isinstance(fn.func, ast.Attribute) and fn.func.attr in ("execute", "executemany") and fn.args:
                text = codeinfo.const_str(fn.args[0])
                if text:
                    info = sqltools.parse(text)
                    for t in info["tables"]:
                        if f"table:{t}" in m.components:
                            m.link(cid, f"table:{t}", "writes" if info["kind"] in ("INSERT", "UPDATE", "DELETE") else "reads")


def first_doc(mod):
    d = ast.get_docstring(mod.tree)
    return d.strip().splitlines()[0] if d else None


def add_runtime(m, pins, py, framework, version):
    bits = [f"Python {py['version']}" if py else "Python (version not pinned)"]
    if framework:
        bits.append(f"{framework} {version or '?'}")
    cid = m.add("runtime:python", "runtime", ", ".join(bits), f"{len(pins)} pinned packages",
                (py or {}).get("file") or "requirements.txt", (py or {}).get("line"), group="code",
                python=(py or {}).get("version"), pins={k: v["version"] for k, v in pins.items()})
    return cid


def eol_findings(m, py, framework, fw_version, today):
    if py and PYTHON_EOL.get(py["version"]) and PYTHON_EOL[py["version"]] <= today[:7]:
        m.find("medium", "dependencies", f"Python {py['version']} is past end of life",
               f"Upstream security fixes for Python {py['version']} ended in {PYTHON_EOL[py['version']]}.",
               [{"file": py["file"], "line": py["line"], "text": f"python-{py['version']}"}], ["runtime:python"])
    if framework == "Django" and fw_version:
        series = ".".join(fw_version.split(".")[:2])
        if DJANGO_EOL.get(series) and DJANGO_EOL[series] <= today[:7]:
            m.find("high", "dependencies", f"Django {series} no longer receives security fixes",
                   f"Django {series} support ended in {DJANGO_EOL[series]}. The current long-term support release is 5.2 "
                   "(supported until April 2028).", [{"file": "requirements.txt", "text": f"Django=={fw_version}"}], ["runtime:python"])


# ------------------------------------------------------------------------------------------------ Flask

def flask_map(m, repo, db, tz, latest, modules):
    a = analyze.assess(str(repo), db, tz, latest)
    fns = {}
    for mod in modules:
        for name, fn in mod.functions.items():
            fns[(str(mod.rel), name)] = (mod, fn)
    m.add("api:http", "interface", f"HTTP API ({len(a['routes'])} endpoints)", "Flask routes returning JSON", group="entry")
    m.add("db:main", "database", "SQLite database file", database_summary(a), group="data",
          env_vars=a["app"]["database_location"].get("env_vars"), default_path=a["app"]["database_location"].get("default_path"))
    for name, t in a["tables"].items():
        m.add(f"table:{name}", "table", name, f"{t['row_count']:,} rows, {len(t['columns'])} columns" if t.get("row_count") is not None
              else f"{len(t['columns'])} columns", "schema.sql" if (repo / "schema.sql").exists() else None, group="data",
              rows=t.get("row_count"), columns=[c["name"] for c in t["columns"]])
        m.link(f"table:{name}", "db:main", "stored in")
    for r in a["routes"]:
        rid = m.add(f"route:{' '.join(r['methods'])} {r['path']}", "route", f"{'/'.join(r['methods'])} {r['path']}",
                    route_summary(r), r["module"], r["line"], group="entry", methods=r["methods"], route_kind=r["kind"])
        m.link("api:http", rid, "serves")
        fid = m.add(f"fn:{r['module']}:{r['function']}", "function", f"{r['function']}()", f"Handles {'/'.join(r['methods'])} {r['path']}",
                    r["module"], r["line"], group="code")
        m.link(rid, fid, "handled by")
        for s in r["sql"]:
            info = sqltools.parse(s["text"])
            for t in info["tables"]:
                m.link(fid, f"table:{t}", "writes" if info["kind"] in ("INSERT", "UPDATE", "DELETE", "REPLACE") else "reads")
        for h in r["helpers"]:
            hit = next(((k, v) for k, v in fns.items() if k[1] == h), None)
            if hit:
                hid = m.add(f"fn:{hit[0][0]}:{h}", "function", f"{h}()", first_line_doc(hit[1][1]) or "Helper", hit[0][0],
                            hit[1][1].lineno, group="code")
                m.link(fid, hid, "calls")
                for call, text, _ in codeinfo.execute_calls(hit[1][1]):
                    if text:
                        for t in sqltools.parse(text)["tables"]:
                            m.link(hid, f"table:{t}", "reads" if sqltools.parse(text)["kind"] in ("SELECT", "WITH") else "writes")
                if h == "get_db":
                    m.link(hid, "db:main", "connects")
    for r in a.get("rules") or []:
        tiers = "; ".join(f"{float(t['rate']) * 100:g}% off from {float(t['min']):g}" for t in r["tiers"])
        stale = [n for n in r.get("notes", []) if n["kind"] == "stale_comment"]
        rid = m.add(f"rule:{r['id']}", "rule", "Discount rule", tiers + (f" (a comment says {stale[0]['comment_percent']:g}%)" if stale else ""),
                    r["module"], r["line"], group="code", checked_orders=(r.get("history") or {}).get("checked"))
        m.link(f"fn:{r['module']}:{r['function']}", rid, "applies")
    for t in a["app"].get("test_modules") or []:
        src = (repo / t).read_text(errors="replace")
        n = len(re.findall(r"^\s*def test", src, re.M))
        tid = m.add(f"test:{t}", "test", t, f"{n} test function{'s' if n != 1 else ''}", t, 1, group="code")
        for r in a["routes"]:
            if re.search(r"[\"']" + re.escape(re.sub(r"\{\w+\}", "", r["path"]).rstrip("/") or "/") , src):
                m.link(tid, f"route:{' '.join(r['methods'])} {r['path']}", "tests")
    for v in a["app"]["database_location"].get("env_vars") or []:
        m.add(f"cfg:{v}", "setting", v, "Environment variable that chooses the database file", group="code")
        m.link(f"cfg:{v}", "db:main", "configures")
    for f in a["findings"]:
        m.find(f["severity"], f["area"], f["title"], f["detail"], flask_evidence(f["evidence"]),
               link_finding(m, f, a, fns), fid=f["id"])
    return a


def database_summary(a):
    d = a.get("database") or {}
    if not d:
        return "No database copy supplied"
    return f"{a['size']['rows']:,} rows in {a['size']['tables']} tables ({d.get('bytes', 0) // 1024} KB, integrity {d.get('integrity')})"


def first_line_doc(fn):
    d = ast.get_docstring(fn)
    return d.strip().splitlines()[0] if d else None


def route_summary(r):
    reads, writes = set(), set()
    for s in r["sql"]:
        info = sqltools.parse(s["text"])
        (writes if info["kind"] in ("INSERT", "UPDATE", "DELETE", "REPLACE") else reads).update(info["tables"])
    bits = []
    if writes:
        bits.append("changes " + ", ".join(sorted(writes)))
    if reads - writes:
        bits.append("reads " + ", ".join(sorted(reads - writes)))
    return (r["kind"].replace("_", " ").capitalize() + ": " if r["kind"] not in ("get", "list", "index") else "") + ("; ".join(bits) or "no database access")


def flask_evidence(items):
    out = []
    for e in items:
        m = re.match(r"^([\w./-]+\.(?:py|txt|sql|md)):?(\d+)?\s*(.*)$", e)
        if m:
            out.append({"file": m.group(1), "line": int(m.group(2)) if m.group(2) else None, "text": m.group(3) or None})
        else:
            out.append({"observed": e})
    return out


def link_finding(m, f, a, fns):
    ids = set()
    for e in flask_evidence(f["evidence"]):
        if e.get("file") and e.get("line"):
            for (module, name), (_, fn) in fns.items():
                if module == e["file"] and fn.lineno <= e["line"] <= (fn.end_lineno or fn.lineno) and f"fn:{module}:{name}" in m.components:
                    ids.add(f"fn:{module}:{name}")
            for c in m.components.values():
                if c["kind"] == "rule" and c["file"] == e["file"] and abs((c["line"] or 0) - e["line"]) <= 40:
                    ids.add(c["id"])
        elif e.get("file"):
            ids.update(c["id"] for c in m.components.values() if c["file"] == e["file"] and c["kind"] == "test")
    text = f"{f['title']} {f['detail']}"
    for t in a["tables"]:
        if re.search(rf"\b{re.escape(t)}\b", text):
            ids.add(f"table:{t}")
    if f["area"] == "dependencies":
        ids.add("runtime:python")
    return sorted(ids)


# ------------------------------------------------------------------------------------------------ Django

def literal(node):
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def django_map(m, repo, db, modules, files):
    settings_mod = next((x for x in modules if any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "INSTALLED_APPS"
                                                                                   for t in n.targets) for n in x.tree.body)), None)
    settings = {}
    if settings_mod:
        for n in settings_mod.tree.body:
            if isinstance(n, ast.Assign):
                for t in n.targets:
                    if isinstance(t, ast.Name):
                        settings[t.id] = {"line": n.lineno, "value": literal(n.value), "src": ast.get_source_segment(settings_mod.source, n.value)}
    sfile = str(settings_mod.rel) if settings_mod else None
    apps = [a for a in (settings.get("INSTALLED_APPS", {}).get("value") or []) if not a.startswith("django.")]
    db_cfg = (settings.get("DATABASES") or {}).get("src") or ""
    engine = re.search(r"backends\.(\w+)", db_cfg)
    m.add("api:http", "interface", "Web pages and JSON endpoints", "Served by Django (URL patterns in ROOT_URLCONF)", group="entry")
    eng = (engine.group(1) if engine else "unknown").replace("sqlite3", "sqlite")
    m.add("db:main", "database", f"{'SQLite' if eng == 'sqlite' else eng} database", "", sfile, (settings.get("DATABASES") or {}).get("line"),
          group="data", engine=eng)
    for v, ev in env_vars([settings_mod] if settings_mod else [], repo).items():
        m.add(f"cfg:{v}", "setting", v, ev["text"], ev["file"], ev["line"], group="code")
        if v in db_cfg:
            m.link(f"cfg:{v}", "db:main", "configures")
    # models
    models = {}
    for mod in modules:
        if mod.rel.name != "models.py":
            continue
        app = mod.rel.parent.name
        for n in mod.tree.body:
            if isinstance(n, ast.ClassDef) and any(codeinfo.dotted(b).endswith("Model") for b in n.bases):
                fields, fks, db_table = [], [], None
                for s in n.body:
                    if isinstance(s, ast.Assign) and isinstance(s.value, ast.Call) and isinstance(s.targets[0], ast.Name):
                        kind = codeinfo.dotted(s.value.func).split(".")[-1]
                        fields.append({"name": s.targets[0].id, "type": kind, "line": s.lineno,
                                       "choices": any(k.arg == "choices" for k in s.value.keywords),
                                       "auto": any(k.arg in ("auto_now", "auto_now_add") for k in s.value.keywords)})
                        if kind in ("ForeignKey", "OneToOneField") and s.value.args:
                            fks.append((s.targets[0].id, codeinfo.dotted(s.value.args[0])))
                    if isinstance(s, ast.ClassDef) and s.name == "Meta":
                        for x in s.body:
                            if isinstance(x, ast.Assign) and getattr(x.targets[0], "id", "") == "db_table":
                                db_table = literal(x.value)
                table = db_table or f"{app}_{n.name.lower()}"
                models[n.name] = {"app": app, "table": table, "fields": fields, "fks": fks, "file": str(mod.rel), "line": n.lineno}
    tables = sqlite_tables(db)
    for name, md in models.items():
        t = tables.get(md["table"], {})
        m.add(f"table:{md['table']}", "table", f"{name} ({md['table']})",
              (f"{t['rows']:,} rows, " if t else "") + f"{len(md['fields'])} fields", md["file"], md["line"], group="data",
              model=name, rows=t.get("rows"), fields=[f"{f['name']}: {f['type']}" for f in md["fields"]])
        m.link(f"table:{md['table']}", "db:main", "stored in")
    for name, md in models.items():
        for field, target in md["fks"]:
            if target in models:
                m.link(f"table:{md['table']}", f"table:{models[target]['table']}", f"refers to ({field})")
    # URL patterns and views
    urlconf = (settings.get("ROOT_URLCONF") or {}).get("value")
    url_mod = next((x for x in modules if urlconf and str(x.rel) == urlconf.replace(".", "/") + ".py"), None)
    view_mods = {}
    if url_mod:
        for n in url_mod.tree.body:
            if isinstance(n, ast.ImportFrom) and n.module:
                for al in n.names:
                    target = f"{n.module.replace('.', '/')}/{al.name}.py"
                    view_mods[al.asname or al.name] = next((x for x in modules if str(x.rel) == target), None)
        patterns = next((n.value for n in url_mod.tree.body if isinstance(n, ast.Assign)
                         and getattr(n.targets[0], "id", "") == "urlpatterns"), None)
        comments = {i + 1: l.strip() for i, l in enumerate(url_mod.lines) if l.strip().startswith("#")}
        for call in (patterns.elts if isinstance(patterns, ast.List) else []):
            if not isinstance(call, ast.Call) or len(call.args) < 2:
                continue
            fn = codeinfo.dotted(call.func)
            pattern = literal(call.args[0])
            view = codeinfo.dotted(call.args[1])
            path = django_path(pattern, fn)
            mod_alias, _, vname = view.rpartition(".")
            vmod = view_mods.get(mod_alias)
            vdef = vmod.functions.get(vname) if vmod else None
            facts = view_facts(vdef, vmod, models) if vdef else {"methods": ["GET"]}
            rid = m.add(f"route:{' '.join(facts['methods'])} {path}", "route", f"{'/'.join(facts['methods'])} {path}",
                        facts.get("summary", ""), str(url_mod.rel), call.lineno, group="entry", methods=facts["methods"],
                        pattern=pattern, url_function=fn, json=facts.get("json", False))
            m.link("api:http", rid, "serves")
            note = comments.get(call.lineno - 1)
            if note and re.search(r"(read|poll|used|call)", note, re.I):
                ext = m.add(f"ext:{slug(note)}", "client", "Outside client (code comment)", note.strip("# "),
                            str(url_mod.rel), call.lineno - 1, group="connections")
                m.link(ext, rid, "calls")
            if vdef:
                vid = m.add(f"fn:{vmod.rel}:{vname}", "function", f"{vname}()", facts.get("summary", ""), str(vmod.rel), vdef.lineno,
                            group="code", decorators=facts.get("decorators", []))
                m.link(rid, vid, "handled by")
                for t in facts["reads"]:
                    m.link(vid, f"table:{models[t]['table']}", "reads")
                for t in facts["writes"]:
                    m.link(vid, f"table:{models[t]['table']}", "writes")
                for tpl in facts["templates"]:
                    tp = next((f for f in files if rel(f, repo).endswith("templates/" + tpl)), None)
                    tid = m.add(f"tpl:{tpl}", "template", tpl, "Page template", rel(tp, repo) if tp else None, 1, group="code")
                    m.link(vid, tid, "renders")
    model_rows = sum((tables.get(md["table"]) or {}).get("rows") or 0 for md in models.values())
    m.components["db:main"]["summary"] = (f"{model_rows:,} rows in {len(models)} app tables" if tables else "No database copy supplied") + \
        f"; file set by {', '.join(v for v in env_vars([settings_mod], repo) if v in db_cfg) or 'settings'}"
    return {"settings": {k: {"line": v["line"], "value": v["value"] if not isinstance(v["value"], (dict, list)) or k in ("INSTALLED_APPS",) else None,
                             "src": (v["src"] or "")[:200]} for k, v in settings.items()},
            "settings_file": sfile, "apps": apps, "models": models, "tables": tables, "urlconf": str(url_mod.rel) if url_mod else None}


def django_path(pattern, fn):
    if not isinstance(pattern, str):
        return "?"
    if fn.endswith("path") and not fn.endswith("re_path"):
        return "/" + re.sub(r"<(?:\w+:)?(\w+)>", r"{\1}", pattern)
    p = pattern.lstrip("^").rstrip("$")
    p = re.sub(r"\(\?P<(\w+)>[^)]*\)", r"{\1}", p).replace("\\.", ".")
    return "/" + p


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40]


def view_facts(fn, mod, models):
    src = ast.get_source_segment(mod.source, fn) or ""
    decorators = [codeinfo.dotted(d.func if isinstance(d, ast.Call) else d).split(".")[-1] for d in fn.decorator_list]
    posts = "require_POST" in decorators or re.search(r"request\.method\s*==\s*[\"']POST", src)
    methods = ["POST"] if "require_POST" in decorators else (["GET", "POST"] if posts else ["GET"])
    reads, writes = set(), set()
    for name in models:
        if re.search(rf"\b{name}\.objects\.(create|get_or_create|update_or_create|bulk_create)\b", src):
            writes.add(name)
        if re.search(rf"\b{name}\b", src):
            reads.add(name)
    for var in re.findall(r"(\w+)\.save\(", src):
        m = re.search(rf"{var}\s*=\s*get_object_or_404\(\s*(\w+)", src)
        if m and m.group(1) in models:
            writes.add(m.group(1))
    for name in list(reads):
        if re.search(rf"\b{name}\.objects\.select_related\([^)]*\)", src) is None and not re.search(rf"\b{name}\b(?!\.objects\.create)", src):
            reads.discard(name)
    templates = re.findall(r"render\(\s*request\s*,\s*[\"']([^\"']+)[\"']", src)
    json = "JsonResponse" in src
    what = ("JSON: " if json else "Page: " if templates else "") + ("changes " + ", ".join(sorted(writes)) + "; " if writes else "") + \
        ("reads " + ", ".join(sorted(reads - writes)) if reads - writes else "")
    return {"methods": methods, "reads": sorted(reads - writes), "writes": sorted(writes), "templates": templates, "json": json,
            "decorators": decorators, "summary": what.strip("; ")}


def django_findings(m, repo, modules, files, facts, pins):
    s = facts["settings"]
    sfile = facts["settings_file"]
    hits = []
    for mod in modules:
        for pat, what, removed_in, auto in DJANGO_REMOVALS:
            for i, line in enumerate(mod.lines, 1):
                if re.search(pat, line) and not line.strip().startswith("#") and "migrations" not in mod.rel.parts:
                    hits.append({"file": str(mod.rel), "line": i, "text": line.strip()[:120], "api": what, "removed_in": removed_in,
                                 "auto_fix": auto})
    if hits:
        by_api = {}
        for h in hits:
            by_api.setdefault(h["api"], []).append(h)
        manual = sorted({h["api"] for h in hits if not h["auto_fix"]})
        m.find("high", "code", f"{len(hits)} uses of Django features removed after 3.2",
               "These stop the app from starting on a supported Django: " + "; ".join(
                   f"{api} (removed in {v[0]['removed_in']}, {len(v)} place{'s' if len(v) > 1 else ''})" for api, v in by_api.items()) + "." +
               (f" Not rewritable by tools: {', '.join(manual)}." if manual else " All can be rewritten mechanically."),
               [{"file": h["file"], "line": h["line"], "text": h["text"]} for h in hits],
               [comp_for_line(m, h["file"], h["line"]) for h in hits], fid="F-django-removed", removals=hits)
    if sfile and "USE_TZ" not in s:
        m.find("high", "code", "USE_TZ is not set, and its default changes in Django 5.0",
               "Django 3.2 treats a missing USE_TZ as False and stores local clinic times; Django 5.0 changed the default to "
               "True, which would read every stored time as UTC and shift what pages and the kiosk feed show. An upgrade must "
               "set USE_TZ = False explicitly to keep current behaviour.", [{"file": sfile, "line": s.get("TIME_ZONE", {}).get("line"),
                                                                              "text": "TIME_ZONE set, USE_TZ missing"}], ["db:main"], fid="F-use-tz")
    if "USE_L10N" in s:
        m.find("low", "code", "USE_L10N setting no longer exists", "It was removed in Django 5.0; localized formatting is always on.",
               [{"file": sfile, "line": s["USE_L10N"]["line"], "text": "USE_L10N = True"}], fid="F-use-l10n")
    sk = s.get("SECRET_KEY", {})
    if sk and re.search(r"[\"'][^\"']{8,}[\"']", sk.get("src") or ""):
        m.find("medium", "security", "A fallback secret key is written in the code",
               "If DJANGO_SECRET_KEY is not set, the app runs with the key in the repository, which anyone with the code can read.",
               [{"file": sfile, "line": sk["line"], "text": (sk.get("src") or "")[:80]}], fid="F-secret-key")
    dbg = s.get("DEBUG", {})
    if dbg and "\"1\"" in (dbg.get("src") or "").replace("'", "\""):
        m.find("medium", "security", "Debug mode is on unless someone turns it off",
               "DEBUG defaults to on, which shows internal details to visitors when an error happens.",
               [{"file": sfile, "line": dbg["line"], "text": dbg.get("src")}], fid="F-debug")
    auth = any("login_required" in (c["attrs"].get("decorators") or []) for c in m.components.values() if c["kind"] == "function")
    if not auth and "django.contrib.auth" not in (s.get("INSTALLED_APPS", {}).get("value") or []):
        m.find("medium", "security", "No sign-in on staff pages", "Every page, including the daily patient list with phone numbers, "
               "opens without a login. It is fine on a closed clinic network, not on the internet.", [{"file": sfile, "line": s.get("INSTALLED_APPS", {}).get("line"),
                                                                                                   "text": "django.contrib.auth not installed"}],
               [c for c in m.components if c.startswith("route:GET /day")], fid="F-no-auth")
    tests = [x for x in modules if codeinfo.is_test_file(x.rel) and "migrations" not in x.rel.parts]
    n_tests = sum(1 for x in tests for f in ast.walk(x.tree) if isinstance(f, ast.FunctionDef) and f.name.startswith("test"))
    for t in tests:
        m.add(f"test:{t.rel}", "test", str(t.rel), f"{n_tests} test functions", str(t.rel), 1, group="code")
    routes = [c for c in m.components.values() if c["kind"] == "route"]
    if n_tests < len(routes):
        m.find("medium", "code", "Few automated tests", f"{n_tests} tests for {len(routes)} pages and endpoints; cancelling and the "
               "kiosk feed have none.", [{"file": str(t.rel), "line": 1} for t in tests], fid="F-tests")
    double_booking(m, repo, modules, facts)
    return hits


def comp_for_line(m, file, line):
    best = None
    for c in m.components.values():
        if c["file"] == file and c["line"] and c["line"] <= line and c["kind"] in ("function", "route"):
            if not best or c["line"] > best["line"]:
                best = c
    if best:
        return best["id"]
    tbl = next((c["id"] for c in m.components.values() if c["kind"] == "table" and c["file"] == file), None)
    return tbl or "runtime:python"


def double_booking(m, repo, modules, facts):
    """A child row created in a POST view with no existence check, whose parent already has more than one active child."""
    models, tables = facts["models"], facts["tables"]
    for name, md in models.items():
        status = next((f for f in md["fields"] if f["choices"]), None)
        for field, parent in md["fks"]:
            # only parents that are scheduled resources (a date or time the user sets), such as a slot or a room night
            scheduled = parent in models and any(f["type"] in ("DateTimeField", "DateField") and not f["auto"]
                                                 for f in models[parent]["fields"])
            if not scheduled or not status:
                continue
            creates = []
            for mod in modules:
                for i, line in enumerate(mod.lines, 1):
                    if re.search(rf"\b{name}\.objects\.create\([^)]*\b{field}\s*=", line):
                        window = "\n".join(mod.lines[max(0, i - 8):i])
                        if not re.search(r"\.exists\(\)|is_free|select_for_update|IntegrityError", window):
                            creates.append({"file": str(mod.rel), "line": i, "text": line.strip()})
            if not creates or md["table"] not in tables:
                continue
            col = f"{field}_id"
            c = sqlite3.connect(f"file:{facts['db']}?mode=ro", uri=True) if facts.get("db") else None
            dupes = []
            if c:
                default = default_choice(repo, md, status)
                if default:
                    dupes = c.execute(f'SELECT {col}, COUNT(*) FROM "{md["table"]}" WHERE "{status["name"]}" = ? GROUP BY {col} '
                                      f'HAVING COUNT(*) > 1 ORDER BY {col}', (default,)).fetchall()
                c.close()
            if dupes or creates:
                m.find("high", "code", f"Two {name.lower()}s can be made for the same {parent.lower()}",
                       f"The view creates a {name} without checking whether the {parent.lower()} is already taken, and nothing in the "
                       f"database prevents it." + (f" Your data already has {len(dupes)} {parent.lower()}s with two active "
                                                   f"{name.lower()}s." if dupes else " No database copy was supplied to check how often it happened."),
                       creates + [{"observed": f"{parent.lower()} {d[0]}: {d[1]} active {name.lower()}s"} for d in dupes[:8]],
                       [comp_for_line(m, x["file"], x["line"]) for x in creates] + [f"table:{md['table']}"], fid="F-double-booking",
                       data_rows=len(dupes))


def default_choice(repo, md, status):
    src = (repo / md["file"]).read_text().splitlines()[status["line"] - 1]
    m = re.search(r"default\s*=\s*[\"'](\w+)[\"']", src)
    return m.group(1) if m else None


# ------------------------------------------------------------------------------------------------ main

def inspect(repo, db=None, tz=None, latest_file=None, today=None):
    repo = Path(repo)
    today = today or datetime.date.today().isoformat()
    files = source_files(repo)
    langs = {}
    for f in files:
        lang = LANGS.get(f.suffix.lower())
        if lang:
            n = sum(1 for _ in f.open(errors="replace"))
            langs.setdefault(lang, {"files": 0, "lines": 0})
            langs[lang]["files"] += 1
            langs[lang]["lines"] += n
    modules, problems = codeinfo.scan(repo)
    imports = set().union(*[x.imports for x in modules]) if modules else set()
    pins, py = pins_and_python(repo)
    m = Map()
    framework, fw_version, facts = None, None, {}
    if (repo / "manage.py").exists() and ("django" in imports or "django" in pins):
        framework, fw_version = "Django", (pins.get("django") or {}).get("version")
        facts = django_map(m, repo, db, modules, files)
        facts["db"] = db
        add_runtime(m, pins, py, framework, fw_version)
        facts["removals"] = django_findings(m, repo, modules, files, facts, pins)
    elif "flask" in imports:
        framework, fw_version = "Flask", (pins.get("flask") or {}).get("version")
        add_runtime(m, pins, py, framework, fw_version)
        latest = read_json(latest_file)["versions"] if latest_file else None
        a = flask_map(m, repo, db, tz, latest, modules)
        facts = {"assessment_fit": a["fit"], "routes": len(a["routes"]), "size": a["size"], "questions": a["questions"],
                 "unsupported_imports": sorted(i for i in imports if i in codeinfo.UNSUPPORTED_IMPORTS),
                 "sql_sites": a["size"].get("sql_sites"), "orphans": a.get("orphans"), "roles": a.get("roles")}
    if framework:
        app_modules = {c["file"] for c in m.components.values() if c["kind"] in ("function", "route")}
        if "db:main" in m.components:
            outside_scripts(m, repo, modules, app_modules, None)
        for e in documented_clients(repo, files):
            cid = m.add(f"ext:{slug(e['text'])}", "client", "Documented connection", e["text"], e["file"], e["line"], group="connections")
            named = [x for x in re.findall(r"`([^`]+)`", e["text"])]
            targets = [c["id"] for c in m.components.values() for n in named
                       if (c["kind"] == "route" and c["name"].split(" ", 1)[-1] == n) or (c["kind"] == "script" and c["file"] == n)]
            for t in targets:
                m.link(cid, t, "calls" if t.startswith("route:") else "runs")
            if not targets:
                m.link(cid, "api:http", "calls")
        for f in m.findings:   # findings with no component yet: attach to what sits at the cited file and line
            if not f["component_ids"]:
                f["component_ids"] = sorted({c["id"] for e in f["evidence"] if e.get("file") for c in m.components.values()
                                             if c["file"] == e["file"] and (c["line"] == e.get("line") or c["kind"] == "test")})
        if framework != "Flask":   # the Flask analyzer reports these itself
            eol_findings(m, py, framework, fw_version, today)
    else:
        m.add("app:unknown", "module", "Application", ", ".join(f"{k}: {v['files']} files" for k, v in langs.items()) or "No source files",
              group="code")
    if db and "db:main" not in m.components:
        m.add("db:main", "database", "SQLite database file", "", group="data")
    stack = {"language": max(langs, key=lambda k: langs[k]["lines"]) if langs else None, "languages": langs,
             "framework": framework, "framework_version": fw_version, "python": (py or {}).get("version"),
             "database": {"engine": (m.components.get("db:main", {}).get("attrs", {}).get("engine") or ("sqlite" if framework == "Flask" else None)),
                          "copy_supplied": bool(db)},
             "imports": sorted(imports)}
    return {"schema_version": 1, "inspected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "today": today, "stack": stack, "pins": {k: v["version"] for k, v in pins.items()}, "problems": problems,
            "size": {"files": len(files), "lines": sum(v["lines"] for v in langs.values()),
                     "components": len(m.components), "connections": len(m.edges)},
            "components": list(m.components.values()), "edges": m.edges, "findings": m.findings, "facts": facts}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--db")
    ap.add_argument("--timezone")
    ap.add_argument("--latest")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    res = inspect(a.repo, a.db, a.timezone, a.latest)
    write_json(a.out, res)
    emit("inspection.done", framework=res["stack"]["framework"], components=len(res["components"]), edges=len(res["edges"]),
         findings=len(res["findings"]))


if __name__ == "__main__":
    main()
