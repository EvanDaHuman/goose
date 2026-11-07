"""Lead conversion: exact vs similar matches, the one-transaction conversion, idempotency and concurrent double
submits (two threads on two connections, and two HTTP requests against a live server)."""
from __future__ import annotations

import socket
import threading
import time

import httpx
import psycopg
import pytest
import uvicorn

from app import convert as convert_mod
from app.config import load_workspace_config
from app.convert import convert_lead
from app.main import create_app
from conftest import CONFIG_PATH, TEST_PASSWORD, dsn

MSG = load_workspace_config(CONFIG_PATH).rule.messages


def count(db, sql, *params):
    return db.execute(sql, params).fetchone()["n"]


def contacts_named(db, last_name):
    return count(db, "SELECT count(*) AS n FROM contacts WHERE last_name = %s", last_name)


EXISTING = {"mode": "existing", "id": "acc-acme-supply"}


# ------------------------------------------------------------------------------------------------- matching
def test_exact_match_after_normalisation_and_similar_only_as_warning(login):
    state = login("pnair").get("/api/leads/l-ethan-brooks/conversion").json()  # company "  acme   SUPPLY "
    assert state["already_converted"] is False and state["result"] is None
    assert [a["id"] for a in state["exact_matches"]] == ["acc-acme-supply"]
    assert [a["id"] for a in state["similar"]] == ["acc-acme-supply-inc"]  # ACME Supply Co. is West: not viewable
    assert state["suggested_account"] == {"mode": "existing", "id": "acc-acme-supply"}
    assert state["similar"][0]["similarity"] >= 0.8


def test_matches_only_include_viewable_accounts(login):
    state = login("admin").get("/api/leads/l-ethan-brooks/conversion").json()
    assert [a["id"] for a in state["exact_matches"]] == ["acc-acme-supply"]
    assert {a["id"] for a in state["similar"]} == {"acc-acme-supply-co", "acc-acme-supply-inc"}
    west = login("sokafor").get("/api/leads/l-rita-mendes/conversion").json()  # company "ACME Supply Co."
    assert [a["id"] for a in west["exact_matches"]] == ["acc-acme-supply-co"] and west["similar"] == []


def test_similar_only_lead(login):
    state = login("jweber").get("/api/leads/l-nora-fields/conversion").json()  # "Acme Supplies"
    assert state["exact_matches"] == []
    assert [a["id"] for a in state["similar"]] == ["acc-acme-supplies-ltd", "acc-acme-supply"]
    assert state["suggested_account"] == {"mode": "new", "name": "Acme Supplies"}


def test_no_match(login):
    state = login("pnair").get("/api/leads/l-olivia-grant/conversion").json()
    assert state["exact_matches"] == [] and state["similar"] == []


# ------------------------------------------------------------------------------------------------- converting
def test_convert_to_existing_account_with_blocked_deal(login, db):
    priya = login("pnair")
    response = priya.post("/api/leads/l-ethan-brooks/convert", json={
        "request_key": "k-ethan-1", "account": EXISTING, "create_deal": True,
        "deal": {"name": "Acme Supply – Second warehouse", "amount": "31000", "currency_code": "USD",
                 "stage": "Closed Won", "close_date": "2026-12-15"}})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["already_converted"] is False and body["account_created"] is False
    assert body["account_id"] == "acc-acme-supply" and body["contact_id"] and body["deal_id"]
    assert body["blocked"] is True and body["rule_messages"] == [MSG["blocked"]]

    contact = db.execute("SELECT * FROM contacts WHERE id = %s", (body["contact_id"],)).fetchone()
    assert (contact["first_name"], contact["last_name"], contact["title"], contact["email"], contact["phone"],
            contact["city"], contact["lead_source"]) == (
        "Ethan", "Brooks", "Facilities Manager", "ethan.brooks@acme-supply.example", "(518) 555-0188", "Albany", "Web Site")
    assert contact["owner_id"] == "u-pnair" and contact["account_id"] == "acc-acme-supply"
    deal = db.execute("SELECT * FROM deals WHERE id = %s", (body["deal_id"],)).fetchone()
    assert deal["stage"] == "Negotiation/Review" and deal["approval_status"] == "requested"  # through the deal rules
    assert deal["account_id"] == "acc-acme-supply" and deal["owner_id"] == "u-pnair"
    role = db.execute("SELECT role FROM deal_contacts WHERE deal_id = %s AND contact_id = %s",
                      (body["deal_id"], body["contact_id"])).fetchone()
    assert role["role"] == "Primary Decision Maker"
    lead = db.execute("SELECT * FROM leads WHERE id = 'l-ethan-brooks'").fetchone()
    assert lead["status"] == "Converted" and lead["converted"] is True
    assert (lead["converted_contact_id"], lead["converted_account_id"], lead["converted_deal_id"]) == (
        body["contact_id"], "acc-acme-supply", body["deal_id"])
    conv = db.execute("SELECT * FROM lead_conversions WHERE lead_id = 'l-ethan-brooks'").fetchone()
    assert conv["request_key"] == "k-ethan-1" and conv["converted_by"] == "u-pnair" and conv["account_created"] is False
    # activities = donothing: the lead's notes and tasks stay on the lead
    assert db.execute("SELECT parent_type FROM notes WHERE id = 'n-ethan'").fetchone()["parent_type"] == "lead"
    assert db.execute("SELECT parent_type FROM tasks WHERE id = 't-ethan-followup'").fetchone()["parent_type"] == "lead"
    teams = db.execute("SELECT team_id FROM record_teams WHERE entity = 'contacts' AND record_id = %s",
                       (body["contact_id"],)).fetchall()
    assert {t["team_id"] for t in teams} == {"t-east"}
    assert {a["field"] for a in db.execute("SELECT field FROM audit_log WHERE record_id = 'l-ethan-brooks'").fetchall()} >= {
        "status", "converted", "converted_contact_id", "converted_account_id", "converted_deal_id"}


