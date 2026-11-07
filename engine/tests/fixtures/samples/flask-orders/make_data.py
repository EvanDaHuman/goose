"""Build the synthetic Sample Supply database (TEST DATA ONLY).

Every name, email and order below is generated from a fixed seed. Nothing here describes a
real business or a real person. Emails use the reserved example.com domain.

The data deliberately carries the quirks a real six-year-old SQLite file accumulates, so the
upgrade has something real to find:
  * money stored as binary floating point (REAL)
  * timestamps as text in local shop time, in two formats (an older release used 'T')
  * two orders placed inside the hour that repeats when daylight saving time ends
  * the status 'canceled' (older code) next to 'cancelled' (newer code)
  * customers who share a name
  * order items that point at a product deleted by hand in 2023
  * one order whose stored total was edited by hand after it was placed
  * historical unit prices that differ from today's catalogue prices

Usage:  python make_data.py OUTPUT.db
"""
import random
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

SEED = 20241104
HERE = Path(__file__).resolve().parent

FIRST = ["Maria", "John", "Wei", "Fatima", "James", "Aisha", "Daniel", "Sofia", "Liam", "Olivia",
         "Noah", "Emma", "Lucas", "Mia", "Ethan", "Ava", "Mateo", "Isabella", "Arjun", "Chloe",
         "Hiroshi", "Zara", "Diego", "Grace", "Omar", "Hannah", "Ivan", "Leila", "Samuel", "Nora",
         "Tomas", "Priya", "Kofi", "Elena", "Ryan", "Amara", "Felix", "Ines", "Caleb", "Yara"]
LAST = ["Garcia", "Smith", "Chen", "Khan", "Johnson", "Okafor", "Novak", "Rossi", "Brown",
        "Silva", "Nguyen", "Kim", "Patel", "Muller", "Haddad", "Larsen", "Moreau", "Tanaka",
        "Walsh", "Costa", "Ibrahim", "Kowalski", "Reyes", "Fischer", "Osei", "Duarte", "Ali",
        "Berg", "Price", "Lopez"]

PRODUCT_WORDS = [
    ("Brass cleat", "4 in"), ("Brass cleat", "6 in"), ("Marine rope", "10 m"), ("Marine rope", "25 m"),
    ("Dock line", "15 ft"), ("Dock line", "25 ft"), ("Fender", "small"), ("Fender", "large"),
    ("Boat hook", "telescopic"), ("Anchor chain", "5 m"), ("Shackle", "stainless 8 mm"),
    ("Shackle", "stainless 10 mm"), ("Bilge pump", "500 gph"), ("Bilge pump", "1100 gph"),
    ("Navigation light", "bow"), ("Navigation light", "stern"), ("Life jacket", "adult"),
    ("Life jacket", "child"), ("Throw ring", "24 in"), ("Paddle", "aluminium"),
    ("Paddle", "wood"), ("Hull cleaner", "1 L"), ("Teak oil", "500 ml"), ("Antifouling paint", "2.5 L"),
    ("Antifouling paint", "5 L"), ("Epoxy kit", "small"), ("Epoxy kit", "large"),
    ("Sail tape", "roll"), ("Winch handle", "10 in"), ("Snatch block", "60 mm"),
    ("Swivel", "stainless"), ("Mooring buoy", "orange"), ("Deck brush", "soft"),
    ("Bucket", "collapsible"), ("Flashlight", "waterproof"), ("Air horn", "standard"),
    ("Flare kit", "coastal"), ("First aid kit", "marine"), ("Compass", "handheld"),
    ("Chart plotter mount", "universal"), ("Cable ties", "pack of 100"), ("Hose clamp", "set"),
    ("Fuel filter", "10 micron"), ("Spark plug", "marine"), ("Impeller", "standard"),
    ("Zinc anode", "shaft"), ("Zinc anode", "plate"), ("Gelcoat repair", "white"),
    ("Varnish", "1 L"), ("Rope cutter", "hand"), ("Bow line", "20 ft"), ("Kayak strap", "pair"),
    ("Dry bag", "20 L"), ("Dry bag", "40 L"), ("Rain jacket", "M"), ("Rain jacket", "L"),
    ("Deck shoe", "size 9"), ("Deck shoe", "size 10"), ("Sunglasses", "polarised"),
    ("Sun hat", "wide brim"), ("Gloves", "sailing"), ("Knife", "rigging"), ("Tool kit", "basic"),
    ("Battery", "deep cycle"), ("Battery switch", "dual"), ("Solar panel", "50 W"),
    ("Cooler", "25 qt"), ("Cushion", "seat"), ("Ladder", "folding"), ("Grab rail", "12 in"),
    ("Cleaning cloth", "microfibre"), ("Wax", "polish"), ("Hatch seal", "3 m"),
    ("Sealant", "white tube"), ("Bimini strap", "pair"), ("Cover clip", "set of 10"),
    ("Tie-down", "ratchet"), ("Trailer light", "kit"), ("Bow roller", "standard"),
    ("Anchor", "folding 3 kg"), ("Anchor", "plough 7 kg"), ("Bell", "brass"),
    ("Flag", "ensign"), ("Gift card", "store"),
]

