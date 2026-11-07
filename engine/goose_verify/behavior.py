"""Behaviour checks: replay the frozen scenario against the upgraded app and compare it with the
original app's recorded answers, then run the targeted business checks."""
import copy
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal

from .common import CENT, cents, diff, http, read_json
from .datachecks import result
from .record import run as run_scenario

ISO_T = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})$")


def window(rec, zone):
    """When a recorded run happened, as aware instants, plus the shop zone for reading naive text."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo

    def p(s):
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=ZoneInfo(zone))
    return (p(rec["started"]) - timedelta(minutes=2), p(rec["finished"]) + timedelta(minutes=2), zone)


class Normaliser:
    """Applies the agreed differences to the ORIGINAL app's answers, so what remains is a regression."""

    def __init__(self, scope):
        self.scope = scope
        ids = {d["id"] for d in scope["intentional_differences"]}
        self.date_format = "D-date-format" in ids
        self.status = {}
        for col, mp in scope["status_mappings"].items():
            self.status[col.split(".")[1]] = mp
        self.placeholder = {}
        for o in scope["orphan_decisions"]:
            if o["decision"] == "placeholder":
                for p in o["placeholders"]:
                    self.placeholder[p.get("id")] = p
        self.item_fk = scope["roles"].get("item_product_fk")
        self.counts = {}

    def bump(self, name):
        self.counts[name] = self.counts.get(name, 0) + 1

    def apply(self, value):
        if isinstance(value, list):
            return [self.apply(v) for v in value]
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                v = self.apply(v)
                if k in self.status and isinstance(v, str) and v in self.status[k]:
                    v = self.status[k][v]
                    self.bump(f"status {k}")
                out[k] = v
            if self.item_fk and out.get(self.item_fk) in self.placeholder:
                ph = self.placeholder[out[self.item_fk]]
                for k in list(out):
                    if k != "id" and k in ph and out[k] is None:
                        out[k] = ph[k]
                        self.bump("placeholder")
            return out
        if isinstance(value, str) and self.date_format:
            m = ISO_T.match(value)
            if m:
                self.bump("date format")
                return f"{m.group(1)} {m.group(2)}"
        return value


def drop_placeholders(body, placeholders, counts):
    """The agreed placeholder records may appear in the new app's lists; the old app had none."""
    if not placeholders or not isinstance(body, list):
        return body
    keep = []
    for x in body:
        ph = placeholders.get(x.get("id")) if isinstance(x, dict) else None
        if ph and all(str(x.get(k)) == str(v) or (isinstance(x.get(k), float) and float(v) == x.get(k))
                      for k, v in ph.items() if k in x):
            counts["placeholder in list"] = counts.get("placeholder in list", 0) + 1
            continue
        keep.append(x)
    return keep


def status_query(path, scope):
    """(column, value, canonical, variants) when a request filters on a status the move merged."""
    m = re.search(r"[?&](status|state)=([^&]+)", path)
    if not m:
        return None
    for col, mp in scope["status_mappings"].items():
        if col.split(".")[1] != m.group(1):
            continue
        v = m.group(2)
        if v in mp:
            return {"value": v, "legacy": True, "canonical": mp[v]}
        variants = [a for a, b in mp.items() if b == v]
        if variants:
            return {"value": v, "legacy": False, "canonical": v, "variants": variants, "arg": m.group(1)}
    return None