def test_convert_creating_a_new_account(login, db):
    response = login("jweber").post("/api/leads/l-nora-fields/convert", json={
        "request_key": "k-nora", "account": {"mode": "new", "name": "Acme Supplies"}, "create_deal": False})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["account_created"] is True and body["deal_id"] is None
    account = db.execute("SELECT * FROM accounts WHERE id = %s", (body["account_id"],)).fetchone()
    assert account["name"] == "Acme Supplies" and account["owner_id"] == "u-jweber" and account["source"] == "workspace"
    # the similar accounts were never linked
    assert body["account_id"] not in ("acc-acme-supplies-ltd", "acc-acme-supply")
    assert count(db, "SELECT count(*) AS n FROM contacts WHERE account_id = 'acc-acme-supplies-ltd' AND last_name = 'Fields'") == 0


def test_converting_again_returns_the_stored_result(login, db):
    priya = login("pnair")
    first = priya.post("/api/leads/l-olivia-grant/convert", json={
        "request_key": "k-olivia-1", "account": {"mode": "new", "name": "Brightwater Dental"}}).json()
    again = priya.post("/api/leads/l-olivia-grant/convert", json={
        "request_key": "k-olivia-2", "account": {"mode": "new", "name": "Something else"}})
    assert again.status_code == 200
    body = again.json()
    assert body["already_converted"] is True
    assert (body["contact_id"], body["account_id"], body["deal_id"]) == (
        first["contact_id"], first["account_id"], first["deal_id"])
    replay = priya.post("/api/leads/l-olivia-grant/convert", json={
        "request_key": "k-olivia-1", "account": {"mode": "new", "name": "Brightwater Dental"}})
    assert replay.status_code == 200 and replay.json()["contact_id"] == first["contact_id"]
    assert contacts_named(db, "Grant") == 1
    assert count(db, "SELECT count(*) AS n FROM accounts WHERE name IN ('Brightwater Dental', 'Something else')") == 1
    state = priya.get("/api/leads/l-olivia-grant/conversion").json()
    assert state["already_converted"] is True and state["result"]["contact_id"] == first["contact_id"]


def test_lead_converted_before_the_migration(login):
    priya = login("pnair")
    state = priya.get("/api/leads/l-quinn-harper/conversion").json()
    assert state["already_converted"] is True and state["result"]["contact_id"] == "c-quinn-harper"
    response = priya.post("/api/leads/l-quinn-harper/convert", json={"request_key": "x", "account": EXISTING})
    assert response.status_code == 200 and response.json()["already_converted"] is True


def test_request_key_of_another_lead_is_rejected(login, db):
    priya = login("pnair")
    response = priya.post("/api/leads/l-ethan-brooks/convert", json={"request_key": "fixture-quinn-harper",
                                                                     "account": EXISTING})
    assert response.status_code == 422
    assert db.execute("SELECT converted FROM leads WHERE id = 'l-ethan-brooks'").fetchone()["converted"] is False


# ------------------------------------------------------------------------------------------------- refusals
def test_conversion_permissions(login, db):
    priya = login("pnair")
    response = priya.post("/api/leads/l-greg-lowe/convert", json={"request_key": "k1", "account": EXISTING})
    assert response.status_code == 403  # Jonah's lead: viewable, not editable by Priya
    assert login("ohaddad").post("/api/leads/l-ethan-brooks/convert",
                                 json={"request_key": "k2", "account": EXISTING}).status_code == 404
    assert login("dkim").post("/api/leads/l-ethan-brooks/convert",
                              json={"request_key": "k3", "account": EXISTING}).status_code == 404
    response = priya.post("/api/leads/l-olivia-grant/convert", json={
        "request_key": "k4", "account": {"mode": "existing", "id": "acc-acme-supply-co"}})
    assert response.status_code == 404  # an existing account must be viewable
    assert contacts_named(db, "Lowe") == 0 and contacts_named(db, "Grant") == 0 and contacts_named(db, "Brooks") == 0


