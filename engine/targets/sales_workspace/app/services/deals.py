"""Deals: list, detail with the approval panel, writes through the approval rule, the pipeline and the
manager approval queue."""
from __future__ import annotations

from decimal import Decimal

from .. import db
from ..access import clause, team_manager_clause
from . import activities
from .base import (
    Ctx, Forbidden, Invalid, fetch_visible, like, record_teams, require_list, run_list, soft_delete, team_names_sql,
    user_brief, user_name_sql,
)

SORTS = {
    "close": "d.close_date NULLS LAST, lower(d.name), d.id",
    "close_desc": "d.close_date DESC NULLS LAST, lower(d.name), d.id",
    "amount": "d.amount_usd DESC, d.id",
    "updated": "d.updated_at DESC, d.id",
}
FIELD_LABELS = {
    "name": "Name", "account_id": "Account", "stage": "Stage", "probability": "Probability", "amount": "Amount",
    "currency_code": "Currency", "amount_usd": "Amount (USD)", "close_date": "Close date",
    "lead_source": "Lead source", "next_step": "Next step", "description": "Description",
    "approval_status": "Manager approval", "approved_by": "Approved by", "approved_amount_usd": "Approved amount (USD)",
    "approved_at": "Approved at", "owner_id": "Owner", "deleted_at": "Deleted",
}


def _select(ctx: Ctx) -> str:
    return f"""
        d.id, d.name, d.account_id, d.stage, d.probability, d.amount, d.currency_code, d.amount_usd, d.close_date,
        d.lead_source, d.next_step, d.description, d.approval_status, d.approved_by, d.approved_amount_usd,
        d.approved_at, d.owner_id, d.created_by, d.created_at, d.updated_at, d.source,
        {user_name_sql('u')} AS owner_name, a.name AS account_name, cur.symbol AS currency_symbol,
        {team_names_sql('deals', 'd')} AS team_names
    """


def _from(ctx: Ctx) -> str:
    return (
        "deals d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN currencies cur ON cur.code = d.currency_code "
        f"LEFT JOIN accounts a ON a.id = d.account_id AND {clause(ctx.actor, 'accounts', 'view', 'a')}"
    )


def _out(ctx: Ctx, row: dict) -> dict:
    item = dict(row)
    item["team_names"] = item.get("team_names") or []
    stage = ctx.cfg.stage_by_key.get(item["stage"])
    item["stage_label"] = stage.label if stage else item["stage"]
    item["is_won"] = bool(stage and stage.won)
    item["is_lost"] = bool(stage and stage.lost)
    item["is_open"] = not (stage and stage.closed)
    return item


def list_deals(ctx: Ctx, q: str = "", page=1, per_page=None, account_id: str | None = None,
               contact_id: str | None = None, owner: str | None = None, stage: str | None = None,
               status: str | None = None, approval_status: str | None = None, sort: str = "close",
               related: bool = False) -> dict:
    if not related:
        require_list(ctx, "deals")
    where = [clause(ctx.actor, "deals", "list", "d")]
    params = ctx.p()
    q = (q or "").strip()
    if q:
        where.append("(d.name ILIKE %(q)s OR a.name ILIKE %(q)s)")
        params["q"] = like(q)
    if account_id:  # filters on records the user cannot view find nothing (never reveal them)
        where.append("d.account_id = %(account_id)s AND EXISTS (SELECT 1 FROM accounts fa WHERE fa.id = %(account_id)s "
                     f"AND {clause(ctx.actor, 'accounts', 'view', 'fa')})")
        params["account_id"] = account_id
    if contact_id:
        where.append("EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.deal_id = d.id AND dc.contact_id = %(contact_id)s) "
                     "AND EXISTS (SELECT 1 FROM contacts fc WHERE fc.id = %(contact_id)s "
                     f"AND {clause(ctx.actor, 'contacts', 'view', 'fc')})")
        params["contact_id"] = contact_id
    if owner == "me":
        where.append("d.owner_id = %(actor_id)s")
    if stage:
        where.append("d.stage = %(stage)s")
        params["stage"] = stage
    if status in ("open", "closed", "won", "lost"):
        keys = {
            "open": ctx.cfg.closed_stage_keys, "closed": ctx.cfg.closed_stage_keys,
            "won": ctx.cfg.won_stage_keys, "lost": ctx.cfg.lost_stage_keys,
        }[status]
        params["status_stages"] = keys
        where.append("d.stage <> ALL(%(status_stages)s::text[])" if status == "open"
                     else "d.stage = ANY(%(status_stages)s::text[])")
    if approval_status is not None and approval_status != "any":
        where.append("d.approval_status = %(approval_status)s")
        params["approval_status"] = approval_status
    order = SORTS.get(sort or "close", SORTS["close"])
    result = run_list(ctx, select=_select(ctx), from_=_from(ctx), where=where, params=params, order=order,
                      page=page, per_page=per_page)
    result["items"] = [_out(ctx, r) for r in result["items"]]
    return result


