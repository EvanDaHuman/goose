"""Build the representative scenario: the same requests are sent to the original application and
to the upgraded one, each on its own copy of the data.

Reads cover real records, including the awkward ones the assessment found. Writes use products
the scenario creates itself, and an independent stock ledger says what every stock level must be.
"""
import random
import re
from decimal import Decimal

from .common import apply_rule, sqlite_ro

SEED = 7


def table_for_param(name, route, tables, roles):
    if name == "id":
        return (route.get("kind_info") or {}).get("table")
    base = re.sub(r"_?id$", "", name)
    for role in ("customer", "product", "order", "order_item"):
        t = roles.get(role)
        if t and (base == role or t.startswith(base) or base.startswith(t.rstrip("s"))):
            return t
    for t in tables:
        if t in (base, base + "s", base + "es") or t.rstrip("s") == base:
            return t
    return (route.get("kind_info") or {}).get("table")


class Builder:
    def __init__(self, assessment, scope, source_db):
        self.a, self.s = assessment, scope
        self.roles = scope["roles"]
        self.tables = assessment["tables"]
        self.routes = assessment["routes"]
        self.db = sqlite_ro(source_db)
        self.rnd = random.Random(SEED)
        self.steps = []
        self.coverage = {"covered_routes": set(), "notes": []}
        self.ledger = {}
        self.fixed = {}   # refs bound to existing records (when the app cannot create test products)
        self.qty = {}     # order quantities that reach a tier with an existing product's price

    def add(self, title, method, path, route=None, body=None, headers=None, **extra):
        step = {"id": f"S{len(self.steps) + 1:03d}", "title": title, "method": method, "path": path,
                "body": body, "headers": headers or {}, "route": route["id"] if route else None}
        step.update(extra)
        self.steps.append(step)
        if route:
            self.coverage["covered_routes"].add(route["id"])
        return step

    def route(self, kind, table=None, pred=None):
        for r in self.routes:
            if r["kind"] == kind and (table is None or (r.get("kind_info") or {}).get("table") == table) \
                    and (pred is None or pred(r)):
                return r
        return None

    def fill(self, route, values):
        path = route["path"]
        for p in route["path_params"]:
            path = path.replace("{" + p["name"] + "}", str(values[p["name"]]))
        return path

    # -------------------------------------------------------------- samples
    def ids(self, table, n=3):
        pk = next((c["name"] for c in self.tables[table]["columns"] if c["pk"]), "rowid")
        all_ids = [r[0] for r in self.db.execute(f'SELECT "{pk}" FROM "{table}" ORDER BY "{pk}"')]
        if not all_ids:
            return [], pk
        picks = [all_ids[0], all_ids[-1]] + self.rnd.sample(all_ids, min(n, len(all_ids)))
        return list(dict.fromkeys(picks)), pk

    def special_ids(self, table):
        r, out = self.roles, []
        if table == r.get("customer"):
            for d in r.get("same_name_customers", [])[:3]:
                col = r.get("customer_name_column")
                out += [x[0] for x in self.db.execute(f'SELECT id FROM "{table}" WHERE "{col}" = ?', (d["name"],))]
        if table == r.get("order"):
            for a in self.s.get("ambiguous_times") or self.a.get("ambiguous_times", []):
                t, c = a["column"].split(".")
                if t == table:
                    out += [x[0] for x in self.db.execute(f'SELECT id FROM "{t}" WHERE "{c}" = ?', (a["value"],))]
            for col, mp in self.s["status_mappings"].items():
                t, c = col.split(".")
                if t == table:
                    for legacy in mp:
                        out += [x[0] for x in self.db.execute(f'SELECT id FROM "{t}" WHERE "{c}" = ? LIMIT 2', (legacy,))]
            for o in self.s["orphan_decisions"]:
                if o["table"] == r.get("order_item"):
                    fk = r.get("item_order_fk")
                    q = (f'SELECT DISTINCT "{fk}" FROM "{o["table"]}" WHERE "{o["column"]}" IN '
                         f'({",".join("?" * len(o["missing_ids"]))})')
                    out += [x[0] for x in self.db.execute(q, o["missing_ids"])]
            out += (r.get("orders_not_matching_lines") or [])[:2]
            for rule in self.s["rules"]:
                for ex in (rule.get("history") or {}).get("half_up_examples", [])[:2]:
                    sub = r.get("order_subtotal_column")
                    out += [x[0] for x in self.db.execute(f'SELECT id FROM "{table}" WHERE "{sub}" = ? LIMIT 1',
                                                          (ex["subtotal"],))]
        return list(dict.fromkeys(out))

    def query_values(self, route, arg):
        r = self.roles
        a = arg.lower()
        if a in ("name", "q", "search", "query", "full_name", "client_name", "customer_name"):
            out = []
            dup = (r.get("same_name_customers") or [{}])[0].get("name")
            if dup:
                last = dup.split()[-1]
                out += [last.lower(), last.upper(), last[:3].lower()]
            return out + ["zzqx"]
        if a.endswith("_id"):
            t = table_for_param(arg, route, self.tables, r)
            if t == r.get("customer") and r.get("order"):
                fk = r.get("order_customer_fk")
                row = self.db.execute(f'SELECT "{fk}", COUNT(*) FROM "{r["order"]}" GROUP BY 1 ORDER BY 2 DESC LIMIT 1').fetchone()
                return [str(row[0])] if row else []
            ids, _ = self.ids(t, 1) if t in self.tables else ([], None)
            return [str(i) for i in ids[:2]]
        if a in ("status", "state"):
            col = r.get("status_column")
            if r.get("order") and col:
                return [x[0] for x in self.db.execute(
                    f'SELECT DISTINCT "{col}" FROM "{r["order"]}" ORDER BY 1')]
        if a in ("date", "day", "on"):
            return self.report_dates()
        if a.startswith(("in_", "is_", "include", "active", "only")):
            return ["1", "0"]
        self.coverage["notes"].append(f"{route['id']}: no sample values for query parameter '{arg}'")
        return []

    def report_dates(self):
        r = self.roles
        t, c = r.get("order"), r.get("order_created_column")
        if not (t and c):
            return []
        out = [a["value"][:10] for a in self.a.get("ambiguous_times", [])]
        for col, mp in self.s["status_mappings"].items():
            for legacy in mp:
                row = self.db.execute(f'SELECT substr("{c}", 1, 10) FROM "{t}" WHERE "{r.get("status_column")}" = ? LIMIT 1',
                                      (legacy,)).fetchone()
                if row:
                    out.append(row[0])
        days = [x[0] for x in self.db.execute(f'SELECT DISTINCT substr("{c}", 1, 10) FROM "{t}" ORDER BY 1')]
        out += self.rnd.sample(days, min(5, len(days)))
        out.append("2019-01-01")  # no orders
        return list(dict.fromkeys(out))

    # -------------------------------------------------------------- reads
    def reads(self):
        for r in self.routes:
            if r["methods"][0] != "GET":
                continue
            if r["kind"] == "index" or (not r["path_params"] and not r["query_args"]):
                self.add(f"GET {r['path']}", "GET", r["path"], r, group="read")
            if not r["path_params"]:
                for arg in r["query_args"]:
                    for v in self.query_values(r, arg):
                        self.add(f"GET {r['path']}?{arg}={v}", "GET", f"{r['path']}?{arg}={v}", r, group="read",
                                 tags=["search"] if arg.lower() in ("name", "q", "search") else [])
                continue
            if len(r["path_params"]) != 1:
                self.coverage["notes"].append(f"{r['id']}: more than one path parameter, read with one sample only")
            p = r["path_params"][0]
            t = table_for_param(p["name"], r, self.tables, self.roles)
            if t not in self.tables:
                self.coverage["notes"].append(f"{r['id']}: could not tell which table '{p['name']}' refers to")
                continue
            ids, _ = self.ids(t)
            for i in list(dict.fromkeys(ids + self.special_ids(t)))[:14]:
                self.add(f"GET {self.fill(r, {p['name']: i})}", "GET", self.fill(r, {p["name"]: i}), r, group="read")
            missing = (self.tables[t].get("max_id") or 0) + 100000
            self.add(f"GET {self.fill(r, {p['name']: missing})} (does not exist)", "GET",
                     self.fill(r, {p["name"]: missing}), r, group="read")

    # -------------------------------------------------------------- writes
    def writes(self):
        r = self.roles
        create_c = self.route("create", r.get("customer"))
        create_p = self.route("create", r.get("product"))
        restock = self.route("restock")
        place = self.route("place_order")
        cancel = self.route("cancel_order")
        transition = self.route("transition")
        get_p = self.route("get", r.get("product"), lambda x: table_for_param(
            x["path_params"][0]["name"], x, self.tables, r) == r.get("product"))
        get_o = self.route("get", r.get("order"), lambda x: table_for_param(
            x["path_params"][0]["name"], x, self.tables, r) == r.get("order"))
        if create_c:
            body = {k: f"PW Check {k}" for k in create_c["payload"]["keys"]}
            for k in create_c["payload"]["keys"]:
                if "mail" in k:
                    body[k] = "pw.check@example.com"
            self.add("Create a customer", "POST", create_c["path"], create_c, body=body, group="write",
                     save={"c_new": "id"}, check="new_customer")
            self.add("Create a customer with nothing filled in", "POST", create_c["path"], create_c, body={},
                     group="write")
        if not place:
            self.coverage["notes"].append("No order route recognised; order flows not tested.")
            return
        list_p = self.route("list", r.get("product"))
        keys = create_p["payload"]["keys"] if create_p else []
        cols = {c["name"]: c for c in self.tables[r["product"]]["columns"]}

        def product_body(tag, price, stock):
            body = {}
            for k in keys:
                if k == r.get("price_column") or "price" in k or "cost" in k:
                    body[k] = float(price)
                elif k == r.get("stock_column") or k in ("stock", "qty_on_hand", "quantity"):
                    body[k] = stock
                elif k == r.get("sku_column") or "sku" in k or "code" in k:
                    body[k] = f"PWCHK-{tag}"
                else:
                    body[k] = f"PW check product {tag}"
            return body

        rule = self.s["rules"][0] if self.s["rules"] else None
        tiers = sorted(rule["tiers"], key=lambda t: Decimal(t["min"])) if rule else []
        first_min = Decimal(tiers[0]["min"]) if tiers else Decimal("250.00")
        prices = {"A": Decimal("19.99"), "B": first_min}
        half = None
        if tiers:
            rate = Decimal(tiers[0]["rate"])
            for c in range(int(first_min * 100) + 1, int(first_min * 100) + 20000):
                v = Decimal(c) / 100
                upper = Decimal(tiers[1]["min"]) if len(tiers) > 1 else None
                if upper is not None and v >= upper:
                    break
                if (v * rate * 100) % 1 == Decimal("0.5"):
                    half = v
                    break
        if half is not None:
            prices["C"] = half
        prices["D"] = Decimal("12.50")
        stock0 = {"A": 50, "B": 50, "C": 50, "D": 2}
        if create_p:
            for tag, price in prices.items():
                self.add(f"Create test product {tag} at {price}", "POST", create_p["path"], create_p,
                         body=product_body(tag, price, stock0[tag]), group="write", save={f"p{tag}": "id"})
                self.ledger[f"p{tag}"] = stock0[tag]
            if r.get("sku_column") and any(ix["unique"] for ix in self.tables[r["product"]].get("indexes", [])):
                self.add("Create a product with a code that already exists", "POST", create_p["path"], create_p,
                         body=product_body("A", prices["A"], 1), group="write")
            self.add("Create a product with nothing filled in", "POST", create_p["path"], create_p, body={}, group="write")
        else:
            # no way to create a product: use real products from the snapshot; both apps start from the same data
            prices, stock0 = self.pick_existing_products(tiers)
            if "A" not in prices or "D" not in prices:
                self.coverage["notes"].append("No suitable existing products to test orders with; order flows not tested.")
                return
            self.coverage["notes"].append("The app cannot create products, so order flows use existing products: "
                                          + ", ".join(f"{k} = #{v}" for k, v in self.fixed.items()))

        def read_product(ref, why):
            if get_p:
                p = get_p["path_params"][0]["name"]
                self.add(f"Read test product {ref[1:]} ({why})", "GET", self.fill(get_p, {p: "{" + ref + "}"}), get_p,
                         group="write", expect_stock={"ref": ref, "stock": self.ledger[ref]})
            elif list_p:
                self.add(f"Read product {ref[1:]} in the list ({why})", "GET", list_p["path"], list_p,
                         group="write", expect_stock={"ref": ref, "stock": self.ledger[ref], "in_list": True})

        if restock:
            qk = restock["payload"]["keys"][0] if restock["payload"]["keys"] else "quantity"
            p = restock["path_params"][0]["name"]
            self.add("Restock test product A by 3", "POST", self.fill(restock, {p: "{pA}"}), restock,
                     body={qk: 3}, group="write")
            self.ledger["pA"] += 3
            read_product("pA", "after restock")
            self.add("Restock with quantity 0", "POST", self.fill(restock, {p: "{pA}"}), restock, body={qk: 0},
                     group="write")
            self.add("Restock a product that does not exist", "POST", self.fill(restock, {p: 99999999}), restock,
                     body={qk: 1}, group="write")

        pay = r.get("order_payload") or {}
        okeys, lk, ikeys = pay.get("keys", []), pay.get("list_key"), pay.get("item_keys", [])
        ck = next((k for k in okeys if k == r.get("order_customer_fk")), None) or \
            next((k for k in okeys if "customer" in k or "client" in k), okeys[0] if okeys else "customer_id")
        qk_ = next((k for k in ikeys if "qty" in k or "quant" in k or k in ("count", "units", "amount")), ikeys[-1] if ikeys else "quantity")
        pk_ = next((k for k in ikeys if k == r.get("item_product_fk")), None) or \
            next((k for k in ikeys if k != qk_), "product_id")   # the line's other key names the product
        cust = self.db.execute(f'SELECT MIN(id) FROM "{r["customer"]}"').fetchone()[0] if r.get("customer") else 1

        def order_body(lines, customer=cust):
            return {ck: customer, lk: [{pk_: "{" + ref + "}", qk_: q} for ref, q in lines]}

        def expect_totals(lines):
            sub = sum(prices[ref[1:]] * q for ref, q in lines)
            s, d, t = apply_rule(rule, sub) if rule else (sub, Decimal("0"), sub)
            return {"subtotal": str(s), "discount": str(d), "total": str(t)}

        def legacy_totals(lines):
            # what the original code computes: binary floats and Python's round() (round half to even)
            sub = round(sum(float(prices[ref[1:]]) * q for ref, q in lines), 2)
            d = 0.0
            for tier in sorted(rule["tiers"], key=lambda t: -Decimal(t["min"])):
                if (sub >= float(tier["min"])) if tier.get("inclusive", True) else (sub > float(tier["min"])):
                    d = round(sub * float(tier["rate"]), 2)
                    break
            return {"subtotal": f"{sub:.2f}", "discount": f"{d:.2f}", "total": f"{round(sub - d, 2):.2f}"}

        def place_order(title, lines, save, check=None, **extra):
            step = self.add(title, "POST", place["path"], place, body=order_body(lines), group="write",
                            save={save: "id"}, expect_totals=expect_totals(lines) if rule else None,
                            legacy_totals=legacy_totals(lines) if rule else None, check=check, **extra)
            for ref, q in lines:
                self.ledger[ref] -= q
            return step

        qB, qC = self.qty.get("B", 1), self.qty.get("C", 1)
        place_order("Order below the discount threshold (2 x A)", [("pA", 2)], "o1", check="below_threshold")
        read_product("pA", "after order 1")
        if "B" in prices:
            place_order(f"Order exactly at the threshold ({qB} x B = {prices['B'] * qB})", [("pB", qB)], "o2", check="at_threshold")
        if "C" in prices:
            place_order(f"Order where the discount is exactly half a cent ({qC} x C = {prices['C'] * qC})", [("pC", qC)], "o3",
                        check="half_cent", agreed="D-rounding")
        over = stock0["D"] + 3
        self.add(f"Order more than is in stock ({over} x D, stock {stock0['D']})", "POST", place["path"], place,
                 body=order_body([("pD", over)]), group="write", check="insufficient_stock")
        read_product("pD", "after the refused order")
        self.add("Order for a customer that does not exist", "POST", place["path"], place,
                 body=order_body([("pA", 1)], customer=99999999), group="write")
        self.add("Order with no lines", "POST", place["path"], place, body={ck: cust, lk: []}, group="write")
        self.add("Order with quantity 0", "POST", place["path"], place, body=order_body([("pA", 0)]), group="write")
        self.add("Order for a product that does not exist", "POST", place["path"], place,
                 body={ck: cust, lk: [{pk_: 99999999, qk_: 1}]}, group="write")
        place_order("Order with the same product on two lines (1 x A + 2 x A)", [("pA", 1), ("pA", 2)], "o4",
                    check="repeated_lines")
        read_product("pA", "after order 4")
        if get_o:
            p = get_o["path_params"][0]["name"]
            self.add("Read order 1", "GET", self.fill(get_o, {p: "{o1}"}), get_o, group="write")
        if cancel:
            p = cancel["path_params"][0]["name"]
            self.add("Cancel order 1", "POST", self.fill(cancel, {p: "{o1}"}), cancel, group="write", check="cancel")
            self.ledger["pA"] += 2
            read_product("pA", "after cancelling order 1")
            self.add("Cancel order 1 again", "POST", self.fill(cancel, {p: "{o1}"}), cancel, group="write",
                     check="cancel_again", agreed="D-cancel-once")
            read_product("pA", "after cancelling order 1 a second time")
            self.add("Cancel an order that does not exist", "POST", self.fill(cancel, {p: 99999999}), cancel,
                     group="write")
        if transition:
            p = transition["path_params"][0]["name"]
            ref, name = ("{o2}", "order 2") if "B" in prices else ("{o4}", "order 4")   # an order this scenario created
            self.add(f"Move {name} on ({transition['kind_info']['status'][2]})", "POST",
                     self.fill(transition, {p: ref}), transition, group="write")
            if cancel:
                pc = cancel["path_params"][0]["name"]
                self.add(f"Cancel {name} after it is {transition['kind_info']['status'][2]}", "POST",
                         self.fill(cancel, {pc: ref}), cancel, group="write", check="cancel_refused")
            self.add(f"Move {name} on a second time", "POST", self.fill(transition, {p: ref}), transition,
                     group="write")
        # changes to records that came across in the move
        pend_val = None
        sc = r.get("status_column")
        if r.get("order") and sc:
            vals = [x[0] for x in self.db.execute(f'SELECT DISTINCT "{sc}" FROM "{r["order"]}"')]
            pend_val = next((v for v in vals if v in ("pending", "open", "new", "placed")), None)
        if pend_val and cancel:
            rows = [x[0] for x in self.db.execute(
                f'SELECT id FROM "{r["order"]}" WHERE "{sc}" = ? ORDER BY id', (pend_val,))]
            if rows:
                pid = rows[0]
                p = cancel["path_params"][0]["name"]
                self.add(f"Cancel order #{pid}, which came across from the old database", "POST",
                         self.fill(cancel, {p: pid}), cancel, group="write", check="cancel_migrated",
                         migrated_order=pid)
                if get_p or list_p:
                    items = self.db.execute(
                        f'SELECT "{r["item_product_fk"]}", SUM("{r["quantity_column"]}") FROM "{r["order_item"]}" '
                        f'WHERE "{r["item_order_fk"]}" = ? GROUP BY 1', (pid,)).fetchall()
                    for prod, qty in items[:3]:
                        stock = self.db.execute(f'SELECT "{r["stock_column"]}" FROM "{r["product"]}" WHERE id = ?',
                                                (prod,)).fetchone()
                        if stock and get_p:
                            pp = get_p["path_params"][0]["name"]
                            self.add(f"Read product #{prod} after cancelling order #{pid}", "GET",
                                     self.fill(get_p, {pp: prod}), get_p, group="write",
                                     expect_fields={r["stock_column"]: stock[0] + qty})
                        elif stock:
                            self.add(f"Read product #{prod} in the list after cancelling order #{pid}", "GET", list_p["path"],
                                     list_p, group="write", expect_stock={"id": prod, "stock": stock[0] + qty, "in_list": True,
                                                                          "migrated": True})
            if transition and len(rows) > 1:
                p = transition["path_params"][0]["name"]
                self.add(f"Move order #{rows[1]} on, which came across from the old database", "POST",
                         self.fill(transition, {p: rows[1]}), transition, group="write")
        # retried request with an Idempotency-Key: last, so the old app's duplicate shifts no ids
        key = "gs-check-retry-1"
        first = place_order("Order with an Idempotency-Key (first attempt)", [("pA", 1)], "o_idem",
                            headers={"Idempotency-Key": key})
        self.add("Same order, same Idempotency-Key (retry)", "POST", place["path"], place,
                 body=order_body([("pA", 1)]), headers={"Idempotency-Key": key}, group="write",
                 save={"o_idem_retry": "id"}, check="idempotent_retry", agreed="D-idempotency",
                 compare_with=first["id"])
        read_product("pA", "after the retried order")
        orders_of = self.route("get", r.get("order"), lambda x: table_for_param(
            x["path_params"][0]["name"], x, self.tables, r) == r.get("customer"))
        if orders_of:
            p = orders_of["path_params"][0]["name"]
            self.add("List the test customer's orders", "GET", self.fill(orders_of, {p: cust}), orders_of,
                     group="write", drop_ref="o_idem_retry", agreed="D-idempotency")

    def pick_existing_products(self, tiers):
        """Choose real products (and quantities) that exercise each discount tier, from the snapshot."""
        r = self.roles
        t, pc, sc, ac = r["product"], r.get("price_column"), r.get("stock_column"), r.get("active_column")
        where = f'WHERE "{ac}" = 1' if ac else ""
        rows = [(row[0], Decimal(repr(float(row[1]))).quantize(Decimal("0.01")), int(row[2])) for row in self.db.execute(
            f'SELECT id, "{pc}", "{sc}" FROM "{t}" {where} ORDER BY id')]
        prices, stock0 = {}, {}
        roomy = sorted([x for x in rows if x[2] >= 10], key=lambda x: x[1])
        first = Decimal(tiers[0]["min"]) if tiers else None
        if roomy:
            a = next((x for x in roomy if first is None or x[1] * 3 < first), roomy[0])
            self.fixed["pA"], prices["A"], stock0["A"] = a[0], a[1], a[2]
            self.ledger["pA"] = a[2]
        if tiers:
            # exactly at the first threshold, then a half-cent discount, using quantity 1..stock of one product
            for x in rows:
                if "B" in prices:
                    break
                for q in range(1, x[2] + 1):
                    if x[1] * q == first and x[0] != self.fixed.get("pA"):
                        self.fixed["pB"], prices["B"], stock0["B"] = x[0], x[1], x[2]
                        self.qty["B"] = q
                        self.ledger["pB"] = x[2]
                        break
            rate = Decimal(tiers[0]["rate"])
            upper = Decimal(tiers[1]["min"]) if len(tiers) > 1 else None
            for x in rows:
                if "C" in prices or x[0] in self.fixed.values():
                    continue
                for q in range(1, x[2] + 1):
                    v = x[1] * q
                    if v >= first and (upper is None or v < upper) and (v * rate * 100) % 1 == Decimal("0.5"):
                        self.fixed["pC"], prices["C"], stock0["C"] = x[0], x[1], x[2]
                        self.qty["C"] = q
                        self.ledger["pC"] = x[2]
                        break
        small = sorted([x for x in rows if x[0] not in self.fixed.values() and 2 <= x[2] <= 20], key=lambda x: x[2]) or \
            [x for x in rows if x[0] not in self.fixed.values() and x[2] <= 20]
        if small:
            d = small[0]
            self.fixed["pD"], prices["D"], stock0["D"] = d[0], d[1], d[2]
            self.ledger["pD"] = d[2]
        self.unit = {k: v for k, v in prices.items()}
        return prices, stock0

    def build(self):
        self.reads()
        self.writes()
        uncovered = [r["id"] for r in self.routes if r["id"] not in self.coverage["covered_routes"]]
        return {"steps": self.steps, "ledger_final": self.ledger, "fixed": self.fixed,
                "coverage": {"routes_total": len(self.routes), "routes_covered": len(self.routes) - len(uncovered),
                             "uncovered_routes": uncovered, "notes": self.coverage["notes"]}}


def build(assessment, scope, source_db):
    return Builder(assessment, scope, source_db).build()
