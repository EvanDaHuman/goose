"""Global search and small lookups shared by the API and the pages."""
from __future__ import annotations

from .. import db
from . import accounts, contacts, deals, leads
from .base import Ctx, user_name_sql

SEARCH_LIMIT = 10


def search(ctx: Ctx, q: str) -> dict:
    """Up to 10 accounts, contacts, leads and deals matching ``q`` (name, company, e-mail, city), each filtered by
    its own list rule. Entities the user cannot list come back empty."""
    q = (q or "").strip()
    out = {"q": q, "accounts": [], "contacts": [], "leads": [], "deals": []}
    if not q:
        return out
    if ctx.actor.can("accounts", "list"):
        out["accounts"] = accounts.list_accounts(ctx, q=q, per_page=SEARCH_LIMIT, related=True)["items"]
    if ctx.actor.can("contacts", "list"):
        out["contacts"] = contacts.list_contacts(ctx, q=q, per_page=SEARCH_LIMIT, related=True)["items"]
    if ctx.actor.can("leads", "list"):
        out["leads"] = leads.list_leads(ctx, q=q, per_page=SEARCH_LIMIT, related=True)["items"]
    if ctx.actor.can("deals", "list"):
        out["deals"] = deals.list_deals(ctx, q=q, per_page=SEARCH_LIMIT, related=True, sort="updated")["items"]
    return out


def active_users(ctx: Ctx) -> list[dict]:
    """Users a record can be assigned to."""
    return db.fetch_all(
        ctx.conn,
        f"SELECT u.id, u.user_name, {user_name_sql('u')} AS name, u.title FROM users u WHERE u.status = 'active' "
        f"ORDER BY lower({user_name_sql('u')})",
    )


def account_choices(ctx: Ctx, limit: int = 1000) -> list[dict]:
    """Accounts the user may list, for pickers."""
    from ..access import clause

    return db.fetch_all(
        ctx.conn,
        f"SELECT a.id, a.name, a.billing_city FROM accounts a WHERE {clause(ctx.actor, 'accounts', 'list', 'a')} "
        "ORDER BY lower(a.name), a.id LIMIT %(limit)s",
        ctx.p(limit=limit),
    )


def contact_choices(ctx: Ctx, account_id: str | None = None, limit: int = 500) -> list[dict]:
    from ..access import clause

    params = ctx.p(limit=limit)
    extra = ""
    if account_id:
        extra = " AND c.account_id = %(account_id)s"
        params["account_id"] = account_id
    return db.fetch_all(
        ctx.conn,
        "SELECT c.id, concat_ws(' ', c.first_name, c.last_name) AS name FROM contacts c "
        f"WHERE {clause(ctx.actor, 'contacts', 'list', 'c')}{extra} "
        "ORDER BY lower(c.last_name), lower(COALESCE(c.first_name, '')) LIMIT %(limit)s",
        params,
    )
