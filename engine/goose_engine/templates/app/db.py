"""PostgreSQL access for the upgraded application (psycopg 3 with a connection pool).

This replaces the sqlite3 connection the old code opened by hand in every request.

* Every request borrows one pooled connection and works inside one transaction.
* Changes are saved only when the handler calls ``db.commit()`` - exactly as before. Anything a
  handler did not commit is rolled back when the request ends, which is what closing a sqlite3
  connection used to do.
* Rows can be read by column name (``row["total"]``) or position (``row[0]``), like sqlite3.Row.
* ``db.lock(name)`` takes a transaction-scoped lock, used to make stock checks and stock updates
  happen one order at a time.
"""
from contextlib import contextmanager

from psycopg import errors
from psycopg_pool import ConnectionPool

from .settings import settings

IntegrityError = errors.IntegrityError
DatabaseError = errors.DatabaseError
OperationalError = errors.OperationalError


class Row(dict):
    """A result row readable by column name or by position."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return dict.__getitem__(self, key)


def _row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []

    def make(values):
        return Row(zip(names, values))

    return make


class Result:
    """What ``db.execute`` returns: fetchone/fetchall/rowcount/lastrowid, like a sqlite3 cursor."""

    def __init__(self, cursor, sql):
        self._cursor = cursor
        self.rowcount = cursor.rowcount
        self.lastrowid = None
        if cursor.description is not None and sql.lstrip()[:6].upper() == "INSERT":
            row = cursor.fetchone()
            self.lastrowid = row[0] if row else None

    def fetchone(self):
        return self._cursor.fetchone()

    def fetchall(self):
        return self._cursor.fetchall()

    def __iter__(self):
        return iter(self._cursor.fetchall())


class Db:
    def __init__(self, conn):
        self._conn = conn
        self._defer_commit = False

    def execute(self, sql, params=()):
        cur = self._conn.cursor(row_factory=_row_factory)
        # always pass a tuple so psycopg treats "%%" as a literal percent sign
        cur.execute(sql, tuple(params) if params is not None else ())
        return Result(cur, sql)

    def commit(self):
        if not self._defer_commit:
            self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def lock(self, name):
        """Hold a named lock until this request's transaction ends."""
        self._conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (name,))

    @contextmanager
    def deferred_commit(self):
        """Make handler commits wait, so a caller can save more work in the same transaction."""
        self._defer_commit = True
        try:
            yield
        finally:
            self._defer_commit = False

    def commit_now(self):
        self._conn.commit()


def _configure(conn):
    conn.execute("SELECT set_config('TimeZone', %s, false)", (settings.business_timezone,))
    conn.commit()


pool = ConnectionPool(
    settings.database_url,
    min_size=settings.pool_min,
    max_size=settings.pool_max,
    configure=_configure,
    check=ConnectionPool.check_connection,  # a connection dropped by a database restart is replaced, not used
    open=False,
)


def get_db():
    """FastAPI dependency: one pooled connection per request."""
    conn = pool.getconn()
    try:
        yield Db(conn)
    finally:
        try:
            conn.rollback()  # like closing a sqlite3 connection: unsaved changes are discarded
        finally:
            pool.putconn(conn)
