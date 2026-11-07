"""The approval rule end to end through the API and the database, including direct requests that try to bypass
it; amount_usd recomputation; the pipeline; the manager approval queue."""
from __future__ import annotations

from decimal import Decimal

from conftest import CONFIG_PATH
from app.config import load_workspace_config

MSG = load_workspace_config(CONFIG_PATH).rule.messages


def deal_row(db, deal_id):
    return db.execute("SELECT * FROM deals WHERE id = %s", (deal_id,)).fetchone()


def audit(db, deal_id):
    return db.execute("SELECT field, before, after, changed_by FROM audit_log WHERE record_id = %s AND source = 'workspace' "
                      "ORDER BY id", (deal_id,)).fetchall()


# ------------------------------------------------------------------------------------------------- blocking
def test_exactly_25000_closes_won(login, db):
    response = login("pnair").patch("/api/deals/d-acme-25000", json={"stage": "Closed Won"})
    assert response.status_code == 200
    body = response.json()
    assert body["blocked"] is False and body["rule_messages"] == []
    assert body["deal"]["stage"] == "Closed Won"
    row = deal_row(db, "d-acme-25000")
    assert row["stage"] == "Closed Won" and row["probability"] == 100 and row["approval_status"] == ""


def test_25000_01_is_blocked_and_approval_requested(login, db):
    response = login("pnair").patch("/api/deals/d-acme-25001", json={"stage": "Closed Won"})
    assert response.status_code == 200  # the save succeeds with adjusted values, as in SuiteCRM
    body = response.json()
    assert body["blocked"] is True and body["rule_messages"] == [MSG["blocked"]]
    assert body["deal"]["stage"] == "Negotiation/Review" and body["deal"]["approval_status"] == "requested"
    row = deal_row(db, "d-acme-25001")
    assert row["stage"] == "Negotiation/Review" and row["approval_status"] == "requested" and row["probability"] == 80
    assert [(a["field"], a["before"], a["after"]) for a in audit(db, "d-acme-25001")] == [
        ("approval_status", "", "requested")]


def test_eur_deal_above_threshold_in_usd_is_blocked(login, db):
    jonah = login("jweber")
    blocked = jonah.patch("/api/deals/d-eur-24000", json={"stage": "Closed Won"}).json()
    assert blocked["blocked"] is True and deal_row(db, "d-eur-24000")["stage"] == "Negotiation/Review"
    allowed = jonah.patch("/api/deals/d-eur-23000", json={"stage": "Closed Won"}).json()  # exactly $25,000.00
    assert allowed["blocked"] is False and deal_row(db, "d-eur-23000")["stage"] == "Closed Won"


def test_rejected_deal_is_rerequested_when_closing(login, db):
    body = login("pnair").patch("/api/deals/d-bluebird-imaging", json={"stage": "Closed Won"}).json()
    assert body["blocked"] and deal_row(db, "d-bluebird-imaging")["approval_status"] == "requested"


