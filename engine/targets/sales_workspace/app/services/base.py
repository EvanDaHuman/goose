"""Shared building blocks: errors, the request context, field validation and the generic writes.

Generic writes implement the rules every entity shares:

* create: ``owner_id`` defaults to the creator; ``record_teams`` = creator's teams (``inherit_creator``) and the
  owner's teams (``inherit_assigned``), plus the parent's teams for notes and tasks (``inherit_parent``);
* update: only changed columns are written, with one ``audit_log`` row (source 'workspace') per changed field;
* delete: a soft delete (``deleted_at = now()``), audited like any other change.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

from .. import db
from ..access import ENTITIES, PARENT_TYPES, Actor, clause
from ..config import RuleConfig, WorkspaceConfig


# --------------------------------------------------------------------------------------------------- errors
class ServiceError(Exception):
    status = 400

    def __init__(self, detail: str, fields: dict | None = None, **extra):
        super().__init__(detail)
        self.detail = detail
        self.fields = fields or {}
        self.extra = extra

    def payload(self) -> dict:
        body = {"detail": self.detail}
        if self.fields:
            body["errors"] = self.fields
        body.update(self.extra)
        return body


class NotFound(ServiceError):
    status = 404


class Forbidden(ServiceError):
    status = 403


class Invalid(ServiceError):
    status = 422


class Unsupported(ServiceError):
    status = 415


ENTITY_LABEL = {
    "accounts": "Account", "contacts": "Contact", "leads": "Lead", "deals": "Deal", "notes": "Note", "tasks": "Task",
}


def not_found(entity: str) -> NotFound:
    return NotFound(f"{ENTITY_LABEL[entity]} not found.")


# --------------------------------------------------------------------------------------------------- context
@dataclass
class Ctx:
    conn: db.Connection
    actor: Actor
    cfg: WorkspaceConfig
    _cache: dict = field(default_factory=dict)

    @property
    def rule(self) -> RuleConfig:
        return self.cfg.rule

    def p(self, **extra) -> dict:
        """Named query parameters: the actor's id and teams (used by the access clauses) plus ``extra``."""
        params = self.actor.params()
        params.update(extra)
        return params

    def tz(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.actor.timezone or "UTC")
        except Exception:
            return ZoneInfo("UTC")

    def currencies(self) -> dict[str, dict]:
        if "currencies" not in self._cache:
            rows = db.fetch_all(self.conn, "SELECT code, name, symbol, rate_per_usd FROM currencies ORDER BY code")
            self._cache["currencies"] = {r["code"]: r for r in rows}
        return self._cache["currencies"]


def new_id() -> str:
    return str(uuid.uuid4())


def user_name_sql(alias: str) -> str:
    """Display name of a users row: 'First Last', falling back to the user name."""
    return (
        f"COALESCE(NULLIF(btrim(concat_ws(' ', {alias}.first_name, {alias}.last_name)), ''), {alias}.user_name)"
    )


def person_name(first: str | None, last: str | None) -> str:
    return " ".join(p for p in (first, last) if p).strip()


def like(q: str) -> str:
    """An ILIKE pattern matching ``q`` anywhere (backslash is PostgreSQL's default LIKE escape)."""
    q = q[:200]
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


MAX_PER_PAGE = 100
MAX_PAGE = 1_000_000


def page_args(page, per_page, default_per_page: int = 50) -> tuple[int, int, int, int]:
    """(limit, offset, page, per_page) with per_page clamped to 1..100 and page to >= 1."""
    try:
        page = int(page) if page is not None else 1
    except (TypeError, ValueError):
        raise Invalid("page must be a whole number.")
    try:
        per_page = int(per_page) if per_page is not None else default_per_page
    except (TypeError, ValueError):
        raise Invalid("per_page must be a whole number.")
    page = min(max(page, 1), MAX_PAGE)
    per_page = min(max(per_page, 1), MAX_PER_PAGE)
    return per_page, (page - 1) * per_page, page, per_page


