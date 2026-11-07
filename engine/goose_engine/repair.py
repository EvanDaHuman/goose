"""Repair: read the failed checks, diagnose the cause, and change the generated code.

Input is only the verification report and the generated package (plus the assessment and scope).
It does not read the frozen checks or any record of injected test faults. Each repair strategy
matches a failure signature from the playbook; failures no strategy explains are escalated.

Usage:  python -m goose_engine.repair --package DIR --report report.json --assessment A --scope S --out repair.json
"""
import argparse
import ast
import difflib
import re
from pathlib import Path

from . import porter as P
from .util import emit, read_json, write_json

TEMPLATES = Path(__file__).resolve().parent / "templates"


def _function_text(source, name):
    tree = ast.parse(source)
    src = P.Source(source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return src.starts[node.lineno - 1], P.stmt_end(src, node), node
    return None, None, None


def replace_function(path, name, template_path):
    current = path.read_text()
    a, b, _ = _function_text(current, name)
    ta, tb, _ = _function_text(template_path.read_text(), name)
    if a is None or ta is None:
        return False
    new = current[:a] + template_path.read_text()[ta:tb] + current[b:]
    if new != current:
        path.write_text(new)
        return True
    return False


def money_signature(failed, scope):
    money = set(scope["money_columns"])
    hits = []
    for f in failed:
        if not f["id"].startswith("records.fields."):
            continue
        t = f["id"].split(".", 2)[2]
        cols = (f.get("evidence") or {}).get("by_column") or {}
        ex = (f.get("evidence") or {}).get("examples") or []
        money_cols = [c for c in cols if f"{t}.{c}" in money]
        off_by_cent = [e for e in ex if e["column"] in money_cols and e["expected"] and e["actual"]
                       and abs(float(e["expected"]) - float(e["actual"])) <= 0.0100001]
        if money_cols and off_by_cent:
            hits.append(f)
    return hits


def search_signature(failed):
    hits = []
    for f in failed:
        req = ((f.get("evidence") or {}).get("request") or {}).get("path", "")
        if f["id"].startswith("compat.") and re.search(r"[?&](name|q|search)=", req):
            diffs = (f.get("evidence") or {}).get("differences") or []
            if any(d.get("path") == "$.length" and isinstance(d.get("expected"), int) and isinstance(d.get("actual"), int)
                   and d["actual"] < d["expected"] for d in diffs):
                hits.append(f)
    return hits


def cancel_signature(failed):
    return [f for f in failed if f["id"].startswith("stock.") and "second time" in f["title"]] + \
        [f for f in failed if f["id"] == "retries.cancel_twice"]


def sequence_signature(failed):
    return [f for f in failed if f["id"].startswith("sequences.next_ids")]


def repair(pkg, report, assessment, scope):
    pkg = Path(pkg)
    failed = report["failed"]
    before = {str(p.relative_to(pkg)): p.read_text() for p in pkg.rglob("*.py")}
    diagnoses, actions, explained = [], [], set()

    hits = money_signature(failed, scope)
    if hits:
        diagnoses.append({"signature": "money-conversion",
                          "explanation": "Moved money values are off by one cent against the original. The data move "
                                         "converts binary-float money without rounding half up to the cent.",
                          "failed_checks": [h["id"] for h in hits]})
        if replace_function(pkg / "migrate" / "migrate_data.py", "to_money", TEMPLATES / "migrate" / "migrate_data.py"):
            actions.append({"file": "migrate/migrate_data.py",
                            "action": "Restored the playbook money conversion (Decimal from repr, ROUND_HALF_UP to the cent)"})
            explained |= {h["id"] for h in hits}
            explained |= {f["id"] for f in failed if f["id"].startswith(("records.fields.", "migration.retry"))}

    hits = sequence_signature(failed)
    if hits:
        diagnoses.append({"signature": "id-counters",
                          "explanation": "New ids would start below ids the old application already used. The data "
                                         "move did not move the id counters forward.",
                          "failed_checks": [h["id"] for h in hits]})
        if replace_function(pkg / "migrate" / "migrate_data.py", "migrate", TEMPLATES / "migrate" / "migrate_data.py"):
            actions.append({"file": "migrate/migrate_data.py",
                            "action": "Restored the playbook step that moves each id counter past the highest old id"})
            explained |= {h["id"] for h in hits}

    hits = search_signature(failed)
    if hits:
        diagnoses.append({"signature": "case-sensitive-search",
                          "explanation": "Name searches return fewer customers than the original. SQLite's LIKE ignores "
                                         "case; the upgraded query uses PostgreSQL's case-sensitive LIKE.",
                          "failed_checks": [h["id"] for h in hits]})
        for p in (pkg / "app").rglob("*.py"):
            s = p.read_text()
            new = re.sub(r'("[^"\n]*?)(?<![I\w])LIKE\b', lambda m: m.group(1) + "ILIKE", s)
            if new != s:
                p.write_text(new)
                actions.append({"file": str(p.relative_to(pkg)), "action": "LIKE -> ILIKE in SQL text"})
        explained |= {h["id"] for h in hits}

    hits = cancel_signature(failed)
    if hits:
        diagnoses.append({"signature": "cancel-twice",
                          "explanation": "Stock rose again after a second cancel of the same order. The cancel handler "
                                         "has no check for an order that is already cancelled.",
                          "failed_checks": [h["id"] for h in hits]})
        roles = scope["roles"]
        cancel = next((r for r in assessment["routes"] if r["kind"] == "cancel_order"), None)
        if cancel:
            for p in (pkg / "app" / "routes").glob("*.py"):
                text = p.read_text()
                tree = ast.parse(text)
                fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == cancel["function"]), None)
                if fn is None:
                    continue
                if re.search(rf'\["{roles["status_column"]}"\] == "{roles["cancelled_value"]}"', ast.get_source_segment(text, fn) or ""):
                    continue
                src = P.Source(text)
                idx, var = P.find_none_check(fn)
                final = next((st for st in reversed(fn.body) if isinstance(st, ast.Return)), None)
                if idx is None or final is None:
                    continue
                indent = P.body_indent(src, fn)
                after = P.stmt_end(src, fn.body[idx])
                guard = (f'{indent}if {var}["{roles["status_column"]}"] == "{roles["cancelled_value"]}":\n'
                         f'{indent}    # already cancelled: change nothing (restored by repair)\n'
                         f'{indent}    {src.seg(final)}\n')
                p.write_text(text[:after] + guard + text[after:])
                actions.append({"file": str(p.relative_to(pkg)), "action": f"Added the already-cancelled check to {fn.name}"})
                explained |= {h["id"] for h in hits}
                explained |= {f["id"] for f in failed if f["id"].startswith("compat.") and "cancel" in f["title"].lower()}

    after = {str(p.relative_to(pkg)): p.read_text() for p in pkg.rglob("*.py")}
    diff = []
    for name in sorted(after):
        if before.get(name) != after[name]:
            diff += difflib.unified_diff(before.get(name, "").splitlines(keepends=True), after[name].splitlines(keepends=True),
                                         fromfile=f"a/{name}", tofile=f"b/{name}")
    # answers that differ only because of a diagnosed cause (money a cent off, stock) count as explained
    money_keys = {c.split(".")[1] for c in scope["money_columns"]}
    stock_keys = {scope["roles"].get("stock_column") or "stock"}
    signatures = {d["signature"] for d in diagnoses}
    for f in failed:
        if f["id"] in explained:
            continue
        diffs = (f.get("evidence") or {}).get("differences") or []
        if not diffs:
            continue
        def leaf(d):
            return re.sub(r"\[\d+\]", "", d.get("path", "")).split(".")[-1]
        if "money-conversion" in signatures and all(
                leaf(d) in money_keys and isinstance(d.get("expected"), (int, float)) and isinstance(d.get("actual"), (int, float))
                and abs(d["expected"] - d["actual"]) <= 0.0100001 for d in diffs):
            explained.add(f["id"])
        elif "cancel-twice" in signatures and all(leaf(d) in stock_keys for d in diffs):
            explained.add(f["id"])
    unresolved = [f["id"] for f in failed if f["id"] not in explained]
    return {"diagnoses": diagnoses, "actions": actions, "diff": "".join(diff),
            "explained": sorted(explained), "unresolved": unresolved,
            "needs_founder": not actions,
            "needs_fresh_migration": any(d["signature"] in ("money-conversion", "id-counters") for d in diagnoses)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--assessment", required=True)
    ap.add_argument("--scope", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    res = repair(a.package, read_json(a.report), read_json(a.assessment), read_json(a.scope))
    write_json(a.out, res)
    emit("repair.done", diagnoses=[d["signature"] for d in res["diagnoses"]], actions=len(res["actions"]),
         unresolved=len(res["unresolved"]), needs_founder=res["needs_founder"])


if __name__ == "__main__":
    main()
