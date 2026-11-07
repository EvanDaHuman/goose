from decimal import Decimal

from goose_verify.common import apply_rule, cents, diff, local_to_utc

RULE = {"tiers": [{"min": "250.0", "rate": "0.1", "inclusive": True}]}


def test_cents_round_half_up_from_binary_floats():
    assert cents(19.989999999999998) == Decimal("19.99")
    assert cents(225.04999999999998) == Decimal("225.05")


def test_agreed_rule_rounds_half_cents_up():
    assert apply_rule(RULE, Decimal("261.25")) == (Decimal("261.25"), Decimal("26.13"), Decimal("235.12"))
    assert apply_rule(RULE, Decimal("249.99"))[1] == Decimal("0.00")
    assert apply_rule(RULE, Decimal("250.00"))[1] == Decimal("25.00")


def test_repeated_hour_follows_the_agreed_rule():
    later = local_to_utc("2024-11-03 01:30:00", "America/Chicago", ["%Y-%m-%d %H:%M:%S"], "later")
    earlier = local_to_utc("2024-11-03 01:30:00", "America/Chicago", ["%Y-%m-%d %H:%M:%S"], "earlier")
    assert later == "2024-11-03T07:30:00+00:00" and earlier == "2024-11-03T06:30:00+00:00"


def test_diff_compares_money_to_the_cent_and_reports_everything_else():
    assert diff({"total": 65.46000000000001}, {"total": 65.46}) == []
    assert diff({"total": 26.12}, {"total": 26.13})[0]["path"] == "$.total"
    assert diff([1, 2], [1, 2, 3])[0]["path"] == "$.length"