def test_creating_a_won_deal_above_threshold_falls_back(login, db):
    response = login("pnair").post("/api/deals", json={
        "name": "Acme Supply – Rush order", "account_id": "acc-acme-supply", "amount": "30000", "currency_code": "USD",
        "stage": "Closed Won"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["blocked"] is True and body["rule_messages"] == [MSG["blocked"]]
    row = deal_row(db, body["id"])
    assert row["stage"] == "Negotiation/Review" and row["approval_status"] == "requested"
    assert row["amount_usd"] == Decimal("30000.000000") and row["owner_id"] == "u-pnair"


def test_bulk_edit_form_style_patch_with_won_stage_keeps_old_probability(login, db):
    body = login("pnair").patch("/api/deals/d-acme-25001", json={
        "stage": "Closed Won", "probability": 100, "name": "Acme Supply – Signage and labeling"}).json()
    assert body["blocked"]
    assert deal_row(db, "d-acme-25001")["probability"] == 80


# ------------------------------------------------------------------------------------------------- approving
def test_salesperson_cannot_approve_by_patch(login, db):
    response = login("pnair").patch("/api/deals/d-acme-shelving", json={"approval_status": "approved"})
    assert response.status_code == 200
    assert response.json()["rule_messages"] == [MSG["not_manager"]]
    row = deal_row(db, "d-acme-shelving")
    assert row["approval_status"] == "requested" and row["approved_by"] is None and row["approved_amount_usd"] is None


def test_salesperson_cannot_approve_and_close_in_one_patch(login, db):
    body = login("pnair").patch("/api/deals/d-acme-shelving", json={
        "approval_status": "approved", "stage": "Closed Won"}).json()
    assert body["blocked"] is True
    assert [e["code"] for e in body["rule_events"]] == ["not_manager", "blocked"]
    assert deal_row(db, "d-acme-shelving")["stage"] == "Negotiation/Review"


def test_salesperson_cannot_forge_approval_fields(login, db):
    login("pnair").patch("/api/deals/d-acme-25001", json={
        "approved_amount_usd": 999999, "approved_by": "u-mchen", "approved_at": "2026-01-01T00:00:00Z",
        "amount_usd": 1})
    row = deal_row(db, "d-acme-25001")
    assert row["approved_amount_usd"] is None and row["approved_by"] is None and row["approved_at"] is None
    assert row["amount_usd"] == Decimal("25000.010000")


def test_approval_endpoint_403_for_non_manager(login, db):
    priya = login("pnair")
    for decision in ("approved", "rejected"):
        response = priya.post("/api/deals/d-acme-shelving/approval", json={"decision": decision})
        assert response.status_code == 403
        assert response.json()["detail"] == MSG["not_manager"]
    assert deal_row(db, "d-acme-shelving")["approval_status"] == "requested"


def test_manager_approves_then_salesperson_closes(login, db):
    response = login("mchen").post("/api/deals/d-acme-shelving/approval", json={"decision": "approved"})
    assert response.status_code == 200, response.text
    assert response.json()["deal"]["approval_status"] == "approved"
    row = deal_row(db, "d-acme-shelving")
    assert row["approved_by"] == "u-mchen" and row["approved_amount_usd"] == Decimal("48500.00")
    assert row["approved_at"] is not None
    closed = login("pnair").patch("/api/deals/d-acme-shelving", json={"stage": "Closed Won"}).json()
    assert closed["blocked"] is False and deal_row(db, "d-acme-shelving")["stage"] == "Closed Won"
    fields = {a["field"] for a in audit(db, "d-acme-shelving")}
    assert {"approval_status", "approved_by", "approved_amount_usd", "approved_at", "stage", "probability"} <= fields


def test_manager_rejects(login, db):
    response = login("mchen").post("/api/deals/d-acme-shelving/approval", json={"decision": "rejected"})
    assert response.status_code == 200
    assert deal_row(db, "d-acme-shelving")["approval_status"] == "rejected"


def test_amount_increase_withdraws_the_approval(login, db):
    priya = login("pnair")
    body = priya.patch("/api/deals/d-acme-cold", json={"amount": "30500"}).json()  # approved at $30,000
    assert body["rule_messages"] == [MSG["withdrawn"]]
    row = deal_row(db, "d-acme-cold")
    assert row["approval_status"] == "requested" and row["amount_usd"] == Decimal("30500.000000")
    assert row["approved_amount_usd"] == Decimal("30000.00")
    blocked = priya.patch("/api/deals/d-acme-cold", json={"stage": "Closed Won"}).json()
    assert blocked["blocked"] is True


def test_amount_decrease_keeps_the_approval(login, db):
    login("pnair").patch("/api/deals/d-acme-cold", json={"amount": "29000"})
    assert deal_row(db, "d-acme-cold")["approval_status"] == "approved"


def test_wrong_team_manager_cannot_approve(login, db):
    # Pine Hollow's deal is a West team record (Omar can edit it) owned by Priya (East): Omar shares no team with her.
    omar = login("ohaddad")
    assert omar.get("/api/deals/d-pine-racks").status_code == 200
    response = omar.post("/api/deals/d-pine-racks/approval", json={"decision": "approved"})
    assert response.status_code == 403 and response.json()["detail"] == MSG["not_manager"]
    body = omar.patch("/api/deals/d-pine-racks", json={"approval_status": "approved"}).json()
    assert body["rule_messages"] == [MSG["not_manager"]]
    assert deal_row(db, "d-pine-racks")["approval_status"] == ""
    # and an East deal is not even visible to the West manager
    assert omar.post("/api/deals/d-acme-shelving/approval", json={"decision": "approved"}).status_code == 404


def test_admin_can_approve_any_team(login, db):
    response = login("admin").post("/api/deals/d-acmeco-fleet/approval", json={"decision": "approved"})
    assert response.status_code == 200
    row = deal_row(db, "d-acmeco-fleet")
    assert row["approval_status"] == "approved" and row["approved_by"] == "u-admin"


def test_unowned_deal_uses_the_acting_manager_team(login, db):
    response = login("mchen").post("/api/deals/d-unowned/approval", json={"decision": "approved"})
    assert response.status_code == 200 and deal_row(db, "d-unowned")["approval_status"] == "approved"


def test_request_approval_by_anyone_who_can_edit(login, db):
    priya = login("pnair")
    response = priya.post("/api/deals/d-acme-25001/approval", json={"decision": "requested"})
    assert response.status_code == 200 and deal_row(db, "d-acme-25001")["approval_status"] == "requested"
    assert priya.post("/api/deals/d-acme-safety/approval", json={"decision": "requested"}).status_code == 403
    assert priya.post("/api/deals/d-acme-25001/approval", json={"decision": "maybe"}).status_code == 422
    assert priya.post("/api/deals/d-acme-25001/approval", json={}).status_code == 422


def test_approval_panel(login):
    panel = login("pnair").get("/api/deals/d-acme-shelving").json()["approval"]
    assert panel["status"] == "requested" and panel["can_decide"] is False and panel["explanation"]
    assert panel["needs_approval"] is True
    manager_panel = login("mchen").get("/api/deals/d-acme-shelving").json()["approval"]
    assert manager_panel["can_decide"] is True and manager_panel["explanation"] is None


# ------------------------------------------------------------------------------------------------- amount_usd
def test_amount_usd_recomputed_on_amount_or_currency_change(login, db):
    jonah = login("jweber")
    jonah.patch("/api/deals/d-acme-inc-intro", json={"currency_code": "EUR"})
    assert deal_row(db, "d-acme-inc-intro")["amount_usd"] == Decimal("5652.173913")  # 5200 / 0.92
    jonah.patch("/api/deals/d-acme-inc-intro", json={"amount": "4600"})
    assert deal_row(db, "d-acme-inc-intro")["amount_usd"] == Decimal("5000.000000")
    assert jonah.patch("/api/deals/d-acme-inc-intro", json={"currency_code": "XYZ"}).status_code == 422


def test_amount_usd_untouched_when_amount_and_currency_unchanged(login, db):
    db.execute("UPDATE deals SET amount_usd = 5199.99 WHERE id = 'd-acme-inc-intro'")  # as migrated
    login("jweber").patch("/api/deals/d-acme-inc-intro", json={"next_step": "Call back", "amount": "5200.00"})
    assert deal_row(db, "d-acme-inc-intro")["amount_usd"] == Decimal("5199.990000")


def test_deal_validation(login):
    priya = login("pnair")
    assert priya.post("/api/deals", json={"name": "No amount"}).status_code == 422
    assert priya.post("/api/deals", json={"name": "x", "amount": "lots"}).status_code == 422
    assert priya.post("/api/deals", json={"name": "x", "amount": -5}).status_code == 422
    assert priya.post("/api/deals", json={"name": "x", "amount": 5, "stage": "Won-ish"}).status_code == 422
    response = priya.patch("/api/deals/d-acme-25000", json={"close_date": "31/03/2027"})
    assert response.status_code == 422 and "detail" in response.json()


def test_stage_change_sets_probability(login, db):
    login("pnair").patch("/api/deals/d-orchard-lanes", json={"stage": "Proposal/Price Quote"})
    assert deal_row(db, "d-orchard-lanes")["probability"] == 65


# ------------------------------------------------------------------------------------------------- pipeline
def test_pipeline_stages_in_order_with_totals(login, cfg):
    body = login("pnair").get("/api/pipeline", params={"scope": "mine"}).json()
    assert [s["key"] for s in body["stages"]] == cfg.stage_keys
    deals = [d for s in body["stages"] for d in s["deals"]]
    assert deals and all(d["owner_id"] == "u-pnair" for d in deals)
    for stage in body["stages"]:
        assert stage["count"] == len(stage["deals"])
        assert Decimal(str(stage["total_usd"])) == sum((Decimal(str(d["amount_usd"])) for d in stage["deals"]), Decimal(0))
    negotiation = next(s for s in body["stages"] if s["key"] == "Negotiation/Review")
    assert {"d-acme-shelving", "d-acme-25000", "d-acme-25001", "d-bluebird-imaging"} <= {d["id"] for d in negotiation["deals"]}


def test_pipeline_scopes(login):
    maya = login("mchen")
    team = {d["id"] for s in maya.get("/api/pipeline?scope=team").json()["stages"] for d in s["deals"]}
    mine = {d["id"] for s in maya.get("/api/pipeline?scope=mine").json()["stages"] for d in s["deals"]}
    assert mine == {"d-northwind"} and {"d-acme-shelving", "d-eur-24000", "d-northwind"} <= team
    assert "d-acmeco-fleet" not in team
    assert maya.get("/api/pipeline?scope=galaxy").status_code == 422


def test_pipeline_stage_move_goes_through_the_rule(login, db):
    body = login("pnair").patch("/api/deals/d-acme-25001", json={"stage": "Closed Won"}).json()
    assert body["blocked"]
    pipeline = login("pnair").get("/api/pipeline").json()
    won = next(s for s in pipeline["stages"] if s["key"] == "Closed Won")
    assert "d-acme-25001" not in {d["id"] for d in won["deals"]}


# ------------------------------------------------------------------------------------------------- approvals queue
def test_approvals_queue_per_manager(login):
    east = {d["id"] for d in login("mchen").get("/api/approvals").json()["items"]}
    west = {d["id"] for d in login("ohaddad").get("/api/approvals").json()["items"]}
    everything = login("admin").get("/api/approvals").json()
    assert east == {"d-acme-shelving", "d-unowned"}
    assert west == {"d-acmeco-fleet"}
    assert {d["id"] for d in everything["items"]} == east | west and everything["total"] == 3
    assert login("pnair").get("/api/approvals").status_code == 403
    assert login("dkim").get("/api/approvals").status_code == 403


def test_queue_excludes_deals_the_manager_cannot_decide(login):
    login("pnair").post("/api/deals/d-pine-racks/approval", json={"decision": "requested"})
    assert "d-pine-racks" not in {d["id"] for d in login("ohaddad").get("/api/approvals").json()["items"]}
    assert "d-pine-racks" not in {d["id"] for d in login("mchen").get("/api/approvals").json()["items"]}
    assert "d-pine-racks" in {d["id"] for d in login("admin").get("/api/approvals").json()["items"]}


def test_approved_deal_leaves_the_queue(login):
    maya = login("mchen")
    maya.post("/api/deals/d-acme-shelving/approval", json={"decision": "approved"})
    assert "d-acme-shelving" not in {d["id"] for d in maya.get("/api/approvals").json()["items"]}
