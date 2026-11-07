"""Lead conversion (the agreed workflow, ``config.lead_conversion``).

* Matching: an *exact* match is a viewable account whose name equals the lead's company after trimming,
  collapsing whitespace and ignoring case. *Similar* accounts are other viewable accounts whose normalised name
  has a ``difflib.SequenceMatcher`` ratio >= ``similar_threshold``. Similar accounts are only ever warnings: an
  account is linked only when the request names it.
* Conversion runs in one transaction: lock the lead row; create the contact (owner = lead owner); link the chosen
  existing account or create the new one (owner = lead owner); optionally create the deal through the same deal
  rules (``rules.save_deal``) with ``deal_contacts.role = default_contact_role``; mark the lead converted; insert
  ``lead_conversions``. With ``activities = 'donothing'`` the lead's notes and tasks stay on the lead.
* Idempotent: a converted lead (whatever the request key) returns 200 with the stored result and creates nothing.
  Concurrent requests serialise on the lead row lock; the ``lead_conversions`` primary key is the final guarantee
  (a request that loses the race rolls back everything it created and returns the winner's result).
"""
from __future__ import annotations

from difflib import SequenceMatcher

from . import db
from .access import clause
from .rules import save_deal
from .services import accounts as accounts_svc
from .services import leads as leads_svc
from .services.base import (
    Ctx, Forbidden, Invalid, fetch_visible, insert_record, new_id, record_team_ids, validate, write_audit,
    write_update,
)

CONVERTED_STATUS = "Converted"


def normalize_name(name: str | None) -> str:
    return " ".join((name or "").split()).lower()


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize_name(a), normalize_name(b)).ratio()


def account_matches(ctx: Ctx, company: str | None) -> tuple[list[dict], list[dict]]:
    target = normalize_name(company)
    if not target:
        return [], []
    candidates = db.fetch_all(
        ctx.conn,
        f"SELECT a.id, a.name FROM accounts a WHERE {clause(ctx.actor, 'accounts', 'view', 'a')} "
        "ORDER BY lower(a.name), a.id",
        ctx.p(),
    )
    threshold = ctx.cfg.similar_threshold
    exact_ids: list[str] = []
    similar: list[tuple[float, str]] = []
    for cand in candidates:
        name = normalize_name(cand["name"])
        if name == target:
            exact_ids.append(cand["id"])
            continue
        matcher = SequenceMatcher(None, target, name)
        if matcher.real_quick_ratio() < threshold or matcher.quick_ratio() < threshold:
            continue
        ratio = matcher.ratio()
        if ratio >= threshold:
            similar.append((ratio, cand["id"]))
    exact = []
    for account_id in exact_ids:
        row = accounts_svc.account_row(ctx, account_id)
        row["match"] = "exact"
        row["similarity"] = 1.0
        exact.append(row)
    similar.sort(key=lambda pair: (-pair[0], pair[1]))
    similar_rows = []
    for ratio, account_id in similar:
        row = accounts_svc.account_row(ctx, account_id)
        row["match"] = "similar"
        row["similarity"] = round(ratio, 3)
        similar_rows.append(row)
    return exact, similar_rows


def _conversion_row(ctx: Ctx, lead_id: str) -> dict | None:
    return db.fetch_one(ctx.conn, "SELECT * FROM lead_conversions WHERE lead_id = %s", (lead_id,))


def stored_result(ctx: Ctx, lead: dict) -> dict | None:
    """The stored conversion result of a lead, or None if it has not been converted."""
    conv = _conversion_row(ctx, lead["id"])
    if conv is not None:
        return {
            "lead_id": lead["id"],
            "contact_id": conv["contact_id"],
            "account_id": conv["account_id"],
            "deal_id": conv["deal_id"],
            "account_created": bool(conv["account_created"]),
            "converted_by": conv["converted_by"],
            "converted_at": conv["converted_at"],
        }
    if lead.get("converted"):  # converted in SuiteCRM before the migration
        return {
            "lead_id": lead["id"],
            "contact_id": lead.get("converted_contact_id"),
            "account_id": lead.get("converted_account_id"),
            "deal_id": lead.get("converted_deal_id"),
            "account_created": False,
            "converted_by": None,
            "converted_at": None,
        }
    return None


