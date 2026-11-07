"""Synthetic customer ledger used to prove language and data migrations. No real customer data."""
import os
import sqlite3
from flask import Flask, jsonify, request

app = Flask(__name__)


def db():
    c = sqlite3.connect(os.environ["APP_DB"])
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


@app.route("/", methods=["GET"])
def health():
    return jsonify({"service": "ledger"})


@app.route("/customers", methods=["GET"])
def customers():
    with db() as c:
        return jsonify([dict(r) for r in c.execute("SELECT id,name,email,credit_cents,joined_at FROM customers ORDER BY id")])


@app.route("/customers", methods=["POST"])
def create_customer():
    b = request.get_json(silent=True) or {}
    if not isinstance(b.get("name"), str) or not b["name"].strip():
        return jsonify({"error": "name required"}), 400
    with db() as c:
        cur = c.execute("INSERT INTO customers(name,email,credit_cents,joined_at) VALUES(?,?,?,?)", (b["name"], b.get("email"), 0, "2026-01-01"))
        return jsonify({"id": cur.lastrowid}), 201


@app.route("/customers/<int:customer_id>", methods=["GET"])
def customer(customer_id):
    with db() as c:
        row = c.execute("SELECT id,name,email,credit_cents,joined_at FROM customers WHERE id=?", (customer_id,)).fetchone()
        return (jsonify(dict(row)), 200) if row else (jsonify({"error": "not found"}), 404)


@app.route("/customers/<int:customer_id>", methods=["PATCH"])
def edit_customer(customer_id):
    b = request.get_json(silent=True) or {}
    if not isinstance(b.get("name"), str) or not b["name"].strip():
        return jsonify({"error": "name required"}), 400
    with db() as c:
        cur = c.execute("UPDATE customers SET name=? WHERE id=?", (b["name"], customer_id))
        return (jsonify({"updated": True}), 200) if cur.rowcount else (jsonify({"error": "not found"}), 404)


@app.route("/notes", methods=["POST"])
def add_note():
    b = request.get_json(silent=True) or {}
    if not isinstance(b.get("body"), str) or not b["body"].strip() or type(b.get("customer_id")) is not int:
        return jsonify({"error": "customer_id and body required"}), 400
    try:
        with db() as c:
            cur = c.execute("INSERT INTO notes(customer_id,body) VALUES(?,?)", (b["customer_id"], b["body"]))
            return jsonify({"id": cur.lastrowid}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": "customer not found"}), 409


@app.route("/customers/<int:customer_id>/notes", methods=["GET"])
def notes(customer_id):
    with db() as c:
        return jsonify([dict(r) for r in c.execute("SELECT id,customer_id,body FROM notes WHERE customer_id=? ORDER BY id", (customer_id,))])
