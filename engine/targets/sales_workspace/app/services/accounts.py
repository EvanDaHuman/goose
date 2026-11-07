"""Accounts: list, detail (the customer's story), create, update, delete."""
from __future__ import annotations

from .. import db
from ..access import clause
from . import activities, contacts, deals
from .base import (
    Ctx, fetch_for_edit, fetch_visible, insert_record, like, record_teams, require_create, require_list, run_list,
    soft_delete, team_names_sql, user_brief, user_name_sql, validate, write_update,
)

EXTERNAL_ENTITY_NAMES = {
    "accounts": ["accounts", "account"],
    "contacts": ["contacts", "contact"],
    "leads": ["leads", "lead"],
    "deals": ["deals", "deal", "opportunities", "opportunity"],
}


def _select(ctx: Ctx) -> str:
    deal_list = clause(ctx.actor, "deals", "list", "d")
    return f"""
        a.id, a.name, a.account_type, a.industry, a.phone, a.website, a.billing_city, a.billing_state,
        a.billing_country, a.employees, a.description, a.contract_renewal_date, a.owner_id, a.created_by,
        a.created_at, a.updated_at, a.source,
        (a.contract_renewal_date - CURRENT_DATE) AS days_to_renewal,
        {user_name_sql('u')} AS owner_name,
        {team_names_sql('accounts', 'a')} AS team_names,
        (SELECT COALESCE(sum(d.amount_usd), 0) FROM deals d
          WHERE d.account_id = a.id AND d.stage <> ALL(%(closed_stages)s::text[]) AND {deal_list}) AS open_pipeline_usd,
        (SELECT count(*) FROM deals d
          WHERE d.account_id = a.id AND d.stage <> ALL(%(closed_stages)s::text[]) AND {deal_list}) AS open_deals
    """


FROM = "accounts a LEFT JOIN users u ON u.id = a.owner_id"


def _out(row: dict) -> dict:
    item = dict(row)
    item["team_names"] = item.get("team_names") or []
    item["open_deals"] = int(item.get("open_deals") or 0)
    return item


def list_accounts(ctx: Ctx, q: str = "", page=1, per_page=None, owner: str | None = None,
                  related: bool = False) -> dict:
    if not related:
        require_list(ctx, "accounts")
    where = [clause(ctx.actor, "accounts", "list", "a")]
    params = ctx.p(closed_stages=ctx.cfg.closed_stage_keys)
    q = (q or "").strip()
    if q:
        where.append("(a.name ILIKE %(q)s OR a.billing_city ILIKE %(q)s OR a.website ILIKE %(q)s)")
        params["q"] = like(q)
    if owner == "me":
        where.append("a.owner_id = %(actor_id)s")
    result = run_list(ctx, select=_select(ctx), from_=FROM, where=where, params=params,
                      order="lower(a.name), a.id", page=page, per_page=per_page)
    result["items"] = [_out(r) for r in result["items"]]
    return result


def account_row(ctx: Ctx, account_id: str) -> dict | None:
    """One account in list shape, without an access check (callers check first)."""
    row = db.fetch_one(
        ctx.conn, f"SELECT {_select(ctx)} FROM {FROM} WHERE a.id = %(id)s",
        ctx.p(closed_stages=ctx.cfg.closed_stage_keys, id=account_id),
    )
    return _out(row) if row else None


def external_links(ctx: Ctx, entity: str, record_id: str) -> list[dict]:
    return db.fetch_all(
        ctx.conn,
        "SELECT system, kind, count, url FROM external_links WHERE lower(entity) = ANY(%s::text[]) AND record_id = %s "
        "ORDER BY kind",
        (EXTERNAL_ENTITY_NAMES[entity], record_id),
    )


def get_account(ctx: Ctx, account_id: str) -> dict:
    row = fetch_visible(ctx, "accounts", account_id)
    account = account_row(ctx, account_id)
    deal_items = deals.list_deals(ctx, account_id=account_id, per_page=100, related=True, sort="close_desc")["items"]
    won_keys = set(ctx.cfg.won_stage_keys)
    stats = {
        "open_pipeline_usd": account["open_pipeline_usd"],
        "open_deals": account["open_deals"],
        "won_usd": sum((d["amount_usd"] for d in deal_items if d["stage"] in won_keys), 0),
        "won_deals": sum(1 for d in deal_items if d["stage"] in won_keys),
    }
    task_items = activities.list_tasks(ctx, parent=("account", account_id), per_page=100, related=True)["items"]
    stats["open_tasks"] = sum(1 for t in task_items if t["is_open"])
    return {
        "account": account,
        "contacts": contacts.list_contacts(ctx, account_id=account_id, per_page=100, related=True)["items"],
        "deals": deal_items,
        "notes": activities.list_notes(ctx, parent=("account", account_id), per_page=100, related=True)["items"],
        "tasks": task_items,
        "external_links": external_links(ctx, "accounts", account_id),
        "teams": record_teams(ctx.conn, "accounts", account_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "stats": stats,
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
        "source_url": ctx.cfg.record_url("Accounts", account_id) if row["source"] == "suitecrm" else None,
    }


def create_account(ctx: Ctx, data: dict) -> dict:
    require_create(ctx, "accounts")
    with ctx.conn.transaction():
        values = validate(ctx, "accounts", data)
        account_id = insert_record(ctx, "accounts", values)
    return {"id": account_id, "account": account_row(ctx, account_id)}


def update_account(ctx: Ctx, account_id: str, data: dict) -> dict:
    with ctx.conn.transaction():
        before = fetch_for_edit(ctx, "accounts", account_id)
        changes = validate(ctx, "accounts", data, before)
        changed = write_update(ctx, "accounts", before, changes)
    return {"account": account_row(ctx, account_id), "changed": sorted(changed)}


def delete_account(ctx: Ctx, account_id: str) -> dict:
    return soft_delete(ctx, "accounts", account_id)


def renewals(ctx: Ctx, days=None, page=1, per_page=None, related: bool = False) -> dict:
    from .base import Invalid

    if not related:
        require_list(ctx, "accounts")
    try:
        days = ctx.cfg.renewal_window_days if days in (None, "") else int(days)
    except (TypeError, ValueError):
        raise Invalid("days must be a whole number.", {"days": "Whole number of days."})
    if not 0 <= days <= 3660:
        raise Invalid("days must be between 0 and 3660.", {"days": "Between 0 and 3660."})
    where = [
        clause(ctx.actor, "accounts", "list", "a"),
        "a.contract_renewal_date >= CURRENT_DATE",
        "a.contract_renewal_date <= CURRENT_DATE + %(days)s::int",
    ]
    result = run_list(
        ctx, select=_select(ctx), from_=FROM, where=where,
        params=ctx.p(closed_stages=ctx.cfg.closed_stage_keys, days=days),
        order="a.contract_renewal_date, lower(a.name), a.id", page=page, per_page=per_page,
    )
    result["items"] = [_out(r) for r in result["items"]]
    result["days"] = days
    return result
