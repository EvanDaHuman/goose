"""API flows with the FastAPI test client: sign-in and sessions, content types, validation, pagination, search,
renewals, meta, and create/update/delete flows for every entity."""
from __future__ import annotations

from datetime import date, timedelta

import bcrypt
from fastapi.testclient import TestClient

from conftest import TEST_PASSWORD


# ------------------------------------------------------------------------------------------------- sign-in
def test_healthz(anon):
    response = anon.get("/healthz")
    assert response.status_code == 200 and response.json() == {"ok": True}


def test_login_sets_a_signed_http_only_cookie(anon):
    response = anon.post("/api/login", json={"user_name": "mchen", "password": TEST_PASSWORD})
    assert response.status_code == 200
    user = response.json()["user"]
    assert user["user_name"] == "mchen" and user["name"] == "Maya Chen" and user["roles"] == ["Sales Manager"]
    assert user["teams"] == [{"id": "t-east", "name": "East Sales"}] and user["is_manager_of_teams"] == ["t-east"]
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("lw_session=") and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Max-Age=28800" in cookie
    me = anon.get("/api/me").json()
    assert set(me) >= {"id", "user_name", "name", "title", "is_admin", "roles", "teams", "is_manager_of_teams"}


def test_login_failures_look_the_same(anon):
    bodies = []
    for creds in ({"user_name": "mchen", "password": "wrong"}, {"user_name": "nobody", "password": TEST_PASSWORD},
                  {"user_name": "treyes", "password": TEST_PASSWORD}, {"user_name": "mchen"}):
        response = anon.post("/api/login", json=creds)
        assert response.status_code == 401
        bodies.append(response.json())
    assert all(b == bodies[0] for b in bodies)
    assert "set-cookie" not in response.headers


def test_plain_bcrypt_scheme(anon, db):
    db.execute("UPDATE users SET password_hash = %s, password_scheme = 'bcrypt' WHERE id = 'u-rellis'",
               (bcrypt.hashpw(b"new-password-1", bcrypt.gensalt(rounds=4)).decode(),))
    assert anon.post("/api/login", json={"user_name": "rellis", "password": "new-password-1"}).status_code == 200
    assert anon.post("/api/login", json={"user_name": "rellis", "password": TEST_PASSWORD}).status_code == 401


def test_admin_flags(login):
    me = login("admin").get("/api/me").json()
    assert me["is_admin"] is True and set(me["is_manager_of_teams"]) == {"t-east", "t-west"}


def test_signed_out_api_is_401(anon):
    for method, path in (("get", "/api/me"), ("get", "/api/accounts"), ("get", "/api/accounts/acc-acme-supply"),
                         ("patch", "/api/accounts/acc-acme-supply"), ("post", "/api/deals"),
                         ("get", "/api/pipeline"), ("get", "/api/search?q=a"), ("get", "/api/meta"),
                         ("post", "/api/leads/l-ethan-brooks/convert"), ("delete", "/api/deals/d-acme-25000")):
        response = getattr(anon, method)(path, **({"json": {}} if method in ("post", "patch") else {}))
        assert response.status_code == 401, (method, path)


def test_logout_and_tampered_cookie(app, login):
    client = login("pnair")
    stolen = client.cookies.get("lw_session")
    assert client.post("/api/logout").status_code == 200
    assert client.get("/api/me").status_code == 401
    replay = TestClient(app, cookies={"lw_session": stolen})  # the old cookie no longer works on the server
    assert replay.get("/api/me").status_code == 401
    assert login("pnair").get("/api/me").status_code == 200  # signing in again is fine
    forged = TestClient(app, cookies={"lw_session": "eyJ1aWQiOiJ1LWFkbWluIn0.forged.signature"})
    assert forged.get("/api/me").status_code == 401


def test_deactivated_user_loses_the_session(login, db):
    client = login("jweber")
    db.execute("UPDATE users SET status = 'inactive' WHERE id = 'u-jweber'")
    assert client.get("/api/me").status_code == 401


# ------------------------------------------------------------------------------------------------- content types
def test_mutations_accept_json_only(login, db):
    priya = login("pnair")
    response = priya.patch("/api/accounts/acc-acme-supply", data={"phone": "1"})
    assert response.status_code == 415
    response = priya.post("/api/notes", content="subject=x", headers={"content-type": "text/plain"})
    assert response.status_code == 415
    assert TestClient(priya.app).post("/api/login", data={"user_name": "pnair", "password": TEST_PASSWORD}).status_code == 415
    assert db.execute("SELECT phone FROM accounts WHERE id = 'acc-acme-supply'").fetchone()["phone"] == "(518) 555-0100"


