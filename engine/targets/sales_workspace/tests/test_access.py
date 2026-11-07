"""Access rules through the JSON API: own / team / all, 404 vs 403, related-list filtering, disabled entities,
soft deletes, record_teams inheritance on create and audit rows on update."""
from __future__ import annotations

import pytest


def ids(items):
    return {item["id"] for item in items}


def all_ids(client, path):
    response = client.get(path, params={"per_page": 100})
    assert response.status_code == 200, response.text
    return ids(response.json()["items"])


# ------------------------------------------------------------------------------------------------- list rule
def test_salesperson_lists_team_records_and_owned_records_only(login):
    priya = login("pnair")
    accounts = all_ids(priya, "/api/accounts")
    assert {"acc-acme-supply", "acc-acme-supplies-ltd", "acc-acme-supply-inc", "acc-northwind"} <= accounts
    assert "acc-pine-hollow" in accounts  # owned, although it is a West team record
    assert "acc-acme-supply-co" not in accounts and "acc-harborview" not in accounts  # West
    assert "acc-old-mill" not in accounts  # soft-deleted
    deals = all_ids(priya, "/api/deals")
    assert "d-acme-safety" in deals  # Jonah's, in East Sales
    assert "d-acmeco-fleet" not in deals and "d-acme-old" not in deals


def test_manager_sees_team_not_other_team(login):
    omar = login("ohaddad")
    accounts = all_ids(omar, "/api/accounts")
    assert {"acc-acme-supply-co", "acc-harborview", "acc-pine-hollow"} <= accounts
    assert "acc-acme-supply" not in accounts


def test_list_totals_match_items(login):
    maya = login("mchen")
    body = maya.get("/api/accounts", params={"per_page": 2}).json()
    assert len(body["items"]) == 2 and body["total"] == len(all_ids(maya, "/api/accounts"))


def test_support_reads_all_accounts_but_deals_and_leads_are_disabled(login):
    dana = login("dkim")
    accounts = all_ids(dana, "/api/accounts")
    assert {"acc-acme-supply", "acc-acme-supply-co", "acc-harborview"} <= accounts and "acc-old-mill" not in accounts
    assert dana.get("/api/deals").status_code == 403
    assert dana.get("/api/leads").status_code == 403
    assert dana.get("/api/pipeline").status_code == 403
    assert dana.get("/api/deals/d-acme-shelving").status_code == 404
    assert dana.get("/api/leads/l-ethan-brooks").status_code == 404
    assert dana.patch("/api/deals/d-acme-shelving", json={"stage": "Closed Won"}).status_code == 404
    assert dana.post("/api/deals", json={"name": "x", "amount": 1}).status_code == 403
    found = dana.get("/api/search", params={"q": "acme"}).json()
    assert found["deals"] == [] and found["leads"] == [] and found["accounts"]
    detail = dana.get("/api/accounts/acc-acme-supply").json()
    assert detail["deals"] == []  # related list filtered by the deals list rule


def test_admin_sees_everything_but_deleted(login):
    admin = login("admin")
    accounts = all_ids(admin, "/api/accounts")
    assert {"acc-acme-supply", "acc-acme-supply-co", "acc-pine-hollow"} <= accounts and "acc-old-mill" not in accounts
    assert admin.get("/api/accounts/acc-old-mill").status_code == 404


# ------------------------------------------------------------------------------------------------- 404 vs 403
def test_not_viewable_is_404_for_every_verb(login):
    priya = login("pnair")
    for path in ("/api/accounts/acc-acme-supply-co", "/api/deals/d-acmeco-fleet", "/api/leads/l-paul-iverson",
                 "/api/contacts/c-luis-ortega", "/api/notes/n-acme-west", "/api/tasks/t-fleet-dates"):
        assert priya.get(path).status_code == 404, path
        assert priya.patch(path, json={"name": "x"}).status_code == 404, path
        assert priya.delete(path).status_code == 404, path


