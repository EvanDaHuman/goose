"""TEST FAULTS - deliberate mistakes a founder can inject to demonstrate detection and repair.

A fault is applied to the generated package after generation, is labelled in the code it touches,
and is recorded as a founder intervention. The repair step never reads this module or the fault
record: it works only from the failed checks.

Usage:  python -m goose_engine.faults --package DIR --fault NAME
"""
import argparse
import re
from pathlib import Path

from .util import emit

MARK = "# TEST FAULT (injected by the founder to demonstrate recovery)"


def money_truncation(pkg):
    p = pkg / "migrate" / "migrate_data.py"
    s = p.read_text()
    old = "    return Decimal(repr(float(value))).quantize(CENT, rounding=ROUND_HALF_UP)\n"
    new = f"    {MARK}\n    return Decimal(int(float(value) * 100)) / 100\n"
    if old not in s:
        raise SystemExit("money conversion not found")
    p.write_text(s.replace(old, new, 1))
    return [str(p.relative_to(pkg))]


def case_sensitive_search(pkg):
    touched = []
    for p in (pkg / "app" / "routes").glob("*.py"):
        s = p.read_text()
        if " ILIKE " in s:
            p.write_text(s.replace(" ILIKE ", " LIKE "))
            touched.append(str(p.relative_to(pkg)))
    return touched


def cancel_guard_missing(pkg):
    touched = []
    for p in (pkg / "app" / "routes").glob("*.py"):
        s = p.read_text()
        new = re.sub(r"\n(\s+)if (\w+)\[\"(\w+)\"\] == \"(\w+)\":\n\s+# already cancelled[^\n]*\n\s+return [^\n]*\n",
                     lambda m: f"\n{m.group(1)}{MARK}: cancel guard removed\n", s)
        if new != s:
            p.write_text(new)
            touched.append(str(p.relative_to(pkg)))
    return touched


def sequence_not_reset(pkg):
    p = pkg / "migrate" / "migrate_data.py"
    s = p.read_text()
    old = "        pg.execute(f\"\"\"SELECT setval("
    if old not in s:
        raise SystemExit("sequence reset not found")
    p.write_text(s.replace(old, f"        {MARK}\n        continue\n        pg.execute(f\"\"\"SELECT setval(", 1))
    return [str(p.relative_to(pkg))]


FAULTS = {
    "money-truncation": ("Data move drops fractions of a cent instead of rounding", money_truncation),
    "case-sensitive-search": ("Customer search becomes case-sensitive", case_sensitive_search),
    "cancel-guard-missing": ("Cancelling twice puts stock back twice again", cancel_guard_missing),
    "sequence-not-reset": ("New records would reuse old ids", sequence_not_reset),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--fault", required=True, choices=sorted(FAULTS))
    a = ap.parse_args()
    title, fn = FAULTS[a.fault]
    touched = fn(Path(a.package))
    emit("fault.injected", fault=a.fault, title=title, files=touched)


if __name__ == "__main__":
    main()
