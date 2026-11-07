"""Unit tests of the pure parts: the approval rule (every branch), amount_usd, the team-manager test, access levels
and name matching. No database."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.access import Actor, compute_levels, is_team_manager
from app.config import RuleConfig, load_workspace_config
from app.convert import normalize_name, similarity
from app.rules import DealState, apply_approval_rule, compute_amount_usd

from conftest import CONFIG_PATH

RULE = load_workspace_config(CONFIG_PATH).rule
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
WON, FALLBACK = "Closed Won", "Negotiation/Review"
MSG = RULE.messages


def run(before, after, manager=False, rule=RULE, actor="u-actor"):
    return apply_approval_rule(before, after, actor_id=actor, is_team_manager=manager, now=NOW, rule=rule)


def deal(stage="Negotiation/Review", usd="10000", status="", approved=None, by=None, at=None):
    return DealState(stage=stage, amount_usd=Decimal(usd), approval_status=status,
                     approved_amount_usd=Decimal(approved) if approved is not None else None,
                     approved_by=by, approved_at=at)


# ------------------------------------------------------------------------------------------------- config
def test_config_rule_parameters():
    assert RULE.enabled and RULE.threshold_usd == Decimal("25000")
    assert RULE.won_stage == WON and RULE.fallback_stage == FALLBACK and RULE.manager_role == "Sales Manager"
    assert MSG["blocked"].startswith("Deals above $25,000 need approval")


# ------------------------------------------------------------------------------------------------- step 4: blocking
def test_threshold_boundary_exactly_25000_is_allowed():
    result = run(deal(usd="25000.00"), deal(stage=WON, usd="25000.00"))
    assert result.stage == WON and not result.blocked and result.events == ()
    assert result.approval_status == ""


def test_threshold_boundary_25000_01_is_blocked_and_requests_approval():
    result = run(deal(usd="25000.01"), deal(stage=WON, usd="25000.01"))
    assert result.blocked
    assert result.stage == "Negotiation/Review"
    assert result.approval_status == "requested"
    assert result.messages == [MSG["blocked"]]


def test_blocked_keeps_previous_stage_not_fallback():
    result = run(deal(stage="Proposal/Price Quote", usd="40000"), deal(stage=WON, usd="40000"))
    assert result.stage == "Proposal/Price Quote" and result.blocked


def test_new_deal_created_as_won_falls_back():
    result = run(None, deal(stage=WON, usd="30000"))
    assert result.blocked and result.stage == FALLBACK and result.approval_status == "requested"


def test_new_small_deal_created_as_won_is_fine():
    result = run(None, deal(stage=WON, usd="900"))
    assert not result.blocked and result.stage == WON


def test_rejected_deal_moving_to_won_is_blocked_and_rerequested():
    result = run(deal(usd="38000", status="rejected"), deal(stage=WON, usd="38000", status="rejected"))
    assert result.blocked and result.approval_status == "requested" and result.stage == "Negotiation/Review"


def test_requested_deal_stays_requested_when_blocked():
    result = run(deal(usd="48500", status="requested"), deal(stage=WON, usd="48500", status="requested"))
    assert result.blocked and result.approval_status == "requested"


def test_approved_deal_can_close_won():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, stage=WON))
    assert not result.blocked and result.stage == WON and result.approval_status == "approved"
    assert result.approved_by == "u-mchen"


def test_deal_already_won_is_not_blocked_again():
    before = deal(stage=WON, usd="60000")
    result = run(before, replace(before, amount_usd=Decimal("61000")))
    assert not result.blocked and result.stage == WON


def test_eur_conversion_feeds_the_threshold():
    over = compute_amount_usd(Decimal("24000.00"), Decimal("0.920000"))
    exact = compute_amount_usd(Decimal("23000.00"), Decimal("0.920000"))
    assert over == Decimal("26086.956522")
    assert exact == Decimal("25000.000000")
    assert run(deal(usd=str(over)), deal(stage=WON, usd=str(over))).blocked
    assert not run(deal(usd=str(exact)), deal(stage=WON, usd=str(exact))).blocked


def test_amount_usd_rounds_half_up_to_six_places():
    assert compute_amount_usd(Decimal("1"), Decimal("3")) == Decimal("0.333333")
    assert compute_amount_usd(Decimal("2"), Decimal("3")) == Decimal("0.666667")
    assert compute_amount_usd(Decimal("25000.01"), Decimal("1")) == Decimal("25000.010000")


# ------------------------------------------------------------------------------------------------- step 1: who decides
@pytest.mark.parametrize("decision", ["approved", "rejected"])
def test_non_manager_cannot_approve_or_reject(decision):
    before = deal(usd="48500", status="requested")
    result = run(before, replace(before, approval_status=decision), manager=False)
    assert result.approval_status == "requested"
    assert result.messages == [MSG["not_manager"]]
    assert result.approved_by is None and result.approved_amount_usd is None


def test_non_manager_can_request():
    before = deal(usd="48500")
    result = run(before, replace(before, approval_status="requested"))
    assert result.approval_status == "requested" and result.events == ()


def test_non_manager_approve_then_won_is_reverted_and_blocked():
    before = deal(usd="48500", status="")
    result = run(before, replace(before, approval_status="approved", stage=WON))
    assert result.codes == ["not_manager", "blocked"]
    assert result.stage == "Negotiation/Review" and result.approval_status == "requested"


def test_unchanged_approved_status_is_not_a_decision():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, stage="Proposal/Price Quote"), manager=False)
    assert result.approval_status == "approved" and result.events == ()


# ------------------------------------------------------------------------------------------------- step 2: recording
def test_manager_approval_records_amount_user_and_time():
    before = deal(usd="48500", status="requested")
    result = run(before, replace(before, approval_status="approved"), manager=True, actor="u-mchen")
    assert result.approval_status == "approved" and result.events == ()
    assert result.approved_amount_usd == Decimal("48500.00")
    assert result.approved_by == "u-mchen" and result.approved_at == NOW


def test_manager_approval_and_won_in_one_save():
    before = deal(usd="48500", status="requested")
    result = run(before, replace(before, approval_status="approved", stage=WON), manager=True)
    assert result.stage == WON and not result.blocked and result.approval_status == "approved"


def test_approved_amount_is_rounded_to_cents_and_still_covers_the_deal():
    usd = compute_amount_usd(Decimal("25000"), Decimal("0.92"))  # 27173.913043
    before = deal(usd=str(usd), status="requested")
    approved = run(before, replace(before, approval_status="approved"), manager=True)
    assert approved.approved_amount_usd == Decimal("27173.91")
    stored = deal(usd=str(usd), status="approved", approved="27173.91", by="u-mchen", at=NOW)
    again = run(stored, replace(stored, stage=WON))
    assert again.approval_status == "approved" and not again.blocked


def test_manager_rejection():
    before = deal(usd="48500", status="requested")
    result = run(before, replace(before, approval_status="rejected"), manager=True)
    assert result.approval_status == "rejected" and result.approved_by is None


# ------------------------------------------------------------------------------------------------- step 3: withdrawal
def test_amount_increase_withdraws_approval():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, amount_usd=Decimal("30000.01")))
    assert result.approval_status == "requested"
    assert result.messages == [MSG["withdrawn"]]
    assert result.approved_amount_usd == Decimal("30000.00") and result.approved_by == "u-mchen"


def test_amount_within_half_a_cent_keeps_approval():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, amount_usd=Decimal("30000.005")))
    assert result.approval_status == "approved" and result.events == ()


def test_amount_decrease_keeps_approval():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, amount_usd=Decimal("29000")))
    assert result.approval_status == "approved"


def test_increase_and_won_in_one_save_is_withdrawn_then_blocked():
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, amount_usd=Decimal("35000"), stage=WON))
    assert result.codes == ["withdrawn", "blocked"]
    assert result.stage == "Negotiation/Review" and result.approval_status == "requested"


def test_missing_approved_amount_counts_as_zero_like_the_hook():
    before = deal(usd="30000", status="approved", approved=None)
    result = run(before, before)  # any save of such a deal
    assert result.approval_status == "requested" and result.codes == ["withdrawn"]


def test_withdrawal_can_be_switched_off():
    rule = replace(RULE, withdraw_if_amount_exceeds_approved=False)
    before = deal(usd="30000", status="approved", approved="30000.00", by="u-mchen", at=NOW)
    result = run(before, replace(before, amount_usd=Decimal("90000")), rule=rule)
    assert result.approval_status == "approved"


def test_disabled_rule_changes_nothing():
    rule = replace(RULE, enabled=False)
    result = run(deal(usd="90000"), deal(stage=WON, usd="90000", status="approved"), manager=False, rule=rule)
    assert result.stage == WON and result.approval_status == "approved" and result.events == ()


# ------------------------------------------------------------------------------------------------- team manager
def actor(roles=(), teams=(), admin=False):
    return Actor(id="u-x", user_name="x", is_admin=admin, roles=tuple((r, r) for r in roles),
                 teams=tuple((t, t) for t in teams))


def test_team_manager_needs_role_and_shared_team():
    manager = actor(roles=["Sales Manager"], teams=["t-east"])
    assert is_team_manager(manager, ["t-east"], RULE)
    assert not is_team_manager(manager, ["t-west"], RULE)  # wrong-team manager
    assert not is_team_manager(manager, [], RULE)
    assert not is_team_manager(actor(roles=["Salesperson"], teams=["t-east"]), ["t-east"], RULE)


def test_admin_is_team_manager_unless_configured_otherwise():
    admin = actor(admin=True)
    assert is_team_manager(admin, ["t-west"], RULE)
    assert not is_team_manager(admin, ["t-west"], replace(RULE, admin_can_approve=False))


def test_same_team_requirement_can_be_relaxed():
    manager = actor(roles=["Sales Manager"], teams=["t-east"])
    assert is_team_manager(manager, ["t-west"], replace(RULE, same_team_required=False))


# ------------------------------------------------------------------------------------------------- access levels
def test_levels_additive_most_permissive_and_not_set_means_all():
    sales = {("deals", "access"): "enabled", ("deals", "list"): "team", ("deals", "edit"): "own",
             ("deals", "delete"): "none"}
    levels = compute_levels(False, [sales])
    assert levels[("deals", "list")] == "team" and levels[("deals", "edit")] == "own"
    assert levels[("deals", "view")] == "all"  # no row on any role = SuiteCRM "Not set"
    assert levels[("deals", "delete")] == "none"
    manager = {("deals", "list"): "team", ("deals", "delete"): "team"}
    both = compute_levels(False, [sales, manager])
    assert both[("deals", "delete")] == "team" and both[("deals", "list")] == "team"  # most permissive row
    strict = compute_levels(False, [sales, manager], additive=False)
    assert strict[("deals", "delete")] == "none"  # least permissive row


def test_explicit_rows_beat_not_set_on_another_role():
    sales = {("deals", "list"): "team", ("deals", "edit"): "own"}
    no_rows = {("accounts", "list"): "all"}  # says nothing about deals
    levels = compute_levels(False, [sales, no_rows])
    assert levels[("deals", "list")] == "team" and levels[("deals", "edit")] == "own"


def test_disabled_access_hides_the_entity_unless_another_role_enables_it():
    support = {("deals", "access"): "disabled"}
    only_support = compute_levels(False, [support])
    assert all(only_support[("deals", a)] == "none" for a in ("access", "list", "view", "edit", "delete"))
    assert compute_levels(False, [support, {("accounts", "list"): "all"}])[("deals", "list")] == "none"
    sales = {("deals", "access"): "enabled", ("deals", "list"): "own"}
    assert compute_levels(False, [support, sales])[("deals", "list")] == "own"


def test_admin_and_roleless_users_have_all():
    assert set(compute_levels(True, [{("deals", "list"): "none"}]).values()) == {"all"}
    assert set(compute_levels(False, []).values()) == {"all"}


# ------------------------------------------------------------------------------------------------- name matching
def test_name_normalisation_and_similarity():
    assert normalize_name("  acme   SUPPLY ") == normalize_name("Acme Supply") == "acme supply"
    assert similarity("Acme Supply", "ACME Supply Co.") >= 0.8
    assert similarity("Acme Supply", "Acme Supply Inc") >= 0.8
    assert similarity("Acme Supply", "Acme Supplies Ltd") < 0.8
    assert similarity("Acme Supplies", "Acme Supplies Ltd") >= 0.8
