"""Server-rendered pages. They call the same service functions as the JSON API, so the same rules apply; the UI only
hides what the API would refuse. Forms are plain HTML posts (with a CSRF token from the session) that redirect
after success; app.js enhances a few of them with fetch() calls to the JSON API."""
from __future__ import annotations

import functools
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from starlette.concurrency import run_in_threadpool

from . import __version__, auth, formatting
from .api import get_conn, set_session_cookie
from .convert import conversion_state, convert_lead
from .services import accounts, activities, contacts, deals, leads, search as search_svc
from .services.base import Ctx, Forbidden, Invalid, NotFound, ServiceError, idempotent_create

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
PER_PAGE = 25
router = APIRouter()


class LoginRequired(Exception):
    pass


@dataclass
class PageCtx(Ctx):
    request: Request | None = None
    session: dict | None = None


# --------------------------------------------------------------------------------------------------- templates
def make_templates(cfg) -> Environment:
    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR), autoescape=select_autoescape(["html"]),
                      trim_blocks=True, lstrip_blocks=True)
    formatting.register(env)
    env.globals.update(cfg=cfg, asset_version=__version__)
    return env


def _footer(cfg) -> dict:
    src = cfg.source_system
    snapshot = src.get("snapshot_taken_at")
    return {
        "job": cfg.job_id,
        "system": src.get("name", "SuiteCRM"),
        "version": src.get("version", ""),
        "snapshot": formatting.datetime_fmt(snapshot) + " UTC" if snapshot else "",
    }


def _nav(ctx: Ctx, path: str) -> list[dict]:
    actor = ctx.actor
    items = [{"label": "Home", "href": "/", "key": "home"}]
    if actor.can("deals", "list"):
        items.append({"label": "Pipeline", "href": "/pipeline", "key": "pipeline"})
    if actor.can("accounts", "list"):
        items.append({"label": "Accounts", "href": "/accounts", "key": "accounts"})
    if actor.can("contacts", "list"):
        items.append({"label": "Contacts", "href": "/contacts", "key": "contacts"})
    if actor.can("leads", "list"):
        items.append({"label": "Leads", "href": "/leads", "key": "leads"})
    if actor.is_manager(ctx.rule) and actor.can("deals", "list"):
        items.append({"label": "Approvals", "href": "/approvals", "key": "approvals",
                      "count": deals.approvals_count(ctx)})
    section = path.strip("/").split("/", 1)[0]
    section = {"": "home", "deals": "pipeline"}.get(section, section)
    for item in items:
        item["active"] = item["key"] == section
    return items


def _role_line(ctx: Ctx) -> str:
    actor = ctx.actor
    roles = actor.role_names or (["Administrator"] if actor.is_admin else [])
    if actor.is_admin and "Administrator" not in roles:
        roles = ["Administrator", *roles]
    parts = [", ".join(roles)] if roles else []
    if actor.team_names:
        parts.append(", ".join(actor.team_names))
    return " · ".join(parts)


def render(ctx: PageCtx, template: str, status: int = 200, **context) -> HTMLResponse:
    request = ctx.request
    state = request.app.state
    flashes = state.sessions.read_flash(request.cookies.get(auth.FLASH_COOKIE))
    base = {
        "request": request,
        "me": ctx.actor,
        "role_line": _role_line(ctx),
        "nav": _nav(ctx, request.url.path),
        "flashes": flashes,
        "blocked_deals": {f.get("deal_id"): f for f in flashes if f.get("deal_id")},
        "csrf": (ctx.session or {}).get("csrf", ""),
        "footer": _footer(ctx.cfg),
        "path": request.url.path,
        "full_path": str(request.url.path) + (("?" + request.url.query) if request.url.query else ""),
        "search_q": "",
        "can": ctx.actor.can,
        "currencies": ctx.currencies(),
    }
    base.update(context)
    html = state.templates.get_template(template).render(**base)
    response = HTMLResponse(html, status_code=status)
    if request.cookies.get(auth.FLASH_COOKIE):
        response.delete_cookie(auth.FLASH_COOKIE, path="/")
    return response


def render_public(request: Request, template: str, status: int = 200, **context) -> HTMLResponse:
    state = request.app.state
    html = state.templates.get_template(template).render(
        request=request, me=None, nav=[], flashes=[], footer=_footer(state.cfg), path=request.url.path, **context)
    return HTMLResponse(html, status_code=status)


ERROR_TITLES = {
    403: "You don't have access to this",
    404: "We couldn't find that page",
    405: "That action isn't available here",
    415: "Unsupported request",
    422: "Something in that request wasn't valid",
}