def test_bad_json_and_non_object_bodies_are_422(login):
    priya = login("pnair")
    response = priya.post("/api/accounts", content="{not json", headers={"content-type": "application/json"})
    assert response.status_code == 422 and isinstance(response.json()["detail"], str)
    assert priya.post("/api/accounts", json=["a"]).status_code == 422


def test_validation_errors_are_422_with_detail(login):
    priya = login("pnair")
    response = priya.post("/api/accounts", json={"name": ""})
    assert response.status_code == 422 and response.json()["detail"] and "name" in response.json()["errors"]
    response = priya.post("/api/contacts", json={"first_name": "No", "email": "not-an-email", "last_name": "Body"})
    assert response.status_code == 422 and "email" in response.json()["errors"]
    response = priya.get("/api/accounts", params={"page": "two"})
    assert response.status_code == 422 and isinstance(response.json()["detail"], str)
    assert priya.post("/api/leads", json={"last_name": "X", "status": "Hot"}).status_code == 422
    assert priya.patch("/api/accounts/acc-acme-supply", json={"contract_renewal_date": "2027-02-30"}).status_code == 422


def test_unknown_api_route_is_json_404(login):
    response = login("pnair").get("/api/nothing-here")
    assert response.status_code == 404 and response.json() == {"detail": "Not found."}


# ------------------------------------------------------------------------------------------------- lists
def test_pagination_and_per_page_cap(login):
    admin = login("admin")
    page1 = admin.get("/api/accounts", params={"per_page": 5, "page": 1}).json()
    page2 = admin.get("/api/accounts", params={"per_page": 5, "page": 2}).json()
    assert len(page1["items"]) == 5 and page1["total"] == page2["total"] == 12
    assert not {a["id"] for a in page1["items"]} & {a["id"] for a in page2["items"]}
    assert admin.get("/api/accounts", params={"per_page": 1000}).json()["per_page"] == 100
    assert admin.get("/api/accounts", params={"page": 99}).json()["items"] == []


def test_list_search_q(login):
    priya = login("pnair")
    names = {a["name"] for a in priya.get("/api/accounts", params={"q": "acme"}).json()["items"]}
    assert names == {"Acme Supply", "Acme Supply Inc", "Acme Supplies Ltd"}
    assert [c["id"] for c in priya.get("/api/contacts", params={"q": "maria.lopez@"}).json()["items"]] == ["c-maria-lopez"]
    assert {c["id"] for c in priya.get("/api/contacts", params={"q": "Albany"}).json()["items"]} >= {"c-maria-lopez", "c-dev-patel"}
    assert priya.get("/api/accounts", params={"q": "100%_"}).json()["items"] == []  # wildcards are literal


def test_global_search_groups_and_applies_list_rules(login):
    found = login("pnair").get("/api/search", params={"q": "acme"}).json()
    assert set(found) >= {"accounts", "contacts", "leads", "deals"}
    assert "acc-acme-supply-co" not in {a["id"] for a in found["accounts"]}
    assert "l-rita-mendes" not in {lead["id"] for lead in found["leads"]}
    assert "c-nadia-petrov" not in {c["id"] for c in found["contacts"]}
    assert "l-ethan-brooks" in {lead["id"] for lead in found["leads"]}  # by company
    assert all(len(v) <= 10 for k, v in found.items() if k != "q")
    by_city = login("pnair").get("/api/search", params={"q": "Hartford"}).json()
    assert "acc-acme-supplies-ltd" in {a["id"] for a in by_city["accounts"]}


def test_renewals_next_n_days_soonest_first(login):
    body = login("pnair").get("/api/renewals").json()
    items = body["items"]
    assert [a["id"] for a in items] == ["acc-northwind", "acc-acme-supply", "acc-pine-hollow", "acc-bluebird", "acc-orchard"]
    dates = [date.fromisoformat(a["contract_renewal_date"]) for a in items]
    assert dates == sorted(dates) and all(date.today() <= d <= date.today() + timedelta(days=90) for d in dates)
    assert body["total"] == 5
    short = login("pnair").get("/api/renewals", params={"days": 30}).json()
    assert [a["id"] for a in short["items"]] == ["acc-northwind"]
    assert login("pnair").get("/api/renewals", params={"days": -1}).status_code == 422


