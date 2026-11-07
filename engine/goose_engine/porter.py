"""Port Flask view functions to FastAPI with source edits (a codemod).

The rule of this port: change the framework, the database layer and the agreed fixes; keep the
owner's own logic, SQL, comments and layout recognisable. Edits are made on the original source
text, so a diff of old and new code shows exactly what changed. Every change is recorded.
"""
import ast
import io
import re
import tokenize

from . import codeinfo as ci
from . import sqltools

SQLITE_ERRORS = {"IntegrityError": "IntegrityError", "Error": "DatabaseError", "DatabaseError": "DatabaseError",
                 "OperationalError": "OperationalError"}


class Source:
    def __init__(self, text):
        self.text = text
        self.lines = text.splitlines(keepends=True)
        self.starts = []
        pos = 0
        for line in self.lines:
            self.starts.append(pos)
            pos += len(line)
        self.starts.append(pos)

    def off(self, lineno, col):
        line = self.lines[lineno - 1] if lineno - 1 < len(self.lines) else ""
        return self.starts[lineno - 1] + len(line.encode("utf-8")[:col].decode("utf-8", errors="ignore"))

    def span(self, node):
        return self.off(node.lineno, node.col_offset), self.off(node.end_lineno, node.end_col_offset)

    def seg(self, node):
        a, b = self.span(node)
        return self.text[a:b]


def apply_edits(text, edits, base=0):
    """Apply (start, end, replacement) edits whose offsets are relative to `base`."""
    out = text
    for start, end, rep in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
        out = out[: start - base] + rep + out[end - base:]
    return out


def path_for_fastapi(flask_path):
    """Starlette convertors make non-matching values 404, as Flask's converters did."""
    def rep(m):
        conv, name = (m.group(1) or ""), m.group(2)
        return "{" + name + {"int": ":int", "float": ":float", "path": ":path"}.get(conv, "") + "}"
    return re.sub(r"<(?:(\w+):)?(\w+)>", rep, flask_path)


def group_name(path):
    seg = [s for s in path.split("/") if s and not s.startswith("{")]
    if seg and seg[0] in ("api", "v1", "v2") and len(seg) > 1:
        seg = seg[1:]
    name = re.sub(r"[^a-z0-9_]", "_", seg[0].lower()) if seg else "root"
    return ("r_" + name) if name[0].isdigit() else name


