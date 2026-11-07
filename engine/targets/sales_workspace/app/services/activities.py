"""Notes and tasks. Both hang off a parent record (account, contact, deal or lead) the user must be able to view;
new ones inherit the parent's teams (``config.access.inherit_parent``)."""
from __future__ import annotations

from .. import db
from ..access import PARENT_TYPES, Actor, clause
from .base import (
    Ctx, Invalid, check_parent, fetch_for_edit, fetch_visible, insert_record, like, record_teams, require_create,
    require_list, run_list, soft_delete, team_names_sql, user_brief, user_name_sql, validate, write_update,
)


def parent_name_sql(actor: Actor, alias: str) -> str:
    """The parent's display name, only when the actor may view the parent."""
    return f"""CASE {alias}.parent_type
        WHEN 'account' THEN (SELECT pa.name FROM accounts pa
                             WHERE pa.id = {alias}.parent_id AND {clause(actor, 'accounts', 'view', 'pa')})
        WHEN 'contact' THEN (SELECT concat_ws(' ', pc.first_name, pc.last_name) FROM contacts pc
                             WHERE pc.id = {alias}.parent_id AND {clause(actor, 'contacts', 'view', 'pc')})
        WHEN 'deal' THEN (SELECT pd.name FROM deals pd
                          WHERE pd.id = {alias}.parent_id AND {clause(actor, 'deals', 'view', 'pd')})
        WHEN 'lead' THEN (SELECT concat_ws(' ', pl.first_name, pl.last_name) FROM leads pl
                          WHERE pl.id = {alias}.parent_id AND {clause(actor, 'leads', 'view', 'pl')})
    END"""


def _parent_filter(ctx: Ctx, where: list[str], params: dict, alias: str, parent: tuple[str, str] | None) -> None:
    """Only the notes/tasks of a parent the user can view (a parent they cannot view finds nothing)."""
    if parent:
        parent_type, parent_id = parent
        if parent_type not in PARENT_TYPES:
            raise Invalid(f"parent_type must be one of: {', '.join(PARENT_TYPES)}.")
        entity = PARENT_TYPES[parent_type]
        where.append(f"{alias}.parent_type = %(parent_type)s AND {alias}.parent_id = %(parent_id)s "
                     f"AND EXISTS (SELECT 1 FROM {entity} fp WHERE fp.id = %(parent_id)s "
                     f"AND {clause(ctx.actor, entity, 'view', 'fp')})")
        params["parent_type"], params["parent_id"] = parent_type, parent_id


# --------------------------------------------------------------------------------------------------- notes
def _note_select(ctx: Ctx) -> str:
    return f"""
        n.id, n.subject, n.body, n.parent_type, n.parent_id, n.contact_id, n.owner_id, n.created_by,
        n.created_at, n.updated_at, n.source,
        {user_name_sql('uo')} AS owner_name,
        COALESCE({user_name_sql('uc')}, {user_name_sql('uo')}) AS author_name,
        CASE WHEN c.id IS NOT NULL THEN concat_ws(' ', c.first_name, c.last_name) END AS contact_name,
        {parent_name_sql(ctx.actor, 'n')} AS parent_name,
        {team_names_sql('notes', 'n')} AS team_names
    """


def _note_from(ctx: Ctx) -> str:
    return (
        "notes n LEFT JOIN users uo ON uo.id = n.owner_id LEFT JOIN users uc ON uc.id = n.created_by "
        f"LEFT JOIN contacts c ON c.id = n.contact_id AND {clause(ctx.actor, 'contacts', 'view', 'c')}"
    )


def _out(row: dict) -> dict:
    item = dict(row)
    item["team_names"] = item.get("team_names") or []
    return item


def list_notes(ctx: Ctx, q: str = "", page=1, per_page=None, parent: tuple[str, str] | None = None,
               contact_id: str | None = None, owner: str | None = None, related: bool = False) -> dict:
    if not related:
        require_list(ctx, "notes")
    where = [clause(ctx.actor, "notes", "list", "n")]
    params = ctx.p()
    q = (q or "").strip()
    if q:
        where.append("(n.subject ILIKE %(q)s OR n.body ILIKE %(q)s)")
        params["q"] = like(q)
    _parent_filter(ctx, where, params, "n", parent)
    if contact_id:
        where.append("n.contact_id = %(contact_id)s AND EXISTS (SELECT 1 FROM contacts fc WHERE fc.id = %(contact_id)s "
                     f"AND {clause(ctx.actor, 'contacts', 'view', 'fc')})")
        params["contact_id"] = contact_id
    if owner == "me":
        where.append("n.owner_id = %(actor_id)s")
    result = run_list(ctx, select=_note_select(ctx), from_=_note_from(ctx), where=where, params=params,
                      order="n.created_at DESC, n.id", page=page, per_page=per_page)
    result["items"] = [_out(r) for r in result["items"]]
    return result


def note_row(ctx: Ctx, note_id: str) -> dict | None:
    row = db.fetch_one(ctx.conn, f"SELECT {_note_select(ctx)} FROM {_note_from(ctx)} WHERE n.id = %(id)s",
                       ctx.p(id=note_id))
    return _out(row) if row else None


