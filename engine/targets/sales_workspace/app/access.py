"""Access levels and the SQL visibility clauses (SuiteCRM role actions + security groups, as in SPEC.md).

* A user's level for (entity, action) is the most permissive level among the ``role_permissions`` rows of their
  roles (``config.access.additive``; the least permissive when additive is off). Order: none < own < team < all.
* No row on any of the user's roles means SuiteCRM's "Not set", which allows (``all``); an explicit row on one role
  beats "Not set" on another, as in SuiteCRM. A user without any role therefore has ``all``.
* The entity's ``access`` row is combined the same way; when it comes out disabled every action is ``none``.
* Administrators have ``all`` everywhere.
* own  -> ``owner_id = user``; team -> owned, or a ``record_teams`` row for one of the user's teams; all -> every row.
  Soft-deleted rows (``deleted_at``) are never visible at any level.

Every list, search, related list, detail read and write in the service layer builds its WHERE clause with
``clause()``, so the rule lives in exactly one place. Clauses use the named parameters ``%(actor_id)s`` and
``%(actor_teams)s``; ``Actor.params()`` supplies them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import RuleConfig

ENTITIES = ("accounts", "contacts", "leads", "deals", "notes", "tasks")
ACTIONS = ("access", "list", "view", "edit", "delete")
LEVELS = ("none", "own", "team", "all")
RANK = {name: i for i, name in enumerate(LEVELS)}

# The singular names used by notes.parent_type / tasks.parent_type, and SuiteCRM's module names.
PARENT_TYPES = {"account": "accounts", "contact": "contacts", "deal": "deals", "lead": "leads"}
SINGULAR = {"accounts": "account", "contacts": "contact", "leads": "lead", "deals": "deal", "notes": "note", "tasks": "task"}
MODULES = {
    "accounts": "Accounts", "contacts": "Contacts", "leads": "Leads", "deals": "Opportunities",
    "notes": "Notes", "tasks": "Tasks",
}


def _normalise(action: str, level: str | None) -> str:
    """Map a stored level to one of LEVELS. Unknown values fail closed."""
    if level is None:
        return "all"  # SuiteCRM "Not set"
    level = level.lower()
    if level in RANK:
        return level
    if level == "enabled":
        return "all"
    if level == "disabled":
        return "none"
    return "none"


def compute_levels(is_admin: bool, role_perms: list[dict[tuple[str, str], str]], additive: bool = True) -> dict:
    """Effective level per (entity, action) from the per-role permission maps, as SuiteCRM's ACLAction does:
    an explicit setting on any of the user's roles always beats "Not set" on another; among explicit settings the
    most permissive wins (additive; the least permissive otherwise); with no setting at all the level is ``all``.
    The entity's ``access`` is worked out the same way, and a disabled access makes every action ``none``."""
    pick = max if additive else min
    levels: dict[tuple[str, str], str] = {}
    for entity in ENTITIES:
        access_rows = [p[(entity, "access")] for p in role_perms if (entity, "access") in p]
        enabled = [str(v).lower() not in ("disabled", "none") for v in access_rows]
        access_on = pick(enabled) if enabled else True
        for action in ACTIONS:
            if is_admin:
                levels[(entity, action)] = "all"
            elif not access_on:
                levels[(entity, action)] = "none"
            elif action == "access":
                levels[(entity, action)] = "all"
            else:
                rows = [_normalise(action, p[(entity, action)]) for p in role_perms if (entity, action) in p]
                levels[(entity, action)] = pick(rows, key=RANK.__getitem__) if rows else "all"
    return levels


@dataclass
class Actor:
    """The signed-in user, with everything the access rules need."""

    id: str
    user_name: str
    first_name: str | None = None
    last_name: str | None = None
    title: str | None = None
    email: str | None = None
    timezone: str = "UTC"
    is_admin: bool = False
    roles: tuple[tuple[str, str], ...] = ()  # (id, name)
    teams: tuple[tuple[str, str], ...] = ()  # (id, name)
    levels: dict = field(default_factory=dict)

    @property
    def name(self) -> str:
        full = " ".join(p for p in (self.first_name, self.last_name) if p).strip()
        return full or self.user_name

    @property
    def role_names(self) -> list[str]:
        return [name for _, name in self.roles]

    @property
    def team_ids(self) -> list[str]:
        return [tid for tid, _ in self.teams]

    @property
    def team_names(self) -> list[str]:
        return [name for _, name in self.teams]

    def level(self, entity: str, action: str) -> str:
        if self.is_admin:
            return "all"
        return self.levels.get((entity, action), "none")

    def can(self, entity: str, action: str) -> bool:
        return self.level(entity, action) != "none"

    def params(self) -> dict:
        return {"actor_id": self.id, "actor_teams": self.team_ids}

    # ---------------------------------------------------------------------------------------- approval rule
    def is_manager(self, rule: RuleConfig) -> bool:
        """Has an approval queue at all: an administrator (when admins may approve) or a holder of the manager role."""
        return (self.is_admin and rule.admin_can_approve) or rule.manager_role in self.role_names

    def manages_team_ids(self, rule: RuleConfig, all_team_ids: list[str]) -> list[str]:
        if self.is_admin and rule.admin_can_approve:
            return list(all_team_ids)
        if rule.manager_role not in self.role_names:
            return []
        return list(all_team_ids) if not rule.same_team_required else self.team_ids


def is_team_manager(actor: Actor, owner_team_ids: list[str] | set[str], rule: RuleConfig) -> bool:
    """SPEC: the user is an admin, or has the manager role and shares at least one team with the deal's owner
    (``owner_team_ids`` are the teams of the deal's owner, or of the acting user when the deal has no owner)."""
    if actor.is_admin and rule.admin_can_approve:
        return True
    if rule.manager_role not in actor.role_names:
        return False
    if not rule.same_team_required:
        return True
    return bool(set(owner_team_ids) & set(actor.team_ids))


def team_manager_clause(actor: Actor, rule: RuleConfig, alias: str = "d") -> str:
    """The same test as ``is_team_manager`` as SQL over a deals row, for the approvals queue."""
    if actor.is_admin and rule.admin_can_approve:
        return "TRUE"
    if rule.manager_role not in actor.role_names:
        return "FALSE"
    if not rule.same_team_required:
        return "TRUE"
    return (
        "EXISTS (SELECT 1 FROM user_teams ut_m WHERE ut_m.user_id = COALESCE("
        f"{alias}.owner_id, %(actor_id)s) AND ut_m.team_id = ANY(%(actor_teams)s::text[]))"
    )


def level_clause(level: str, entity: str, alias: str) -> str:
    """SQL for one access level over ``alias`` (a row of ``entity``), excluding soft-deleted rows."""
    assert entity in ENTITIES and alias.isidentifier()
    alive = f"{alias}.deleted_at IS NULL"
    if level == "all":
        return f"({alive})"
    if level == "own":
        return f"({alive} AND {alias}.owner_id = %(actor_id)s)"
    if level == "team":
        return (
            f"({alive} AND ({alias}.owner_id = %(actor_id)s OR EXISTS (SELECT 1 FROM record_teams rt_v "
            f"WHERE rt_v.entity = '{entity}' AND rt_v.record_id = {alias}.id "
            f"AND rt_v.team_id = ANY(%(actor_teams)s::text[]))))"
        )
    return "FALSE"


def clause(actor: Actor, entity: str, action: str, alias: str) -> str:
    """WHERE fragment: the rows of ``entity`` (as ``alias``) that ``actor`` may ``action``."""
    return level_clause(actor.level(entity, action), entity, alias)
