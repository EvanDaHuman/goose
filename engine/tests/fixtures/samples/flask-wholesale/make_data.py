"""Synthetic data for Sample Roasters (TEST DATA ONLY). Fixed seed; example.com emails.

Timestamps come from SQLite's CURRENT_TIMESTAMP, which is UTC, as the real app would have stored them.
Usage:  python make_data.py [OUTPUT.db]
"""
import random
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
rnd = random.Random(7307)

CAFES = ["Bean There", "Second Cup Club", "Grind House", "Morning Ritual", "Copper Kettle", "Little Owl", "Steam & Stone",
         "The Daily Cup", "Lighthouse Cafe", "Ridge Roast", "Juniper Coffee", "Two Rivers", "North Fork Cafe",
         "Quarry Coffee", "Paper Moon", "Field Notes Cafe", "Saltbox", "Golden Hour", "Wren & Co", "Lantern Room"]
CITIES = ["Denver", "Boulder", "Golden", "Fort Collins", "Colorado Springs", "Pueblo", "Aurora"]
BEANS = [("ETH-YRG", "Ethiopia Yirgacheffe"), ("COL-HUI", "Colombia Huila"), ("BRA-SUL", "Brazil Sul de Minas"),
         ("GUA-ANT", "Guatemala Antigua"), ("KEN-AA", "Kenya AA"), ("SUM-MAN", "Sumatra Mandheling"),
         ("CRI-TAR", "Costa Rica Tarrazu"), ("PER-ORG", "Peru Organic"), ("HOU-ESP", "House Espresso"),
         ("DEC-SWP", "Swiss Water Decaf"), ("RWA-NYA", "Rwanda Nyamasheke"), ("MEX-CHI", "Mexico Chiapas")]


def build(out):
    out = Path(out)
    if out.exists():
        out.unlink()
    conn = sqlite3.connect(str(out))
    conn.executescript((HERE / "repo" / "schema.sql").read_text())
    clients = []
    for i, name in enumerate(CAFES + ["Bean There", "Golden Hour"], start=1):  # two cafes share a trading name
        slug = name.lower().replace(" ", "").replace("&", "and")
        clients.append((i, name, f"orders@{slug}{'' if i <= len(CAFES) else i}.example.com", rnd.choice(CITIES)))
    conn.executemany("INSERT INTO clients (id, full_name, email, city) VALUES (?,?,?,?)", clients)
    coffees = []
    for i, (code, title) in enumerate(BEANS, start=1):
        coffees.append((i, code, title, round(rnd.choice([9.5, 11.25, 12.8, 13.4, 14.95, 16.5, 18.75]) + rnd.choice([0, 0.05]), 2),
                        rnd.choice([0, 6, 12, 24, 40, 60, 90])))
    conn.executemany("INSERT INTO coffees (id, code, title, unit_cost, qty_on_hand) VALUES (?,?,?,?,?)", coffees)
    t = datetime(2023, 3, 1, 15, 0, 0)
    pid = lid = 0
    for _ in range(420):
        t += timedelta(minutes=rnd.randint(200, 2400))
        pid += 1
        cid = rnd.randint(1, len(clients))
        picks = rnd.sample(coffees, rnd.choice([1, 1, 2, 3]))
        lines = [(k[0], rnd.choice([2, 4, 6, 10, 12, 20]), k[3]) for k in picks]
        gross = round(sum(p * q for _, q, p in lines), 2)
        disc = round(gross * 0.12, 2) if gross >= 500 else round(gross * 0.05, 2) if gross >= 100 else 0.0
        state = "open" if t > datetime(2024, 11, 20) else rnd.choices(["fulfilled", "void"], [94, 6])[0]
        conn.execute("INSERT INTO purchases (id, client_id, state, placed_on, gross, discount_amount, amount_due) VALUES (?,?,?,?,?,?,?)",
                     (pid, cid, state, t.strftime("%Y-%m-%d %H:%M:%S"), gross, disc, round(gross - disc, 2)))
        for kid, q, p in lines:
            lid += 1
            conn.execute("INSERT INTO purchase_lines (id, purchase_id, coffee_id, qty, price_each) VALUES (?,?,?,?,?)", (lid, pid, kid, q, p))
    conn.commit()
    conn.close()
    return {"clients": len(clients), "coffees": len(coffees), "purchases": pid, "purchase_lines": lid}


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "data" / "wholesale.db")
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    print(build(target))