def test_unknown_and_deleted_ids_are_404(login):
    admin = login("admin")
    for path in ("/api/accounts/nope", "/api/accounts/acc-old-mill", "/api/contacts/c-victor-hale",
                 "/api/deals/d-acme-old", "/api/leads/l-old", "/api/notes/n-acme-deleted", "/api/tasks/t-deleted"):
        assert admin.get(path).status_code == 404, path
        assert admin.patch(path, json={"name": "x"}).status_code == 404, path


def test_viewable_but_not_editable_is_403(login, db):
    priya = login("pnair")
    assert priya.get("/api/deals/d-acme-safety").status_code == 200  # Jonah's deal, same team
    response = priya.patch("/api/deals/d-acme-safety", json={"next_step": "mine now"})
    assert response.status_code == 403 and response.json()["detail"]
    assert priya.patch("/api/contacts/c-grace-kim", json={"title": "CEO"}).status_code == 403
    assert db.execute("SELECT title FROM contacts WHERE id = 'c-grace-kim'").fetchone()["title"] == "Chief Financial Officer"
    # own records: edit yes, delete no (Salesperson delete = none)
    assert priya.patch("/api/contacts/c-maria-lopez", json={"title": "Head of Purchasing"}).status_code == 200
    assert priya.delete("/api/contacts/c-maria-lopez").status_code == 403
    assert db.execute("SELECT deleted_at FROM contacts WHERE id = 'c-maria-lopez'").fetchone()["deleted_at"] is None


def test_support_can_view_everything_but_edit_nothing(login):
    dana = login("dkim")
    assert dana.get("/api/accounts/acc-acme-supply-co").status_code == 200
    assert dana.patch("/api/accounts/acc-acme-supply-co", json={"phone": "1"}).status_code == 403
    assert dana.post("/api/accounts", json={"name": "Nope"}).status_code == 403


def test_owned_record_in_another_team(login):
    # Pine Hollow: owned by Priya (East) but only in West Sales.
    assert login("pnair").patch("/api/accounts/acc-pine-hollow", json={"employees": "45"}).status_code == 200
    assert login("mchen").get("/api/accounts/acc-pine-hollow").status_code == 404
    omar = login("ohaddad")
    assert omar.get("/api/accounts/acc-pine-hollow").status_code == 200
    assert omar.patch("/api/accounts/acc-pine-hollow", json={"employees": "50"}).status_code == 200


def test_manager_edits_and_deletes_team_records(login, db):
    maya = login("mchen")
    assert maya.patch("/api/contacts/c-grace-kim", json={"title": "CFO"}).status_code == 200
    response = maya.delete("/api/deals/d-acme-safety")
    assert response.status_code == 200 and response.json()["deleted"] is True
    row = db.execute("SELECT deleted_at FROM deals WHERE id = 'd-acme-safety'").fetchone()
    assert row["deleted_at"] is not None
    audit = db.execute("SELECT field, changed_by, source FROM audit_log WHERE record_id = 'd-acme-safety'").fetchall()
    assert {"field": "deleted_at", "changed_by": "u-mchen", "source": "workspace"} in audit
    # soft-deleted rows never appear anywhere
    priya = login("pnair")
    assert maya.get("/api/deals/d-acme-safety").status_code == 404
    assert "d-acme-safety" not in all_ids(priya, "/api/deals")
    assert "d-acme-safety" not in ids(priya.get("/api/accounts/acc-acme-supply").json()["deals"])
    assert "d-acme-safety" not in ids(priya.get("/api/search", params={"q": "safety"}).json()["deals"])
    pipeline = priya.get("/api/pipeline").json()
    assert "d-acme-safety" not in {d["id"] for s in pipeline["stages"] for d in s["deals"]}
    assert maya.delete("/api/deals/d-acme-safety").status_code == 404


def test_salesperson_cannot_delete_even_own(login):
    priya = login("pnair")
    assert priya.delete("/api/accounts/acc-acme-supply").status_code == 403
    assert priya.delete("/api/deals/d-acme-25000").status_code == 403


