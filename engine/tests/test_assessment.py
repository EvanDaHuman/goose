from conftest import CLINIC, ORDERS, WHOLESALE
from goose_engine.analyze import assess


def orders():
    return assess(ORDERS / "repo", ORDERS / "data" / "orders.db", "America/Chicago")


def test_orders_fits_but_needs_one_answer():
    a = orders()
    assert a["fit"]["decision"] == "needs_info"
    assert [q["id"] for q in a["questions"]] == ["Q-orphans-order_items-product_id"]


def test_routes_are_classified():
    kinds = {r["id"]: r["kind"] for r in orders()["routes"]}
    assert kinds["post /orders"] == "place_order"
    assert kinds["post /orders/{order_id}/cancel"] == "cancel_order"
    assert kinds["post /products/{product_id}/restock"] == "restock"


def test_findings_include_the_real_problems():
    titles = {f["title"] for f in orders()["findings"]}
    assert "Cancelling twice puts stock back twice" in titles
    assert "A code comment disagrees with the code" in titles
    assert "Money is stored as binary floating point" in titles


def test_discount_rule_checked_against_history():
    rule = orders()["rules"][0]
    assert rule["tiers"][0]["min"] == "250.0" and rule["tiers"][0]["rate"] == "0.1"
    assert rule["history"]["consistent_with_code"] == rule["history"]["checked"] == 1545
    assert rule["history"]["differ_from_half_up"] == 14


def test_django_is_rejected():
    a = assess(CLINIC / "repo", None, "America/New_York")
    assert a["fit"]["decision"] == "unsupported"
    assert any("Django" in b for b in a["fit"]["blockers"])


def test_app_factory_style_is_understood():
    a = assess(WHOLESALE / "repo", WHOLESALE / "data" / "wholesale.db", "America/Denver")
    assert a["app"]["entry_module"] == "wsgi.py"
    assert "WHOLESALE_DB" in a["app"]["database_location"]["env_vars"]
    assert any(r["nested"] and r["path"] == "/ping" for r in a["routes"])
    assert {d["column"]: d["zone"] for d in a["date_columns"]} == {"purchases.placed_on": "UTC"}
