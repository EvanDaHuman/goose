import ast

from conftest import ORDERS
from goose_engine import scope as scope_mod
from goose_engine.analyze import assess
from goose_engine.generate import generate


def test_generated_app_parses_and_carries_the_agreed_fixes(tmp_path):
    a = assess(ORDERS / "repo", ORDERS / "data" / "orders.db", "America/Chicago")
    s = scope_mod.build(a, {"Q-orphans-order_items-product_id": {"decision": "placeholder"}}, "sample-orders", "Sample Supply")
    out = tmp_path / "upgraded"
    generate(ORDERS / "repo", a, s, out)
    for p in (out / "app").rglob("*.py"):
        text = p.read_text()
        ast.parse(text)
        assert "import sqlite3" not in text and "from flask" not in text
    orders = (out / "app" / "routes" / "orders.py").read_text()
    assert 'if order["status"] == "cancelled":' in orders          # cancel once
    assert 'db.lock("stock")' in orders                              # one order at a time
    assert "idempotency.run(" in orders                              # safe retries
    services = (out / "app" / "services.py").read_text()
    assert 'BULK_DISCOUNT_RATE = Decimal("0.10")' in services and "round_cents(" in services
    assert "# 15% off big orders" in services                        # the owner's comment is kept
    schema = (out / "migrations" / "001_schema.sql").read_text()
    assert '"price" NUMERIC(12,2) NOT NULL' in schema and 'CHECK ("stock" >= 0)' in schema
