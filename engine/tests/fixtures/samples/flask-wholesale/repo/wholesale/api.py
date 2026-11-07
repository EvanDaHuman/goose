from flask import Blueprint, jsonify, request

from .db import get_db

bp = Blueprint("api", __name__, url_prefix="/api")

# wholesale tiers agreed with the cafes in 2020
TIER_ONE = 100
TIER_ONE_RATE = 0.05
TIER_TWO = 500
TIER_TWO_RATE = 0.12


def price_purchase(lines):
    gross = round(sum(price * qty for price, qty in lines), 2)
    if gross >= TIER_TWO:
        discount_amount = round(gross * TIER_TWO_RATE, 2)
    elif gross >= TIER_ONE:
        discount_amount = round(gross * TIER_ONE_RATE, 2)
    else:
        discount_amount = 0.0
    return gross, discount_amount, round(gross - discount_amount, 2)


def purchase_json(db, purchase_id):
    p = db.execute(
        "SELECT p.*, c.full_name, c.email FROM purchases p JOIN clients c ON c.id = p.client_id WHERE p.id = ?",
        (purchase_id,),
    ).fetchone()
    if p is None:
        return None
    lines = db.execute(
        "SELECT l.coffee_id, k.code, k.title, l.qty, l.price_each FROM purchase_lines l "
        "JOIN coffees k ON k.id = l.coffee_id WHERE l.purchase_id = ? ORDER BY l.id",
        (purchase_id,),
    ).fetchall()
    return {
        "id": p["id"],
        "client": {"id": p["client_id"], "name": p["full_name"], "email": p["email"]},
        "state": p["state"],
        "placed_on": p["placed_on"],
        "lines": [dict(l) for l in lines],
        "totals": {"gross": p["gross"], "discount": p["discount_amount"], "due": p["amount_due"]},
    }


@bp.get("/clients")
def clients():
    q = request.args.get("q", "")
    rows = get_db().execute(
        "SELECT id, full_name, email, city FROM clients WHERE full_name LIKE ? ORDER BY full_name",
        (f"%{q}%",),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/clients")
def add_client():
    body = request.get_json()
    if not body or not body.get("full_name"):
        return jsonify(error="full_name required"), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO clients (full_name, email, city) VALUES (?, ?, ?)",
        (body["full_name"], body.get("email"), body.get("city")),
    )
    db.commit()
    return jsonify(id=cur.lastrowid, full_name=body["full_name"], email=body.get("email"), city=body.get("city")), 201


@bp.get("/clients/<int:client_id>")
def client(client_id):
    row = get_db().execute("SELECT id, full_name, email, city FROM clients WHERE id = ?", (client_id,)).fetchone()
    if row is None:
        return jsonify(error="no such client"), 404
    return jsonify(dict(row))


@bp.get("/coffees")
def coffees():
    rows = get_db().execute("SELECT * FROM coffees ORDER BY code").fetchall()
    return jsonify([dict(r) for r in rows])


@bp.post("/coffees/<int:coffee_id>/receive")
def receive(coffee_id):
    body = request.get_json() or {}
    qty = body.get("qty")
    if not isinstance(qty, int) or qty < 1:
        return jsonify(error="qty must be a positive whole number"), 400
    db = get_db()
    if db.execute("SELECT 1 FROM coffees WHERE id = ?", (coffee_id,)).fetchone() is None:
        return jsonify(error="no such coffee"), 404
    db.execute("UPDATE coffees SET qty_on_hand = qty_on_hand + ? WHERE id = ?", (qty, coffee_id))
    db.commit()
    return jsonify(dict(db.execute("SELECT * FROM coffees WHERE id = ?", (coffee_id,)).fetchone()))


@bp.get("/purchases/<int:purchase_id>")
def purchase(purchase_id):
    data = purchase_json(get_db(), purchase_id)
    if data is None:
        return jsonify(error="no such purchase"), 404
    return jsonify(data)


@bp.post("/purchases")
def new_purchase():
    body = request.get_json() or {}
    client_id = body.get("client")
    lines = body.get("lines") or []
    if not client_id or not lines:
        return jsonify(error="client and lines are required"), 400
    db = get_db()
    if db.execute("SELECT 1 FROM clients WHERE id = ?", (client_id,)).fetchone() is None:
        return jsonify(error="no such client"), 404
    priced = []
    for line in lines:
        k = db.execute("SELECT * FROM coffees WHERE id = ?", (line.get("coffee"),)).fetchone()
        if k is None:
            return jsonify(error="no such coffee", coffee=line.get("coffee")), 404
        if line.get("qty", 0) < 1:
            return jsonify(error="qty must be at least 1"), 400
        if k["qty_on_hand"] < line["qty"]:
            return jsonify(error="not enough on hand", coffee=k["id"], on_hand=k["qty_on_hand"]), 409
        priced.append((k, line["qty"]))
    gross, discount_amount, amount_due = price_purchase([(k["unit_cost"], qty) for k, qty in priced])
    cur = db.execute(
        "INSERT INTO purchases (client_id, state, gross, discount_amount, amount_due) VALUES (?, 'open', ?, ?, ?)",
        (client_id, gross, discount_amount, amount_due),
    )
    for k, qty in priced:
        db.execute("INSERT INTO purchase_lines (purchase_id, coffee_id, qty, price_each) VALUES (?, ?, ?, ?)",
                   (cur.lastrowid, k["id"], qty, k["unit_cost"]))
        db.execute("UPDATE coffees SET qty_on_hand = qty_on_hand - ? WHERE id = ?", (qty, k["id"]))
    db.commit()
    return jsonify(purchase_json(db, cur.lastrowid)), 201


@bp.post("/purchases/<int:purchase_id>/void")
def void_purchase(purchase_id):
    db = get_db()
    p = db.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if p is None:
        return jsonify(error="no such purchase"), 404
    if p["state"] == "fulfilled":
        return jsonify(error="already fulfilled"), 409
    for line in db.execute("SELECT coffee_id, qty FROM purchase_lines WHERE purchase_id = ?", (purchase_id,)).fetchall():
        db.execute("UPDATE coffees SET qty_on_hand = qty_on_hand + ? WHERE id = ?", (line["qty"], line["coffee_id"]))
    db.execute("UPDATE purchases SET state = 'void' WHERE id = ?", (purchase_id,))
    db.commit()
    return jsonify(purchase_json(db, purchase_id))


@bp.post("/purchases/<int:purchase_id>/fulfil")
def fulfil(purchase_id):
    db = get_db()
    p = db.execute("SELECT * FROM purchases WHERE id = ?", (purchase_id,)).fetchone()
    if p is None:
        return jsonify(error="no such purchase"), 404
    if p["state"] != "open":
        return jsonify(error="only open purchases can be fulfilled"), 409
    db.execute("UPDATE purchases SET state = 'fulfilled' WHERE id = ?", (purchase_id,))
    db.commit()
    return jsonify(purchase_json(db, purchase_id))


@bp.get("/summary")
def summary():
    day = request.args.get("day")
    if not day:
        return jsonify(error="day is required"), 400
    row = get_db().execute(
        "SELECT COUNT(*) AS purchases, IFNULL(SUM(amount_due), 0) AS takings FROM purchases "
        "WHERE date(placed_on) = ? AND state != 'void'",
        (day,),
    ).fetchone()
    return jsonify(day=day, purchases=row["purchases"], takings=round(row["takings"], 2))
