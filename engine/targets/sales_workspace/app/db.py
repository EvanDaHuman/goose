"""PostgreSQL access: psycopg 3 with a connection pool.

Connections run in autocommit mode; every multi-row write is wrapped in an explicit ``with conn.transaction():``
block by the service layer (nested blocks become savepoints). Rows come back as dicts. Every statement is
parameterised; identifiers that are composed into SQL come only from fixed whitelists in the code.
"""
from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import Settings

Connection = psycopg.Connection
UniqueViolation = psycopg.errors.UniqueViolation


def _configure(conn: psycopg.Connection) -> None:
    conn.execute("SET TIME ZONE 'UTC'")


def make_pool(settings: Settings) -> ConnectionPool:
    return ConnectionPool(
        settings.database_url,
        min_size=settings.pool_min,
        max_size=max(settings.pool_max, settings.pool_min),
        kwargs={"autocommit": True, "row_factory": dict_row},
        configure=_configure,
        check=ConnectionPool.check_connection,
        open=False,
        name="sales-workspace",
    )


def fetch_one(conn: Connection, sql: str, params: Any = None) -> dict | None:
    return conn.execute(sql, params).fetchone()


def fetch_all(conn: Connection, sql: str, params: Any = None) -> list[dict]:
    return conn.execute(sql, params).fetchall()


def fetch_val(conn: Connection, sql: str, params: Any = None) -> Any:
    row = conn.execute(sql, params).fetchone()
    if row is None:
        return None
    return next(iter(row.values()))


def execute(conn: Connection, sql: str, params: Any = None) -> int:
    return conn.execute(sql, params).rowcount
