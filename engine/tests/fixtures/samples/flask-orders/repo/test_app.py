import os
import tempfile

import app as orders_app


def test_index():
    client = orders_app.app.test_client()
    resp = client.get("/")
    assert resp.status_code == 200


def test_create_customer_requires_name():
    fd, path = tempfile.mkstemp()
    os.close(fd)
    orders_app.DATABASE = path
    with open(os.path.join(os.path.dirname(__file__), "schema.sql")) as f:
        import sqlite3
        conn = sqlite3.connect(path)
        conn.executescript(f.read())
        conn.close()
    client = orders_app.app.test_client()
    resp = client.post("/customers", json={})
    assert resp.status_code == 400
