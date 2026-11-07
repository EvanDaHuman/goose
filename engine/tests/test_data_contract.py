import copy
import sqlite3
import pytest

from goose_engine.data_contract import apply, migrate
from goose_verify.replatform import compare, snapshot


@pytest.fixture
def source(tmp_path):
    p = tmp_path / "source.sqlite"
    with sqlite3.connect(p) as c:
        c.executescript("CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT);"
                        "CREATE TABLE notes(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), body BLOB);")
        c.executemany("INSERT INTO customers VALUES(?,?,?)", [(7, "Zoë 李", None), (30, "Alex", ""), (99, "Alex", "a@example.test")])
        c.execute("INSERT INTO notes VALUES(2,7,?)", (b'\x00\xff',))
    return p


@pytest.fixture
def contract():
    return {"id": "upgrade-1", "data_changes": [
        {"op": "add_column", "table": "customers", "column": {"name": "tier", "type": "TEXT", "required": True, "default": "standard"}},
        {"op": "rename_column", "table": "customers", "from": "email", "to": "email_address"},
        {"op": "create_table", "table": "tags", "columns": [{"name": "id", "type": "INTEGER", "primary_key": True},
            {"name": "label", "type": "TEXT", "required": True, "unique": True}]},
        {"op": "insert_rows", "table": "tags", "rows": [{"id": 3, "label": "Priority"}]},
    ]}


def test_preserves_all_cells_and_new_writes(source, contract, tmp_path):
    before = source.read_bytes()
    out = tmp_path / "new.sqlite"
    migrate(source, out, contract)
    assert source.read_bytes() == before
    assert compare(snapshot(source), snapshot(out), contract["data_changes"]) == []
    with sqlite3.connect(out) as c:
        c.execute("PRAGMA foreign_keys=ON")
        row_id = c.execute("INSERT INTO customers(name) VALUES('New')").lastrowid
        assert row_id == 100
        c.execute("INSERT INTO notes VALUES(3,?,?)", (row_id, b'new'))
    with sqlite3.connect(out) as c:
        assert c.execute("SELECT tier,email_address FROM customers WHERE id=100").fetchone() == ("standard", None)
        assert not apply(c, contract)["applied"]
        changed = copy.deepcopy(contract)
        changed["data_changes"][0]["column"]["default"] = "premium"
        with pytest.raises(ValueError, match="different contract"):
            apply(c, changed)


def test_failure_rolls_back_and_never_publishes(source, contract, tmp_path):
    contract["data_changes"].append({"op": "insert_rows", "table": "notes", "rows": [{"id": 3, "customer_id": 999, "body": "bad"}]})
    with pytest.raises(sqlite3.IntegrityError):
        migrate(source, tmp_path / "bad.sqlite", contract)
    assert not (tmp_path / "bad.sqlite").exists()
    with sqlite3.connect(source) as c:
        with pytest.raises(sqlite3.IntegrityError):
            apply(c, contract)
        assert "tier" not in [r[1] for r in c.execute("PRAGMA table_info(customers)")]
        assert not c.execute("SELECT name FROM sqlite_master WHERE name='_goose_migrations'").fetchall()


def test_fresh_snapshot_includes_later_data_and_refuses_overwrite(source, contract, tmp_path):
    migrate(source, tmp_path / "first.sqlite", contract)
    with sqlite3.connect(source) as c:
        c.execute("INSERT INTO customers(name) VALUES('Arrived during migration')")
    migrate(source, tmp_path / "latest.sqlite", contract)
    assert compare(snapshot(source), snapshot(tmp_path / "latest.sqlite"), contract["data_changes"]) == []
    with pytest.raises(ValueError, match="never overwritten"):
        migrate(source, tmp_path / "first.sqlite", contract)
    with pytest.raises(ValueError):
        migrate(source, source, contract)


@pytest.mark.parametrize("corrupt", ["UPDATE customers SET name='WRONG' WHERE id=7", "DELETE FROM notes", "UPDATE notes SET customer_id=999", "ALTER TABLE customers ADD COLUMN unapproved TEXT", "UPDATE sqlite_sequence SET seq=999 WHERE name='customers'"])
def test_independent_oracle_catches_corruption(source, contract, tmp_path, corrupt):
    out = tmp_path / "new.sqlite"
    migrate(source, out, contract)
    with sqlite3.connect(out) as c:
        c.execute(corrupt)
    assert compare(snapshot(source), snapshot(out), contract["data_changes"])


def test_required_backfill_and_identifier_validation(source, tmp_path):
    for column in [{"name": "tier", "type": "TEXT", "required": True}, {"name": 'x; DROP TABLE customers', "type": "TEXT"}]:
        with pytest.raises(ValueError):
            migrate(source, tmp_path / "bad.sqlite", {"id": "v1", "data_changes": [{"op": "add_column", "table": "customers", "column": column}]})