def translate_string_tokens(seg, returning_pk, zones=None):
    """Translate each string token of a (possibly implicitly concatenated) literal, keeping layout."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(seg).readline))
    except (tokenize.TokenError, IndentationError):
        return None, []
    strs = [t for t in toks if t.type == tokenize.STRING]
    if not strs:
        return None, []
    lines = seg.splitlines(keepends=True)
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    edits, applied = [], []
    values = []
    for t in strs:
        v = ast.literal_eval(t.string)
        if not isinstance(v, str):
            return None, []
        values.append(v)
    full = "".join(values)
    add_returning = bool(returning_pk and re.match(r"^\s*INSERT\b", full, re.I)
                         and not re.search(r"\bRETURNING\b", full, re.I))
    for i, t in enumerate(strs):
        value = values[i]
        new, rules = sqltools.translate_fragment(value, zones=zones)
        if add_returning and i == len(strs) - 1:
            new = new.rstrip() + f" RETURNING {returning_pk}"
            rules = rules + ["returning_pk"]
        applied += rules
        if new != value:
            quote = '"' if t.string.lstrip("rRbBuU").startswith('"') else "'"
            lit = quote + new.replace("\\", "\\\\").replace(quote, "\\" + quote) + quote
            a = starts[t.start[0] - 1] + t.start[1]
            b = starts[t.end[0] - 1] + t.end[1]
            edits.append((a, b, lit))
    return apply_edits(seg, edits), applied


def leading_comments_start(src, node):
    """Include comment lines directly above a statement (and its decorators)."""
    first = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
    i = first - 1
    while i - 1 >= 0 and src.lines[i - 1].lstrip().startswith("#"):
        i -= 1
    return src.starts[i]


def stmt_end(src, node):
    end = src.off(node.end_lineno, node.end_col_offset)
    nl = src.text.find("\n", end)
    return len(src.text) if nl == -1 else nl + 1


def body_indent(src, fn):
    first = fn.body[0]
    line = src.lines[first.lineno - 1]
    return line[: len(line) - len(line.lstrip())]


def is_docstring(st):
    return isinstance(st, ast.Expr) and isinstance(st.value, ast.Constant) and isinstance(st.value.value, str)


def def_params_span(src, fn):
    """Offsets of the text between the parentheses of `def name(...)`."""
    start = src.off(fn.lineno, fn.col_offset)
    i = src.text.index("(", src.text.index("def", start))
    depth, j = 0, i
    while True:
        ch = src.text[j]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i + 1, j
        j += 1


class EditCollector(ast.NodeVisitor):
    """Walks one function and records the source edits that port it."""

    def __init__(self, src, fn, *, is_route, db_getters, needs_db_helpers, sql_edits, rule_fn, changes):
        self.src, self.fn = src, fn
        self.is_route = is_route
        self.db_getters = db_getters
        self.needs_db_helpers = needs_db_helpers
        self.sql_edits = sql_edits
        self.rule_fn = rule_fn
        self.changes = changes
        self.edits = []
        self.uses = set()
        self.json_call = None
        self.depth = 0
        self.removed_db_assign = False

    def add(self, node_or_span, text):
        a, b = node_or_span if isinstance(node_or_span, tuple) else self.src.span(node_or_span)
        self.edits.append((a, b, text))

    def run(self):
        for st in self.fn.body:
            self.visit(st)
        for (a, b), text in self.sql_edits.items():
            fa = self.src.off(self.fn.lineno, 0)
            fb = self.src.off(self.fn.end_lineno, self.fn.end_col_offset)
            if fa <= a and b <= fb:
                self.edits.append((a, b, text))
        return self

    def visit_FunctionDef(self, node):
        self.depth += 1
        self.generic_visit(node)
        self.depth -= 1

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Lambda(self, node):
        self.depth += 1
        self.generic_visit(node)
        self.depth -= 1

    def visit_Assign(self, node):
        v = node.value
        if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id in self.db_getters \
                and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            self.uses.add("db")
            if node.targets[0].id == "db":
                a = self.src.starts[node.lineno - 1]
                self.edits.append((a, stmt_end(self.src, node), ""))
                self.removed_db_assign = True
                return
            self.add(v, "db")
            return
        self.generic_visit(node)

    def visit_Call(self, node):
        d = ci.dotted(node.func)
        if isinstance(node.func, ast.Name) and node.func.id in self.db_getters:
            self.uses.add("db")
            self.add(node, "db")
            return
        if d == "request.get_json":
            if self.json_call is None:
                kw = {k.arg: getattr(k.value, "value", False) for k in node.keywords}
                self.json_call = {"force": bool(kw.get("force")), "silent": bool(kw.get("silent"))}
            self.uses.add("payload")
            self.add(node, "payload")
            return
        if d == "request.args.get" and any(k.arg == "type" for k in node.keywords):
            self.uses.update({"query_get", "request"})
            inner = ", ".join(self.src.seg(x) for x in node.args + [k.value for k in node.keywords if k.arg != "type"])
            typ = next(self.src.seg(k.value) for k in node.keywords if k.arg == "type")
            self.add(node, f"query_get(request.query_params, {inner}, type={typ})")
            return
        if d in ("datetime.now", "datetime.datetime.now") and not node.args and not node.keywords:
            self.uses.add("BUSINESS_TZ")
            a, b = self.src.span(node)
            self.edits.append((b - 1, b - 1, "BUSINESS_TZ"))
            self.changes.add(self.fn.name, "shop-time clock", "datetime.now() asks for shop time explicitly")
            return
        if self.rule_fn and isinstance(node.func, ast.Name) and node.func.id == "round" and len(node.args) == 2 \
                and isinstance(node.args[1], ast.Constant) and node.args[1].value == 2:
            self.uses.add("round_cents")
            self.add(node.func, "round_cents")
            a0 = self.src.span(node.args[0])[1]
            b1 = self.src.span(node.args[1])[1]
            self.edits.append((a0, b1, ""))
            self.visit(node.args[0])
            return
        if isinstance(node.func, ast.Name) and node.func.id in self.needs_db_helpers:
            self.uses.add("db")
            for x in node.args + [k.value for k in node.keywords]:
                self.visit(x)
            if not any(k.arg == "db" for k in node.keywords):
                a, b = self.src.span(node)
                sep = ", " if (node.args or node.keywords) else ""
                self.edits.append((b - 1, b - 1, f"{sep}db=db"))
            return
        if isinstance(node.func, ast.Name) and node.func.id in ("jsonify", "abort"):
            self.uses.add(node.func.id)
        self.generic_visit(node)

    def visit_Attribute(self, node):
        d = ci.dotted(node)
        if d == "request.json":
            self.uses.add("payload")
            if self.json_call is None:
                self.json_call = {"force": False, "silent": True}
            self.add(node, "payload")
            return
        if d == "request.args":
            self.uses.add("request")
            self.add(node, "request.query_params")
            return
        if d == "request.path":
            self.uses.add("request")
            self.add(node, "request.url.path")
            return
        if d.startswith("sqlite3.") and node.attr in SQLITE_ERRORS:
            self.uses.add(SQLITE_ERRORS[node.attr])
            self.add(node, SQLITE_ERRORS[node.attr])
            return
        if isinstance(node.value, ast.Name) and node.value.id == "request":
            self.uses.add("request")
        self.generic_visit(node)

    def visit_Constant(self, node):
        if self.rule_fn and isinstance(node.value, float):
            self.uses.add("Decimal")
            self.add(node, f'Decimal("{self.src.seg(node)}")')

    def visit_Return(self, node):
        if not self.is_route or self.depth > 0 or node.value is None:
            self.generic_visit(node)
            return
        val = node.value
        if isinstance(val, ast.Tuple) and 2 <= len(val.elts) <= 3 and not self.src.seg(val).startswith("("):
            first, status = val.elts[0], val.elts[1]
            headers = val.elts[2] if len(val.elts) == 3 else None
            for x in val.elts:
                self.visit(x)
            if isinstance(first, ast.Call) and isinstance(first.func, ast.Name) and first.func.id == "jsonify" \
                    and headers is None:
                a, b = self.src.span(first)
                self.edits.append((b - 1, b - 1, f", status={self.src.seg(status)}"))
                self.edits.append((b, self.src.span(val)[1], ""))
                return
            self.uses.add("respond")
            a, b = self.src.span(val)
            self.edits.append((a, a, "respond("))
            self.edits.append((b, b, ")"))
            return
        self.generic_visit(node)
        if isinstance(val, ast.Call) and isinstance(val.func, ast.Name) and val.func.id == "jsonify":
            return
        self.uses.add("respond")
        a, b = self.src.span(val)
        self.edits.append((a, a, "respond("))
        self.edits.append((b, b, ")"))


def find_none_check(fn):
    """`if <row> is None: return ...` - returns (index, variable name)."""
    for i, st in enumerate(fn.body):
        if isinstance(st, ast.If) and isinstance(st.test, ast.Compare) and isinstance(st.test.left, ast.Name) \
                and len(st.test.ops) == 1 and isinstance(st.test.ops[0], ast.Is) \
                and isinstance(st.test.comparators[0], ast.Constant) and st.test.comparators[0].value is None \
                and any(isinstance(b, ast.Return) for b in st.body):
            return i, st.test.left.id
    return None, None


def names_in(text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return set(re.findall(r"[A-Za-z_]\w*", text))
    out = set()
    for x in ast.walk(tree):
        if isinstance(x, ast.Name):
            out.add(x.id)
    return out


def defined_names(stmt):
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {stmt.name}
    if isinstance(stmt, ast.Assign):
        return {t.id for t in stmt.targets if isinstance(t, ast.Name)}
    if isinstance(stmt, (ast.AnnAssign, ast.AugAssign)) and isinstance(stmt.target, ast.Name):
        return {stmt.target.id}
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split(".")[0] for a in stmt.names}
    return set()
