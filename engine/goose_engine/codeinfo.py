"""Static reading of a Flask + sqlite3 code base. Never imports or runs the customer's code."""
import ast
import re
from pathlib import Path

from . import sqltools

FLASK_CONVERTERS = {"int": "int", "float": "float", "string": "str", "path": "path", "uuid": "str", "": "str"}
ROUTE_VERBS = {"get": "GET", "post": "POST", "put": "PUT", "patch": "PATCH", "delete": "DELETE"}

UNSUPPORTED_IMPORTS = {
    "django": "Django project (v1 supports Flask only)",
    "fastapi": "Already a FastAPI application",
    "flask_sqlalchemy": "Flask-SQLAlchemy ORM (v1 supports hand-written sqlite3 queries only)",
    "sqlalchemy": "SQLAlchemy (v1 supports hand-written sqlite3 queries only)",
    "peewee": "Peewee ORM (not supported in v1)",
    "pymysql": "MySQL database driver (v1 upgrades SQLite databases only)",
    "MySQLdb": "MySQL database driver (v1 upgrades SQLite databases only)",
    "psycopg2": "Already uses PostgreSQL",
    "celery": "Background jobs with Celery (not supported in v1)",
    "rq": "Background jobs with RQ (not supported in v1)",
    "apscheduler": "Scheduled jobs (not supported in v1)",
    "flask_login": "User login sessions (not supported in v1)",
    "flask_socketio": "WebSockets (not supported in v1)",
    "flask_restful": "Flask-RESTful resources (not supported in v1)",
    "flask_wtf": "Server-rendered forms (v1 supports JSON APIs only)",
}


def is_test_file(path):
    name = path.name
    return name.startswith("test_") or name.endswith("_test.py") or "tests" in path.parts or name in ("conftest.py", "tests.py")


def const_str(node):
    """The string value of a constant expression, or None if any part is not constant."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = const_str(node.left), const_str(node.right)
        if a is not None and b is not None:
            return a + b
    if isinstance(node, ast.JoinedStr) and all(isinstance(v, ast.Constant) for v in node.values):
        return "".join(v.value for v in node.values)
    return None


def str_nodes(node):
    """Every string-constant node that makes up a constant expression."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node]
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return str_nodes(node.left) + str_nodes(node.right)
    return []


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Call):
        return dotted(node.func) + "()"
    return ""


def flask_path(path):
    """'/orders/<int:order_id>' -> ('/orders/{order_id}', [{'name':'order_id','type':'int'}])"""
    params = []

    def rep(m):
        conv, name = (m.group(1) or ""), m.group(2)
        conv = conv.rstrip(":")
        params.append({"name": name, "type": FLASK_CONVERTERS.get(conv, "str")})
        return "{" + name + (":path" if conv == "path" else "") + "}"

    new = re.sub(r"<(?:(\w+):)?(\w+)>", lambda m: rep(m), path)
    return new, params


class ModuleInfo:
    def __init__(self, path, rel):
        self.path = path
        self.rel = rel
        self.source = path.read_text(encoding="utf-8", errors="replace")
        self.tree = ast.parse(self.source, filename=str(rel))
        self.lines = self.source.splitlines()
        self.functions = {n.name: n for n in self.tree.body if isinstance(n, ast.FunctionDef)}
        self.imports = set()
        for n in ast.walk(self.tree):
            if isinstance(n, ast.Import):
                for a in n.names:
                    self.imports.add(a.name.split(".")[0])
            elif isinstance(n, ast.ImportFrom) and n.module:
                self.imports.add(n.module.split(".")[0])
        self.app_names, self.blueprints = self._find_apps()

    def _find_apps(self):
        apps, bps = set(), {}
        for n in ast.walk(self.tree):
            if isinstance(n, ast.Assign) and isinstance(n.value, ast.Call):
                fn = dotted(n.value.func)
                targets = [t.id for t in n.targets if isinstance(t, ast.Name)]
                if fn.endswith("Flask"):
                    apps.update(targets)
                elif fn.endswith("Blueprint"):
                    prefix = ""
                    for kw in n.value.keywords:
                        if kw.arg == "url_prefix":
                            prefix = const_str(kw.value) or ""
                    for t in targets:
                        bps[t] = prefix
        # register_blueprint(bp, url_prefix=...) overrides the blueprint's own prefix
        for n in ast.walk(self.tree):
            if isinstance(n, ast.Call) and dotted(n.func).endswith("register_blueprint") and n.args:
                name = dotted(n.args[0]).split(".")[-1]
                for kw in n.keywords:
                    if kw.arg == "url_prefix":
                        bps[name] = const_str(kw.value) or ""
        return apps, bps

    def comment_above(self, lineno, max_lines=3):
        out = []
        i = lineno - 2
        while i >= 0 and len(out) < max_lines:
            line = self.lines[i].strip()
            if line.startswith("#"):
                out.insert(0, line.lstrip("# ").rstrip())
                i -= 1
            else:
                break
        return out


