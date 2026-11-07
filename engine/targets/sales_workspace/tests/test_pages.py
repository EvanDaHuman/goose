"""Server-rendered pages: sign-in, every page for every role, forms (with CSRF), the blocked Closed Won message,
the approvals queue, lead conversion through the forms, and HTML error pages."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from conftest import CONFIG_PATH, TEST_PASSWORD
from app.config import load_workspace_config

MSG = load_workspace_config(CONFIG_PATH).rule.messages
PAGES = [
    "/", "/search?q=acme", "/search", "/accounts", "/accounts?owner=me&q=acme", "/accounts/acc-acme-supply",
    "/accounts/new", "/contacts", "/contacts/c-maria-lopez", "/leads", "/leads?show=all", "/leads/l-ethan-brooks",
    "/leads/l-ethan-brooks/convert", "/leads/l-quinn-harper/convert", "/deals", "/deals?status=won",
    "/deals/d-acme-shelving", "/deals/new", "/pipeline", "/pipeline?scope=mine", "/approvals",
]


def csrf_of(html: str) -> str:
    match = re.search(r'name="csrf-token" content="([^"]+)"', html)
    assert match, "no CSRF token on the page"
    return match.group(1)


def page_session(app, user: str) -> TestClient:
    client = TestClient(app)
    response = client.post("/login", data={"user_name": user, "password": TEST_PASSWORD}, follow_redirects=False)
    assert response.status_code == 303, response.text
    return client


def csrf_for(client: TestClient, path: str = "/") -> str:
    return csrf_of(client.get(path).text)


# ------------------------------------------------------------------------------------------------- sign-in
def test_signed_out_pages_redirect_to_login(anon):
    response = anon.get("/accounts/acc-acme-supply", follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/login?next=%2Faccounts%2Facc-acme-supply"
    assert anon.get("/", follow_redirects=False).headers["location"] == "/login"
    login = anon.get("/login")
    assert login.status_code == 200 and "Sign in" in login.text and "Synthetic demo data" in login.text
    assert "Delivered by Goose · job GS-EXAMPLE" in login.text


def test_login_form(app):
    client = TestClient(app)
    bad = client.post("/login", data={"user_name": "pnair", "password": "nope"})
    assert bad.status_code == 401 and "match an active account" in bad.text
    inactive = client.post("/login", data={"user_name": "treyes", "password": TEST_PASSWORD})
    assert inactive.status_code == 401 and inactive.text.count("match an active account") == 1
    ok = client.post("/login", data={"user_name": "pnair", "password": TEST_PASSWORD, "next": "/pipeline"},
                     follow_redirects=False)
    assert ok.status_code == 303 and ok.headers["location"] == "/pipeline"
    assert "lw_session=" in ok.headers["set-cookie"]
    evil = TestClient(app).post("/login", data={"user_name": "pnair", "password": TEST_PASSWORD,
                                                "next": "//evil.example"}, follow_redirects=False)
    assert evil.headers["location"] == "/"
    out = client.post("/logout", follow_redirects=False)
    assert out.status_code == 303 and client.get("/", follow_redirects=False).status_code == 303


# ------------------------------------------------------------------------------------------------- every page
@pytest.mark.parametrize("user", ["pnair", "mchen", "dkim", "admin"])
def test_pages_render_for_every_role(app, user):
    client = page_session(app, user)
    for path in PAGES:
        response = client.get(path, follow_redirects=False)
        assert response.status_code in (200, 403, 404), (user, path, response.status_code)
        if response.status_code == 200:
            assert "<main" in response.text and "Delivered by Goose" in response.text


def test_header_shows_role_team_and_manager_queue(app):
    priya = page_session(app, "pnair").get("/").text
    assert "Priya Nair" in priya and "Salesperson · East Sales" in priya and "Synthetic demo data" in priya
    assert 'href="/approvals"' not in priya
    maya = page_session(app, "mchen").get("/").text
    assert 'href="/approvals"' in maya and 'id="nav-approvals-count"' in maya
    dana = page_session(app, "dkim").get("/").text
    assert 'href="/pipeline"' not in dana and 'href="/leads"' not in dana


def test_ui_hides_what_the_api_refuses(app):
    dana = page_session(app, "dkim")
    assert dana.get("/pipeline").status_code == 403
    assert dana.get("/deals/d-acme-shelving").status_code == 404
    assert dana.get("/approvals").status_code == 403
    priya = page_session(app, "pnair")
    assert priya.get("/approvals").status_code == 403
    assert priya.get("/accounts/acc-acme-supply-co").status_code == 404
    assert "records you can't see" in priya.get("/accounts/acc-acme-supply-co").text
    assert priya.get("/deals/d-acme-safety/edit").status_code == 403  # Jonah's deal
    page = priya.get("/accounts/acc-acme-supply").text
    assert "/accounts/acc-acme-supply/delete" not in page  # Salesperson: delete = none
    assert "Nadia Petrov" not in page and "West team intro" not in page


def test_account_page_tells_the_story(app):
    html = page_session(app, "pnair").get("/accounts/acc-acme-supply").text
    assert "Contract renewal date" in html and "renews in 45 days" in html
    for text in ("Maria Lopez", "Warehouse shelving", "Quarterly business review", "about Maria Lopez",
                 "Send renewal proposal", "Support cases", "In SuiteCRM", "Open in SuiteCRM"):
        assert text in html, text
    assert "localhost:8081/index.php?module=Accounts&amp;action=DetailView&amp;record=acc-acme-supply" in html


def test_eur_deal_shows_usd_value(app):
    html = page_session(app, "jweber").get("/deals/d-eur-24000").text
    assert "€24,000.00" in html and "$26,086.96" in html


# ------------------------------------------------------------------------------------------------- forms
def test_forms_require_the_csrf_token(app, db):
    client = page_session(app, "pnair")
    response = client.post("/accounts/acc-acme-supply/edit", data={"name": "Hijacked"})
    assert response.status_code == 403
    assert db.execute("SELECT name FROM accounts WHERE id = 'acc-acme-supply'").fetchone()["name"] == "Acme Supply"


def test_edit_form_validation_and_save(app, db):
    client = page_session(app, "pnair")
    token = csrf_for(client, "/accounts/acc-acme-supply/edit")
    bad = client.post("/accounts/acc-acme-supply/edit", data={"csrf": token, "name": "", "contract_renewal_date": "soon"})
    assert bad.status_code == 422 and "Not saved." in bad.text and "field-error" in bad.text
    ok = client.post("/accounts/acc-acme-supply/edit", data={"csrf": token, "name": "Acme Supply", "phone": "(518) 555-0111"},
                     follow_redirects=False)
    assert ok.status_code == 303 and ok.headers["location"] == "/accounts/acc-acme-supply"
    assert "Changes saved." in client.get(ok.headers["location"]).text
    assert db.execute("SELECT phone FROM accounts WHERE id = 'acc-acme-supply'").fetchone()["phone"] == "(518) 555-0111"


def test_create_deal_form_above_threshold_as_won_is_blocked(app, db):
    client = page_session(app, "pnair")
    token = csrf_for(client, "/deals/new")
    response = client.post("/deals/new", data={
        "csrf": token, "request_key": "form-key-1", "name": "Acme Supply – Rush order", "account_id": "acc-acme-supply",
        "owner_id": "u-pnair", "amount": "31,000.00", "currency_code": "USD", "stage": "Closed Won"}, follow_redirects=False)
    assert response.status_code == 303
    page = client.get(response.headers["location"]).text
    assert MSG["blocked"] in page and "rule-banner" in page
    row = db.execute("SELECT stage, approval_status FROM deals WHERE name = 'Acme Supply – Rush order'").fetchone()
    assert row == {"stage": "Negotiation/Review", "approval_status": "requested"}


def test_deal_page_stage_move_shows_the_blocked_message(app, db):
    client = page_session(app, "pnair")
    token = csrf_for(client, "/deals/d-acme-25001")
    response = client.post("/deals/d-acme-25001/stage", data={"csrf": token, "stage": "Closed Won",
                                                              "next": "/deals/d-acme-25001"}, follow_redirects=False)
    assert response.status_code == 303
    page = client.get("/deals/d-acme-25001").text
    assert "rule-banner" in page and MSG["blocked"] in page and 'role="alert"' in page
    assert db.execute("SELECT stage FROM deals WHERE id = 'd-acme-25001'").fetchone()["stage"] == "Negotiation/Review"
    allowed = client.post("/deals/d-acme-25000/stage", data={"csrf": token, "stage": "Closed Won", "next": "/pipeline"},
                          follow_redirects=False)
    assert "moved to Closed Won" in client.get(allowed.headers["location"]).text


def test_pipeline_card_shows_the_blocked_message(app):
    client = page_session(app, "pnair")
    token = csrf_for(client, "/pipeline")
    response = client.post("/deals/d-bluebird-imaging/stage", data={"csrf": token, "stage": "Closed Won",
                                                                    "next": "/pipeline"}, follow_redirects=False)
    html = client.get(response.headers["location"]).text
    card = html.split('data-deal-id="d-bluebird-imaging"', 1)[1].split("</article>", 1)[0]
    assert "Not moved: approval needed" in card and "is-blocked" in html
    assert html.count("rule-banner") >= 2  # at the top of the page and on the card


def test_approvals_queue_forms(app, db):
    maya = page_session(app, "mchen")
    html = maya.get("/approvals").text
    assert "Warehouse shelving" in html and "Fleet supplies" not in html
    token = csrf_of(html)
    response = maya.post("/deals/d-acme-shelving/approval", data={"csrf": token, "decision": "approved",
                                                                  "next": "/approvals"}, follow_redirects=False)
    assert response.status_code == 303 and "Approved" in maya.get("/approvals").text
    assert db.execute("SELECT approval_status FROM deals WHERE id = 'd-acme-shelving'").fetchone()["approval_status"] == "approved"
    priya = page_session(app, "pnair")
    token = csrf_for(priya, "/deals/d-acme-25001")
    refused = priya.post("/deals/d-acme-25001/approval", data={"csrf": token, "decision": "approved"}, follow_redirects=False)
    assert MSG["not_manager"].replace("'", "&#39;") in priya.get(refused.headers["location"]).text
    assert db.execute("SELECT approval_status FROM deals WHERE id = 'd-acme-25001'").fetchone()["approval_status"] == ""


def test_deal_page_approval_panel_by_role(app):
    priya = page_session(app, "pnair").get("/deals/d-acme-shelving").text
    assert "Only a sales manager on the East Sales team can approve or reject this deal." in priya
    assert 'value="approved"' not in priya
    maya = page_session(app, "mchen").get("/deals/d-acme-shelving").text
    assert 'value="approved"' in maya and 'value="rejected"' in maya


def test_inline_note_and_task(app, db):
    client = page_session(app, "pnair")
    token = csrf_for(client, "/accounts/acc-acme-supply")
    response = client.post("/notes", data={"csrf": token, "parent_type": "account", "parent_id": "acc-acme-supply",
                                           "subject": "Site visit booked", "body": "Thursday 10am", "request_key": "n-1"},
                           follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/accounts/acc-acme-supply#notes"
    assert "Site visit booked" in client.get("/accounts/acc-acme-supply").text
    client.post("/notes", data={"csrf": token, "parent_type": "account", "parent_id": "acc-acme-supply",
                                "subject": "Site visit booked", "request_key": "n-1"})
    assert db.execute("SELECT count(*) AS n FROM notes WHERE subject = 'Site visit booked'").fetchone()["n"] == 1
    client.post("/tasks", data={"csrf": token, "parent_type": "account", "parent_id": "acc-acme-supply",
                                "subject": "Bring samples", "due_at": "2027-01-12", "priority": "High"})
    task = db.execute("SELECT id, status FROM tasks WHERE subject = 'Bring samples'").fetchone()
    assert task["status"] == "Not Started"
    client.post(f"/tasks/{task['id']}/complete", data={"csrf": token, "next": "/"})
    assert db.execute("SELECT status FROM tasks WHERE id = %s", (task["id"],)).fetchone()["status"] == "Completed"
    refused = client.post("/notes", data={"csrf": token, "parent_type": "account", "parent_id": "acc-harborview",
                                          "subject": "x"}, follow_redirects=False)
    assert "Parent record not found." in client.get(refused.headers["location"].split("#")[0]).text


# ------------------------------------------------------------------------------------------------- lead conversion
def test_conversion_page_preselects_exact_match_and_warns_on_similar(app):
    html = page_session(app, "pnair").get("/leads/l-ethan-brooks/convert").text
    assert 'value="existing:acc-acme-supply" checked' in html
    assert "Exact match" in html and "Acme Supply Inc" in html
    assert "Different customer — not linked unless you choose it." in html
    assert 'value="existing:acc-acme-supply-inc" checked' not in html
    assert "ACME Supply Co." not in html  # West account: not viewable


def test_conversion_through_the_form_then_already_converted(app, db):
    client = page_session(app, "pnair")
    html = client.get("/leads/l-ethan-brooks/convert").text
    key = re.search(r'name="request_key" value="([^"]+)"', html).group(1)
    form = {"csrf": csrf_of(html), "request_key": key, "account_choice": "existing:acc-acme-supply",
            "create_deal": "on", "deal_name": "Acme Supply – Second warehouse", "deal_amount": "41,000",
            "deal_currency": "USD", "deal_stage": "Closed Won"}
    response = client.post("/leads/l-ethan-brooks/convert", data=form, follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/leads/l-ethan-brooks/converted"
    result = client.get(response.headers["location"]).text
    assert "Ethan Brooks is now a contact" in result and MSG["blocked"] in result
    again = client.post("/leads/l-ethan-brooks/convert", data=form, follow_redirects=False)
    assert again.status_code == 303
    assert "Already converted" in client.get("/leads/l-ethan-brooks/convert").text
    assert db.execute("SELECT count(*) AS n FROM contacts WHERE last_name = 'Brooks'").fetchone()["n"] == 1


def test_conversion_form_errors_are_shown_inline(app):
    client = page_session(app, "pnair")
    html = client.get("/leads/l-olivia-grant/convert").text
    response = client.post("/leads/l-olivia-grant/convert", data={
        "csrf": csrf_of(html), "request_key": "k", "account_choice": "new", "new_account_name": "Brightwater Dental",
        "create_deal": "on", "deal_name": "", "deal_amount": "lots"})
    assert response.status_code == 422 and "alert-error" in response.text and "{" not in response.text.split("alert-error")[1][:200]


def test_unknown_page_is_html_404(app):
    response = page_session(app, "pnair").get("/no-such-page")
    assert response.status_code == 404 and "text/html" in response.headers["content-type"]
