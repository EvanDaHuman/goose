from goose_engine import sqltools


def t(sql, **kw):
    return sqltools.translate_fragment(sql, **kw)[0]


def test_placeholders_and_literal_percent():
    assert t("SELECT * FROM t WHERE a = ? AND b LIKE 'x%'") == "SELECT * FROM t WHERE a = %s AND b ILIKE 'x%%'"


def test_question_mark_inside_a_string_is_kept():
    assert t("SELECT '?' AS q, x FROM t WHERE y = ?") == "SELECT '?' AS q, x FROM t WHERE y = %s"


def test_like_becomes_ilike_to_keep_sqlite_case_rules():
    assert "ILIKE" in t("SELECT * FROM customers WHERE name LIKE ?")


def test_functions():
    assert t("SELECT IFNULL(SUM(total), 0) FROM orders") == "SELECT COALESCE(SUM(total), 0) FROM orders"
    assert t("WHERE date(created_at) = ?") == "WHERE (created_at)::date = %s"
    assert t("WHERE date(placed_on) = ?", zones={"placed_on": "UTC"}) == "WHERE ((placed_on) AT TIME ZONE 'UTC')::date = %s"


def test_returning_for_lastrowid():
    assert t("INSERT INTO c (n) VALUES (?)", returning_pk="id").endswith("RETURNING id")


def test_parse_update_effects():
    p = sqltools.parse("UPDATE products SET stock = stock - ? WHERE id = ?")
    assert p["table"] == "products" and sqltools.set_effect(*p["set"][0]) == "decrement"
