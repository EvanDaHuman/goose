"""Configuration.

Two sources, kept apart on purpose:

* ``Settings`` - the process environment (``DATABASE_URL``, ``SESSION_SECRET``, ``HOST``, ``PORT``,
  ``WORKSPACE_CONFIG``). Secrets live only here, never in code or in config.json.
* ``WorkspaceConfig`` - the per-job ``config.json`` generated from the inspection of the customer's SuiteCRM:
  stages, dropdowns, custom field labels, the approval rule's parameters and the access settings.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

log = logging.getLogger("sales_workspace")

TARGET_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = TARGET_DIR / "config.example.json"

LIST_NAMES = (
    "lead_statuses",
    "task_statuses",
    "task_priorities",
    "account_types",
    "industries",
    "lead_sources",
    "contact_roles",
)

# Keys that are never exposed through /api/meta, wherever they appear in config.json.
_SECRET_MARKERS = ("secret", "password", "token", "api_key", "apikey", "credential", "private")


class ConfigError(ValueError):
    """config.json is missing something the application needs."""


@dataclass(frozen=True)
class Settings:
    database_url: str
    session_secret: str
    host: str = "127.0.0.1"
    port: int = 8090
    workspace_config: Path = DEFAULT_CONFIG_PATH
    pool_min: int = 1
    pool_max: int = 10
    session_hours: int = 8
    cookie_secure: bool = False

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        env = os.environ if env is None else env
        database_url = env.get("DATABASE_URL", "").strip()
        if not database_url:
            raise ConfigError("DATABASE_URL is not set (e.g. postgresql://user:password@127.0.0.1:5432/sales_workspace).")
        secret = env.get("SESSION_SECRET", "").strip()
        if not secret:
            secret = secrets.token_urlsafe(48)
            log.warning("SESSION_SECRET is not set: using a random secret, so sessions end when the process restarts.")
        config_path = Path(env.get("WORKSPACE_CONFIG") or DEFAULT_CONFIG_PATH)
        return cls(
            database_url=database_url,
            session_secret=secret,
            host=env.get("HOST", "127.0.0.1") or "127.0.0.1",
            port=int(env.get("PORT", "8090") or 8090),
            workspace_config=config_path,
            pool_min=int(env.get("DB_POOL_MIN", "1")),
            pool_max=int(env.get("DB_POOL_MAX", "10")),
            cookie_secure=env.get("SESSION_COOKIE_SECURE", "").lower() in ("1", "true", "yes"),
        )


@dataclass(frozen=True)
class Stage:
    key: str
    label: str
    probability: int | None
    won: bool = False
    lost: bool = False

    @property
    def closed(self) -> bool:
        return self.won or self.lost


DEFAULT_MESSAGES = {
    "not_manager": "Only a sales manager on this team can approve or reject a deal.",
    "withdrawn": "The amount is now above the approved amount, so the approval was withdrawn.",
    "blocked": "Deals above the approval threshold need approval from a sales manager before they can be marked won. "
    "Approval has been requested.",
}


@dataclass(frozen=True)
class RuleConfig:
    """The approval rule's parameters (``config.approval_rule``)."""

    enabled: bool = True
    threshold_usd: Decimal = Decimal("25000")
    won_stage: str = "Closed Won"
    fallback_stage: str = "Negotiation/Review"
    manager_role: str = "Sales Manager"
    same_team_required: bool = True
    admin_can_approve: bool = True
    withdraw_if_amount_exceeds_approved: bool = True
    messages: dict = field(default_factory=lambda: dict(DEFAULT_MESSAGES))

    @classmethod
    def from_dict(cls, raw: dict) -> "RuleConfig":
        messages = dict(DEFAULT_MESSAGES)
        messages.update({k: str(v) for k, v in (raw.get("messages") or {}).items()})
        return cls(
            enabled=bool(raw.get("enabled", True)),
            threshold_usd=Decimal(str(raw.get("threshold_usd", 25000))),
            won_stage=str(raw.get("won_stage", "Closed Won")),
            fallback_stage=str(raw.get("fallback_stage", "Negotiation/Review")),
            manager_role=str(raw.get("manager_role", "Sales Manager")),
            same_team_required=bool(raw.get("same_team_required", True)),
            admin_can_approve=bool(raw.get("admin_can_approve", True)),
            withdraw_if_amount_exceeds_approved=bool(raw.get("withdraw_if_amount_exceeds_approved", True)),
            messages=messages,
        )