def error_response(request: Request, status: int, detail: str) -> HTMLResponse:
    return render_public(request, "error.html", status=status, status_code=status,
                         title=ERROR_TITLES.get(status, "Something went wrong"), detail=detail)


def render_error(ctx: PageCtx, exc: ServiceError) -> HTMLResponse:
    return render(ctx, "error.html", status=exc.status, status_code=exc.status,
                  title=ERROR_TITLES.get(exc.status, "Something went wrong"), detail=exc.detail)


def login_redirect(request: Request) -> RedirectResponse:
    target = request.url.path + (("?" + request.url.query) if request.url.query else "")
    if target in ("/", ""):
        return RedirectResponse("/login", status_code=303)
    return RedirectResponse("/login?" + urlencode({"next": target}), status_code=303)


def safe_next(value: str | None, default: str) -> str:
    if value and value.startswith("/") and not value.startswith("//") and "\\" not in value:
        return value
    return default


def redirect(ctx: PageCtx | None, url: str, flashes: list[dict] | None = None, request: Request | None = None):
    response = RedirectResponse(url, status_code=303)
    request = request or ctx.request
    if flashes:
        response.set_cookie(auth.FLASH_COOKIE, request.app.state.sessions.dump_flash(flashes), max_age=600,
                            httponly=True, samesite="lax", path="/")
    return response


# --------------------------------------------------------------------------------------------------- dependencies
def page_ctx(request: Request, conn=Depends(get_conn)) -> PageCtx:
    state = request.app.state
    session = state.sessions.read(request.cookies.get(auth.SESSION_COOKIE))
    actor = auth.current_actor(conn, state.cfg, session)
    if actor is None:
        raise LoginRequired()
    return PageCtx(conn=conn, actor=actor, cfg=state.cfg, request=request, session=session)


async def form_body(request: Request, ctx: PageCtx = Depends(page_ctx)) -> dict:
    form = await request.form()
    data = {}
    for key, value in form.multi_items():
        if isinstance(value, str):
            data[key] = value
    if not auth.csrf_ok((ctx.session or {}).get("csrf"), data.get("csrf")):
        raise Forbidden("This form has expired. Reload the page and try again.")
    return data