def get_note(ctx: Ctx, note_id: str) -> dict:
    row = fetch_visible(ctx, "notes", note_id)
    note = note_row(ctx, note_id)
    return {
        "note": note,
        "parent": {"type": note["parent_type"], "id": note["parent_id"], "name": note["parent_name"]},
        "contact": {"id": note["contact_id"], "name": note["contact_name"]} if note["contact_name"] else None,
        "teams": record_teams(ctx.conn, "notes", note_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
    }


def create_note(ctx: Ctx, data: dict) -> dict:
    require_create(ctx, "notes")
    with ctx.conn.transaction():
        values = validate(ctx, "notes", data)
        parent = check_parent(ctx, values.get("parent_type"), values.get("parent_id"), required=True)
        note_id = insert_record(ctx, "notes", values, parent=parent)
    return {"id": note_id, "note": note_row(ctx, note_id)}


def _changed_parent(ctx: Ctx, before: dict, changes: dict, required: bool) -> None:
    new_type = changes.get("parent_type", before["parent_type"])
    new_id = changes.get("parent_id", before["parent_id"])
    if (new_type, new_id) != (before["parent_type"], before["parent_id"]):
        check_parent(ctx, new_type, new_id, required)


def update_note(ctx: Ctx, note_id: str, data: dict) -> dict:
    with ctx.conn.transaction():
        before = fetch_for_edit(ctx, "notes", note_id)
        changes = validate(ctx, "notes", data, before)
        _changed_parent(ctx, before, changes, required=True)
        changed = write_update(ctx, "notes", before, changes)
    return {"note": note_row(ctx, note_id), "changed": sorted(changed)}


def delete_note(ctx: Ctx, note_id: str) -> dict:
    return soft_delete(ctx, "notes", note_id)


# --------------------------------------------------------------------------------------------------- tasks
def _task_select(ctx: Ctx) -> str:
    return f"""
        t.id, t.subject, t.status, t.priority, t.due_at, t.parent_type, t.parent_id, t.contact_id, t.description,
        t.owner_id, t.created_by, t.created_at, t.updated_at, t.source,
        (t.status <> ALL(%(closed_task_statuses)s::text[])) AS is_open,
        (t.due_at < now() AND t.status <> ALL(%(closed_task_statuses)s::text[])) AS is_overdue,
        {user_name_sql('uo')} AS owner_name,
        CASE WHEN c.id IS NOT NULL THEN concat_ws(' ', c.first_name, c.last_name) END AS contact_name,
        {parent_name_sql(ctx.actor, 't')} AS parent_name,
        {team_names_sql('tasks', 't')} AS team_names
    """


def _task_from(ctx: Ctx) -> str:
    return (
        "tasks t LEFT JOIN users uo ON uo.id = t.owner_id "
        f"LEFT JOIN contacts c ON c.id = t.contact_id AND {clause(ctx.actor, 'contacts', 'view', 'c')}"
    )


def list_tasks(ctx: Ctx, q: str = "", page=1, per_page=None, parent: tuple[str, str] | None = None,
               owner: str | None = None, open: bool | None = None, related: bool = False) -> dict:
    if not related:
        require_list(ctx, "tasks")
    where = [clause(ctx.actor, "tasks", "list", "t")]
    params = ctx.p(closed_task_statuses=sorted(ctx.cfg.closed_task_statuses))
    q = (q or "").strip()
    if q:
        where.append("(t.subject ILIKE %(q)s OR t.description ILIKE %(q)s)")
        params["q"] = like(q)
    _parent_filter(ctx, where, params, "t", parent)
    if owner == "me":
        where.append("t.owner_id = %(actor_id)s")
    if open is True:
        where.append("t.status <> ALL(%(closed_task_statuses)s::text[])")
    elif open is False:
        where.append("t.status = ANY(%(closed_task_statuses)s::text[])")
    result = run_list(
        ctx, select=_task_select(ctx), from_=_task_from(ctx), where=where, params=params,
        order="(t.status = ANY(%(closed_task_statuses)s::text[])), t.due_at NULLS LAST, t.created_at DESC, t.id",
        page=page, per_page=per_page,
    )
    result["items"] = [_out(r) for r in result["items"]]
    return result


def task_row(ctx: Ctx, task_id: str) -> dict | None:
    row = db.fetch_one(
        ctx.conn, f"SELECT {_task_select(ctx)} FROM {_task_from(ctx)} WHERE t.id = %(id)s",
        ctx.p(id=task_id, closed_task_statuses=sorted(ctx.cfg.closed_task_statuses)),
    )
    return _out(row) if row else None


def get_task(ctx: Ctx, task_id: str) -> dict:
    row = fetch_visible(ctx, "tasks", task_id)
    task = task_row(ctx, task_id)
    parent = None
    if task["parent_type"]:
        parent = {"type": task["parent_type"], "id": task["parent_id"], "name": task["parent_name"]}
    return {
        "task": task,
        "parent": parent,
        "contact": {"id": task["contact_id"], "name": task["contact_name"]} if task["contact_name"] else None,
        "teams": record_teams(ctx.conn, "tasks", task_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
    }


def create_task(ctx: Ctx, data: dict) -> dict:
    require_create(ctx, "tasks")
    data = dict(data)
    if not data.get("status"):
        data["status"] = ctx.cfg.first_key("task_statuses", "Not Started")
    with ctx.conn.transaction():
        values = validate(ctx, "tasks", data)
        parent = check_parent(ctx, values.get("parent_type"), values.get("parent_id"), required=False)
        task_id = insert_record(ctx, "tasks", values, parent=parent)
    return {"id": task_id, "task": task_row(ctx, task_id)}


def update_task(ctx: Ctx, task_id: str, data: dict) -> dict:
    with ctx.conn.transaction():
        before = fetch_for_edit(ctx, "tasks", task_id)
        changes = validate(ctx, "tasks", data, before)
        _changed_parent(ctx, before, changes, required=False)
        changed = write_update(ctx, "tasks", before, changes)
    return {"task": task_row(ctx, task_id), "changed": sorted(changed)}


def delete_task(ctx: Ctx, task_id: str) -> dict:
    return soft_delete(ctx, "tasks", task_id)