def deal_row(ctx: Ctx, deal_id: str) -> dict | None:
    row = db.fetch_one(ctx.conn, f"SELECT {_select(ctx)} FROM {_from(ctx)} WHERE d.id = %(id)s", ctx.p(id=deal_id))
    return _out(ctx, row) if row else None


def approval_panel(ctx: Ctx, deal: dict, can_edit: bool) -> dict:
    from ..rules import team_manager_for

    rule = ctx.rule
    status = deal["approval_status"] or ""
    manager = team_manager_for(ctx, deal["owner_id"])
    owner_teams = [
        r["name"] for r in db.fetch_all(
            ctx.conn,
            "SELECT t.name FROM user_teams ut JOIN teams t ON t.id = ut.team_id WHERE ut.user_id = %s ORDER BY t.name",
            (deal["owner_id"] or ctx.actor.id,),
        )
    ]
    if manager:
        explanation = None
    elif owner_teams:
        explanation = (f"Only a {rule.manager_role.lower()} on the {' / '.join(owner_teams)} team can approve or "
                       "reject this deal.")
    else:
        explanation = rule.messages["not_manager"]
    return {
        "status": status,
        "approved_by": user_brief(ctx.conn, deal["approved_by"]),
        "approved_amount_usd": deal["approved_amount_usd"],
        "approved_at": deal["approved_at"],
        "threshold_usd": rule.threshold_usd,
        "won_stage": rule.won_stage,
        "needs_approval": Decimal(deal["amount_usd"]) > rule.threshold_usd,
        "can_request": bool(can_edit) and status in ("", "rejected"),
        "can_decide": bool(manager) and bool(can_edit),
        "is_team_manager": bool(manager),
        "explanation": explanation,
        "requested_at": db.fetch_val(
            ctx.conn,
            "SELECT max(changed_at) FROM audit_log WHERE entity = 'deals' AND record_id = %s "
            "AND field = 'approval_status' AND after = 'requested'",
            (deal["id"],),
        ),
    }


def history(ctx: Ctx, deal_id: str, limit: int = 50) -> list[dict]:
    rows = db.fetch_all(
        ctx.conn,
        f"SELECT al.field, al.before, al.after, al.changed_at, al.source, al.changed_by, {user_name_sql('u')} AS changed_by_name "
        "FROM audit_log al LEFT JOIN users u ON u.id = al.changed_by "
        "WHERE al.entity = 'deals' AND al.record_id = %s ORDER BY al.changed_at DESC, al.id DESC LIMIT %s",
        (deal_id, limit),
    )
    for r in rows:
        r["label"] = FIELD_LABELS.get(r["field"], r["field"])
    return rows


def get_deal(ctx: Ctx, deal_id: str) -> dict:
    from .accounts import account_row, external_links
    from .contacts import deal_contacts

    row = fetch_visible(ctx, "deals", deal_id)
    deal = deal_row(ctx, deal_id)
    account = account_row(ctx, deal["account_id"]) if deal["account_id"] and deal["account_name"] is not None else None
    return {
        "deal": deal,
        "account": account,
        "contacts": deal_contacts(ctx, deal_id),
        "notes": activities.list_notes(ctx, parent=("deal", deal_id), per_page=100, related=True)["items"],
        "tasks": activities.list_tasks(ctx, parent=("deal", deal_id), per_page=100, related=True)["items"],
        "approval": approval_panel(ctx, deal, row["_can_edit"]),
        "external_links": external_links(ctx, "deals", deal_id),
        "history": history(ctx, deal_id),
        "teams": record_teams(ctx.conn, "deals", deal_id),
        "owner": user_brief(ctx.conn, row["owner_id"]),
        "permissions": {"edit": bool(row["_can_edit"]), "delete": bool(row["_can_delete"])},
        "source_url": ctx.cfg.record_url("Opportunities", deal_id) if row["source"] == "suitecrm" else None,
    }


def _save_response(ctx: Ctx, saved) -> dict:
    return {
        "id": saved.deal_id,
        "deal": deal_row(ctx, saved.deal_id),
        "rule_messages": saved.messages,
        "rule_events": [{"code": c, "message": m} for c, m in saved.events],
        "blocked": saved.blocked,
        "changed": sorted(saved.changed),
    }


def create_deal(ctx: Ctx, data: dict) -> dict:
    from ..rules import save_deal

    if not isinstance(data, dict):
        raise Invalid("The request body must be a JSON object.")
    contact = None
    contact_id = data.get("contact_id")
    if contact_id:
        if not isinstance(contact_id, str):
            raise Invalid("contact_id must be a string.", {"contact_id": "Invalid."})
        role = data.get("contact_role") or ctx.cfg.default_contact_role
        contact = (contact_id, role if isinstance(role, str) else None)
    saved = save_deal(ctx, None, data, contact=contact)
    return _save_response(ctx, saved)


def update_deal(ctx: Ctx, deal_id: str, data: dict) -> dict:
    from ..rules import save_deal

    saved = save_deal(ctx, deal_id, data)
    return _save_response(ctx, saved)