def test_meta_exposes_configuration_without_secrets(login, cfg):
    meta = login("pnair").get("/api/meta").json()
    assert [s["key"] for s in meta["stages"]] == cfg.stage_keys
    assert meta["synthetic"] is True and meta["source_system"]["name"] == "SuiteCRM"
    assert meta["approval_rule"]["threshold_usd"] == 25000 and meta["lead_statuses"]
    assert {c["code"] for c in meta["currencies"]} == {"USD", "EUR"}
    text = str(meta).lower()
    assert "password" not in text and "secret" not in text


# ------------------------------------------------------------------------------------------------- CRUD flows
def test_account_crud_flow(login, db):
    maya = login("mchen")
    created = maya.post("/api/accounts", json={"name": "Lakeside Foods", "account_type": "Prospect",
                                               "industry": "Retail", "contract_renewal_date": "2027-03-31"})
    assert created.status_code == 201
    account_id = created.json()["id"]
    assert created.json()["account"]["name"] == "Lakeside Foods"
    detail = maya.get(f"/api/accounts/{account_id}").json()
    assert detail["account"]["contract_renewal_date"] == "2027-03-31" and detail["permissions"] == {"edit": True, "delete": True}
    assert maya.patch(f"/api/accounts/{account_id}", json={"industry": "Healthcare"}).json()["account"]["industry"] == "Healthcare"
    assert maya.patch(f"/api/accounts/{account_id}", json={"industry": "Astrology"}).status_code == 422
    assert maya.delete(f"/api/accounts/{account_id}").status_code == 200
    assert maya.get(f"/api/accounts/{account_id}").status_code == 404


def test_migrated_dropdown_values_survive_unrelated_edits(login, db):
    priya = login("pnair")
    # "Word of mouth" is not in config.lead_sources but came from SuiteCRM; keeping it is fine, setting it is not.
    db.execute("UPDATE contacts SET lead_source = 'Word of mouth' WHERE id = 'c-maria-lopez'")
    assert priya.patch("/api/contacts/c-maria-lopez", json={"lead_source": "Word of mouth", "title": "Buyer"}).status_code == 200
    assert priya.patch("/api/contacts/c-dev-patel", json={"lead_source": "Word of mouth"}).status_code == 422


def test_lead_flow(login):
    priya = login("pnair")
    created = priya.post("/api/leads", json={"first_name": "Ada", "last_name": "Byrne", "company": "Byrne Bakery",
                                             "email": "ada@byrne.example"})
    assert created.status_code == 201
    lead = created.json()["lead"]
    assert lead["status"] == "New" and lead["converted"] is False
    detail = priya.get(f"/api/leads/{lead['id']}").json()
    assert detail["conversion"] == {"already_converted": False, "result": None, "can_convert": True}
    assert priya.patch(f"/api/leads/{lead['id']}", json={"status": "In Process"}).json()["lead"]["status"] == "In Process"


def test_contact_flow_with_account(login):
    priya = login("pnair")
    created = priya.post("/api/contacts", json={"first_name": "Ivy", "last_name": "Moss", "account_id": "acc-acme-supply"})
    assert created.status_code == 201
    contact_id = created.json()["id"]
    detail = priya.get(f"/api/contacts/{contact_id}").json()
    assert detail["account"]["id"] == "acc-acme-supply"
    assert contact_id in {c["id"] for c in priya.get("/api/accounts/acc-acme-supply").json()["contacts"]}


def test_deal_create_with_contact_and_eur(login, db):
    priya = login("pnair")
    response = priya.post("/api/deals", json={"name": "Acme Supply – EU pallets", "account_id": "acc-acme-supply",
                                              "amount": 9200, "currency_code": "EUR", "contact_id": "c-maria-lopez"})
    assert response.status_code == 201
    body = response.json()
    assert body["deal"]["amount_usd"] == 10000.0 and body["deal"]["stage"] == "Prospecting"
    assert body["deal"]["probability"] == 10
    role = db.execute("SELECT role FROM deal_contacts WHERE deal_id = %s", (body["id"],)).fetchone()["role"]
    assert role == "Primary Decision Maker"
    assert priya.post("/api/deals", json={"name": "x", "amount": 1, "contact_id": "c-luis-ortega"}).status_code == 404


