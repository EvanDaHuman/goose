"""Contacts: list, detail, create, update, delete."""
from __future__ import annotations

from .. import db
from ..access import clause
from . import activities, deals
from .base import (
    Ctx, fetch_for_edit, fetch_visible, insert_record, like, person_name, record_teams, require_create, require_list,
    run_list, soft_delete, team_names_sql, user_brief, user_name_sql, validate, write_update,
)


def _select() -> str:
    return f"""
        c.id, c.first_name, c.last_name, c.title, c.email, c.phone, c.city, c.state, c.lead_source, c.description,
        c.account_id, c.owner_id, c.created_by, c.created_at, c.updated_at, c.source,
        {user_name_sql('u')} AS owner_name, a.name AS account_name,
        {team_names_sql('contacts', 'c')} AS team_names
    """


def _from(ctx: Ctx) -> str:
    return (
        "contacts c LEFT JOIN users u ON u.id = c.owner_id "
        f"LEFT JOIN accounts a ON a.id = c.account_id AND {clause(ctx.actor, 'accounts', 'view', 'a')}"
    )


def _out(row: dict) -> dict:
    item = dict(row)
    item["name"] = person_name(item["first_name"], item["last_name"])
    item["team_names"] = item.get("team_names") or []
    return item


def list_contacts(ctx: Ctx, q: str = "", page=1, per_page=None, account_id: str | None = None,
                  owner: str | None = None, related: bool = False) -> dict:
    if not related:
        require_list(ctx, "contacts")
    where = [clause(ctx.actor, "contacts", "list", "c")]
    params = ctx.p()
    q = (q or "").strip()
    if q:
        where.append(
            "(concat_ws(' ', c.first_name, c.last_name) ILIKE %(q)s OR c.email ILIKE %(q)s OR c.city ILIKE %(q)s "
            "OR a.name ILIKE %(q)s)"
        )
        params["q"] = like(q)
    if account_id:  # filtering by an account the user cannot view finds nothing (never reveal it)
        where.append("c.account_id = %(account_id)s AND EXISTS (SELECT 1 FROM accounts fa WHERE fa.id = %(account_id)s "
                     f"AND {clause(ctx.actor, 'accounts', 'view', 'fa')})")
        params["account_id"] = account_id
    if owner == "me":
        where.append("c.owner_id = %(actor_id)s")
    result = run_list(ctx, select=_select(), from_=_from(ctx), where=where, params=params,
                      order="lower(c.last_name), lower(COALESCE(c.first_name, '')), c.id", page=page, per_page=per_page)
    result["items"] = [_out(r) for r in result["items"]]
    return result


def contact_row(ctx: Ctx, contact_id: str) -> dict | None:
    row = db.fetch_one(ctx.conn, f"SELECT {_select()} FROM {_from(ctx)} WHERE c.id = %(id)s", ctx.p(id=contact_id))
    return _out(row) if row else None


def deal_contacts(ctx: Ctx, deal_id: str) -> list[dict]:
    """The contacts of a deal with their roles (the contacts list rule applies)."""
    rows = db.fetch_all(
        ctx.conn,
        f"SELECT {_select()}, dc.role FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id "
        f"LEFT JOIN users u ON u.id = c.owner_id "
        f"LEFT JOIN accounts a ON a.id = c.account_id AND {clause(ctx.actor, 'accounts', 'view', 'a')} "
        f"WHERE dc.deal_id = %(deal_id)s AND {clause(ctx.actor, 'contacts', 'list', 'c')} "
        "ORDER BY lower(c.last_name), lower(COALESCE(c.first_name, ''))",
        ctx.p(deal_id=deal_id),
    )
    return [_out(r) for r in rows]


def get_contact(ctx: Ctx, contact_id: str) -> dict:
    from .accounts import account_row, external_links

    row = fetch_visible(ctx, "contacts", contact_id)
    contact = contact_row(ctx, contact_id)
    account = None
    if contact["account_id"] and contact["account_name"] is not None:
        account = account_row(ctx, contact["account_id"])
    return {
        "contact": contact,
        "account": account,
        "deals": deals.list_deals(ctx, contact_id=contact_id, per_page=100, related=True, sort="close_desc")["items"],
        "notes": activities.list_notes(ctx, parent=("contact", contact_id), per_page=100, related=True)["items"],
        "tasks": activities.list_tasks(ctx, parent=("contact", contact_id), per_page=100, related=True)["items"],
        "external_links": external_links(ctx, "contacts", contact_id),
        "teams": record_teams(ctx.conn, "contacts", contact_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
        "source_url": ctx.cfg.record_url("Contacts", contact_id) if row["source"] == "suitecrm" else None,
    }


def create_contact(ctx: Ctx, data: dict) -> dict:
    require_create(ctx, "contacts")
    with ctx.conn.transaction():
        values = validate(ctx, "contacts", data)
        contact_id = insert_record(ctx, "contacts", values)
    return {"id": contact_id, "contact": contact_row(ctx, contact_id)}


def update_contact(ctx: Ctx, contact_id: str, data: dict) -> dict:
    with ctx.conn.transaction():
        before = fetch_for_edit(ctx, "contacts", contact_id)
        changes = validate(ctx, "contacts", data, before)
        changed = write_update(ctx, "contacts", before, changes)
    return {"contact": contact_row(ctx, contact_id), "changed": sorted(changed)}


def delete_contact(ctx: Ctx, contact_id: str) -> dict:
    return soft_delete(ctx, "contacts", contact_id)
