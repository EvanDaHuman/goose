"""Sign-in, the session cookie and loading the signed-in user.

* ``password_scheme = 'suitecrm-bcrypt-md5'``: SuiteCRM 7 stores ``password_hash(strtolower(md5(password)))``, so the
  check is ``bcrypt.checkpw(md5(password).hexdigest().lower(), hash)`` (PHP's ``$2y$`` prefix is accepted).
* ``password_scheme = 'bcrypt'``: a plain bcrypt hash of the password.
* Inactive users, users without a hash, unknown users and wrong passwords all fail the same way (and take about the
  same time: an unknown user still costs one bcrypt check).
* The session is a signed cookie ``lw_session`` (HttpOnly, SameSite=Lax, 8 hours) holding the user id and a CSRF
  token for the HTML forms. The user is reloaded on every request, so deactivating a user ends their session.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

import bcrypt
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import db
from .access import Actor, compute_levels
from .config import WorkspaceConfig

SESSION_COOKIE = "lw_session"
FLASH_COOKIE = "lw_flash"

_DUMMY_HASH: bytes | None = None


def _dummy_hash() -> bytes:
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = bcrypt.hashpw(secrets.token_bytes(16).hex().encode(), bcrypt.gensalt(rounds=10))
    return _DUMMY_HASH


def hash_password(password: str, scheme: str = "bcrypt", rounds: int = 12) -> str:
    """Hash for users created in the workspace (``bcrypt``) or a SuiteCRM-compatible one (``suitecrm-bcrypt-md5``)."""
    if scheme == "suitecrm-bcrypt-md5":
        secret = hashlib.md5(password.encode("utf-8")).hexdigest().lower().encode()
    else:
        secret = password.encode("utf-8")
    return bcrypt.hashpw(secret, bcrypt.gensalt(rounds=rounds)).decode()


def verify_password(password: str, stored_hash: str | None, scheme: str | None) -> bool:
    if not stored_hash or scheme not in ("suitecrm-bcrypt-md5", "bcrypt"):
        return False
    if scheme == "suitecrm-bcrypt-md5":
        secret = hashlib.md5(password.encode("utf-8")).hexdigest().lower().encode()
    else:
        secret = password.encode("utf-8")
    try:
        return bcrypt.checkpw(secret, stored_hash.encode("utf-8"))
    except ValueError:  # malformed hash, or a plain password longer than bcrypt's 72 bytes
        return False


def authenticate(conn: db.Connection, user_name: str, password: str) -> dict | None:
    """The user row for valid credentials of an active user, else None."""
    user_name = (user_name or "").strip()
    row = None
    if user_name:
        row = db.fetch_one(
            conn,
            "SELECT id, user_name, status, password_hash, password_scheme FROM users WHERE user_name = %s",
            (user_name,),
        )
        if row is None:
            rows = db.fetch_all(
                conn,
                "SELECT id, user_name, status, password_hash, password_scheme FROM users "
                "WHERE lower(user_name) = lower(%s)",
                (user_name,),
            )
            row = rows[0] if len(rows) == 1 else None
    if row is None or not row["password_hash"]:
        bcrypt.checkpw(b"timing-equaliser", _dummy_hash())
        return None
    ok = verify_password(password or "", row["password_hash"], row["password_scheme"])
    if not ok or row["status"] != "active":
        return None
    return row


# --------------------------------------------------------------------------------------------------- sessions
class SessionCodec:
    def __init__(self, secret: str, max_age_seconds: int):
        self._serializer = URLSafeTimedSerializer(secret, salt="lw-session")
        self._flash = URLSafeTimedSerializer(secret, salt="lw-flash")
        self.max_age = max_age_seconds

    def issue(self, user_id: str) -> tuple[str, str]:
        csrf = secrets.token_urlsafe(24)
        sid = secrets.token_urlsafe(18)
        return self._serializer.dumps({"uid": user_id, "sid": sid, "csrf": csrf}), csrf

    def read(self, token: str | None) -> dict | None:
        if not token:
            return None
        try:
            data = self._serializer.loads(token, max_age=self.max_age)
        except BadSignature:  # includes SignatureExpired
            return None
        if not isinstance(data, dict) or not isinstance(data.get("uid"), str) or not isinstance(data.get("sid"), str):
            return None
        return data

    def dump_flash(self, messages: list[dict]) -> str:
        return self._flash.dumps(messages)

    def read_flash(self, token: str | None) -> list[dict]:
        if not token:
            return []
        try:
            data = self._flash.loads(token, max_age=600)
        except BadSignature:
            return []
        return [m for m in data if isinstance(m, dict)] if isinstance(data, list) else []


def csrf_ok(expected: str | None, given: str | None) -> bool:
    return bool(expected) and bool(given) and hmac.compare_digest(str(expected), str(given))


# Signing out ends the session on the server too: the session id is remembered (in the schema's generic
# request_keys table, under a namespaced key) until the cookie would have expired anyway.
_REVOKED = "session-revoked:"


def session_revoked(conn: db.Connection, session: dict) -> bool:
    return db.fetch_one(conn, "SELECT 1 AS r FROM request_keys WHERE key = %s", (_REVOKED + session["sid"],)) is not None


def revoke_session(conn: db.Connection, session: dict | None, max_age_seconds: int) -> None:
    if not session:
        return
    with conn.transaction():
        db.execute(conn, "INSERT INTO request_keys (key, user_id, response) VALUES (%s, %s, '{}'::jsonb) "
                   "ON CONFLICT (key) DO NOTHING", (_REVOKED + session["sid"], session["uid"]))
        db.execute(conn, "DELETE FROM request_keys WHERE key LIKE 'session-revoked:%%' "
                   "AND created_at < now() - make_interval(secs => %s)", (max_age_seconds + 3600,))


def current_actor(conn: db.Connection, cfg: WorkspaceConfig, session: dict | None) -> Actor | None:
    """The signed-in, still-active user of a valid, not signed-out session."""
    if not session or session_revoked(conn, session):
        return None
    return load_actor(conn, cfg, session["uid"])


# --------------------------------------------------------------------------------------------------- the actor
def load_actor(conn: db.Connection, cfg: WorkspaceConfig, user_id: str) -> Actor | None:
    user = db.fetch_one(
        conn,
        "SELECT id, user_name, first_name, last_name, title, email, status, is_admin, timezone "
        "FROM users WHERE id = %s",
        (user_id,),
    )
    if user is None or user["status"] != "active":
        return None
    roles = db.fetch_all(
        conn,
        "SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = %s ORDER BY r.name",
        (user_id,),
    )
    perm_rows = db.fetch_all(
        conn,
        "SELECT rp.role_id, rp.entity, rp.action, rp.level FROM role_permissions rp "
        "JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = %s",
        (user_id,),
    )
    teams = db.fetch_all(
        conn,
        "SELECT t.id, t.name FROM user_teams ut JOIN teams t ON t.id = ut.team_id WHERE ut.user_id = %s ORDER BY t.name",
        (user_id,),
    )
    per_role: dict[str, dict] = {r["id"]: {} for r in roles}
    for p in perm_rows:
        per_role.setdefault(p["role_id"], {})[(p["entity"], p["action"])] = p["level"]
    levels = compute_levels(bool(user["is_admin"]), list(per_role.values()), cfg.additive)
    return Actor(
        id=user["id"],
        user_name=user["user_name"],
        first_name=user["first_name"],
        last_name=user["last_name"],
        title=user["title"],
        email=user["email"],
        timezone=user["timezone"] or "UTC",
        is_admin=bool(user["is_admin"]),
        roles=tuple((r["id"], r["name"]) for r in roles),
        teams=tuple((t["id"], t["name"]) for t in teams),
        levels=levels,
    )


def me_payload(conn: db.Connection, cfg: WorkspaceConfig, actor: Actor) -> dict:
    all_team_ids = [r["id"] for r in db.fetch_all(conn, "SELECT id FROM teams ORDER BY name")]
    return {
        "id": actor.id,
        "user_name": actor.user_name,
        "name": actor.name,
        "title": actor.title,
        "email": actor.email,
        "is_admin": actor.is_admin,
        "roles": actor.role_names,
        "teams": [{"id": tid, "name": name} for tid, name in actor.teams],
        "is_manager_of_teams": actor.manages_team_ids(cfg.rule, all_team_ids),
        "permissions": {
            entity: {action: actor.level(entity, action) for action in ("list", "view", "edit", "delete")}
            for entity in ("accounts", "contacts", "leads", "deals", "notes", "tasks")
        },
    }