def test_notes_and_tasks_flow(login, db):
    priya = login("pnair")
    note = priya.post("/api/notes", json={"subject": "Called Maria", "body": "Agreed next steps.",
                                          "parent_type": "account", "parent_id": "acc-acme-supply",
                                          "contact_id": "c-maria-lopez"})
    assert note.status_code == 201
    note_body = note.json()["note"]
    assert note_body["author_name"] == "Priya Nair" and note_body["contact_name"] == "Maria Lopez"
    assert note_body["parent_name"] == "Acme Supply"
    notes = priya.get("/api/accounts/acc-acme-supply").json()["notes"]
    assert notes[0]["id"] == note_body["id"]  # newest first
    task = priya.post("/api/tasks", json={"subject": "Send revised quote", "due_at": "2027-01-15", "priority": "High",
                                          "parent_type": "deal", "parent_id": "d-acme-shelving"})
    assert task.status_code == 201
    task_body = task.json()["task"]
    assert task_body["status"] == "Not Started" and task_body["is_open"] is True
    done = priya.patch(f"/api/tasks/{task_body['id']}", json={"status": "Completed"}).json()["task"]
    assert done["is_open"] is False
    assert priya.post("/api/tasks", json={"subject": "Solo task"}).status_code == 201  # tasks may have no parent
    assert priya.post("/api/tasks", json={"subject": "x", "due_at": "soon"}).status_code == 422
    listed = priya.get("/api/tasks", params={"owner": "me", "open": "true"}).json()["items"]
    assert all(t["owner_id"] == "u-pnair" and t["is_open"] for t in listed)


def test_request_key_makes_creates_idempotent(login, db):
    priya = login("pnair")
    body = {"subject": "Double click", "parent_type": "account", "parent_id": "acc-acme-supply", "request_key": "rk-1"}
    first = priya.post("/api/notes", json=body)
    second = priya.post("/api/notes", json=body)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert db.execute("SELECT count(*) AS n FROM notes WHERE subject = 'Double click'").fetchone()["n"] == 1
    other_user = login("jweber").post("/api/notes", json=body)
    assert other_user.status_code == 422


# ------------------------------------------------------------------------------------------------- odd input
def test_odd_but_well_formed_input_is_422_not_500(login, anon):
    priya = login("pnair")
    task = {"subject": "x", "parent_type": "account", "parent_id": "acc-acme-supply"}
    assert priya.post("/api/tasks", json={**task, "due_at": "9999-12-31T23:00:00-05:00"}).status_code == 422
    assert priya.post("/api/tasks", json={**task, "due_at": "0001-01-01T00:00:00+14:00"}).status_code == 422
    assert priya.patch("/api/deals/d-acme-25000", json={"probability": "1e999999999"}).status_code == 422
    assert priya.post("/api/notes", json={"subject": "nul\u0000", "parent_type": "account",
                                          "parent_id": "acc-acme-supply"}).status_code == 422
    assert priya.post("/api/notes", content='{"subject": "\\ud800", "parent_type": "account", "parent_id": "acc-acme-supply"}',
                      headers={"content-type": "application/json"}).status_code == 422
    assert priya.get("/api/search", params={"q": "\u0000"}).status_code == 422
    assert priya.get("/api/accounts/%00").status_code in (404, 422)
    assert priya.get("/api/accounts", params={"page": 10**18}).status_code == 200
    assert priya.get("/api/notes", params={"parent_type": "planet", "parent_id": "x"}).status_code == 422
    deep = "[" * 5000 + "]" * 5000
    assert priya.post("/api/accounts", content=deep, headers={"content-type": "application/json"}).status_code == 422
    assert anon.post("/api/login", json=["pnair"]).status_code == 401


def test_filters_on_invisible_records_find_nothing(login):
    priya = login("pnair")
    assert priya.get("/api/contacts", params={"account_id": "acc-acme-supply-co"}).json()["items"] == []
    assert priya.get("/api/deals", params={"contact_id": "c-nadia-petrov"}).json()["items"] == []
    assert priya.get("/api/notes", params={"parent_type": "account", "parent_id": "acc-harborview"}).json()["items"] == []