def run_list(ctx: Ctx, *, select: str, from_: str, where: list[str], params: dict, order: str,
             page=1, per_page=None, default_per_page: int = 50) -> dict:
    limit, offset, page, per_page = page_args(page, per_page, default_per_page)
    where_sql = " AND ".join(where) if where else "TRUE"
    total = db.fetch_val(ctx.conn, f"SELECT count(*) AS n FROM {from_} WHERE {where_sql}", params)
    rows = db.fetch_all(
        ctx.conn,
        f"SELECT {select} FROM {from_} WHERE {where_sql} ORDER BY {order} LIMIT %(_limit)s OFFSET %(_offset)s",
        {**params, "_limit": limit, "_offset": offset},
    )
    return {"items": rows, "total": int(total or 0), "page": page, "per_page": per_page}


# --------------------------------------------------------------------------------------------------- records
def fetch_visible(ctx: Ctx, entity: str, record_id: str, *, for_update: bool = False) -> dict:
    """The row if the actor may view it, with ``_can_edit`` / ``_can_delete``; otherwise 404 (never reveal)."""
    assert entity in ENTITIES
    if not isinstance(record_id, str) or not record_id:
        raise not_found(entity)
    lock = " FOR UPDATE OF x" if for_update else ""
    row = db.fetch_one(
        ctx.conn,
        f"SELECT x.*, {clause(ctx.actor, entity, 'edit', 'x')} AS _can_edit, "
        f"{clause(ctx.actor, entity, 'delete', 'x')} AS _can_delete "
        f"FROM {entity} x WHERE x.id = %(id)s AND {clause(ctx.actor, entity, 'view', 'x')}{lock}",
        ctx.p(id=record_id),
    )
    if row is None:
        raise not_found(entity)
    return row


def fetch_for_edit(ctx: Ctx, entity: str, record_id: str) -> dict:
    row = fetch_visible(ctx, entity, record_id, for_update=True)
    if not row["_can_edit"]:
        raise Forbidden(f"You can view this {ENTITY_LABEL[entity].lower()} but you are not allowed to change it.")
    return row


def require_create(ctx: Ctx, entity: str) -> None:
    if not ctx.actor.can(entity, "edit"):
        raise Forbidden(f"You are not allowed to create {entity}.")


def require_list(ctx: Ctx, entity: str) -> None:
    if not ctx.actor.can(entity, "list"):
        raise Forbidden(f"You do not have access to {entity}.")


def visible_exists(ctx: Ctx, entity: str, record_id: str, action: str = "view") -> bool:
    if not isinstance(record_id, str) or not record_id:
        return False
    return db.fetch_one(
        ctx.conn,
        f"SELECT 1 AS ok FROM {entity} x WHERE x.id = %(id)s AND {clause(ctx.actor, entity, action, 'x')}",
        ctx.p(id=record_id),
    ) is not None


def user_team_ids(conn: db.Connection, user_id: str | None) -> list[str]:
    if not user_id:
        return []
    return [r["team_id"] for r in db.fetch_all(conn, "SELECT team_id FROM user_teams WHERE user_id = %s", (user_id,))]


def record_team_ids(conn: db.Connection, entity: str, record_id: str) -> list[str]:
    return [
        r["team_id"]
        for r in db.fetch_all(
            conn, "SELECT team_id FROM record_teams WHERE entity = %s AND record_id = %s", (entity, record_id)
        )
    ]


def record_teams(conn: db.Connection, entity: str, record_id: str) -> list[dict]:
    return db.fetch_all(
        conn,
        "SELECT t.id, t.name FROM record_teams rt JOIN teams t ON t.id = rt.team_id "
        "WHERE rt.entity = %s AND rt.record_id = %s ORDER BY t.name",
        (entity, record_id),
    )


def user_brief(conn: db.Connection, user_id: str | None) -> dict | None:
    if not user_id:
        return None
    row = db.fetch_one(
        conn,
        f"SELECT u.id, u.user_name, {user_name_sql('u')} AS name, u.title, u.status FROM users u WHERE u.id = %s",
        (user_id,),
    )
    return dict(row) if row else None


def team_names_sql(entity: str, alias: str) -> str:
    assert entity in ENTITIES
    return (
        "(SELECT array_agg(t.name ORDER BY t.name) FROM record_teams rt_n JOIN teams t ON t.id = rt_n.team_id "
        f"WHERE rt_n.entity = '{entity}' AND rt_n.record_id = {alias}.id)"
    )


