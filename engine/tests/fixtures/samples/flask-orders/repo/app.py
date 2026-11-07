"""
Sample Supply Co. - order service
(SAMPLE APPLICATION (test fixture) - synthetic business, synthetic data)

Internal API used by the shop front-end and the warehouse scripts.

Run:  python app.py   (uses orders.db in the current folder unless ORDERS_DB is set)
"""
import os
import sqlite3
from datetime import datetime

from flask import Flask, request, jsonify, g

app = Flask(__name__)
DATABASE = os.environ.get("ORDERS_DB", "orders.db")

BULK_DISCOUNT_THRESHOLD = 250.00
# 15% off big orders (per Linda, Mar 2019)
BULK_DISCOUNT_RATE = 0.10


def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DATABASE)
        db.row_factory = sqlite3.Row
    return db


@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


def now_str():
    # server clock is set to shop time
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def compute_totals(lines):
    """lines is a list of (unit_price, quantity)"""
    subtotal = 0.0
    for price, qty in lines:
        subtotal += price * qty
    subtotal = round(subtotal, 2)
    discount = 0.0
    if subtotal >= BULK_DISCOUNT_THRESHOLD:
        discount = round(subtotal * BULK_DISCOUNT_RATE, 2)
    total = round(subtotal - discount, 2)
    return subtotal, discount, total


def order_to_dict(db, order_id):
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        return None
    items = db.execute(
        "SELECT oi.id, oi.product_id, p.sku, p.name, oi.quantity, oi.unit_price "
        "FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id "
        "WHERE oi.order_id = ? ORDER BY oi.id",
        (order_id,),
    ).fetchall()
    d = dict(order)
    d["items"] = [dict(i) for i in items]
    return d


@app.route("/")
def index():
    return jsonify({"service": "sample-orders", "version": "1.4.2"})


# ---------------------------------------------------------------- customers

@app.route("/customers", methods=["GET"])
def list_customers():
    db = get_db()
    name = request.args.get("name")
    if name:
        rows = db.execute(
            "SELECT * FROM customers WHERE name LIKE ? ORDER BY id", ("%" + name + "%",)
        ).fetchall()
    else:
        rows = db.execute("SELECT * FROM customers ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/customers", methods=["POST"])
def create_customer():
    data = request.get_json(force=True, silent=True) or {}
    if not data.get("name"):
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO customers (name, email, phone, created_at) VALUES (?, ?, ?, ?)",
        (data["name"], data.get("email"), data.get("phone"), now_str()),
    )
    db.commit()
    row = db.execute("SELECT * FROM customers WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/customers/<int:customer_id>")
def get_customer(customer_id):
    db = get_db()
    row = db.execute(
        "SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count "
        "FROM customers c WHERE c.id = ?",
        (customer_id,),
    ).fetchone()
    if row is None:
        return jsonify({"error": "customer not found"}), 404
    return jsonify(dict(row))


@app.route("/customers/<int:customer_id>/orders")
def customer_orders(customer_id):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM orders WHERE customer_id = ? ORDER BY id", (customer_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# ---------------------------------------------------------------- products

@app.route("/products")
def list_products():
    db = get_db()
    if request.args.get("in_stock") == "1":
        rows = db.execute(
            "SELECT * FROM products WHERE stock > 0 AND active = 1 ORDER BY id"
        ).fetchall()
    else:
        rows = db.execute("SELECT * FROM products ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/products", methods=["POST"])