@pytest.mark.parametrize("body", [
    {"request_key": "v1"},
    {"request_key": "v2", "account": {"mode": "merge"}},
    {"request_key": "v3", "account": {"mode": "existing"}},
    {"request_key": "v4", "account": EXISTING, "create_deal": True},
    {"request_key": "v5", "account": EXISTING, "create_deal": True, "deal": {"name": "x", "amount": "abc"}},
    {"request_key": "v6", "account": EXISTING, "create_deal": True, "deal": {"amount": "100"}},
    {"request_key": ["not", "a", "string"], "account": EXISTING},
])
def test_conversion_validation_creates_nothing(login, db, body):
    response = login("pnair").post("/api/leads/l-ethan-brooks/convert", json=body)
    assert response.status_code == 422, response.text
    assert "detail" in response.json()
    assert contacts_named(db, "Brooks") == 0
    assert db.execute("SELECT converted FROM leads WHERE id = 'l-ethan-brooks'").fetchone()["converted"] is False


# ------------------------------------------------------------------------------------------------- concurrency
def _lock_waiters(monitor) -> int:
    return monitor.execute(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    ).fetchone()[0]


def _race(ctx_for, db_name, monkeypatch=None, skip_row_lock_for_b=False):
    """Thread A converts and, before committing, waits until thread B is blocked on a lock; B converts the same
    lead with another request key. Returns both results."""
    ctx_a, ctx_b = ctx_for("u-pnair"), ctx_for("u-pnair")
    monitor = psycopg.connect(dsn(db_name), autocommit=True)
    a_inside = threading.Event()
    results, errors = {}, []

    def hold_until_b_waits():
        a_inside.set()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and _lock_waiters(monitor) < 1:
            time.sleep(0.01)

    if skip_row_lock_for_b:  # B skips the row lock, so only the lead_conversions primary key can stop it
        original = convert_mod.fetch_visible

        def fetch_visible(ctx, entity, record_id, *, for_update=False):
            if threading.current_thread().name == "B":
                for_update = False
            return original(ctx, entity, record_id, for_update=for_update)

        monkeypatch.setattr(convert_mod, "fetch_visible", fetch_visible)

    def run_a():
        try:
            results["a"] = convert_lead(ctx_a, "l-ethan-brooks", {"request_key": "race-a", "account": EXISTING},
                                        on_before_commit=hold_until_b_waits)
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)

    def run_b():
        try:
            assert a_inside.wait(15)
            results["b"] = convert_lead(ctx_b, "l-ethan-brooks", {"request_key": "race-b", "account": EXISTING})
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=run_a, name="A"), threading.Thread(target=run_b, name="B")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    monitor.close()
    assert not errors, errors
    return results


def test_concurrent_double_submit_creates_one_contact(ctx_for, db_name, db):
    results = _race(ctx_for, db_name)
    (status_a, body_a), (status_b, body_b) = results["a"], results["b"]
    assert (status_a, status_b) == (201, 200)
    assert body_b["already_converted"] is True and body_b["contact_id"] == body_a["contact_id"]
    assert contacts_named(db, "Brooks") == 1
    assert count(db, "SELECT count(*) AS n FROM lead_conversions WHERE lead_id = 'l-ethan-brooks'") == 1


def test_primary_key_is_the_final_guarantee(ctx_for, db_name, db, monkeypatch):
    results = _race(ctx_for, db_name, monkeypatch, skip_row_lock_for_b=True)
    (status_a, body_a), (status_b, body_b) = results["a"], results["b"]
    assert (status_a, status_b) == (201, 200)
    assert body_b["contact_id"] == body_a["contact_id"]
    assert contacts_named(db, "Brooks") == 1  # B's contact was rolled back with its transaction


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_concurrent_http_double_submit(settings, cfg, db):
    app = create_app(settings, cfg)
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        base = f"http://127.0.0.1:{port}"
        with httpx.Client(base_url=base) as login_client:
            login_client.post("/api/login", json={"user_name": "pnair", "password": TEST_PASSWORD}).raise_for_status()
            cookies = dict(login_client.cookies)
        barrier = threading.Barrier(2)
        responses = []

        def submit(key):
            with httpx.Client(base_url=base, cookies=cookies, timeout=30) as client:
                barrier.wait()
                responses.append(client.post("/api/leads/l-ethan-brooks/convert",
                                             json={"request_key": key, "account": EXISTING}))

        workers = [threading.Thread(target=submit, args=(k,)) for k in ("http-1", "http-2")]
        for w in workers:
            w.start()
        for w in workers:
            w.join(30)
        assert sorted(r.status_code for r in responses) == [200, 201]
        assert len({r.json()["contact_id"] for r in responses}) == 1
        assert contacts_named(db, "Brooks") == 1
    finally:
        server.should_exit = True
        thread.join(15)