def page(fn):
    """Render service errors (404, 403, ...) as pages with the full header while the connection is still open."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ServiceError as exc:
            ctx = kwargs.get("ctx")
            if not isinstance(ctx, PageCtx):
                raise
            return render_error(ctx, exc)

    return wrapper


# --------------------------------------------------------------------------------------------------- sign-in
@router.get("/login")
def login_page(request: Request, next: str | None = None):
    state = request.app.state
    session = state.sessions.read(request.cookies.get(auth.SESSION_COOKIE))
    if session:
        with state.pool.connection() as conn:
            if auth.current_actor(conn, state.cfg, session):
                return RedirectResponse(safe_next(next, "/"), status_code=303)
    return render_public(request, "login.html", next=safe_next(next, ""), error=None, user_name="")


@router.post("/login")
async def login_submit(request: Request):
    form = await request.form()
    user_name = str(form.get("user_name") or "")
    password = str(form.get("password") or "")
    target = safe_next(str(form.get("next") or ""), "/")
    state = request.app.state

    def check():
        with state.pool.connection() as conn:
            return auth.authenticate(conn, user_name, password)

    user = await run_in_threadpool(check)
    if user is None:
        return render_public(request, "login.html", status=401, next=target if target != "/" else "",
                             error="That user name and password don't match an active account.",
                             user_name=user_name)
    token, _ = state.sessions.issue(user["id"])
    response = RedirectResponse(target, status_code=303)
    set_session_cookie(response, state, token)
    return response


@router.post("/logout")
async def logout_submit(request: Request):
    state = request.app.state
    session = state.sessions.read(request.cookies.get(auth.SESSION_COOKIE))

    def revoke():
        with state.pool.connection() as conn:
            auth.revoke_session(conn, session, state.sessions.max_age)

    if session:
        await run_in_threadpool(revoke)
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(auth.SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return response


# --------------------------------------------------------------------------------------------------- home & search
@router.get("/")
@page
def home(ctx: PageCtx = Depends(page_ctx)):
    actor = ctx.actor
    data = {"my_deals": [], "renewals": [], "tasks": [], "approvals": None, "mine": None, "team": None}
    if actor.can("deals", "list"):
        data["my_deals"] = deals.list_deals(ctx, owner="me", status="open", sort="close", per_page=8, related=True)
        data["mine"] = deals.pipeline(ctx, "mine")
        if actor.is_manager(ctx.rule):
            data["team"] = deals.pipeline(ctx, "team" if actor.team_ids else "all")
            data["approvals"] = deals.approvals(ctx, per_page=6)
    if actor.can("accounts", "list"):
        data["renewals"] = accounts.renewals(ctx, per_page=8, related=True)
    data["tasks"] = activities.list_tasks(ctx, owner="me", open=True, per_page=8, related=True)
    now = datetime.now(ctx.tz())
    data["greeting"] = "Good morning" if now.hour < 12 else ("Good afternoon" if now.hour < 18 else "Good evening")
    data["today_label"] = f"{now:%A} {now.day} {now:%B} {now.year}"
    data["kpis"] = _home_kpis(ctx, data)
    return render(ctx, "home.html", **data)


def _home_kpis(ctx: PageCtx, data: dict) -> list[dict]:
    kpis = []
    mine, team = data["mine"], data["team"]
    if mine is not None:
        kpis.append({"label": "My open pipeline", "icon": "trend", "value": formatting.usd0(mine["open_total_usd"]),
                     "sub": f"{formatting.plural(mine['open_count'], 'open deal')} · {formatting.usd_compact(mine['weighted_usd'])} weighted",
                     "href": "/pipeline?scope=mine"})
        if team is not None:
            kpis.append({"label": "Team pipeline", "icon": "layers", "value": formatting.usd0(team["open_total_usd"]),
                         "sub": f"{formatting.plural(team['open_count'], 'open deal')} across the team",
                         "href": "/pipeline?scope=team"})
        else:
            soon = [d for s in mine["stages"] if not (s["won"] or s["lost"]) for d in s["deals"]
                    if d["close_date"] is not None and 0 <= (formatting.days_from_today(d["close_date"]) or 0) <= 30]
            kpis.append({"label": "Closing in 30 days", "icon": "calendar",
                         "value": formatting.usd0(sum((d["amount_usd"] for d in soon), Decimal(0))),
                         "sub": formatting.plural(len(soon), "deal"), "href": "/deals?status=open"})
    if data["approvals"] is not None:
        waiting = data["approvals"]["total"]
        kpis.append({"label": "Approvals waiting", "icon": "shield", "value": str(waiting),
                     "sub": "need your decision" if waiting else "nothing waiting", "attention": waiting > 0,
                     "href": "/approvals"})
    if data["renewals"]:
        renewals = data["renewals"]
        first = renewals["items"][0] if renewals["items"] else None
        kpis.append({"label": f"Renewals · {ctx.cfg.renewal_window_days} days", "icon": "calendar",
                     "value": str(renewals["total"]),
                     "sub": f"next: {first['name']} {formatting.renewal_hint(first['contract_renewal_date']).replace('renews ', '')}" if first else "none coming up",
                     "href": "/accounts"})
    tasks = data["tasks"]
    overdue = sum(1 for t in tasks["items"] if t["is_overdue"])
    if len(kpis) < 4:
        kpis.append({"label": "My open tasks", "icon": "task", "value": str(tasks["total"]),
                     "sub": f"{overdue} overdue" if overdue else "none overdue", "attention": overdue > 0, "href": "#my-tasks"})
    return kpis[:4]


@router.get("/search")
@page
def search_page(q: str = "", ctx: PageCtx = Depends(page_ctx)):
    results = search_svc.search(ctx, q)
    total = sum(len(results[k]) for k in ("accounts", "contacts", "leads", "deals"))
    return render(ctx, "search.html", results=results, total=total, search_q=q)


# --------------------------------------------------------------------------------------------------- forms
FORMS = {
    "accounts": [
        ("name", "Account name", "text", {"span": 2, "required": True}),
        ("account_type", "Type", "choice:account_types", {}),
        ("industry", "Industry", "choice:industries", {}),
        ("phone", "Phone", "tel", {}),
        ("website", "Website", "text", {"placeholder": "www.example.com"}),
        ("billing_city", "City", "text", {}),
        ("billing_state", "State / region", "text", {}),
        ("billing_country", "Country", "text", {}),
        ("employees", "Employees", "text", {}),
        ("contract_renewal_date", "Contract renewal date", "date", {"custom": True}),
        ("owner_id", "Owner", "owner", {}),
        ("description", "Description", "textarea", {"span": 2}),
    ],
    "contacts": [
        ("first_name", "First name", "text", {}),
        ("last_name", "Last name", "text", {"required": True}),
        ("title", "Title", "text", {}),
        ("account_id", "Account", "account", {}),
        ("email", "E-mail", "email", {}),
        ("phone", "Phone", "tel", {}),
        ("city", "City", "text", {}),
        ("state", "State / region", "text", {}),
        ("lead_source", "Lead source", "choice:lead_sources", {}),
        ("owner_id", "Owner", "owner", {}),
        ("description", "Description", "textarea", {"span": 2}),
    ],
    "leads": [
        ("first_name", "First name", "text", {}),
        ("last_name", "Last name", "text", {"required": True}),
        ("company", "Company", "text", {}),
        ("title", "Title", "text", {}),
        ("email", "E-mail", "email", {}),
        ("phone", "Phone", "tel", {}),
        ("city", "City", "text", {}),
        ("status", "Status", "choice:lead_statuses", {"required": True}),
        ("lead_source", "Lead source", "choice:lead_sources", {}),
        ("owner_id", "Owner", "owner", {}),
        ("description", "Description", "textarea", {"span": 2}),
    ],
    "deals": [
        ("name", "Deal name", "text", {"span": 2, "required": True}),
        ("account_id", "Account", "account", {}),
        ("owner_id", "Owner", "owner", {}),
        ("amount", "Amount", "amount", {"required": True}),
        ("currency_code", "Currency", "currency", {"required": True}),
        ("stage", "Stage", "stage", {"required": True}),
        ("close_date", "Expected close date", "date", {}),
        ("probability", "Probability (%)", "number", {"min": 0, "max": 100, "placeholder": "Follows the stage"}),
        ("lead_source", "Lead source", "choice:lead_sources", {}),
        ("next_step", "Next step", "text", {"span": 2}),
        ("description", "Description", "textarea", {"span": 2}),
    ],
}
SINGULAR_LABEL = {"accounts": "account", "contacts": "contact", "leads": "lead", "deals": "deal"}


def _value_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, Decimal):
        text = format(value.normalize(), "f")
        if "." in text:
            whole, frac = text.split(".")
            text = whole + "." + (frac + "00")[:max(2, len(frac))]
        return text
    if isinstance(value, (date, datetime)):
        return formatting.date_input(value)
    return str(value)


def build_fields(ctx: PageCtx, entity: str, values: dict, errors: dict, *, creating: bool) -> list[dict]:
    cfg = ctx.cfg
    fields = []
    owners = accounts_list = None
    for name, label, kind, opts in FORMS[entity]:
        if opts.get("custom"):
            label = cfg.field_label(entity, name, label)
        current = _value_text(values.get(name))
        field = {"name": name, "label": label, "kind": kind, "value": current, "error": errors.get(name),
                 "required": opts.get("required", False), "span": opts.get("span", 1),
                 "placeholder": opts.get("placeholder", ""), "min": opts.get("min"), "max": opts.get("max"),
                 "options": None}
        options = None
        if kind.startswith("choice:"):
            options = cfg.options(kind.split(":", 1)[1])
        elif kind == "owner":
            owners = owners or search_svc.active_users(ctx)
            options = [(u["id"], u["name"]) for u in owners]
        elif kind == "account":
            accounts_list = accounts_list or search_svc.account_choices(ctx)
            options = [(a["id"], a["name"] + (f" · {a['billing_city']}" if a["billing_city"] else ""))
                       for a in accounts_list]
        elif kind == "stage":
            options = [(s.key, s.label) for s in cfg.stages]
        elif kind == "currency":
            options = [(c["code"], f"{c['code']} · {c['name']}") for c in ctx.currencies().values()]
        if options is not None:
            if current and current not in {k for k, _ in options}:
                options = [*options, (current, current)]  # a migrated value outside today's list stays selectable
            if not field["required"] and kind not in ("owner", "currency"):
                options = [("", "—"), *options]
            field["options"] = options
            field["kind"] = "select"
        fields.append(field)
    return fields


def form_data(entity: str, form: dict) -> dict:
    return {name: form[name] for name, *_ in FORMS[entity] if name in form}


def render_form(ctx: PageCtx, entity: str, *, record: dict | None, values: dict, errors: dict | None = None,
                error: str | None = None, status: int = 200, cancel: str):
    creating = record is None
    title = f"New {SINGULAR_LABEL[entity]}" if creating else f"Edit {record.get('name') or SINGULAR_LABEL[entity]}"
    return render(ctx, "record_form.html", status=status, entity=entity, record=record, title=title,
                  fields=build_fields(ctx, entity, values, errors or {}, creating=creating), error=error,
                  action=f"/{entity}/new" if creating else f"/{entity}/{record['id']}/edit", cancel=cancel,
                  request_key=str(uuid.uuid4()), singular=SINGULAR_LABEL[entity])


CREATE = {"accounts": accounts.create_account, "contacts": contacts.create_contact, "leads": leads.create_lead,
          "deals": deals.create_deal}
UPDATE = {"accounts": accounts.update_account, "contacts": contacts.update_contact, "leads": leads.update_lead,
          "deals": deals.update_deal}
DELETE = {"accounts": accounts.delete_account, "contacts": contacts.delete_contact, "leads": leads.delete_lead,
          "deals": deals.delete_deal}
ROW = {"accounts": lambda ctx, i: accounts.get_account(ctx, i)["account"],
       "contacts": lambda ctx, i: contacts.get_contact(ctx, i)["contact"],
       "leads": lambda ctx, i: leads.get_lead(ctx, i)["lead"],
       "deals": lambda ctx, i: deals.get_deal(ctx, i)["deal"]}


def _rule_flashes(result: dict, deal_name: str | None = None) -> list[dict]:
    flashes = []
    for event in result.get("rule_events", []):
        level = {"blocked": "blocked", "withdrawn": "warning", "not_manager": "error"}.get(event["code"], "warning")
        flashes.append({"level": level, "code": event["code"], "text": event["message"],
                        "deal_id": result.get("id") if event["code"] == "blocked" else None,
                        "deal_name": deal_name})
    return flashes


def _new_page(entity: str):
    def handler(account_id: str | None = None, ctx: PageCtx = Depends(page_ctx)):
        if not ctx.actor.can(entity, "edit"):
            raise Forbidden(f"You are not allowed to create {entity}.")
        values = {"owner_id": ctx.actor.id}
        if entity == "deals":
            values.update(stage=ctx.cfg.stages[0].key, currency_code="USD")
        if entity == "leads":
            values["status"] = ctx.cfg.first_key("lead_statuses", "New")
        if account_id and entity in ("deals", "contacts"):
            values["account_id"] = account_id
        return render_form(ctx, entity, record=None, values=values, cancel=f"/{entity}" if entity != "deals" else "/pipeline")

    handler.__name__ = f"new_{entity}_page"
    return page(handler)


def _create_submit(entity: str):
    def handler(ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
        data = form_data(entity, form)
        try:
            result, _ = idempotent_create(ctx, f"page-{entity}", form.get("request_key"),
                                          lambda: CREATE[entity](ctx, data))
        except (Invalid, NotFound) as exc:
            return render_form(ctx, entity, record=None, values=form, errors=exc.fields, error=exc.detail, status=422,
                               cancel=f"/{entity}")
        flashes = [{"level": "success", "text": f"{SINGULAR_LABEL[entity].capitalize()} created."}]
        if entity == "deals":
            flashes = _rule_flashes(result, result["deal"]["name"]) or flashes
        return redirect(ctx, f"/{entity}/{result['id']}", flashes)

    handler.__name__ = f"create_{entity}_submit"
    return page(handler)


def _edit_page(entity: str):
    def handler(record_id: str, ctx: PageCtx = Depends(page_ctx)):
        record = ROW[entity](ctx, record_id)
        detail_perm = _permissions(ctx, entity, record_id)
        if not detail_perm["edit"]:
            raise Forbidden(f"You can view this {SINGULAR_LABEL[entity]} but you are not allowed to change it.")
        return render_form(ctx, entity, record=record, values=record, cancel=f"/{entity}/{record_id}")

    handler.__name__ = f"edit_{entity}_page"
    return page(handler)


def _permissions(ctx: PageCtx, entity: str, record_id: str) -> dict:
    from .services.base import fetch_visible

    row = fetch_visible(ctx, entity, record_id)
    return {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])}


def _edit_submit(entity: str):
    def handler(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
        data = form_data(entity, form)
        try:
            result = UPDATE[entity](ctx, record_id, data)
        except (Invalid, NotFound) as exc:
            if isinstance(exc, NotFound) and not exc.fields:
                raise
            record = ROW[entity](ctx, record_id)
            return render_form(ctx, entity, record=record, values=form, errors=exc.fields, error=exc.detail,
                               status=422, cancel=f"/{entity}/{record_id}")
        flashes = [{"level": "success", "text": "Changes saved."}]
        if entity == "deals":
            flashes = _rule_flashes(result, result["deal"]["name"]) or flashes
        return redirect(ctx, f"/{entity}/{record_id}", flashes)

    handler.__name__ = f"edit_{entity}_submit"
    return page(handler)


def _delete_submit(entity: str):
    def handler(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
        record = ROW[entity](ctx, record_id)
        DELETE[entity](ctx, record_id)
        name = record.get("name") or SINGULAR_LABEL[entity]
        target = "/pipeline" if entity == "deals" else f"/{entity}"
        return redirect(ctx, target, [{"level": "success", "text": f"Deleted {name}."}])

    handler.__name__ = f"delete_{entity}_submit"
    return page(handler)


for _entity in ("accounts", "contacts", "leads", "deals"):
    router.add_api_route(f"/{_entity}/new", _new_page(_entity), methods=["GET"], response_class=HTMLResponse)
    router.add_api_route(f"/{_entity}/new", _create_submit(_entity), methods=["POST"], response_class=HTMLResponse)


# --------------------------------------------------------------------------------------------------- lists
def _pager(result: dict, base: str, params: dict) -> dict:
    page_no, per_page, total = result["page"], result["per_page"], result["total"]
    pages = max(1, -(-total // per_page))

    def link(n):
        q = {k: v for k, v in params.items() if v not in (None, "")}
        q["page"] = n
        return f"{base}?{urlencode(q)}"

    return {
        "page": page_no, "pages": pages, "total": total,
        "first": 0 if total == 0 else (page_no - 1) * per_page + 1,
        "last": min(page_no * per_page, total),
        "prev": link(page_no - 1) if page_no > 1 else None,
        "next": link(page_no + 1) if page_no < pages else None,
    }


@router.get("/accounts")
@page
def accounts_page(q: str = "", page: int = 1, owner: str = "", ctx: PageCtx = Depends(page_ctx)):
    result = accounts.list_accounts(ctx, q=q, page=page, per_page=PER_PAGE, owner=owner or None)
    return render(ctx, "accounts_list.html", result=result, q=q, owner=owner,
                  pager=_pager(result, "/accounts", {"q": q, "owner": owner}))


@router.get("/contacts")
@page
def contacts_page(q: str = "", page: int = 1, ctx: PageCtx = Depends(page_ctx)):
    result = contacts.list_contacts(ctx, q=q, page=page, per_page=PER_PAGE)
    return render(ctx, "contacts_list.html", result=result, q=q, pager=_pager(result, "/contacts", {"q": q}))


@router.get("/leads")
@page
def leads_page(q: str = "", page: int = 1, show: str = "open", ctx: PageCtx = Depends(page_ctx)):
    converted = None if show == "all" else (True if show == "converted" else False)
    result = leads.list_leads(ctx, q=q, page=page, per_page=PER_PAGE, converted=converted)
    return render(ctx, "leads_list.html", result=result, q=q, show=show,
                  pager=_pager(result, "/leads", {"q": q, "show": show}))


@router.get("/deals")
@page
def deals_page(q: str = "", page: int = 1, status: str = "open", ctx: PageCtx = Depends(page_ctx)):
    result = deals.list_deals(ctx, q=q, page=page, per_page=PER_PAGE, status=status if status != "all" else None,
                              sort="close" if status == "open" else "close_desc")
    return render(ctx, "deals_list.html", result=result, q=q, deal_status=status,
                  pager=_pager(result, "/deals", {"q": q, "status": status}))


# --------------------------------------------------------------------------------------------------- detail pages
@router.get("/accounts/{record_id}")
@page
def account_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    detail = accounts.get_account(ctx, record_id)
    return render(ctx, "account_detail.html", d=detail, a=detail["account"],
                  contact_options=[(c["id"], c["name"]) for c in detail["contacts"]],
                  parent=("account", record_id), request_key=str(uuid.uuid4()))


@router.get("/contacts/{record_id}")
@page
def contact_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    detail = contacts.get_contact(ctx, record_id)
    return render(ctx, "contact_detail.html", d=detail, c=detail["contact"], parent=("contact", record_id),
                  contact_options=[], request_key=str(uuid.uuid4()))


@router.get("/leads/{record_id}")
@page
def lead_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    detail = leads.get_lead(ctx, record_id)
    return render(ctx, "lead_detail.html", d=detail, lead=detail["lead"], parent=("lead", record_id),
                  contact_options=[], request_key=str(uuid.uuid4()))


@router.get("/deals/{record_id}")
@page
def deal_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    detail = deals.get_deal(ctx, record_id)
    contact_options = [(c["id"], c["name"]) for c in detail["contacts"]]
    return render(ctx, "deal_detail.html", d=detail, deal=detail["deal"], parent=("deal", record_id),
                  contact_options=contact_options, request_key=str(uuid.uuid4()))


for _entity in ("accounts", "contacts", "leads", "deals"):
    router.add_api_route(f"/{_entity}/{{record_id}}/edit", _edit_page(_entity), methods=["GET"],
                         response_class=HTMLResponse)
    router.add_api_route(f"/{_entity}/{{record_id}}/edit", _edit_submit(_entity), methods=["POST"],
                         response_class=HTMLResponse)
    router.add_api_route(f"/{_entity}/{{record_id}}/delete", _delete_submit(_entity), methods=["POST"],
                         response_class=HTMLResponse)


# --------------------------------------------------------------------------------------------------- deal actions
@router.post("/deals/{record_id}/stage")
@page
def deal_stage_submit(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    target = safe_next(form.get("next"), f"/deals/{record_id}")
    try:
        result = deals.update_deal(ctx, record_id, {"stage": form.get("stage")})
    except Invalid as exc:
        return redirect(ctx, target, [{"level": "error", "text": exc.detail}])
    name = result["deal"]["name"]
    flashes = _rule_flashes(result, name)
    if not result["blocked"]:
        flashes.insert(0, {"level": "success", "text": f"{name} moved to {ctx.cfg.stage_label(result['deal']['stage'])}."})
    return redirect(ctx, target, flashes)


@router.post("/deals/{record_id}/approval")
@page
def deal_approval_submit(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    target = safe_next(form.get("next"), f"/deals/{record_id}")
    decision = form.get("decision")
    try:
        result = deals.decide(ctx, record_id, decision)
    except (Forbidden, Invalid) as exc:
        return redirect(ctx, target, [{"level": "error", "text": exc.detail}])
    name = result["deal"]["name"]
    text = {"approved": f"Approved {name}.", "rejected": f"Rejected {name}.",
            "requested": f"Approval requested for {name}."}.get(decision, "Saved.")
    return redirect(ctx, target, [{"level": "success", "text": text}, *_rule_flashes(result, name)])


@router.get("/pipeline")
@page
def pipeline_page(scope: str = "", ctx: PageCtx = Depends(page_ctx)):
    default = "team" if ctx.actor.team_ids else "all"
    scope = scope if scope in deals.SCOPES else default
    data = deals.pipeline(ctx, scope)
    return render(ctx, "pipeline.html", p=data, scope=scope, stages=ctx.cfg.stages)


@router.get("/approvals")
@page
def approvals_page(ctx: PageCtx = Depends(page_ctx)):
    result = deals.approvals(ctx, per_page=100)
    return render(ctx, "approvals.html", result=result)


# --------------------------------------------------------------------------------------------------- notes & tasks
PARENT_PATHS = {"account": "/accounts/", "contact": "/contacts/", "deal": "/deals/", "lead": "/leads/"}


def _parent_url(form: dict) -> str:
    base = PARENT_PATHS.get(form.get("parent_type") or "", None)
    default = f"{base}{quote(form.get('parent_id') or '', safe='-_')}" if base else "/"
    return safe_next(form.get("next"), default)


@router.post("/notes")
@page
def note_submit(ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    data = {k: form.get(k) for k in ("subject", "body", "parent_type", "parent_id", "contact_id") if k in form}
    target = _parent_url(form)
    try:
        idempotent_create(ctx, "notes", form.get("request_key"), lambda: activities.create_note(ctx, data))
    except (Invalid, NotFound, Forbidden) as exc:
        return redirect(ctx, target + "#notes", [{"level": "error", "text": exc.detail}])
    return redirect(ctx, target + "#notes", [{"level": "success", "text": "Note added."}])


@router.post("/tasks")
@page
def task_submit(ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    data = {k: form.get(k) for k in ("subject", "due_at", "priority", "parent_type", "parent_id", "contact_id",
                                     "description") if k in form}
    target = _parent_url(form)
    try:
        idempotent_create(ctx, "tasks", form.get("request_key"), lambda: activities.create_task(ctx, data))
    except (Invalid, NotFound, Forbidden) as exc:
        return redirect(ctx, target + "#tasks", [{"level": "error", "text": exc.detail}])
    return redirect(ctx, target + "#tasks", [{"level": "success", "text": "Task added."}])


@router.post("/tasks/{record_id}/complete")
@page
def task_complete_submit(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    target = safe_next(form.get("next"), "/")
    try:
        activities.update_task(ctx, record_id, {"status": "Completed"})
    except (Invalid, Forbidden) as exc:
        return redirect(ctx, target, [{"level": "error", "text": exc.detail}])
    return redirect(ctx, target, [{"level": "success", "text": "Task completed."}])


# --------------------------------------------------------------------------------------------------- lead conversion
def _convert_form_values(state: dict, form: dict | None = None) -> dict:
    lead = state["lead"]
    suggested = state["suggested_account"]
    company = (lead["company"] or "").strip()
    values = {
        "account_choice": f"existing:{suggested['id']}" if suggested["mode"] == "existing" else "new",
        "new_account_name": " ".join(company.split()),
        "create_deal": "",
        "deal_name": f"{' '.join(company.split()) or lead['name']} – new business",
        "deal_amount": "", "deal_currency": "USD", "deal_stage": "", "deal_close_date": "",
    }
    if form:
        values.update({k: form.get(k, "") for k in values})
    return values


def _render_convert(ctx: PageCtx, record_id: str, *, form: dict | None = None, error: str | None = None,
                    status: int = 200):
    state = conversion_state(ctx, record_id)
    if state["already_converted"]:
        return _render_converted(ctx, record_id, state, fresh=False)
    if not state["permissions"]["convert"]:
        raise Forbidden("You can view this lead but you are not allowed to convert it.")
    return render(ctx, "lead_convert.html", status=status, state=state, lead=state["lead"],
                  values=_convert_form_values(state, form), error=error,
                  request_key=(form or {}).get("request_key") or str(uuid.uuid4()),
                  open_stages=[s for s in ctx.cfg.stages])


def _render_converted(ctx: PageCtx, record_id: str, state: dict, *, fresh: bool):
    result = state["result"]
    linked = {"contact": None, "account": None, "deal": None}
    if result:
        for key, fetch in (("contact", contacts.contact_row), ("account", accounts.account_row),
                           ("deal", deals.deal_row)):
            record_id_ = result.get(f"{key}_id")
            if record_id_:
                entity = {"contact": "contacts", "account": "accounts", "deal": "deals"}[key]
                from .services.base import visible_exists

                if visible_exists(ctx, entity, record_id_):
                    linked[key] = fetch(ctx, record_id_)
    return render(ctx, "lead_converted.html", state=state, lead=state["lead"], result=result, linked=linked,
                  fresh=fresh)


@router.get("/leads/{record_id}/convert")
@page
def convert_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    return _render_convert(ctx, record_id)


@router.post("/leads/{record_id}/convert")
@page
def convert_submit(record_id: str, ctx: PageCtx = Depends(page_ctx), form: dict = Depends(form_body)):
    choice = form.get("account_choice") or ""
    if choice.startswith("existing:"):
        account = {"mode": "existing", "id": choice.split(":", 1)[1]}
    elif choice == "new":
        account = {"mode": "new", "name": form.get("new_account_name", "")}
    else:
        account = None
    body = {"request_key": form.get("request_key"), "account": account,
            "create_deal": form.get("create_deal") in ("on", "true", "1")}
    if body["create_deal"]:
        body["deal"] = {"name": form.get("deal_name"), "amount": form.get("deal_amount"),
                        "currency_code": form.get("deal_currency") or "USD",
                        "stage": form.get("deal_stage") or None, "close_date": form.get("deal_close_date") or None}
        body["deal"] = {k: v for k, v in body["deal"].items() if v is not None}
    try:
        status, result = convert_lead(ctx, record_id, body)
    except (Invalid, NotFound) as exc:
        if isinstance(exc, NotFound) and exc.detail.startswith("Lead"):
            raise
        return _render_convert(ctx, record_id, form=form, error=exc.detail, status=422)
    flashes = []
    for event in result.get("rule_events", []):
        flashes.append({"level": "blocked" if event["code"] == "blocked" else "warning", "text": event["message"],
                        "code": event["code"]})
    return redirect(ctx, f"/leads/{record_id}/converted", flashes)


@router.get("/leads/{record_id}/converted")
@page
def converted_page(record_id: str, ctx: PageCtx = Depends(page_ctx)):
    state = conversion_state(ctx, record_id)
    if not state["already_converted"]:
        return redirect(ctx, f"/leads/{record_id}/convert")
    return _render_converted(ctx, record_id, state, fresh=True)
