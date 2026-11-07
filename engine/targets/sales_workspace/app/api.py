"""The JSON API under /api (SPEC.md "JSON API").

Status codes: 401 signed out; 403 viewable but not editable/deletable, creating without an edit level, lists of an
entity the user cannot list, non-managers approving/rejecting (with the ``not_manager`` message); 404 unknown,
soft-deleted or not viewable ids (also for referenced records in a body); 415 a mutation whose body is not JSON;
422 validation errors. Every error body is ``{"detail": "..."}`` (plus ``errors`` per field when useful).
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from . import auth, db
from .convert import conversion_state, convert_lead
from .services import accounts, activities, contacts, deals, leads, search as search_svc
from .services.base import Ctx, Invalid, ServiceError, Unsupported, idempotent_create, json_default


class JSONOut(Response):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        text = json.dumps(content, default=json_default, ensure_ascii=False, separators=(",", ":"))
        return text.encode("utf-8", errors="replace")


def out(data: Any, status: int = 200) -> JSONOut:
    return JSONOut(content=data, status_code=status, headers={"Cache-Control": "no-store"})


class NotSignedIn(ServiceError):
    status = 401


# --------------------------------------------------------------------------------------------------- dependencies
def get_conn(request: Request):
    with request.app.state.pool.connection() as conn:
        yield conn


def api_ctx(request: Request, conn: db.Connection = Depends(get_conn)) -> Ctx:
    state = request.app.state
    session = state.sessions.read(request.cookies.get(auth.SESSION_COOKIE))
    actor = auth.current_actor(conn, state.cfg, session)
    if actor is None:
        raise NotSignedIn("Sign in first.")
    request.state.session = session
    return Ctx(conn=conn, actor=actor, cfg=state.cfg)


def _check_text(value, depth: int = 0) -> None:
    """Reject what PostgreSQL text cannot hold (NUL) or UTF-8 cannot encode (lone surrogates)."""
    if depth > 32:
        raise Invalid("The request body is nested too deeply.")
    if isinstance(value, str):
        if "\x00" in value:
            raise Invalid("Text cannot contain NUL characters.")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise Invalid("Text contains characters that are not valid Unicode.")
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_text(key, depth + 1)
            _check_text(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _check_text(item, depth + 1)


async def json_body(request: Request) -> dict:
    """API mutations accept JSON only: 415 for another content type, 422 for a body that is not a JSON object."""
    content_type = request.headers.get("content-type", "")
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type != "application/json" and not media_type.endswith("+json"):
        raise Unsupported("Send a JSON body with Content-Type: application/json.")
    raw = await request.body()
    try:
        data = json.loads(raw) if raw else None
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise Invalid("The request body is not valid JSON.")
    if not isinstance(data, dict):
        raise Invalid("The request body must be a JSON object.")
    _check_text(data)
    return data


async def body_for(request: Request, ctx: Ctx = Depends(api_ctx)) -> dict:
    """The JSON body, read only after the session was checked (so a signed-out request gets 401 first)."""
    return await json_body(request)


router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------------------------------- session
@router.post("/login")
async def login(request: Request):
    try:
        data = await json_body(request)
    except Invalid:  # "401 otherwise": a malformed body is just a failed sign-in
        return out({"detail": "Incorrect user name or password."}, 401)
    user_name, password = data.get("user_name"), data.get("password")
    state = request.app.state
    if not isinstance(user_name, str) or not isinstance(password, str):
        return out({"detail": "Incorrect user name or password."}, 401)

    def work():
        with state.pool.connection() as conn:
            user = auth.authenticate(conn, user_name, password)
            if user is None:
                return None, None
            actor = auth.load_actor(conn, state.cfg, user["id"])
            return user, (auth.me_payload(conn, state.cfg, actor) if actor else None)

    from starlette.concurrency import run_in_threadpool

    user, me = await run_in_threadpool(work)
    if user is None or me is None:
        return out({"detail": "Incorrect user name or password."}, 401)
    token, _csrf = state.sessions.issue(user["id"])
    response = out({"user": me})
    set_session_cookie(response, state, token)
    return response


def set_session_cookie(response: Response, state, token: str) -> None:
    response.set_cookie(
        auth.SESSION_COOKIE, token, max_age=state.settings.session_hours * 3600, httponly=True, samesite="lax",
        secure=state.settings.cookie_secure, path="/",
    )


@router.post("/logout")
def logout(request: Request):
    state = request.app.state
    session = state.sessions.read(request.cookies.get(auth.SESSION_COOKIE))
    if session:
        with state.pool.connection() as conn:
            auth.revoke_session(conn, session, state.sessions.max_age)
    response = out({"ok": True})
    response.delete_cookie(auth.SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return response


@router.get("/me")
def me(ctx: Ctx = Depends(api_ctx)):
    return out(auth.me_payload(ctx.conn, ctx.cfg, ctx.actor))


@router.get("/meta")
def meta(ctx: Ctx = Depends(api_ctx)):
    data = ctx.cfg.meta()
    data["currencies"] = [
        {"code": c["code"], "name": c["name"], "symbol": c["symbol"], "rate_per_usd": c["rate_per_usd"]}
        for c in ctx.currencies().values()
    ]
    return out(data)


@router.get("/users")
def users(ctx: Ctx = Depends(api_ctx)):
    items = search_svc.active_users(ctx)
    return out({"items": items, "total": len(items)})


# --------------------------------------------------------------------------------------------------- overview
@router.get("/search")
def search(q: str = "", ctx: Ctx = Depends(api_ctx)):
    return out(search_svc.search(ctx, q))


@router.get("/pipeline")
def pipeline(scope: str = "all", ctx: Ctx = Depends(api_ctx)):
    return out(deals.pipeline(ctx, scope))


@router.get("/renewals")
def renewals(days: int | None = None, page: int = 1, per_page: int = 50, ctx: Ctx = Depends(api_ctx)):
    return out(accounts.renewals(ctx, days=days, page=page, per_page=per_page))


@router.get("/approvals")
def approvals(q: str = "", page: int = 1, per_page: int = 50, ctx: Ctx = Depends(api_ctx)):
    return out(deals.approvals(ctx, q=q, page=page, per_page=per_page))


# --------------------------------------------------------------------------------------------------- accounts
@router.get("/accounts")
def list_accounts(q: str = "", page: int = 1, per_page: int = 50, owner: str | None = None,
                  ctx: Ctx = Depends(api_ctx)):
    return out(accounts.list_accounts(ctx, q=q, page=page, per_page=per_page, owner=owner))


@router.post("/accounts")
def create_account(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "accounts", body.get("request_key"), lambda: accounts.create_account(ctx, body))
    return out(result, 201)


@router.get("/accounts/{account_id}")
def get_account(account_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(accounts.get_account(ctx, account_id))


@router.patch("/accounts/{account_id}")
def update_account(account_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(accounts.update_account(ctx, account_id, body))


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(accounts.delete_account(ctx, account_id))


# --------------------------------------------------------------------------------------------------- contacts
@router.get("/contacts")
def list_contacts(q: str = "", page: int = 1, per_page: int = 50, account_id: str | None = None,
                  owner: str | None = None, ctx: Ctx = Depends(api_ctx)):
    return out(contacts.list_contacts(ctx, q=q, page=page, per_page=per_page, account_id=account_id, owner=owner))


@router.post("/contacts")
def create_contact(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "contacts", body.get("request_key"), lambda: contacts.create_contact(ctx, body))
    return out(result, 201)


@router.get("/contacts/{contact_id}")
def get_contact(contact_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(contacts.get_contact(ctx, contact_id))


@router.patch("/contacts/{contact_id}")
def update_contact(contact_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(contacts.update_contact(ctx, contact_id, body))


@router.delete("/contacts/{contact_id}")
def delete_contact(contact_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(contacts.delete_contact(ctx, contact_id))


# --------------------------------------------------------------------------------------------------- leads
def _opt_bool(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    if value.lower() in ("true", "1", "yes"):
        return True
    if value.lower() in ("false", "0", "no"):
        return False
    raise Invalid("Use true or false.")


@router.get("/leads")
def list_leads(q: str = "", page: int = 1, per_page: int = 50, status: str | None = None,
               converted: str | None = None, owner: str | None = None, ctx: Ctx = Depends(api_ctx)):
    return out(leads.list_leads(ctx, q=q, page=page, per_page=per_page, status=status,
                                converted=_opt_bool(converted), owner=owner))


@router.post("/leads")
def create_lead(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "leads", body.get("request_key"), lambda: leads.create_lead(ctx, body))
    return out(result, 201)


@router.get("/leads/{lead_id}")
def get_lead(lead_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(leads.get_lead(ctx, lead_id))


@router.patch("/leads/{lead_id}")
def update_lead(lead_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(leads.update_lead(ctx, lead_id, body))


@router.delete("/leads/{lead_id}")
def delete_lead(lead_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(leads.delete_lead(ctx, lead_id))


@router.get("/leads/{lead_id}/conversion")
def lead_conversion(lead_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(conversion_state(ctx, lead_id))


@router.post("/leads/{lead_id}/convert")
def lead_convert(lead_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    status, payload = convert_lead(ctx, lead_id, body)
    return out(payload, status)


# --------------------------------------------------------------------------------------------------- deals
@router.get("/deals")
def list_deals(q: str = "", page: int = 1, per_page: int = 50, account_id: str | None = None,
               contact_id: str | None = None, owner: str | None = None, stage: str | None = None,
               status: str | None = None, approval_status: str | None = None, sort: str = "close",
               ctx: Ctx = Depends(api_ctx)):
    return out(deals.list_deals(ctx, q=q, page=page, per_page=per_page, account_id=account_id, contact_id=contact_id,
                                owner=owner, stage=stage, status=status, approval_status=approval_status, sort=sort))


@router.post("/deals")
def create_deal(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "deals", body.get("request_key"), lambda: deals.create_deal(ctx, body))
    return out(result, 201)


@router.get("/deals/{deal_id}")
def get_deal(deal_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(deals.get_deal(ctx, deal_id))


@router.patch("/deals/{deal_id}")
def update_deal(deal_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(deals.update_deal(ctx, deal_id, body))


@router.delete("/deals/{deal_id}")
def delete_deal(deal_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(deals.delete_deal(ctx, deal_id))


@router.post("/deals/{deal_id}/approval")
def deal_approval(deal_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(deals.decide(ctx, deal_id, body.get("decision")))


# --------------------------------------------------------------------------------------------------- notes & tasks
def _parent(parent_type: str | None, parent_id: str | None) -> tuple[str, str] | None:
    if parent_type and parent_id:
        return parent_type, parent_id
    if parent_type or parent_id:
        raise Invalid("parent_type and parent_id go together.")
    return None


@router.get("/notes")
def list_notes(q: str = "", page: int = 1, per_page: int = 50, parent_type: str | None = None,
               parent_id: str | None = None, contact_id: str | None = None, owner: str | None = None,
               ctx: Ctx = Depends(api_ctx)):
    return out(activities.list_notes(ctx, q=q, page=page, per_page=per_page, parent=_parent(parent_type, parent_id),
                                     contact_id=contact_id, owner=owner))


@router.post("/notes")
def create_note(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "notes", body.get("request_key"), lambda: activities.create_note(ctx, body))
    return out(result, 201)


@router.get("/notes/{note_id}")
def get_note(note_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(activities.get_note(ctx, note_id))


@router.patch("/notes/{note_id}")
def update_note(note_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(activities.update_note(ctx, note_id, body))


@router.delete("/notes/{note_id}")
def delete_note(note_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(activities.delete_note(ctx, note_id))


@router.get("/tasks")
def list_tasks(q: str = "", page: int = 1, per_page: int = 50, parent_type: str | None = None,
               parent_id: str | None = None, owner: str | None = None, open: str | None = None,
               ctx: Ctx = Depends(api_ctx)):
    return out(activities.list_tasks(ctx, q=q, page=page, per_page=per_page, parent=_parent(parent_type, parent_id),
                                     owner=owner, open=_opt_bool(open)))


@router.post("/tasks")
def create_task(ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    result, _ = idempotent_create(ctx, "tasks", body.get("request_key"), lambda: activities.create_task(ctx, body))
    return out(result, 201)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(activities.get_task(ctx, task_id))


@router.patch("/tasks/{task_id}")
def update_task(task_id: str, ctx: Ctx = Depends(api_ctx), body: dict = Depends(body_for)):
    return out(activities.update_task(ctx, task_id, body))


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, ctx: Ctx = Depends(api_ctx)):
    return out(activities.delete_task(ctx, task_id))
