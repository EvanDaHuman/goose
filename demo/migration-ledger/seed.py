import json
from pathlib import Path
import sqlite3
import sys

out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
if out.exists():
    raise SystemExit("Refusing to overwrite an existing database")
with sqlite3.connect(out) as c:
    c.executescript((Path(__file__).parent / "repo" / "schema.sql").read_text())
    c.executemany("INSERT INTO customers VALUES(?,?,?,?,?)", [
        (7, "Zoë 李", "zoe@example.test", 123456789, "2020-02-29"),
        (19, "Alex", None, -15, "2024-11-03"),
        (40, "Alex", "alex+other@example.test", 0, "2026-01-01"),
    ])
    c.executemany("INSERT INTO notes VALUES(?,?,?)", [(11, 7, "Keep Unicode 🪿 and apostrophe: O'Neil"), (25, 19, "A different Alex")])
print(json.dumps({"database": str(out), "synthetic": True, "customers": 3, "notes": 2}))