def insert_record(ctx: Ctx, entity: str, values: dict, *, parent: tuple[str, str] | None = None,
                  record_id: str | None = None) -> str:
    """Insert a row created in the workspace and its ``record_teams`` rows. Returns the new id."""
    assert entity in ENTITIES
    record_id = record_id or new_id()
    values = dict(values)
    values.setdefault("owner_id", ctx.actor.id)
    if values.get("owner_id") is None:
        values["owner_id"] = ctx.actor.id
    cols = ["id", *values.keys(), "created_by", "created_at", "updated_at", "source"]
    placeholders = ["%(id)s", *[f"%({k})s" for k in values], "%(_created_by)s", "now()", "now()", "'workspace'"]
    db.execute(
        ctx.conn,
        f"INSERT INTO {entity} ({', '.join(cols)}) VALUES ({', '.join(placeholders)})",
        {"id": record_id, **values, "_created_by": ctx.actor.id},
    )
    teams: set[str] = set()
    if ctx.cfg.inherit_creator:
        teams.update(ctx.actor.team_ids)
    if ctx.cfg.inherit_assigned:
        teams.update(user_team_ids(ctx.conn, values.get("owner_id")))
    if parent and ctx.cfg.inherit_parent and entity in ("notes", "tasks"):
        parent_type, parent_id = parent
        teams.update(record_team_ids(ctx.conn, PARENT_TYPES[parent_type], parent_id))
    if teams:
        db.execute(
            ctx.conn,
            "INSERT INTO record_teams (entity, record_id, team_id) "
            "SELECT %s, %s, unnest(%s::text[]) ON CONFLICT DO NOTHING",
            (entity, record_id, sorted(teams)),
        )
    return record_id


def audit_text(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        text = format(value.normalize(), "f")
        return text if text != "-0" else "0"
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def same_value(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, Decimal) or isinstance(b, Decimal):
        try:
            return Decimal(str(a)) == Decimal(str(b))
        except InvalidOperation:
            return False
    return a == b


def write_update(ctx: Ctx, entity: str, before: dict, changes: dict) -> dict:
    """Write the changed columns of one row and audit them. Returns {field: (before, after)} of what changed."""
    assert entity in ENTITIES
    diffs = {k: v for k, v in changes.items() if k in before and not same_value(before[k], v)}
    if not diffs:
        return {}
    sets = ", ".join(f"{k} = %({k})s" for k in diffs)
    after = db.fetch_one(
        ctx.conn,
        f"UPDATE {entity} SET {sets}, updated_at = now() WHERE id = %(_id)s RETURNING *",
        {**diffs, "_id": before["id"]},
    )
    changed = {k: (before[k], after[k]) for k in diffs}
    write_audit(ctx, entity, before["id"], changed)
    return changed


def write_audit(ctx: Ctx, entity: str, record_id: str, changed: dict) -> None:
    if not changed:
        return
    with ctx.conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO audit_log (entity, record_id, field, before, after, changed_by, changed_at, source) "
            "VALUES (%s, %s, %s, %s, %s, %s, now(), 'workspace')",
            [(entity, record_id, k, audit_text(b), audit_text(a), ctx.actor.id) for k, (b, a) in changed.items()],
        )


def soft_delete(ctx: Ctx, entity: str, record_id: str) -> dict:
    with ctx.conn.transaction():
        row = fetch_visible(ctx, entity, record_id, for_update=True)
        if not row["_can_delete"]:
            raise Forbidden(f"You can view this {ENTITY_LABEL[entity].lower()} but you are not allowed to delete it.")
        after = db.fetch_one(
            ctx.conn,
            f"UPDATE {entity} SET deleted_at = now(), updated_at = now() WHERE id = %s RETURNING deleted_at",
            (record_id,),
        )
        write_audit(ctx, entity, record_id, {"deleted_at": (None, after["deleted_at"])})
    return {"ok": True, "id": record_id, "deleted": True}