def route_decorators(fn, mod, extra_bp_prefixes):
    out = []
    for dec in fn.decorator_list:
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
            continue
        owner = dotted(dec.func.value)
        attr = dec.func.attr
        if owner not in mod.app_names and owner not in mod.blueprints and owner not in extra_bp_prefixes:
            continue
        if attr == "route":
            methods = ["GET"]
            for kw in dec.keywords:
                if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                    methods = [const_str(e).upper() for e in kw.value.elts if const_str(e)]
        elif attr in ROUTE_VERBS:
            methods = [ROUTE_VERBS[attr]]
        else:
            continue
        raw = const_str(dec.args[0]) if dec.args else None
        if raw is None:
            continue
        prefix = mod.blueprints.get(owner, extra_bp_prefixes.get(owner, ""))
        out.append({"owner": owner, "path": (prefix.rstrip("/") + raw) if prefix else raw,
                    "methods": methods, "decorator": dec})
    return out


def execute_calls(fn):
    """(call node, sql text or None, list of string nodes) for every .execute() inside fn."""
    assigns = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            if const_str(n.value) is not None:
                assigns.setdefault(n.targets[0].id, []).append(n.value)
        elif isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name) and isinstance(n.op, ast.Add):
            if const_str(n.value) is not None:
                assigns.setdefault(n.target.id, []).append(n.value)
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in (
                "execute", "executemany", "executescript") and n.args:
            arg = n.args[0]
            text = const_str(arg)
            nodes = str_nodes(arg)
            if text is None and isinstance(arg, ast.Name) and arg.id in assigns:
                parts = assigns[arg.id]
                text = " ".join(const_str(p) for p in parts)
                nodes = [s for p in parts for s in str_nodes(p)]
            out.append((n, text, nodes))
    return out


def payload_info(fn):
    """Which JSON body keys a handler reads, including keys of items in a list it loops over."""
    payload_vars, list_vars, item_vars = set(), {}, {}
    keys, item_keys = [], []
    uses_json = False
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            src = n.value
            if isinstance(src, ast.BoolOp):
                src = src.values[0]
            d = dotted(src.func) if isinstance(src, ast.Call) else dotted(src)
            if d in ("request.get_json", "request.get_json()") or d.startswith("request.get_json") or d == "request.json":
                payload_vars.add(n.targets[0].id)
                uses_json = True
    for n in ast.walk(fn):
        key = None
        base = None
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and n.args:
            base, key = dotted(n.func.value), const_str(n.args[0])
        elif isinstance(n, ast.Subscript):
            base = dotted(n.value)
            sl = n.slice
            key = const_str(sl)
        if key is None:
            continue
        if base in payload_vars and key not in keys:
            keys.append(key)
    # loops over a payload list: for item in items  /  for item in data.get("items")
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            src = n.value
            if isinstance(src, ast.BoolOp):
                src = src.values[0]
            if isinstance(src, ast.Call) and isinstance(src.func, ast.Attribute) and src.func.attr == "get":
                if dotted(src.func.value) in payload_vars and src.args:
                    list_vars[n.targets[0].id] = const_str(src.args[0])
            elif isinstance(src, ast.Subscript) and dotted(src.value) in payload_vars:
                list_vars[n.targets[0].id] = const_str(src.slice)
    for n in ast.walk(fn):
        if isinstance(n, ast.For) and isinstance(n.target, ast.Name):
            it = n.iter
            src_key = None
            if isinstance(it, ast.Name) and it.id in list_vars:
                src_key = list_vars[it.id]
            elif isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and it.func.attr == "get" \
                    and dotted(it.func.value) in payload_vars and it.args:
                src_key = const_str(it.args[0])
            if src_key:
                item_vars[n.target.id] = src_key
    list_key = None
    for n in ast.walk(fn):
        base = key = None
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get" and n.args:
            base, key = dotted(n.func.value), const_str(n.args[0])
        elif isinstance(n, ast.Subscript):
            base, key = dotted(n.value), const_str(n.slice)
        if base in item_vars and key and key not in item_keys:
            item_keys.append(key)
            list_key = item_vars[base]
    return {"uses_json": uses_json, "keys": keys, "list_key": list_key, "item_keys": item_keys}


def query_args(fn):
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "get":
            if dotted(n.func.value) == "request.args" and n.args and const_str(n.args[0]):
                k = const_str(n.args[0])
                if k not in out:
                    out.append(k)
    return out


def responses(fn):
    """Status codes and error messages a handler returns explicitly."""
    out = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Return) and n.value is not None:
            status, msg = 200, None
            val = n.value
            if isinstance(val, ast.Tuple) and len(val.elts) >= 2 and isinstance(val.elts[1], ast.Constant):
                status = val.elts[1].value
                val = val.elts[0]
            if isinstance(val, ast.Call) and dotted(val.func).endswith("jsonify") and val.args \
                    and isinstance(val.args[0], ast.Dict):
                for k, v in zip(val.args[0].keys, val.args[0].values):
                    if k is not None and const_str(k) == "error":
                        msg = const_str(v)
            out.append({"status": status, "error": msg, "line": n.lineno})
    return out


def called_functions(fn, mod):
    names = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in mod.functions:
            if n.func.id not in names and n.func.id != fn.name:
                names.append(n.func.id)
    return names


def scan(repo_dir):
    """Read every Python module of the application. Returns (modules, problems)."""
    repo = Path(repo_dir)
    modules, problems = [], []
    for path in sorted(repo.rglob("*.py")):
        rel = path.relative_to(repo)
        if any(p.startswith(".") or p in ("venv", ".venv", "env", "node_modules", "site-packages")
               for p in rel.parts):
            continue
        try:
            modules.append(ModuleInfo(path, rel))
        except SyntaxError as e:
            problems.append(f"{rel}: could not be parsed ({e.msg} at line {e.lineno})")
    return modules, problems