def conversion_state(ctx: Ctx, lead_id: str) -> dict:
    """GET /api/leads/{id}/conversion."""
    row = fetch_visible(ctx, "leads", lead_id)
    result = stored_result(ctx, row)
    exact, similar = account_matches(ctx, row["company"])
    if exact and ctx.cfg.account_match in ("exact_suggest", "exact"):
        suggested = {"mode": "existing", "id": exact[0]["id"]}
    else:
        suggested = {"mode": "new", "name": (row["company"] or "").strip()}
    return {
        "lead": leads_svc.lead_row(ctx, lead_id),
        "already_converted": result is not None,
        "result": result,
        "exact_matches": exact,
        "similar": similar,
        "suggested_account": suggested,
        "similar_threshold": ctx.cfg.similar_threshold,
        "permissions": {
            "convert": bool(row["_can_edit"]) and ctx.actor.can("contacts", "edit"),
            "create_account": ctx.actor.can("accounts", "edit"),
            "create_deal": ctx.actor.can("deals", "edit"),
        },
    }


def _bool(value, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return False
    if isinstance(value, str) and value.lower() in ("true", "on", "1", "yes"):
        return True
    if isinstance(value, str) and value.lower() in ("false", "off", "0", "no"):
        return False
    raise Invalid(f"{name} must be true or false.", {name: "true or false"})


def _parse_account(ctx: Ctx, lead: dict, account) -> dict:
    if not isinstance(account, dict):
        raise Invalid("Choose an account: link an existing account or create a new one.",
                      {"account": "Choose an account."})
    mode = account.get("mode")
    if mode == "existing":
        account_id = account.get("id")
        if not isinstance(account_id, str) or not account_id.strip():
            raise Invalid("Choose the existing account to link.", {"account": "Choose an account."})
        return {"mode": "existing", "id": account_id.strip()}
    if mode == "new":
        name = account.get("name")
        if name is not None and not isinstance(name, str):
            raise Invalid("The new account's name must be text.", {"account": "Name must be text."})
        name = (name or "").strip() or (lead["company"] or "").strip()
        if not name:
            raise Invalid("Give the new account a name.", {"account": "Name is required."})
        if len(name) > 255:
            raise Invalid("The new account's name is too long.", {"account": "At most 255 characters."})
        return {"mode": "new", "name": name}
    raise Invalid("account.mode must be 'existing' or 'new'.", {"account": "Choose an account."})


def _result_payload(result: dict, *, already: bool, **extra) -> dict:
    payload = {
        "lead_id": result["lead_id"],
        "contact_id": result["contact_id"],
        "account_id": result["account_id"],
        "deal_id": result["deal_id"],
        "account_created": result["account_created"],
        "already_converted": already,
    }
    payload.update(extra)
    return payload


def convert_lead(ctx: Ctx, lead_id: str, body: dict, *, on_before_commit=None) -> tuple[int, dict]:
    """POST /api/leads/{id}/convert -> (status, payload): 201 when converted now, 200 when it already was."""
    if not isinstance(body, dict):
        raise Invalid("The request body must be a JSON object.")
    request_key = body.get("request_key")
    if request_key in (None, ""):
        request_key = new_id()
    elif not isinstance(request_key, str) or len(request_key) > 200:
        raise Invalid("request_key must be a string of at most 200 characters.", {"request_key": "Invalid key."})

    try:
        with ctx.conn.transaction():
            lead = fetch_visible(ctx, "leads", lead_id, for_update=True)  # 404; locks the lead row
            if not lead["_can_edit"]:
                raise Forbidden("You can view this lead but you are not allowed to convert it.")
            existing = stored_result(ctx, lead)
            if existing is not None:
                return 200, _result_payload(existing, already=True)
            used = db.fetch_one(ctx.conn, "SELECT lead_id FROM lead_conversions WHERE request_key = %s", (request_key,))
            if used is not None:
                raise Invalid("This request_key was already used to convert another lead.",
                              {"request_key": "Already used."})
            if not ctx.actor.can("contacts", "edit"):
                raise Forbidden("You are not allowed to create contacts, so you cannot convert leads.")

            account_choice = _parse_account(ctx, lead, body.get("account"))
            create_deal = _bool(body.get("create_deal", False), "create_deal")
            deal_data = body.get("deal") if create_deal else None
            if create_deal and not isinstance(deal_data, dict):
                raise Invalid("Give the deal's details.", {"deal": "Required when create_deal is true."})
            if account_choice["mode"] == "new" and not ctx.actor.can("accounts", "edit"):
                raise Forbidden("You are not allowed to create accounts.")
            if create_deal and not ctx.actor.can("deals", "edit"):
                raise Forbidden("You are not allowed to create deals.")
            if account_choice["mode"] == "existing":
                fetch_visible(ctx, "accounts", account_choice["id"])  # 404 when not viewable
            if create_deal:
                allowed = {k: deal_data[k] for k in ("name", "amount", "currency_code", "stage", "close_date")
                           if k in deal_data}
                allowed.setdefault("stage", ctx.cfg.stages[0].key)
                if not allowed.get("currency_code"):
                    allowed["currency_code"] = "USD" if "USD" in ctx.currencies() else next(iter(ctx.currencies()))
                validate(ctx, "deals", allowed)  # 422 before anything is written
                deal_data = allowed

            owner_id = lead["owner_id"] or ctx.actor.id
            if account_choice["mode"] == "existing":
                account_id, account_created = account_choice["id"], False
            else:
                account_id = insert_record(ctx, "accounts", {"name": account_choice["name"], "owner_id": owner_id})
                account_created = True

            contact_id = insert_record(ctx, "contacts", {
                "first_name": lead["first_name"], "last_name": lead["last_name"], "title": lead["title"],
                "email": lead["email"], "phone": lead["phone"], "city": lead["city"],
                "lead_source": lead["lead_source"], "account_id": account_id, "owner_id": owner_id,
            })

            deal_id, events, blocked = None, [], False
            if create_deal:
                deal_owner = owner_id
                active = db.fetch_one(ctx.conn, "SELECT status FROM users WHERE id = %s", (deal_owner,))
                if active is None or active["status"] != "active":
                    deal_owner = ctx.actor.id
                saved = save_deal(
                    ctx, None, deal_data,
                    contact=(contact_id, ctx.cfg.default_contact_role), check_contact=False,
                    trusted={"account_id": account_id, "owner_id": deal_owner, "lead_source": lead["lead_source"]},
                )
                deal_id, events, blocked = saved.deal_id, saved.events, saved.blocked

            write_update(ctx, "leads", lead, {
                "status": CONVERTED_STATUS, "converted": True, "converted_contact_id": contact_id,
                "converted_account_id": account_id, "converted_deal_id": deal_id,
            })
            db.execute(
                ctx.conn,
                "INSERT INTO lead_conversions (lead_id, request_key, contact_id, account_id, deal_id, account_created, "
                "converted_by, converted_at) VALUES (%s, %s, %s, %s, %s, %s, %s, now())",
                (lead_id, request_key, contact_id, account_id, deal_id, account_created, ctx.actor.id),
            )
            _carry_activities(ctx, lead_id, contact_id)
            if on_before_commit is not None:
                on_before_commit()
    except db.UniqueViolation as exc:
        constraint = getattr(exc.diag, "constraint_name", "") or ""
        if not constraint.startswith("lead_conversions"):
            raise
        winner = _conversion_row(ctx, lead_id)
        if winner is not None:
            lead = fetch_visible(ctx, "leads", lead_id)
            return 200, _result_payload(stored_result(ctx, lead), already=True)
        raise Invalid("This request_key was already used to convert another lead.", {"request_key": "Already used."})

    return 201, _result_payload(
        {"lead_id": lead_id, "contact_id": contact_id, "account_id": account_id, "deal_id": deal_id,
         "account_created": account_created},
        already=False,
        request_key=request_key,
        rule_messages=[m for _, m in events],
        rule_events=[{"code": c, "message": m} for c, m in events],
        blocked=blocked,
    )


def _carry_activities(ctx: Ctx, lead_id: str, contact_id: str) -> None:
    """``activities``: donothing (notes and tasks stay on the lead), move or copy them to the new contact."""
    mode = ctx.cfg.conversion_activities
    if mode == "donothing":
        return
    for entity in ("notes", "tasks"):
        rows = db.fetch_all(
            ctx.conn,
            f"SELECT * FROM {entity} WHERE parent_type = 'lead' AND parent_id = %s AND deleted_at IS NULL",
            (lead_id,),
        )
        for row in rows:
            if mode == "move":
                db.execute(ctx.conn, f"UPDATE {entity} SET parent_type = 'contact', parent_id = %s, updated_at = now() "
                           "WHERE id = %s", (contact_id, row["id"]))
                write_audit(ctx, entity, row["id"], {"parent_type": ("lead", "contact"),
                                                     "parent_id": (lead_id, contact_id)})
            else:  # copy
                copy_id = new_id()
                columns = [c for c in row if c not in ("id", "parent_type", "parent_id", "created_at", "updated_at",
                                                       "source", "created_by")]
                db.execute(
                    ctx.conn,
                    f"INSERT INTO {entity} (id, parent_type, parent_id, {', '.join(columns)}, created_by, created_at, "
                    f"updated_at, source) VALUES (%s, 'contact', %s, {', '.join(['%s'] * len(columns))}, %s, now(), "
                    "now(), 'workspace')",
                    (copy_id, contact_id, *[row[c] for c in columns], ctx.actor.id),
                )
                teams = record_team_ids(ctx.conn, entity, row["id"])
                if teams:
                    db.execute(ctx.conn, "INSERT INTO record_teams (entity, record_id, team_id) "
                               "SELECT %s, %s, unnest(%s::text[]) ON CONFLICT DO NOTHING", (entity, copy_id, teams))
