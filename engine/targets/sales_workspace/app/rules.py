"""The manager-approval rule for large deals, and the one deal-save path that applies it.

``apply_approval_rule`` is a pure function with the exact semantics of the customer's SuiteCRM before_save hook
(SPEC.md "The approval rule"), parameterised by ``config.approval_rule``:

1. Approving or rejecting (a change of approval_status to 'approved'/'rejected') by someone who is not a team
   manager for the deal keeps the previous status  -> message ``not_manager``.
2. A new approval records approved_amount_usd = amount_usd, approved_by and approved_at.
3. An approved deal whose amount_usd rises above approved_amount_usd + 0.005 goes back to 'requested'
   -> message ``withdrawn``. (A missing approved amount counts as 0, as in the hook.)
4. Moving a deal to the won stage above threshold_usd without a current approval keeps the previous stage
   (``fallback_stage`` for a new deal); '' or 'rejected' becomes 'requested' -> message ``blocked``.

``save_deal`` is used by every deal write: POST/PATCH /api/deals, pipeline stage moves, the approval endpoint and
lead conversion. It locks the stored row, recomputes ``amount_usd = round(amount / rate_per_usd, 6)`` whenever the
amount or currency changes, decides whether the actor is a team manager, applies the rule and writes the adjusted
values (with audit rows) in one transaction. The save itself succeeds, as in SuiteCRM.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, localcontext

from . import db
from .access import Actor, is_team_manager
from .config import RuleConfig
from .services.base import (
    Ctx, Forbidden, Invalid, fetch_for_edit, fetch_visible, insert_record, require_create, same_value, user_team_ids,
    validate, write_update,
)

SIX = Decimal("0.000001")
TWO = Decimal("0.01")
TOLERANCE = Decimal("0.005")
DECISIONS = ("requested", "approved", "rejected")


def compute_amount_usd(amount: Decimal, rate_per_usd: Decimal) -> Decimal:
    """``round(amount / rate_per_usd, 6)``; rate_per_usd is units of the currency per US dollar (USD = 1)."""
    with localcontext() as ctx:
        ctx.prec = 60
        return (Decimal(amount) / Decimal(rate_per_usd)).quantize(SIX, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class DealState:
    stage: str | None
    amount_usd: Decimal
    approval_status: str = ""
    approved_amount_usd: Decimal | None = None
    approved_by: str | None = None
    approved_at: datetime | None = None


@dataclass(frozen=True)
class RuleResult:
    stage: str | None
    approval_status: str
    approved_amount_usd: Decimal | None
    approved_by: str | None
    approved_at: datetime | None
    events: tuple[tuple[str, str], ...] = ()
    blocked: bool = False

    @property
    def messages(self) -> list[str]:
        return [message for _, message in self.events]

    @property
    def codes(self) -> list[str]:
        return [code for code, _ in self.events]


def apply_approval_rule(before: DealState | None, after: DealState, *, actor_id: str, is_team_manager: bool,
                        now: datetime, rule: RuleConfig) -> RuleResult:
    """Pure: the values to save for ``after`` (the deal with the requested changes) given ``before`` (the stored
    deal, or None for a new one) and whether the acting user is a team manager for the deal."""
    old_status = (before.approval_status or "") if before else ""
    old_stage = (before.stage or "") if before else ""
    status = after.approval_status or ""
    stage = after.stage
    usd = Decimal(after.amount_usd)
    approved_amount, approved_by, approved_at = after.approved_amount_usd, after.approved_by, after.approved_at
    events: list[tuple[str, str]] = []
    blocked = False

    # 1. Only a team manager may approve or reject.
    if rule.enabled and status != old_status and status in ("approved", "rejected") and not is_team_manager:
        status = old_status
        events.append(("not_manager", rule.messages["not_manager"]))

    # 2. Record a new approval.
    if status == "approved" and old_status != "approved":
        approved_amount = usd.quantize(TWO, rounding=ROUND_HALF_UP)
        approved_by = actor_id
        approved_at = now

    # 3. An approval covers the approved amount, not more.
    if (rule.enabled and rule.withdraw_if_amount_exceeds_approved and status == "approved"
            and usd > Decimal(approved_amount if approved_amount is not None else 0) + TOLERANCE):
        status = "requested"
        events.append(("withdrawn", rule.messages["withdrawn"]))

    # 4. Winning above the threshold needs a current approval.
    if (rule.enabled and stage == rule.won_stage and old_stage != rule.won_stage
            and usd > rule.threshold_usd and status != "approved"):
        stage = old_stage if old_stage != "" else rule.fallback_stage
        if status in ("", "rejected"):
            status = "requested"
        events.append(("blocked", rule.messages["blocked"]))
        blocked = True

    return RuleResult(stage, status, approved_amount, approved_by, approved_at, tuple(events), blocked)


def team_manager_for(ctx: Ctx, owner_id: str | None) -> bool:
    """Whether the acting user is a team manager for a deal owned by ``owner_id`` (the actor when unowned)."""
    return is_team_manager(ctx.actor, user_team_ids(ctx.conn, owner_id or ctx.actor.id), ctx.rule)


DEAL_COLUMNS = (
    "name", "account_id", "stage", "probability", "amount", "currency_code", "amount_usd", "close_date", "lead_source",
    "next_step", "description", "approval_status", "approved_by", "approved_amount_usd", "approved_at", "owner_id",
)


@dataclass
class DealSave:
    deal_id: str
    created: bool
    events: list[tuple[str, str]] = field(default_factory=list)
    blocked: bool = False
    changed: dict = field(default_factory=dict)

    @property
    def messages(self) -> list[str]:
        return [m for _, m in self.events]


def save_deal(ctx: Ctx, deal_id: str | None, data: dict, *, contact: tuple[str, str | None] | None = None,
              locked_before: dict | None = None, trusted: dict | None = None,
              check_contact: bool = True) -> DealSave:
    """Create (``deal_id=None``) or update a deal through the approval rule, in one transaction.

    ``contact`` = (contact_id, role) adds a deal_contacts row on create (the contact must be viewable unless
    ``check_contact`` is off). ``trusted`` holds values set by the system rather than the user (lead conversion
    links the new deal to the account and contact it has just created); they skip validation.
    """
    cfg = ctx.cfg
    with ctx.conn.transaction():
        if deal_id is None:
            require_create(ctx, "deals")
            data = dict(data)
            data.setdefault("stage", cfg.stages[0].key)
            if not data.get("currency_code"):
                data["currency_code"] = "USD" if "USD" in ctx.currencies() else next(iter(ctx.currencies()), None)
            for key in trusted or {}:
                data.pop(key, None)
            changes = validate(ctx, "deals", data)
            changes.update(trusted or {})
            before = None
            after = {k: None for k in DEAL_COLUMNS}
            after["approval_status"] = ""
            after.update(changes)
        else:
            before = locked_before or fetch_for_edit(ctx, "deals", deal_id)
            changes = validate(ctx, "deals", data, before)
            after = {k: before[k] for k in DEAL_COLUMNS}
            after.update(changes)
        if after.get("approval_status") is None:
            after["approval_status"] = ""

        if (before is None or not same_value(before["amount"], after["amount"])
                or before["currency_code"] != after["currency_code"]):
            rate = ctx.currencies()[after["currency_code"]]["rate_per_usd"]
            after["amount_usd"] = compute_amount_usd(after["amount"], rate)

        before_state = None if before is None else DealState(
            stage=before["stage"], amount_usd=before["amount_usd"], approval_status=before["approval_status"] or "",
            approved_amount_usd=before["approved_amount_usd"], approved_by=before["approved_by"],
            approved_at=before["approved_at"],
        )
        after_state = DealState(
            stage=after["stage"], amount_usd=after["amount_usd"], approval_status=after["approval_status"],
            approved_amount_usd=after["approved_amount_usd"], approved_by=after["approved_by"],
            approved_at=after["approved_at"],
        )
        owner_for_rule = after.get("owner_id") or (before["owner_id"] if before else None) or ctx.actor.id
        result = apply_approval_rule(
            before_state, after_state, actor_id=ctx.actor.id, is_team_manager=team_manager_for(ctx, owner_for_rule),
            now=datetime.now(timezone.utc), rule=ctx.rule,
        )
        after.update(
            stage=result.stage, approval_status=result.approval_status,
            approved_amount_usd=result.approved_amount_usd, approved_by=result.approved_by,
            approved_at=result.approved_at,
        )

        # Probability follows the stage unless the user set a different value; a blocked move keeps the old one.
        old_probability = before["probability"] if before else None
        explicit = "probability" in changes and not same_value(changes["probability"], old_probability)
        if result.blocked and explicit:
            explicit = False
            after["probability"] = old_probability
        if not explicit:
            if before is None or after["stage"] != before["stage"]:
                stage_probability = cfg.stage_probability(after["stage"])
                after["probability"] = stage_probability if stage_probability is not None else old_probability
            else:
                after["probability"] = old_probability

        if before is None:
            values = {k: after[k] for k in DEAL_COLUMNS}
            values["owner_id"] = values.get("owner_id") or ctx.actor.id
            new_id = insert_record(ctx, "deals", values)
            if contact is not None:
                contact_id, role = contact
                if check_contact:
                    fetch_visible(ctx, "contacts", contact_id)  # 404 if not viewable
                db.execute(
                    ctx.conn,
                    "INSERT INTO deal_contacts (deal_id, contact_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                    (new_id, contact_id, role),
                )
            return DealSave(new_id, True, list(result.events), result.blocked, {})
        changed = write_update(ctx, "deals", before, after)
        return DealSave(before["id"], False, list(result.events), result.blocked, changed)


def decide_approval(ctx: Ctx, deal_id: str, decision) -> DealSave:
    """POST /api/deals/{id}/approval: 'requested' by anyone who can edit the deal; 'approved'/'rejected' only by a
    team manager (403 with the not_manager message otherwise - a clearer API than SuiteCRM's silent revert);
    then the same rule path as every other save."""
    if not isinstance(decision, str) or decision not in DECISIONS:
        raise Invalid("decision must be 'requested', 'approved' or 'rejected'.", {"decision": "Invalid decision."})
    with ctx.conn.transaction():
        before = fetch_visible(ctx, "deals", deal_id, for_update=True)
        if decision in ("approved", "rejected") and not team_manager_for(ctx, before["owner_id"]):
            raise Forbidden(ctx.rule.messages["not_manager"], code="not_manager")
        if not before["_can_edit"]:
            raise Forbidden("You can view this deal but you are not allowed to change it.")
        return save_deal(ctx, deal_id, {"approval_status": decision}, locked_before=before)


def can_decide(ctx: Ctx, deal: dict) -> bool:
    return team_manager_for(ctx, deal.get("owner_id"))


def actor_is_team_manager(actor: Actor, owner_team_ids, rule: RuleConfig) -> bool:  # re-export for callers/tests
    return is_team_manager(actor, owner_team_ids, rule)
