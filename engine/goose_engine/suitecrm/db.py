"""Read-only access to a workbench copy of a SuiteCRM database (PyMySQL)."""
import json
from pathlib import Path

import pymysql
import pymysql.cursors

ROOT = Path(__file__).resolve().parents[3]


def connect(db, user="gs_reader", port=3327, host="127.0.0.1", password=None):
    if password is None:
        c = json.loads((ROOT / "var" / "workbench" / "credentials.json").read_text())
        password = c["root_password"] if user == "root" else c["reader_password"]
    return pymysql.connect(host=host, port=port, user=user, password=password, database=db, charset="utf8mb4",
                           cursorclass=pymysql.cursors.DictCursor, autocommit=True)


def rows(conn, sql, args=None):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return list(cur.fetchall())


def one(conn, sql, args=None):
    r = rows(conn, sql, args)
    return r[0] if r else None


def scalar(conn, sql, args=None):
    r = one(conn, sql, args)
    return None if r is None else next(iter(r.values()))
