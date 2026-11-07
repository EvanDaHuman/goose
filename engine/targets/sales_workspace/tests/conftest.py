"""Test harness: throwaway PostgreSQL databases built from schema.sql + tests/fixture.sql.

A template database ``sw_test_<random>_tpl`` is built once per session; every test that needs the database gets
its own copy (``CREATE DATABASE sw_test_<random> TEMPLATE ...``), so tests never see each other's writes. All
databases are created and dropped here with the project's PostgreSQL admin user, whose password is read from
``var/pg/admin-password`` (never printed). Overrides: SW_TEST_PG_HOST, SW_TEST_PG_PORT, SW_TEST_PG_USER,
SW_TEST_PG_PASSWORD_FILE.
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

TARGET = Path(__file__).resolve().parents[1]
ROOT = TARGET.parents[1].parent
sys.path.insert(0, str(TARGET))

from app.auth import load_actor  # noqa: E402
from app.config import Settings, load_workspace_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.base import Ctx  # noqa: E402

# The fixture users' SuiteCRM-style hashes are bcrypt(md5(TEST_PASSWORD)).
TEST_PASSWORD = "sample-test-2026"
CONFIG_PATH = TARGET / "config.example.json"

PG_HOST = os.environ.get("SW_TEST_PG_HOST", "127.0.0.1")
PG_PORT = int(os.environ.get("SW_TEST_PG_PORT", "54329"))
PG_USER = os.environ.get("SW_TEST_PG_USER", "goose_admin")
PG_PASSWORD_FILE = Path(os.environ.get("SW_TEST_PG_PASSWORD_FILE", ROOT / "var" / "pg" / "admin-password"))


def _password() -> str:
    return PG_PASSWORD_FILE.read_text(encoding="utf-8").strip()


def dsn(dbname: str) -> str:
    return make_conninfo(host=PG_HOST, port=PG_PORT, user=PG_USER, password=_password(), dbname=dbname)


def _admin_execute(sql: str) -> None:
    with psycopg.connect(dsn("postgres"), autocommit=True) as conn:
        conn.execute(sql)


def create_database(name: str, template: str | None = None) -> None:
    assert name.startswith("sw_test_") and name.replace("_", "").isalnum()
    if template:
        assert template.startswith("sw_test_") and template.replace("_", "").isalnum()
        _admin_execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
    else:
        _admin_execute(f'CREATE DATABASE "{name}"')


def drop_database(name: str) -> None:
    assert name.startswith("sw_test_") and name.replace("_", "").isalnum()
    _admin_execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def load_fixture(name: str) -> None:
    with psycopg.connect(dsn(name), autocommit=True) as conn:
        conn.execute((TARGET / "schema.sql").read_text(encoding="utf-8"))
        conn.execute((TARGET / "tests" / "fixture.sql").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def template_db():
    name = f"sw_test_{secrets.token_hex(4)}_tpl"
    create_database(name)
    try:
        load_fixture(name)
        yield name
    finally:
        drop_database(name)


@pytest.fixture
def db_name(template_db):
    name = f"sw_test_{secrets.token_hex(6)}"
    create_database(name, template=template_db)
    try:
        yield name
    finally:
        drop_database(name)


@pytest.fixture
def cfg():
    return load_workspace_config(CONFIG_PATH)


@pytest.fixture
def settings(db_name):
    return Settings(database_url=dsn(db_name), session_secret="test-session-secret-" + secrets.token_hex(8),
                    workspace_config=CONFIG_PATH, pool_min=1, pool_max=8)


@pytest.fixture
def app(settings, cfg):
    application = create_app(settings, cfg)
    application.state.pool.open(wait=True, timeout=10)
    try:
        yield application
    finally:
        application.state.pool.close()


@pytest.fixture
def anon(app):
    return TestClient(app)


@pytest.fixture
def login(app):
    """login('pnair') -> a TestClient signed in as that user (each call is a separate browser)."""

    def _login(user_name: str, password: str = TEST_PASSWORD) -> TestClient:
        client = TestClient(app)
        response = client.post("/api/login", json={"user_name": user_name, "password": password})
        assert response.status_code == 200, response.text
        return client

    return _login


@pytest.fixture
def db(db_name):
    """A direct autocommit connection to the test database, for assertions."""
    with psycopg.connect(dsn(db_name), autocommit=True, row_factory=dict_row) as conn:
        yield conn


@pytest.fixture
def ctx_for(db_name, cfg):
    """ctx_for('u-pnair') -> a service-layer Ctx on its own connection."""
    conns = []

    def _ctx(user_id: str) -> Ctx:
        conn = psycopg.connect(dsn(db_name), autocommit=True, row_factory=dict_row)
        conn.execute("SET TIME ZONE 'UTC'")
        conns.append(conn)
        actor = load_actor(conn, cfg, user_id)
        assert actor is not None, user_id
        return Ctx(conn=conn, actor=actor, cfg=cfg)

    yield _ctx
    for conn in conns:
        conn.close()
