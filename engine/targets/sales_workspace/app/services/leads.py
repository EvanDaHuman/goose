"""Leads: list, detail (with the conversion state), create, update, delete."""
from __future__ import annotations

from .. import db
from ..access import clause
from . import activities
from .base import (
    Ctx, fetch_for_edit, fetch_visible, insert_record, like, person_name, record_teams, require_create, require_list,
    run_list, soft_delete, team_names_sql, user_brief, user_name_sql, validate, write_update,
)


def _select() -> str:
    return f"""
        l.id, l.first_name, l.last_name, l.company, l.title, l.email, l.phone, l.city, l.status, l.lead_source,
        l.description, l.converted, l.converted_contact_id, l.converted_account_id, l.converted_deal_id,
        l.owner_id, l.created_by, l.created_at, l.updated_at, l.source,
        {user_name_sql('u')} AS owner_name,
        {team_names_sql('leads', 'l')} AS team_names
    """


FROM = "leads l LEFT JOIN users u ON u.id = l.owner_id"


def _out(row: dict) -> dict:
    item = dict(row)
    item["name"] = person_name(item["first_name"], item["last_name"])
    item["team_names"] = item.get("team_names") or []
    return item


def list_leads(ctx: Ctx, q: str = "", page=1, per_page=None, status: str | None = None,
               converted: bool | None = None, owner: str | None = None, related: bool = False) -> dict:
    if not related:
        require_list(ctx, "leads")
    where = [clause(ctx.actor, "leads", "list", "l")]
    params = ctx.p()
    q = (q or "").strip()
    if q:
        where.append(
            "(concat_ws(' ', l.first_name, l.last_name) ILIKE %(q)s OR l.company ILIKE %(q)s "
            "OR l.email ILIKE %(q)s OR l.city ILIKE %(q)s)"
        )
        params["q"] = like(q)
    if status:
        where.append("l.status = %(status)s")
        params["status"] = status
    if converted is not None:
        where.append("l.converted = %(converted)s")
        params["converted"] = bool(converted)
    if owner == "me":
        where.append("l.owner_id = %(actor_id)s")
    result = run_list(ctx, select=_select(), from_=FROM, where=where, params=params,
                      order="l.converted, l.created_at DESC, l.id", page=page, per_page=per_page)
    result["items"] = [_out(r) for r in result["items"]]
    return result


def lead_row(ctx: Ctx, lead_id: str) -> dict | None:
    row = db.fetch_one(ctx.conn, f"SELECT {_select()} FROM {FROM} WHERE l.id = %(id)s", ctx.p(id=lead_id))
    return _out(row) if row else None


def get_lead(ctx: Ctx, lead_id: str) -> dict:
    from ..convert import stored_result

    row = fetch_visible(ctx, "leads", lead_id)
    lead = lead_row(ctx, lead_id)
    result = stored_result(ctx, row)
    can_convert = (
        bool(row["_can_edit"]) and ctx.actor.can("contacts", "edit") and result is None
    )
    return {
        "lead": lead,
        "notes": activities.list_notes(ctx, parent=("lead", lead_id), per_page=100, related=True)["items"],
        "tasks": activities.list_tasks(ctx, parent=("lead", lead_id), per_page=100, related=True)["items"],
        "conversion": {"already_converted": result is not None, "result": result, "can_convert": can_convert},
        "teams": record_teams(ctx.conn, "leads", lead_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
        "source_url": ctx.cfg.record_url("Leads", lead_id) if row["source"] == "suitecrm" else None,
    }


def create_lead(ctx: Ctx, data: dict) -> dict:
    require_create(ctx, "leads")
    data = dict(data)
    if not data.get("status"):
        data["status"] = ctx.cfg.first_key("lead_statuses", "New")
    with ctx.conn.transaction():
        values = validate(ctx, "leads", data)
        lead_id = insert_record(ctx, "leads", values)
    return {"id": lead_id, "lead": lead_row(ctx, lead_id)}


def update_lead(ctx: Ctx, lead_id: str, data: dict) -> dict:
    with ctx.conn.transaction():
        before = fetch_for_edit(ctx, "leads", lead_id)
        changes = validate(ctx, "leads", data, before)
        changed = write_update(ctx, "leads", before, changes)
    return {"lead": lead_row(ctx, lead_id), "changed": sorted(changed)}


def delete_lead(ctx: Ctx, lead_id: str) -> dict:
    return soft_delete(ctx, "leads", lead_id)