# --------------------------------------------------------------------------------------------------- idempotent creates
def idempotent_create(ctx: Ctx, scope: str, request_key, create):
    """Run ``create()`` once per (scope, request_key). A replay returns the stored response.

    ``request_keys`` holds the response; an advisory lock on the key makes a concurrent duplicate wait.
    Returns (response, replayed).
    """
    if request_key in (None, ""):
        return create(), False
    if not isinstance(request_key, str) or len(request_key) > 200:
        raise Invalid("request_key must be a string of at most 200 characters.", {"request_key": "Invalid key."})
    key = f"{scope}:{request_key}"
    with ctx.conn.transaction():
        db.execute(ctx.conn, "SELECT pg_advisory_xact_lock(hashtext(%s))", (key,))
        row = db.fetch_one(ctx.conn, "SELECT user_id, response FROM request_keys WHERE key = %s", (key,))
        if row is not None:
            if row["user_id"] != ctx.actor.id:
                raise Invalid("This request_key was already used.", {"request_key": "Already used."})
            return row["response"], True
        response = create()
        db.execute(
            ctx.conn,
            "INSERT INTO request_keys (key, user_id, response) VALUES (%s, %s, %s::jsonb)",
            (key, ctx.actor.id, json.dumps(response, default=json_default)),
        )
    return response, False


def json_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, (set, frozenset, tuple)):
        return list(obj)
    raise TypeError(f"Not JSON serialisable: {type(obj).__name__}")


# --------------------------------------------------------------------------------------------------- fields
@dataclass(frozen=True)
class F:
    kind: str  # text | email | date | datetime | choice | stage | owner | ref | decimal | int | approval | currency
    label: str
    required: bool = False
    max_len: int = 255
    choices: str | None = None  # config list name for kind 'choice'
    ref: str | None = None  # entity for kind 'ref'


FIELDS: dict[str, dict[str, F]] = {
    "accounts": {
        "name": F("text", "Account name", required=True),
        "account_type": F("choice", "Type", choices="account_types"),
        "industry": F("choice", "Industry", choices="industries"),
        "phone": F("text", "Phone", max_len=100),
        "website": F("text", "Website"),
        "billing_city": F("text", "City", max_len=120),
        "billing_state": F("text", "State", max_len=120),
        "billing_country": F("text", "Country", max_len=120),
        "employees": F("text", "Employees", max_len=50),
        "description": F("text", "Description", max_len=20000),
        "contract_renewal_date": F("date", "Contract renewal date"),
        "owner_id": F("owner", "Owner"),
    },
    "contacts": {
        "first_name": F("text", "First name", max_len=100),
        "last_name": F("text", "Last name", required=True, max_len=100),
        "title": F("text", "Title"),
        "email": F("email", "E-mail"),
        "phone": F("text", "Phone", max_len=100),
        "city": F("text", "City", max_len=120),
        "state": F("text", "State", max_len=120),
        "lead_source": F("choice", "Lead source", choices="lead_sources"),
        "description": F("text", "Description", max_len=20000),
        "account_id": F("ref", "Account", ref="accounts"),
        "owner_id": F("owner", "Owner"),
    },
    "leads": {
        "first_name": F("text", "First name", max_len=100),
        "last_name": F("text", "Last name", required=True, max_len=100),
        "company": F("text", "Company"),
        "title": F("text", "Title"),
        "email": F("email", "E-mail"),
        "phone": F("text", "Phone", max_len=100),
        "city": F("text", "City", max_len=120),
        "status": F("choice", "Status", required=True, choices="lead_statuses"),
        "lead_source": F("choice", "Lead source", choices="lead_sources"),
        "description": F("text", "Description", max_len=20000),
        "owner_id": F("owner", "Owner"),
    },
    "deals": {
        "name": F("text", "Deal name", required=True),
        "account_id": F("ref", "Account", ref="accounts"),
        "stage": F("stage", "Stage", required=True),
        "probability": F("int", "Probability (%)"),
        "amount": F("decimal", "Amount", required=True),
        "currency_code": F("currency", "Currency", required=True),
        "close_date": F("date", "Expected close date"),
        "lead_source": F("choice", "Lead source", choices="lead_sources"),
        "next_step": F("text", "Next step"),
        "description": F("text", "Description", max_len=20000),
        "approval_status": F("approval", "Manager approval"),
        "owner_id": F("owner", "Owner"),
    },
    "notes": {
        "subject": F("text", "Subject", required=True),
        "body": F("text", "Note", max_len=50000),
        "parent_type": F("parent_type", "Related to", required=True),
        "parent_id": F("text", "Related record", required=True, max_len=100),
        "contact_id": F("ref", "Contact", ref="contacts"),
        "owner_id": F("owner", "Owner"),
    },
    "tasks": {
        "subject": F("text", "Subject", required=True),
        "status": F("choice", "Status", required=True, choices="task_statuses"),
        "priority": F("choice", "Priority", choices="task_priorities"),
        "due_at": F("datetime", "Due"),
        "parent_type": F("parent_type", "Related to"),
        "parent_id": F("text", "Related record", max_len=100),
        "contact_id": F("ref", "Contact", ref="contacts"),
        "description": F("text", "Description", max_len=20000),
        "owner_id": F("owner", "Owner"),
    },
}