def decide(ctx: Ctx, deal_id: str, decision) -> dict:
    from ..rules import decide_approval

    saved = decide_approval(ctx, deal_id, decision)
    return _save_response(ctx, saved)


def delete_deal(ctx: Ctx, deal_id: str) -> dict:
    return soft_delete(ctx, "deals", deal_id)


# --------------------------------------------------------------------------------------------------- pipeline
SCOPES = ("mine", "team", "all")


def pipeline(ctx: Ctx, scope: str | None = "all") -> dict:
    require_list(ctx, "deals")
    scope = scope or "all"
    if scope not in SCOPES:
        raise Invalid("scope must be mine, team or all.", {"scope": "mine, team or all"})
    where = [clause(ctx.actor, "deals", "list", "d")]
    if scope == "mine":
        where.append("d.owner_id = %(actor_id)s")
    elif scope == "team":
        where.append(
            "(d.owner_id = %(actor_id)s OR EXISTS (SELECT 1 FROM record_teams rt_s WHERE rt_s.entity = 'deals' "
            "AND rt_s.record_id = d.id AND rt_s.team_id = ANY(%(actor_teams)s::text[])))"
        )
    rows = db.fetch_all(
        ctx.conn,
        f"SELECT {_select(ctx)}, {clause(ctx.actor, 'deals', 'edit', 'd')} AS can_edit "
        f"FROM {_from(ctx)} WHERE {' AND '.join(where)} "
        "ORDER BY d.close_date NULLS LAST, lower(d.name), d.id",
        ctx.p(),
    )
    by_stage: dict[str, list] = {}
    for r in rows:
        by_stage.setdefault(r["stage"], []).append(_out(ctx, r))
    columns = []
    stage_list = list(ctx.cfg.stages)
    extra = [k for k in by_stage if k not in ctx.cfg.stage_by_key]
    for stage in stage_list:
        columns.append(_column(stage.key, stage.label, stage.probability, stage.won, stage.lost, by_stage.get(stage.key, [])))
    for key in sorted(extra):
        columns.append(_column(key, key, None, False, False, by_stage[key]))
    open_cols = [c for c in columns if not (c["won"] or c["lost"])]
    return {
        "scope": scope,
        "stages": columns,
        "count": len(rows),
        "total_usd": sum((c["total_usd"] for c in columns), Decimal(0)),
        "open_count": sum(c["count"] for c in open_cols),
        "open_total_usd": sum((c["total_usd"] for c in open_cols), Decimal(0)),
        "weighted_usd": sum((c["weighted_usd"] for c in open_cols), Decimal(0)),
    }


def _column(key, label, probability, won, lost, deals: list) -> dict:
    total = sum((Decimal(d["amount_usd"]) for d in deals), Decimal(0))
    weighted = sum((Decimal(d["amount_usd"]) * Decimal(d["probability"] if d["probability"] is not None else (probability or 0)) / 100
                    for d in deals), Decimal(0))
    return {
        "key": key, "label": label, "probability": probability, "won": won, "lost": lost,
        "count": len(deals), "total_usd": total, "weighted_usd": weighted.quantize(Decimal("0.01")), "deals": deals,
    }


# --------------------------------------------------------------------------------------------------- approvals
def approvals(ctx: Ctx, q: str = "", page=1, per_page=None) -> dict:
    """Deals waiting for approval that the user may list and is a team manager for."""
    if not ctx.actor.is_manager(ctx.rule):
        raise Forbidden("Only sales managers have an approval queue.")
    where = [
        clause(ctx.actor, "deals", "list", "d"),
        "d.approval_status = 'requested'",
        team_manager_clause(ctx.actor, ctx.rule, "d"),
    ]
    params = ctx.p()
    q = (q or "").strip()
    if q:
        where.append("(d.name ILIKE %(q)s OR a.name ILIKE %(q)s)")
        params["q"] = like(q)
    select = _select(ctx) + """,
        (SELECT max(al.changed_at) FROM audit_log al WHERE al.entity = 'deals' AND al.record_id = d.id
           AND al.field = 'approval_status' AND al.after = 'requested') AS requested_at"""
    result = run_list(ctx, select=select, from_=_from(ctx), where=where, params=params,
                      order="requested_at NULLS LAST, d.amount_usd DESC, d.id", page=page, per_page=per_page)
    result["items"] = [_out(ctx, r) for r in result["items"]]
    return result


def approvals_count(ctx: Ctx) -> int:
    if not ctx.actor.is_manager(ctx.rule) or not ctx.actor.can("deals", "list"):
        return 0
    return int(db.fetch_val(
        ctx.conn,
        f"SELECT count(*) FROM deals d WHERE {clause(ctx.actor, 'deals', 'list', 'd')} "
        f"AND d.approval_status = 'requested' AND {team_manager_clause(ctx.actor, ctx.rule, 'd')}",
        ctx.p(),
    ) or 0)