def swap_values(node, mapping):
    """Inside one record, replace each legacy money value by the agreed one (matching to the cent)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool) and str(cents(v)) in mapping:
                node[k] = float(mapping[str(cents(v))])
            elif isinstance(v, (dict, list)):
                swap_values(v, mapping)
    elif isinstance(node, list):
        for x in node:
            swap_values(x, mapping)


def set_fields(body, record_id, mapping):
    """Apply swap_values to every dict in body whose id is record_id."""
    if isinstance(body, list):
        for x in body:
            set_fields(x, record_id, mapping)
    elif isinstance(body, dict):
        if body.get("id") == record_id:
            swap_values(body, mapping)
        else:
            for v in body.values():
                if isinstance(v, (list, dict)):
                    set_fields(v, record_id, mapping)


def run_behavior(vault, new_url, dsn=None):
    scope = read_json(f"{vault}/scope.json")
    scenario = read_json(f"{vault}/scenario.json")
    baseline = read_json(f"{vault}/baseline.json")
    roles = scope["roles"]
    stock_col = roles.get("stock_column") or "stock"
    out = []
    health = http(new_url, "GET", "/healthz")
    root = http(new_url, "GET", "/")
    out.append(result("app.starts", "app_starts", "The upgraded app starts and answers",
                      health["status"] == 200 or root["status"] == 200, 200,
                      health["status"] if health["status"] else health.get("error")))
    rec = run_scenario(new_url, scenario, scope["timezone"])
    windows = (window(baseline, scope["timezone"]), window(rec, scope["timezone"]))
    norm = Normaliser(scope)
    base_by = {r["step"]: r for r in baseline["results"]}
    new_by = {r["step"]: r for r in rec["results"]}
    steps = {s["id"]: s for s in scenario["steps"]}
    overrides = []
    for s in scenario["steps"]:
        if s.get("agreed") == "D-rounding" and s.get("expect_totals") and s.get("legacy_totals") and s.get("save"):
            ref = next(iter(s["save"]))
            old_id = baseline["saved"].get(ref)
            mapping = {s["legacy_totals"][k]: s["expect_totals"][k] for k in ("discount", "total")
                       if s["legacy_totals"][k] != s["expect_totals"][k]}
            if old_id is not None and mapping:
                overrides.append((old_id, mapping))
    compat_fail = 0
    for s in scenario["steps"]:
        old, new = base_by.get(s["id"]), new_by.get(s["id"])
        ref_step = s.get("compare_with")
        if ref_step:
            old = base_by.get(ref_step)
        expected_body = norm.apply(copy.deepcopy(old["body"])) if old else None
        for rid, fields in overrides:
            set_fields(expected_body, rid, fields)
        if s.get("expect_stock") and isinstance(expected_body, dict):
            expected_body[stock_col] = s["expect_stock"]["stock"]
        if s.get("expect_stock", {}).get("in_list") and isinstance(expected_body, list):
            want = s["expect_stock"].get("id") or (baseline["saved"].get(s["expect_stock"].get("ref")))
            for x in expected_body:
                if isinstance(x, dict) and x.get("id") == want and stock_col in x:
                    x[stock_col] = s["expect_stock"]["stock"]
        if s.get("expect_fields") and isinstance(expected_body, dict):
            expected_body.update(s["expect_fields"])
        if s.get("drop_ref") and isinstance(expected_body, list):
            drop_id = baseline["saved"].get(s["drop_ref"])
            first_id = baseline["saved"].get("o_idem")
            if drop_id is not None and drop_id != first_id:
                expected_body = [x for x in expected_body if not (isinstance(x, dict) and x.get("id") == drop_id)]
        agreed = s.get("agreed")
        sq = status_query(s["path"], scope)
        if sq and sq["legacy"]:
            expected_body, agreed = [], f"D-status (records now use '{sq['canonical']}')"
        elif sq and isinstance(expected_body, list):
            for v in sq["variants"]:
                other = next((b for b in baseline["results"]
                              if b["path"] == s["path"].replace(f"{sq['arg']}={sq['value']}", f"{sq['arg']}={v}")), None)
                if other and isinstance(other["body"], list):
                    expected_body += norm.apply(copy.deepcopy(other["body"]))
            expected_body = sorted(expected_body, key=lambda x: x.get("id", 0), reverse=True)
            agreed = f"D-status (includes former {', '.join(sq['variants'])})"
        actual_body = drop_placeholders(copy.deepcopy(new["body"]) if new else None, norm.placeholder, norm.counts)
        if sq and isinstance(actual_body, list):
            actual_body = sorted(actual_body, key=lambda x: x.get("id", 0), reverse=True)
        problems = []
        if old is None or new is None:
            problems.append({"path": "$", "expected": "recorded step", "actual": "missing"})
        else:
            if old["status"] != new["status"]:
                problems.append({"path": "status", "expected": old["status"], "actual": new["status"]})
            if old.get("kind") == "json" or new.get("kind") == "json":
                problems += diff(expected_body, actual_body, windows=windows)
        ok = not problems
        compat_fail += 0 if ok else 1
        out.append(result(f"compat.{s['id']}", "compatibility",
                          f"{s['title']}" + (f" (agreed difference {agreed})" if agreed else ""),
                          ok, {"status": old["status"] if old else None},
                          {"status": new["status"] if new else None},
                          {"request": {"method": s["method"], "path": new["path"] if new else s["path"]},
                           "differences": problems[:6], "agreed": agreed}))
    out += targeted(scenario, rec, steps, roles, scope, new_url, dsn)
    out += coverage_gate(vault, scenario)
    out.append(result("compat.normalisations", "compatibility",
                      "Agreed differences applied when comparing (for the record)", True, None, norm.counts,
                      {"counts": norm.counts}))
    return out, rec


def money_of(body, field):
    if not isinstance(body, dict) or body.get(field) is None:
        return None
    return str(cents(body[field]))


def coverage_gate(vault, scenario):
    """Delivery needs the core order flows to have been exercised; a pass without them is not a pass."""
    a = read_json(f"{vault}/assessment.json")
    covered = set()
    for s in scenario["steps"]:
        if s.get("route"):
            covered.add(s["route"])
    core = [r["id"] for r in a["routes"] if r["kind"] in ("place_order", "cancel_order", "restock", "transition")]
    missing = [c for c in core if c not in covered]
    return [result("coverage.core_flows", "compatibility",
                   "The scenario exercised every order, cancel, status-change and restock endpoint",
                   not missing, core, {"not exercised": missing} if missing else "all exercised")]


def order_row(dsn, roles, order_id):
    import psycopg
    with psycopg.connect(dsn) as conn:
        cols = [roles.get("order_subtotal_column"), roles.get("order_discount_column"), roles.get("order_total_column")]
        cols = [c for c in cols if c]
        row = conn.execute(f'SELECT {", ".join(chr(34) + c + chr(34) for c in cols)} FROM "{roles["order"]}" WHERE id = %s',
                           (order_id,)).fetchone()
        return dict(zip(["subtotal", "discount", "total"][: len(cols)], [str(v) if v is not None else None for v in row])) if row else None


def targeted(scenario, rec, steps, roles, scope, base, dsn=None):
    out = []
    by_check = {}
    for s in scenario["steps"]:
        if s.get("check"):
            by_check.setdefault(s["check"], []).append(s)
    res = {r["step"]: r for r in rec["results"]}
    stock_col = roles.get("stock_column") or "stock"
    sub_c = roles.get("order_subtotal_column") or "subtotal"
    dis_c = roles.get("order_discount_column") or "discount"
    tot_c = roles.get("order_total_column") or "total"
    for name, label in (("below_threshold", "below the discount threshold"), ("at_threshold", "exactly at the threshold"),
                        ("half_cent", "with a half-cent discount (rounds half up)"), ("repeated_lines", "with a product on two lines")):
        for s in by_check.get(name, []):
            r = res[s["id"]]
            exp = s.get("expect_totals") or {}
            oid = r["body"].get("id") if isinstance(r["body"], dict) else None
            if dsn and oid is not None:
                got = order_row(dsn, roles, oid) or {}      # what was stored, whatever the response looks like
                where = "stored order"
            else:
                got = {"subtotal": money_of(r["body"], sub_c), "discount": money_of(r["body"], dis_c), "total": money_of(r["body"], tot_c)}
                where = "response"
            got = {k: v for k, v in got.items() if k in exp}
            out.append(result(f"money.{name}", "money", f"Order {label}: totals follow the agreed rule",
                              r["status"] == 201 and got == exp, exp, got, {"status": r["status"], "read_from": where}))
    for s in scenario["steps"]:
        if s.get("expect_stock"):
            r = res[s["id"]]
            actual = r["body"].get(stock_col) if isinstance(r["body"], dict) else None
            if s["expect_stock"].get("in_list") and isinstance(r["body"], list):
                want = s["expect_stock"].get("id") or rec["saved"].get(s["expect_stock"].get("ref"))
                actual = next((x.get(stock_col) for x in r["body"] if isinstance(x, dict) and x.get("id") == want), None)
            label = f"product #{s['expect_stock']['id']}" if s["expect_stock"].get("id") else f"test product {s['expect_stock']['ref'][1:]}"
            out.append(result(f"stock.{s['id']}", "stock", f"Stock of {label} "
                              f"{s['title'].split('(', 1)[-1].rstrip(')')} is {s['expect_stock']['stock']}",
                              actual == s["expect_stock"]["stock"], s["expect_stock"]["stock"], actual))
        if s.get("expect_fields"):
            r = res[s["id"]]
            got = {k: (r["body"] or {}).get(k) if isinstance(r["body"], dict) else None for k in s["expect_fields"]}
            out.append(result(f"read_update.{s['id']}", "read_update", s["title"] + ": stock went back up by the order's lines",
                              got == s["expect_fields"], s["expect_fields"], got))
    for s in by_check.get("insufficient_stock", []):
        r = res[s["id"]]
        out.append(result("stock.refused_order", "stock", "An order for more than is in stock is refused (409)",
                          r["status"] == 409, 409, r["status"]))
    for s in by_check.get("cancel_refused", []):
        r = res[s["id"]]
        out.append(result("stock.shipped_cannot_cancel", "stock", "A shipped order cannot be cancelled (409)",
                          r["status"] == 409, 409, r["status"]))
    for s in by_check.get("cancel", []):
        r = res[s["id"]]
        out.append(result("stock.cancel_ok", "stock", "Cancelling an order succeeds", r["status"] == 200, 200, r["status"]))
    for s in by_check.get("cancel_again", []):
        r = res[s["id"]]
        out.append(result("retries.cancel_twice", "retries",
                          "Cancelling the same order twice: the second request changes nothing", r["status"] == 200,
                          200, r["status"], {"note": "stock after the second cancel is checked separately"}))
    for s in by_check.get("idempotent_retry", []):
        r = res[s["id"]]
        first = res.get(s.get("compare_with"))
        same = first and isinstance(r["body"], dict) and isinstance(first["body"], dict) and \
            r["body"].get("id") == first["body"].get("id")
        out.append(result("retries.idempotency_key", "retries",
                          "A retried order with the same Idempotency-Key returns the first order instead of a new one",
                          bool(same), first["body"].get("id") if first and isinstance(first["body"], dict) else None,
                          r["body"].get("id") if isinstance(r["body"], dict) else r["status"]))
    for s in by_check.get("cancel_migrated", []):
        r = res[s["id"]]
        out.append(result("read_update.cancel_migrated", "read_update",
                          f"Order #{s['migrated_order']}, which came across from SQLite, can be cancelled",
                          r["status"] == 200, 200, r["status"]))
    for s in by_check.get("new_customer", []):
        r = res[s["id"]]
        out.append(result("read_update.create", "read_update", "A new customer can be created (201)",
                          r["status"] == 201, 201, r["status"]))
    fmt_bad = []
    pat = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
    for r in rec["results"]:
        def walk(v):
            if isinstance(v, dict):
                for x in v.values():
                    walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
            elif isinstance(v, str) and pat.match(v):
                fmt_bad.append(v)
        walk(r["body"])
    out.append(result("dates.api_format", "dates_statuses",
                      f"Every date in every response uses the agreed format ({scope['datetime_output_format']})",
                      not fmt_bad, "no other formats", fmt_bad[:5] or "no other formats"))
    out += concurrency(scenario, base, roles)
    return out


def concurrency(scenario, base, roles):
    """Several identical orders at once for a product with little stock: none may oversell."""
    create_p = next((s for s in scenario["steps"] if s["title"].startswith("Create test product A")), None)
    place = next((s for s in scenario["steps"] if s.get("check") == "below_threshold"), None)
    stock_col = roles.get("stock_column") or "stock"
    fixed = scenario.get("fixed") or {}
    if not place or not (create_p or "pD" in fixed):
        return [result("concurrency.no_oversell", "stock", "Orders arriving at the same time cannot oversell stock",
                       False, None, None, {"reason": "no order route or test product"}, skipped=True)]
    if create_p:
        body = copy.deepcopy(create_p["body"])
        for k in body:
            if isinstance(body[k], str) and body[k].startswith("PWCHK-"):
                body[k] = "PWCHK-CONC"
            if k == stock_col or k in ("stock", "qty_on_hand"):
                body[k] = 5
        made = http(base, "POST", create_p["path"], body)
        pid = (made.get("body") or {}).get("id") if isinstance(made.get("body"), dict) else None
        if pid is None:
            return [result("concurrency.no_oversell", "stock", "Orders arriving at the same time cannot oversell stock",
                           False, "a test product", made.get("status"))]
        have = 5
    else:
        pid, have = fixed["pD"], scenario["ledger_final"]["pD"]   # an existing product; its stock is known exactly
    order = copy.deepcopy(place["body"])
    lk = next(k for k, v in order.items() if isinstance(v, list))
    pk_ = next(k for k in order[lk][0] if order[lk][0][k] == "{pA}")
    qk = next(k for k in order[lk][0] if k != pk_)
    order[lk] = [{pk_: pid, qk: 1}]
    n = have + 7
    with ThreadPoolExecutor(max_workers=12) as ex:
        codes = list(ex.map(lambda _: http(base, "POST", place["path"], order)["status"], range(n)))
    reader = next((s for s in scenario["steps"] if s.get("expect_stock")), None)
    final = None
    if reader and reader["expect_stock"].get("in_list"):
        final = next((x.get(stock_col) for x in (http(base, "GET", reader["path"]).get("body") or []) if isinstance(x, dict)
                      and x.get("id") == pid), None)
    elif reader and "{pA}" in reader["path"]:
        final = (http(base, "GET", reader["path"].replace("{pA}", str(pid))).get("body") or {}).get(stock_col)
    ok = codes.count(201) == have and codes.count(409) == n - have and final == 0
    return [result("concurrency.no_oversell", "stock",
                   f"{n} orders at the same time for a product with {have} in stock: exactly {have} succeed, stock ends at 0",
                   ok, {"201": have, "409": n - have, "final_stock": 0},
                   {"201": codes.count(201), "409": codes.count(409), "other": len(codes) - codes.count(201) - codes.count(409),
                    "final_stock": final})]