DELETED_PRODUCTS = {57, 71}          # removed by hand in 2023 (see README)
ORPHAN_ORDER_COUNT = 3               # orders that still reference product 57
MANUAL_EDIT_ORDER = 812              # stored total edited by hand after the order was placed


def legacy_compute_totals(lines):
    """Exactly what the legacy app.py does - binary floats and Python's round()."""
    subtotal = 0.0
    for price, qty in lines:
        subtotal += price * qty
    subtotal = round(subtotal, 2)
    discount = 0.0
    if subtotal >= 250.00:
        discount = round(subtotal * 0.10, 2)
    total = round(subtotal - discount, 2)
    return subtotal, discount, total


def fmt(ts, old_format):
    return ts.strftime("%Y-%m-%dT%H:%M:%S" if old_format else "%Y-%m-%d %H:%M:%S")


def build(path):
    rnd = random.Random(SEED)
    path = Path(path)
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(str(path))
    conn.executescript((HERE / "repo" / "schema.sql").read_text())

    # ------------------------------------------------------------ customers
    customers = []
    start = datetime(2020, 9, 1, 9, 0, 0)
    fixed_dupes = [("Maria", "Garcia"), ("Maria", "Garcia"), ("Maria", "Garcia"),
                   ("John", "Smith"), ("John", "Smith"), ("Wei", "Chen"), ("Wei", "Chen"),
                   ("Fatima", "Khan"), ("Fatima", "Khan")]
    names = list(fixed_dupes)
    seen = set(fixed_dupes)
    while len(names) < 240:
        pair = (rnd.choice(FIRST), rnd.choice(LAST))
        if pair in seen:
            continue
        seen.add(pair)
        names.append(pair)
    rnd.shuffle(names)
    email_counts = {}
    for i, (first, last) in enumerate(names, start=1):
        base = f"{first}.{last}".lower()
        email_counts[base] = email_counts.get(base, 0) + 1
        n = email_counts[base]
        email = f"{base}{'' if n == 1 else n}@example.com"
        if rnd.random() < 0.06:
            email = None            # a few walk-in customers never gave an email
        phone = f"555-01{rnd.randint(10, 99)}" if rnd.random() < 0.7 else None
        created = start + timedelta(days=i * 5, minutes=rnd.randint(0, 600))
        customers.append((i, f"{first} {last}", email, phone, fmt(created, created < datetime(2021, 6, 1))))
    conn.executemany("INSERT INTO customers (id, name, email, phone, created_at) VALUES (?,?,?,?,?)",
                     customers)

    # ------------------------------------------------------------ products
    products = []
    original_price = {}
    for i, (word, variant) in enumerate(PRODUCT_WORDS, start=1):
        price = round(rnd.choice([4.99, 6.49, 7.25, 9.99, 12.5, 14.95, 18.75, 19.99, 24.5,
                                  29.95, 34.99, 39.0, 44.75, 49.99, 59.95, 64.25, 79.99, 89.5,
                                  99.0, 119.95, 129.99, 149.0, 189.95, 249.0]) + rnd.choice([0, 0, 0.01, 0.05]), 2)
        original_price[i] = price
        sku = f"HS-{1000 + i}"
        stock = rnd.choice([0, 3, 5, 8, 12, 20, 25, 40, 60, 75, 120, 150])
        products.append((i, sku, f"{word} {variant}", price, stock, 1))
    # two products were retired but kept (active = 0)
    products[44] = products[44][:5] + (0,)
    products[60] = products[60][:5] + (0,)
    conn.executemany("INSERT INTO products (id, sku, name, price, stock, active) VALUES (?,?,?,?,?,?)",
                     products)

    # ------------------------------------------------------------ orders
    order_id = 0
    item_id = 0
    orders, items = [], []
    t = datetime(2021, 1, 4, 9, 15, 0)
    end = datetime(2024, 12, 20, 17, 0, 0)
    ambiguous = {datetime(2021, 11, 7, 1, 22, 10), datetime(2024, 11, 3, 1, 30, 0)}
    pending_from = datetime(2024, 12, 6)
    orphan_left = ORPHAN_ORDER_COUNT
    customer_ids = [c[0] for c in customers]
    weights = [1 + (rnd.random() * 4 if rnd.random() < 0.2 else 0) for _ in customer_ids]
    while t < end:
        t += timedelta(minutes=rnd.randint(300, 2200))
        if t.hour < 8 or t.hour > 19:
            t = t.replace(hour=rnd.randint(9, 17))
        stamp = t
        # place the two daylight-saving orders on their exact local times
        for amb in list(ambiguous):
            if abs((t - amb).days) < 1:
                stamp = amb
                ambiguous.discard(amb)
        order_id += 1
        cust = rnd.choices(customer_ids, weights=weights)[0]
        n_lines = rnd.choice([1, 1, 2, 2, 3, 4])
        chosen = rnd.sample(range(1, len(products) + 1), n_lines)
        if orphan_left and stamp.year == 2021 and stamp.month in (2, 5, 9):
            if 57 not in chosen:
                chosen[0] = 57
            orphan_left -= 1
        elif 57 in chosen and stamp.year >= 2021:
            chosen = [p for p in chosen if p != 57] or [12]
        chosen = [p for p in chosen if p != 71] or [3]
        lines = []
        for pid in chosen:
            qty = rnd.choice([1, 1, 1, 2, 2, 3, 4, 6])
            unit = original_price[pid]
            if stamp >= datetime(2023, 4, 1):
                unit = round(unit * 1.08, 2)        # spring 2023 price rise
            lines.append((pid, qty, unit))
        subtotal, discount, total = legacy_compute_totals([(u, q) for _, q, u in lines])
        old_format = stamp < datetime(2021, 6, 1)
        created = fmt(stamp, old_format)
        if stamp >= pending_from:
            status, shipped_at, cancelled_at = "pending", None, None
        elif rnd.random() < 0.065:
            status = "canceled" if stamp < datetime(2022, 3, 1) else "cancelled"
            shipped_at = None
            cancelled_at = fmt(stamp + timedelta(hours=rnd.randint(1, 30)), old_format)
        else:
            status = "shipped"
            shipped_at = fmt(stamp + timedelta(hours=rnd.randint(4, 60)), old_format)
            cancelled_at = None
        if order_id == MANUAL_EDIT_ORDER:
            total = round(total - 10.0, 2)          # goodwill refund typed straight into the DB
        orders.append((order_id, cust, status, subtotal, discount, total, created, shipped_at, cancelled_at))
        for pid, qty, unit in lines:
            item_id += 1
            items.append((item_id, order_id, pid, qty, unit))
    # any daylight-saving timestamp the loop did not land on goes to the nearest order
    for amb in sorted(ambiguous):
        idx = min(range(len(orders)), key=lambda k: abs(datetime.fromisoformat(orders[k][6]) - amb))
        o = list(orders[idx])
        o[6] = fmt(amb, False)
        if o[7]:
            o[7] = fmt(amb + timedelta(hours=7), False)
        if o[8]:
            o[8] = fmt(amb + timedelta(hours=3), False)
        orders[idx] = tuple(o)
    conn.executemany(
        "INSERT INTO orders (id, customer_id, status, subtotal, discount, total, created_at, shipped_at, cancelled_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)", orders)
    conn.executemany(
        "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES (?,?,?,?,?)", items)

    # products deleted by hand in 2023
    conn.executemany("DELETE FROM products WHERE id = ?", [(p,) for p in sorted(DELETED_PRODUCTS)])
    conn.commit()
    conn.close()
    return {"customers": len(customers), "products": len(products) - len(DELETED_PRODUCTS),
            "orders": len(orders), "order_items": len(items)}


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "data" / "orders.db")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    print(build(out))