# ------------------------------------------------------------------------------------------------- related lists
def test_account_page_related_lists_use_their_own_list_rule(login):
    priya = login("pnair")
    detail = priya.get("/api/accounts/acc-acme-supply").json()
    assert set(detail) >= {"account", "contacts", "deals", "notes", "tasks", "external_links", "teams", "owner"}
    assert ids(detail["contacts"]) == {"c-maria-lopez", "c-dev-patel", "c-grace-kim"}  # not Nadia (West), not deleted
    assert ids(detail["notes"]) == {"n-acme-renewal", "n-acme-qbr", "n-acme-pricing"}  # not the West note
    assert "t-deleted" not in ids(detail["tasks"]) and "t-renewal-proposal" in ids(detail["tasks"])
    assert "d-acme-old" not in ids(detail["deals"]) and "d-acme-shelving" in ids(detail["deals"])
    assert [n["id"] for n in detail["notes"]] == ["n-acme-renewal", "n-acme-qbr", "n-acme-pricing"]  # newest first
    assert {link["kind"] for link in detail["external_links"]} == {"Support cases", "Meetings", "Calls"}
    assert detail["owner"]["id"] == "u-pnair" and detail["teams"] == [{"id": "t-east", "name": "East Sales"}]
    admin = login("admin").get("/api/accounts/acc-acme-supply").json()
    assert "c-nadia-petrov" in ids(admin["contacts"]) and "n-acme-west" in ids(admin["notes"])


def test_deal_contacts_are_filtered(login):
    detail = login("pnair").get("/api/deals/d-acme-shelving").json()
    assert {(c["id"], c["role"]) for c in detail["contacts"]} == {
        ("c-maria-lopez", "Primary Decision Maker"), ("c-dev-patel", "Technical Evaluator")}


def test_related_account_hidden_when_not_viewable(login):
    detail = login("ohaddad").get("/api/contacts/c-nadia-petrov").json()  # West contact at an East account
    assert detail["account"] is None and detail["contact"]["account_name"] is None


# ------------------------------------------------------------------------------------------------- creating
def test_create_inherits_creator_and_owner_teams(login, db):
    priya = login("pnair")
    response = priya.post("/api/accounts", json={"name": "Lakeside Foods", "billing_city": "Utica"})
    assert response.status_code == 201, response.text
    new_id = response.json()["id"]
    row = db.execute("SELECT owner_id, created_by, source FROM accounts WHERE id = %s", (new_id,)).fetchone()
    assert row == {"owner_id": "u-pnair", "created_by": "u-pnair", "source": "workspace"}
    teams = db.execute("SELECT team_id FROM record_teams WHERE entity = 'accounts' AND record_id = %s", (new_id,)).fetchall()
    assert {t["team_id"] for t in teams} == {"t-east"}

    response = priya.post("/api/accounts", json={"name": "Shared Co", "owner_id": "u-sokafor"})
    assert response.status_code == 201
    teams = db.execute("SELECT team_id FROM record_teams WHERE entity = 'accounts' AND record_id = %s",
                       (response.json()["id"],)).fetchall()
    assert {t["team_id"] for t in teams} == {"t-east", "t-west"}


def test_owner_must_be_an_active_user(login):
    priya = login("pnair")
    assert priya.post("/api/accounts", json={"name": "X", "owner_id": "u-treyes"}).status_code == 422
    assert priya.post("/api/accounts", json={"name": "X", "owner_id": "u-nobody"}).status_code == 422