APPROVAL_STATUSES = ("", "requested", "approved", "rejected")
MIN_YEAR, MAX_YEAR = 1900, 2999
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_AMOUNT = Decimal("1e19")


class _FieldError(Exception):
    pass


def _text(f: F, raw) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, (str, int, float, Decimal)):
        raise _FieldError(f"{f.label} must be text.")
    value = str(raw).strip()
    if value == "":
        return None
    if len(value) > f.max_len:
        raise _FieldError(f"{f.label} is too long (at most {f.max_len} characters).")
    return value


def _coerce(ctx: Ctx, name: str, f: F, raw, before: dict | None):
    current = before.get(name) if before else None
    if f.kind in ("text", "owner", "ref", "currency"):
        return _text(f, raw)
    if f.kind == "parent_type":
        value = _text(f, raw)
        if value is not None and value not in PARENT_TYPES:
            raise _FieldError(f"{f.label} must be one of: {', '.join(PARENT_TYPES)}.")
        return value
    if f.kind == "email":
        value = _text(f, raw)
        if value is not None and value != current and not _EMAIL.match(value):
            raise _FieldError(f"{f.label} does not look like an e-mail address.")
        return value
    if f.kind == "choice":
        value = _text(f, raw)
        allowed = ctx.cfg.option_keys(f.choices)  # a list config.json does not define is free text
        if value is not None and value != current and allowed and value not in allowed:
            raise _FieldError(f"'{value}' is not a valid {f.label.lower()}.")
        return value
    if f.kind == "stage":
        value = _text(f, raw)
        if value is not None and value != current and value not in ctx.cfg.stage_by_key:
            raise _FieldError(f"'{value}' is not a stage of this pipeline.")
        return value
    if f.kind == "approval":
        if raw is None:
            return ""
        if not isinstance(raw, str) or raw.strip() not in APPROVAL_STATUSES:
            raise _FieldError("Manager approval must be '', 'requested', 'approved' or 'rejected'.")
        return raw.strip()
    if f.kind == "date":
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            return None
        if isinstance(raw, date) and not isinstance(raw, datetime):
            return raw
        if not isinstance(raw, str) or not _DATE.match(raw.strip()):
            raise _FieldError(f"{f.label} must be a date like 2027-03-31.")
        try:
            value = date.fromisoformat(raw.strip())
        except ValueError:
            raise _FieldError(f"{f.label} is not a valid date.")
        if not MIN_YEAR <= value.year <= MAX_YEAR:
            raise _FieldError(f"{f.label} must be between {MIN_YEAR} and {MAX_YEAR}.")
        return value
    if f.kind == "datetime":
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            return None
        if not isinstance(raw, str):
            raise _FieldError(f"{f.label} must be a date or date and time.")
        text = raw.strip()
        try:
            if _DATE.match(text):  # a date alone means the end of that business day in the user's timezone
                value = datetime.combine(date.fromisoformat(text), time(17, 0), tzinfo=ctx.tz())
            else:
                value = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            raise _FieldError(f"{f.label} must be a date like 2027-03-31 or 2027-03-31T17:00.")
        if value.tzinfo is None:
            value = value.replace(tzinfo=ctx.tz())
        try:
            value = value.astimezone(timezone.utc)
        except (OverflowError, ValueError):
            raise _FieldError(f"{f.label} is out of range.")
        if not MIN_YEAR <= value.year <= MAX_YEAR:
            raise _FieldError(f"{f.label} must be between {MIN_YEAR} and {MAX_YEAR}.")
        return value
    if f.kind == "decimal":
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            return None
        if isinstance(raw, bool):
            raise _FieldError(f"{f.label} must be a number.")
        try:
            value = Decimal(str(raw).strip().replace(",", "")) if isinstance(raw, str) else Decimal(str(raw))
        except InvalidOperation:
            raise _FieldError(f"{f.label} must be a number.")
        if not value.is_finite():
            raise _FieldError(f"{f.label} must be a number.")
        if value < 0:
            raise _FieldError(f"{f.label} cannot be negative.")
        if value >= MAX_AMOUNT:
            raise _FieldError(f"{f.label} is too large.")
        return value.quantize(Decimal("0.000001"))
    if f.kind == "int":
        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
            return None
        if isinstance(raw, bool):
            raise _FieldError(f"{f.label} must be a whole number.")
        try:
            number = Decimal(str(raw).strip())
        except InvalidOperation:
            raise _FieldError(f"{f.label} must be a whole number.")
        if not number.is_finite():
            raise _FieldError(f"{f.label} must be a whole number.")
        if not 0 <= number <= 100:  # checked before int(): a huge exponent must not be expanded
            raise _FieldError(f"{f.label} must be between 0 and 100.")
        if number != number.to_integral_value():
            raise _FieldError(f"{f.label} must be a whole number.")
        return int(number)
    raise AssertionError(f"unknown field kind {f.kind}")


