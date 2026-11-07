"""Turn an assessment (and the customer's answers) into the draft scope a proposal is built from.

The scope is the agreement: what changes, what stays the same, every data decision, and the
acceptance checklist. Once the customer accepts it, it is frozen and both the modernization work
and the independent checks are built from it.

Usage:  python -m goose_engine.scope --assessment a.json [--answers answers.json] --slug NAME --out scope.json
"""
import argparse
import json
from collections import Counter
from pathlib import Path

from .util import read_json, write_json, emit

CHANGES = [
    ("fastapi", "Move the API from Flask 1.1 to FastAPI",
     "Flask 1.1 and its pinned libraries are several major versions behind. FastAPI is maintained, documents "
     "every endpoint automatically and runs on a current Python."),
    ("postgresql", "Move the data from SQLite to PostgreSQL",
     "PostgreSQL handles orders arriving at the same time, enforces the links between records and can be "
     "backed up while the shop is open."),
    ("exact_money", "Store money as exact cents",
     "Money columns become NUMERIC instead of binary floating point, so totals add up exactly."),
    ("transactions_and_locks", "Take stock one order at a time",
     "Stock checks and stock updates run under a lock inside one transaction, so two orders arriving together "
     "cannot both take the last item."),
    ("idempotency_keys", "Allow safe retries of new orders",
     "Clients may send an Idempotency-Key header; a retried request returns the first order instead of "
     "creating a second one. Requests without the header behave as before."),
    ("cancel_once", "Cancelling twice changes nothing",
     "A second cancel request returns the order as it is and does not add stock again."),
    ("shop_time_clock", "Timestamps always use shop time",
     "New timestamps use the shop's time zone explicitly instead of trusting the server clock."),
    ("stock_never_negative", "Stock can never go below zero",
     "A database rule rejects any change that would make stock negative."),
    ("tests_and_docs", "Tests, run book and rollback guide",
     "Unit tests for the business rules, a migration run book, and a rollback guide are delivered with the code."),
]

KEEP = [
    "Every endpoint keeps its path, method and status codes.",
    "JSON responses keep their field names and values.",
    "Error messages keep their wording.",
    "Customer search still ignores upper/lower case.",
    "Historical orders keep their stored totals exactly, to the cent.",
]


def placeholder_for(table_info, row_id, roles):
    values = {}
    pk = next((c["name"] for c in table_info["columns"] if c["pk"]), "id")
    values[pk] = row_id
    for c in table_info["columns"]:
        n, t = c["name"], c["decl_type"]
        if c["pk"]:
            continue
        unique = any(n in ix["columns"] and ix["unique"] for ix in table_info.get("indexes", []))
        if n == roles.get("active_column"):
            values[n] = 0
        elif n == roles.get("stock_column"):
            values[n] = 0
        elif not c["notnull"] and c["default"] is None:
            continue
        elif "INT" in t:
            values[n] = 0
        elif t in ("REAL", "FLOAT", "DOUBLE", "NUMERIC") or "DEC" in t:
            values[n] = "0.00"
        elif unique:
            values[n] = f"DELETED-{row_id}"
        else:
            values[n] = f"Deleted record #{row_id}" if n != roles.get("product_name_column") \
                else f"Deleted product #{row_id}"
    return values