def create_product():
    data = request.get_json(force=True, silent=True) or {}
    if not data.get("sku") or not data.get("name") or data.get("price") is None:
        return jsonify({"error": "sku, name and price are required"}), 400
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO products (sku, name, price, stock, active) VALUES (?, ?, ?, ?, 1)",
            (data["sku"], data["name"], float(data["price"]), int(data.get("stock", 0))),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "sku already exists"}), 409
    row = db.execute("SELECT * FROM products WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route("/products/<int:product_id>")
def get_product(product_id):
    db = get_db()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    if row is None:
        return jsonify({"error": "product not found"}), 404
    return jsonify(dict(row))


@app.route("/products/<int:product_id>/restock", methods=["POST"])
def restock_product(product_id):
    data = request.get_json(force=True, silent=True) or {}
    qty = int(data.get("quantity", 0))
    if qty <= 0:
        return jsonify({"error": "quantity must be positive"}), 400
    db = get_db()
    cur = db.execute("UPDATE products SET stock = stock + ? WHERE id = ?", (qty, product_id))
    if cur.rowcount == 0:
        return jsonify({"error": "product not found"}), 404
    db.commit()
    row = db.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
    return jsonify(dict(row))


# ---------------------------------------------------------------- orders

@app.route("/orders")
def list_orders():
    db = get_db()
    sql = "SELECT * FROM orders WHERE 1=1"
    params = []
    if request.args.get("customer_id"):
        sql += " AND customer_id = ?"
        params.append(int(request.args.get("customer_id")))
    if request.args.get("status"):
        sql += " AND status = ?"
        params.append(request.args.get("status"))
    sql += " ORDER BY id DESC LIMIT 200"
    rows = db.execute(sql, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/orders/<int:order_id>")
def get_order(order_id):
    db = get_db()
    d = order_to_dict(db, order_id)
    if d is None:
        return jsonify({"error": "order not found"}), 404
    return jsonify(d)


@app.route("/orders", methods=["POST"])
def create_order():
    data = request.get_json(force=True, silent=True) or {}
    customer_id = data.get("customer_id")
    items = data.get("items") or []
    if not customer_id or not items:
        return jsonify({"error": "customer_id and items are required"}), 400
    db = get_db()
    customer = db.execute("SELECT id FROM customers WHERE id = ?", (customer_id,)).fetchone()
    if customer is None:
        return jsonify({"error": "customer not found"}), 404

    # add up quantities per product first (the till sometimes sends the same product twice)
    wanted = {}
    for item in items:
        qty = int(item.get("quantity", 0))
        if qty <= 0:
            return jsonify({"error": "quantity must be positive"}), 400
        pid = item.get("product_id")
        wanted[pid] = wanted.get(pid, 0) + qty

    lines = []
    for pid, qty in wanted.items():
        product = db.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
        if product is None or product["active"] != 1:
            return jsonify({"error": "product not found", "product_id": pid}), 404
        if product["stock"] < qty:
            return jsonify({"error": "insufficient stock", "product_id": pid,
                            "available": product["stock"]}), 409
        lines.append((product, qty))

    subtotal, discount, total = compute_totals([(p["price"], q) for p, q in lines])
    cur = db.execute(
        "INSERT INTO orders (customer_id, status, subtotal, discount, total, created_at) "
        "VALUES (?, 'pending', ?, ?, ?, ?)",
        (customer_id, subtotal, discount, total, now_str()),
    )
    order_id = cur.lastrowid
    for product, qty in lines:
        db.execute(
            "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
            (order_id, product["id"], qty, product["price"]),
        )
        db.execute("UPDATE products SET stock = stock - ? WHERE id = ?", (qty, product["id"]))
    db.commit()
    return jsonify(order_to_dict(db, order_id)), 201


@app.route("/orders/<int:order_id>/cancel", methods=["POST"])
def cancel_order(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        return jsonify({"error": "order not found"}), 404
    if order["status"] == "shipped":
        return jsonify({"error": "shipped orders cannot be cancelled"}), 409
    items = db.execute(
        "SELECT product_id, quantity FROM order_items WHERE order_id = ?", (order_id,)
    ).fetchall()
    for it in items:
        db.execute("UPDATE products SET stock = stock + ? WHERE id = ?",
                   (it["quantity"], it["product_id"]))
    db.execute("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
               (now_str(), order_id))
    db.commit()
    return jsonify(order_to_dict(db, order_id))


@app.route("/orders/<int:order_id>/ship", methods=["POST"])
def ship_order(order_id):
    db = get_db()
    order = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    if order is None:
        return jsonify({"error": "order not found"}), 404
    if order["status"] != "pending":
        return jsonify({"error": "only pending orders can be shipped"}), 409
    db.execute("UPDATE orders SET status = 'shipped', shipped_at = ? WHERE id = ?",
               (now_str(), order_id))
    db.commit()
    return jsonify(order_to_dict(db, order_id))


# ---------------------------------------------------------------- reports

@app.route("/reports/daily-sales")
def daily_sales():
    day = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
    db = get_db()
    row = db.execute(
        "SELECT COUNT(*) AS orders, IFNULL(SUM(total), 0) AS revenue FROM orders "
        "WHERE date(created_at) = ? AND status NOT IN ('cancelled', 'canceled')",
        (day,),
    ).fetchone()
    return jsonify({"date": day, "orders": row["orders"], "revenue": round(row["revenue"], 2)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, threaded=True)