def validate(ctx: Ctx, entity: str, data: dict, before: dict | None = None) -> dict:
    """Normalise and check the editable fields present in ``data`` (others are ignored).

    Raises Invalid (422) for bad values and NotFound (404) for references to records the actor cannot view
    (accounts, contacts, the parent of a note or task): unknown and invisible records look the same.
    """
    if not isinstance(data, dict):
        raise Invalid("The request body must be a JSON object.")
    spec = FIELDS[entity]
    out: dict = {}
    errors: dict[str, str] = {}
    for name, f in spec.items():
        if name not in data:
            continue
        try:
            out[name] = _coerce(ctx, name, f, data[name], before)
        except _FieldError as exc:
            errors[name] = str(exc)
    for name, f in spec.items():
        if not f.required or name in errors:
            continue
        if before is None and out.get(name) is None:
            errors[name] = f"{f.label} is required."
        elif before is not None and name in out and out[name] is None:
            errors[name] = f"{f.label} cannot be empty."
    if errors:
        raise Invalid(next(iter(errors.values())), errors)

    # Checks that need the database.
    for name, f in spec.items():
        if name not in out or out[name] is None:
            continue
        value = out[name]
        if before is not None and same_value(before.get(name), value):
            continue
        if f.kind == "owner":
            row = db.fetch_one(ctx.conn, "SELECT status FROM users WHERE id = %s", (value,))
            if row is None or row["status"] != "active":
                errors[name] = "Choose an active user as the owner."
        elif f.kind == "currency":
            if value not in ctx.currencies():
                errors[name] = f"'{value}' is not a known currency."
        elif f.kind == "ref":
            if not visible_exists(ctx, f.ref, value):
                raise NotFound(f"{f.label} not found.", {name: f"{f.label} not found."})
    if "owner_id" in out and out["owner_id"] is None and "owner_id" not in errors:
        if before is not None:
            errors["owner_id"] = "Choose an owner."
    if errors:
        raise Invalid(next(iter(errors.values())), errors)
    return out


def check_parent(ctx: Ctx, parent_type: str | None, parent_id: str | None, required: bool) -> tuple[str, str] | None:
    """The (parent_type, parent_id) of a note or task; the actor must be able to view the parent (else 404)."""
    if parent_type is None and parent_id is None:
        if required:
            raise Invalid("Choose the record this belongs to.", {"parent_type": "Required."})
        return None
    if parent_type is None or parent_id is None:
        raise Invalid("parent_type and parent_id go together.", {"parent_type": "parent_type and parent_id go together."})
    if not visible_exists(ctx, PARENT_TYPES[parent_type], parent_id):
        raise NotFound("Parent record not found.", {"parent_id": "Parent record not found."})
    return parent_type, parent_id