def build(assessment, answers, slug, app_title):
    roles = assessment["roles"]
    tables = assessment["tables"]
    decltypes = bool(assessment["app"].get("parse_decltypes"))

    def keep_as_time(d):
        # with PARSE_DECLTYPES only TIMESTAMP/DATETIME/DATE columns reach the old API as datetimes;
        # text columns must stay text there, or their JSON would change
        return not decltypes or d.get("declared", "").startswith(("TIMESTAMP", "DATETIME", "DATE"))
    formats = Counter()
    for d in assessment["date_columns"]:
        formats.update(d["formats"])
    out_fmt = "%Y-%m-%d %H:%M:%S"
    if formats:
        top = formats.most_common(1)[0][0]
        out_fmt = top if "%H" in top else out_fmt
    if decltypes:
        out_fmt = "http_date"   # Flask's JSON encoder sends datetimes as 'Wed, 05 Feb 2025 14:03:00 GMT'
    utc_cols = [d["column"] for d in assessment["date_columns"] if d.get("zone") == "UTC"]

    orphan_decisions = []
    for q in assessment["questions"]:
        if not q["id"].startswith("Q-orphans-"):
            continue
        decision = (answers.get(q["id"]) or {}).get("decision") or q.get("recommended")
        ref_table = q["references"].split(".")[0]
        entry = {"question": q["id"], "table": q["table"], "column": q["column"], "references": q["references"],
                 "missing_ids": q["missing_ids"], "decision": decision, "answered": q["id"] in answers}
        if decision == "placeholder":
            entry["placeholders"] = [placeholder_for(tables[ref_table], i, roles) for i in q["missing_ids"]]
        orphan_decisions.append(entry)

    rules = []
    for r in assessment["rules"]:
        rules.append({"id": r["id"], "function": r["function"], "module": r["module"], "tiers": r["tiers"],
                      "base_variable": r["base_variable"], "discount_variable": r["discount_variable"],
                      "new_order_rounding": (answers.get("rounding") or {}).get("decision", "half_up"),
                      "history": r.get("history"), "notes": r.get("notes", [])})

    changes = [{"id": c[0], "title": c[1], "why": c[2]} for c in CHANGES]
    if not roles.get("order"):
        changes = [c for c in changes if c["id"] not in ("idempotency_keys", "cancel_once", "transactions_and_locks")]
    if roles.get("stock_min") is not None and roles["stock_min"] < 0:
        changes = [c for c in changes if c["id"] != "stock_never_negative"]

    differences = []
    for r in rules:
        h = r.get("history") or {}
        if r["new_order_rounding"] == "half_up":
            past = (f"{h['differ_from_half_up']} of {h['checked']} past orders were affected"
                    if h.get("checked") else "past orders could not be checked")
            differences.append({
                "id": "D-rounding", "title": "Half-cent discounts on new orders round up",
                "detail": f"The old code rounded with binary floating point, which can round a half cent down "
                          f"({past}). New orders round half up to the cent. Past orders keep their stored amounts."})
    if utc_cols:
        differences.append({"id": "D-utc-columns", "title": "UTC timestamps stay UTC",
                            "detail": f"{', '.join(utc_cols)} were written by SQLite in UTC. They move as UTC instants and "
                                      "come out of the API exactly as before."})
    if len(formats) > 1:
        differences.append({"id": "D-date-format", "title": "One date format in API responses",
                            "detail": "Older records stored dates with a 'T' between date and time (2021-03-04T10:22:31). "
                                      "The upgraded API returns every date one way (2021-03-04 10:22:31), in shop time."})
    for od in orphan_decisions:
        if od["decision"] == "placeholder":
            differences.append({"id": f"D-placeholder-{od['table']}", "title": "Deleted products show a placeholder name",
                                "detail": f"Order lines that pointed at deleted product(s) {od['missing_ids']} now "
                                          f"point at an inactive placeholder record, so the API shows its name "
                                          f"instead of an empty value."})
    if assessment["status_mappings"]:
        for col, mp in assessment["status_mappings"].items():
            differences.append({"id": f"D-status-{col}", "title": f"One spelling for each status in {col}",
                                "detail": "; ".join(f"'{a}' becomes '{b}'" for a, b in mp.items()) + "."})
    differences += [
        {"id": "D-cancel-once", "title": "A second cancel no longer adds stock",
         "detail": "Agreed fix. The old app added the stock back every time cancel was called."},
        {"id": "D-idempotency", "title": "Retried orders with the same Idempotency-Key are not duplicated",
         "detail": "Agreed addition. Without the header, behaviour is unchanged."},
        {"id": "D-unknown-routes", "title": "Unknown addresses answer in JSON",
         "detail": "Addresses the API does not have now return a short JSON error instead of Flask's HTML page. "
                   "Status codes are unchanged."},
        {"id": "D-unicode-search", "title": "Search also ignores case for accented letters",
         "detail": "SQLite's LIKE ignored case only for A-Z; PostgreSQL's ILIKE also matches accented letters."},
    ]
    if not roles.get("order"):
        differences = [d for d in differences if d["id"] not in ("D-cancel-once", "D-idempotency")]

    checklist = [
        ("records", "Every record arrives: the same number of customers, products, orders and order lines, "
                    "with every field matching after the agreed conversions."),
        ("relationships", "Every order still belongs to the same customer, and every order line to the same "
                          "order and product."),
        ("same_name", "Customers who share a name stay separate, each with their own orders."),
        ("money", "Stored totals arrive exactly; new orders follow the agreed discount and rounding rule."),
        ("stock", "Placing an order takes stock; cancelling puts it back once; refused orders change nothing."),
        ("retries", "Repeating a request does not create a second order or put stock back twice."),
        ("dates_statuses", "Dates keep their shop-time meaning and statuses keep their meaning; daily sales "
                           "reports give the same numbers."),
        ("read_update", "The upgraded app reads the moved data and can update it."),
        ("migration_retry", "Running the data move again creates no duplicates."),
        ("app_starts", "The delivered app installs from its own files, starts, and passes these checks."),
        ("compatibility", "The same requests to the old and new app give the same answers, except the agreed "
                          "differences listed in this proposal."),
    ]
    return {
        "schema_version": 1,
        "app_slug": slug,
        "app_title": app_title,
        "timezone": assessment["timezone"],
        "ambiguous_time_rule": (answers.get("ambiguous_time") or {}).get("decision", "later"),
        "datetime_output_format": out_fmt,
        "datetime_input_formats": sorted(formats) or ["%Y-%m-%d %H:%M:%S"],
        "money_columns": assessment["money_columns"],
        "timestamp_columns": [d["column"] for d in assessment["date_columns"] if not d["date_only"] and keep_as_time(d)],
        "date_columns": [d["column"] for d in assessment["date_columns"] if d["date_only"] and keep_as_time(d)],
        "timestamp_zones": {d["column"]: d.get("zone") or assessment["timezone"] for d in assessment["date_columns"]},
        "parse_decltypes": decltypes,
        "status_mappings": assessment["status_mappings"],
        "orphan_decisions": orphan_decisions,
        "rules": rules,
        "changes": changes,
        "keep": KEEP,
        "intentional_differences": differences,
        "acceptance_checklist": [{"id": c[0], "text": c[1]} for c in checklist],
        "roles": roles,
        "not_included": [
            "Visual redesign (the API has no pages).",
            "Moving the app to a new host or changing DNS; the run book explains the switch-over.",
            "New features beyond the agreed changes.",
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assessment", required=True)
    ap.add_argument("--answers")
    ap.add_argument("--slug", required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    answers = read_json(a.answers) if a.answers and Path(a.answers).exists() else {}
    scope = build(read_json(a.assessment), answers, a.slug, a.title or a.slug)
    write_json(a.out, scope)
    emit("scope.done", changes=len(scope["changes"]), differences=len(scope["intentional_differences"]))


if __name__ == "__main__":
    main()