def test_notes_inherit_parent_teams_and_require_a_viewable_parent(login, db):
    priya = login("pnair")
    response = priya.post("/api/notes", json={"subject": "Visit", "parent_type": "account", "parent_id": "acc-pine-hollow"})
    assert response.status_code == 201, response.text
    teams = db.execute("SELECT team_id FROM record_teams WHERE entity = 'notes' AND record_id = %s",
                       (response.json()["id"],)).fetchall()
    assert {t["team_id"] for t in teams} == {"t-east", "t-west"}  # creator/owner East + parent West
    assert priya.post("/api/notes", json={"subject": "x", "parent_type": "account",
                                          "parent_id": "acc-acme-supply-co"}).status_code == 404
    assert priya.post("/api/notes", json={"subject": "x", "parent_type": "account",
                                          "parent_id": "acc-old-mill"}).status_code == 404
    assert priya.post("/api/notes", json={"subject": "x", "parent_type": "planet",
                                          "parent_id": "acc-acme-supply"}).status_code == 422
    assert priya.post("/api/notes", json={"parent_type": "account", "parent_id": "acc-acme-supply"}).status_code == 422


def test_support_without_team_gets_parent_teams(login, db):
    dana = login("dkim")
    response = dana.post("/api/notes", json={"subject": "Case 4411 escalated", "parent_type": "account",
                                             "parent_id": "acc-acme-supply"})
    assert response.status_code == 201
    teams = db.execute("SELECT team_id FROM record_teams WHERE entity = 'notes' AND record_id = %s",
                       (response.json()["id"],)).fetchall()
    assert {t["team_id"] for t in teams} == {"t-east"}
    # Support may not attach notes to deals (deals are disabled for it): the parent is not viewable
    assert dana.post("/api/notes", json={"subject": "x", "parent_type": "deal",
                                         "parent_id": "d-acme-shelving"}).status_code == 404


def test_reference_to_invisible_account_is_404(login):
    priya = login("pnair")
    response = priya.post("/api/contacts", json={"last_name": "Doe", "account_id": "acc-acme-supply-co"})
    assert response.status_code == 404
    assert priya.patch("/api/contacts/c-maria-lopez", json={"account_id": "acc-harborview"}).status_code == 404


# ------------------------------------------------------------------------------------------------- audit
def test_update_writes_audit_rows_for_changed_fields_only(login, db):
    priya = login("pnair")
    response = priya.patch("/api/accounts/acc-acme-supply", json={"phone": "(518) 555-0999", "name": "Acme Supply",
                                                                 "contract_renewal_date": "2027-03-31"})
    assert response.status_code == 200, response.text
    assert sorted(response.json()["changed"]) == ["contract_renewal_date", "phone"]
    rows = db.execute(
        "SELECT field, before, after, changed_by, source FROM audit_log WHERE entity = 'accounts' "
        "AND record_id = 'acc-acme-supply' ORDER BY field").fetchall()
    assert [r["field"] for r in rows] == ["contract_renewal_date", "phone"]
    phone = rows[1]
    assert (phone["before"], phone["after"], phone["changed_by"], phone["source"]) == (
        "(518) 555-0100", "(518) 555-0999", "u-pnair", "workspace")
    assert rows[0]["after"] == "2027-03-31"
    # a no-op update writes nothing
    priya.patch("/api/accounts/acc-acme-supply", json={"phone": "(518) 555-0999"})
    assert db.execute("SELECT count(*) AS n FROM audit_log WHERE record_id = 'acc-acme-supply'").fetchone()["n"] == 2


def test_read_only_fields_are_ignored(login, db):
    priya = login("pnair")
    response = priya.patch("/api/accounts/acc-acme-supply", json={"id": "hijack", "created_by": "u-admin",
                                                                 "deleted_at": None, "source": "x"})
    assert response.status_code == 200
    row = db.execute("SELECT id, created_by, source FROM accounts WHERE id = 'acc-acme-supply'").fetchone()
    assert row == {"id": "acc-acme-supply", "created_by": "u-pnair", "source": "suitecrm"}


@pytest.mark.parametrize("user", ["pnair", "mchen", "ohaddad", "dkim", "admin"])
def test_every_listed_account_is_viewable(login, user):
    client = login(user)
    for account_id in all_ids(client, "/api/accounts"):
        assert client.get(f"/api/accounts/{account_id}").status_code == 200