class WorkspaceConfig:
    """Typed access to config.json."""

    def __init__(self, raw: dict, path: Path | None = None):
        self.raw = raw
        self.path = path
        self.workspace_name = str(raw.get("workspace_name") or "Sales workspace")
        self.customer = str(raw.get("customer") or "")
        self.synthetic = bool(raw.get("synthetic", False))
        self.job_id = str(raw.get("job_id") or "")
        self.source_system = dict(raw.get("source_system") or {})

        stages = raw.get("stages") or []
        if not stages:
            raise ConfigError("config.json: 'stages' must list the deal stages in pipeline order.")
        self.rule = RuleConfig.from_dict(raw.get("approval_rule") or {})
        parsed = []
        for s in stages:
            if "key" not in s:
                raise ConfigError("config.json: every stage needs a 'key'.")
            key = str(s["key"])
            parsed.append(
                Stage(
                    key=key,
                    label=str(s.get("label") or key),
                    probability=int(s["probability"]) if s.get("probability") is not None else None,
                    won=bool(s.get("won")) or key == self.rule.won_stage,
                    lost=bool(s.get("lost")),
                )
            )
        if len({s.key for s in parsed}) != len(parsed):
            raise ConfigError("config.json: stage keys must be unique.")
        if not any(s.lost for s in parsed):
            parsed = [Stage(s.key, s.label, s.probability, s.won, s.key == "Closed Lost") for s in parsed]
        self.stages: tuple[Stage, ...] = tuple(parsed)
        self.stage_by_key = {s.key: s for s in self.stages}
        if self.rule.enabled:
            for name in ("won_stage", "fallback_stage"):
                if getattr(self.rule, name) not in self.stage_by_key:
                    raise ConfigError(f"config.json: approval_rule.{name} '{getattr(self.rule, name)}' is not a stage.")

        self.lists: dict[str, tuple[tuple[str, str], ...]] = {}
        for name in LIST_NAMES:
            items = raw.get(name) or []
            self.lists[name] = tuple((str(o["key"]), str(o.get("label") or o["key"])) for o in items if "key" in o)
        flagged_closed = {str(o["key"]) for o in raw.get("task_statuses") or [] if o.get("closed")}
        self.closed_task_statuses = frozenset(flagged_closed or {"Completed", "Deferred"})

        access = raw.get("access") or {}
        self.additive = bool(access.get("additive", True))
        self.inherit_creator = bool(access.get("inherit_creator", True))
        self.inherit_assigned = bool(access.get("inherit_assigned", True))
        self.inherit_parent = bool(access.get("inherit_parent", True))

        lc = raw.get("lead_conversion") or {}
        self.conversion_activities = str(lc.get("activities", "donothing"))
        if self.conversion_activities not in ("donothing", "move", "copy"):
            raise ConfigError("config.json: lead_conversion.activities must be donothing, move or copy.")
        self.account_match = str(lc.get("account_match", "exact_suggest"))
        self.similar_threshold = float(lc.get("similar_threshold", 0.8))
        self.default_contact_role = lc.get("default_contact_role") or None

        self.custom_fields = list(raw.get("custom_fields") or [])
        self.renewal_window_days = int(raw.get("renewal_window_days", 90))
        self.record_url_template = (raw.get("external") or {}).get("record_url") or ""

    # ----------------------------------------------------------------------------------------------- stages
    @property
    def stage_keys(self) -> list[str]:
        return [s.key for s in self.stages]

    @property
    def won_stage_keys(self) -> list[str]:
        return [s.key for s in self.stages if s.won]

    @property
    def lost_stage_keys(self) -> list[str]:
        return [s.key for s in self.stages if s.lost]

    @property
    def closed_stage_keys(self) -> list[str]:
        return [s.key for s in self.stages if s.closed]

    @property
    def open_stages(self) -> list[Stage]:
        return [s for s in self.stages if not s.closed]

    def stage_label(self, key: str | None) -> str:
        if key is None:
            return ""
        stage = self.stage_by_key.get(key)
        return stage.label if stage else key

    def stage_probability(self, key: str | None) -> int | None:
        stage = self.stage_by_key.get(key or "")
        return stage.probability if stage else None

    # ----------------------------------------------------------------------------------------------- lists
    def options(self, name: str) -> list[tuple[str, str]]:
        return list(self.lists.get(name, ()))

    def option_keys(self, name: str) -> set[str]:
        return {k for k, _ in self.lists.get(name, ())}

    def label(self, name: str, key: str | None) -> str:
        if key is None:
            return ""
        for k, label in self.lists.get(name, ()):
            if k == key:
                return label
        return key

    def first_key(self, name: str, default: str) -> str:
        items = self.lists.get(name, ())
        return items[0][0] if items else default

    def field_label(self, entity: str, column: str, default: str) -> str:
        for f in self.custom_fields:
            if f.get("entity") == entity and f.get("column") == column and f.get("label"):
                return str(f["label"])
        return default

    # ----------------------------------------------------------------------------------------------- external links
    def record_url(self, module: str, record_id: str) -> str | None:
        if not self.record_url_template:
            return None
        return self.record_url_template.replace("{module}", module).replace("{id}", record_id)

    # ----------------------------------------------------------------------------------------------- /api/meta
    def meta(self) -> dict:
        """The non-secret parts of config.json."""
        keys = (
            "workspace_name", "customer", "synthetic", "job_id", "source_system", "stages", *LIST_NAMES,
            "approval_rule", "access", "lead_conversion", "custom_fields", "renewal_window_days", "external",
        )
        return {k: _scrub(self.raw[k]) for k in keys if k in self.raw}


def _scrub(value):
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if not any(m in str(k).lower() for m in _SECRET_MARKERS)}
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


def load_workspace_config(path: Path | str) -> WorkspaceConfig:
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError(f"WORKSPACE_CONFIG file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConfigError(f"WORKSPACE_CONFIG is not valid JSON: {path}: {exc}") from exc
    return WorkspaceConfig(raw, path)
