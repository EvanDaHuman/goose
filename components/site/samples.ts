// Content for the marketing pages: the four example migrations, the example goals for the start form,
// and the sample files the homepage's live-run demo plays. The samples are illustrations, not real jobs.

export type SampleKey = "flask-fastapi" | "ros" | "cpp-rust" | "flask-react";

export interface Sample {
  from: string;
  to: string;
  fileOld: string;
  fileNew: string;
  meta: string;
  /** The file before and after, line for line (a removed or added line is an empty string on one side). */
  old: string[];
  neu: string[];
  /** Lines that used an API the target removed (marked with a dropping). */
  removed: number[];
  /** What changed on a line, shown in the change list. */
  notes: Record<number, string>;
  /** One line of evidence per pipeline stage before Build. */
  logs: Record<string, string>;
  verify: { n: number; label: string };
  /** [tag, headline, detail]; "{n}" becomes the number of changed lines. */
  findings: [string, string, string][];
}

export interface Example {
  from: string;
  to: string;
  /** Simple Icons keys for the logos on each side. */
  fromIcons: IconName[];
  toIcons: IconName[];
  desc: string;
  sample: SampleKey;
  goal: string;
}

export type IconName = "cplusplus" | "rust" | "react" | "flask" | "sqlite" | "fastapi" | "postgresql" | "ros" | "github";

export const EXAMPLES: Example[] = [
  { from: "C++", fromIcons: ["cplusplus"], to: "Rust", toIcons: ["rust"], sample: "cpp-rust",
    desc: "Rewrite a C++ library in Rust, keeping its interface and its tests.",
    goal: "Rewrite our inventory library in Rust and keep its behaviour and its tests." },
  { from: "Flask", fromIcons: ["flask"], to: "React", toIcons: ["react"], sample: "flask-react",
    desc: "Move server-rendered Flask pages to a React front end on the same data.",
    goal: "Move our server-rendered pages to React without changing what customers see." },
  { from: "Flask + SQLite", fromIcons: ["flask", "sqlite"], to: "FastAPI + PostgreSQL", toIcons: ["fastapi", "postgresql"], sample: "flask-fastapi",
    desc: "Keep your SQL, move every row, and compare old and new answers.",
    goal: "Move the database without changing the customer-facing app." },
  { from: "ROS", fromIcons: ["ros"], to: "ROS 2", toIcons: ["ros"], sample: "ros",
    desc: "Port ROS 1 nodes, launch files and messages to ROS 2, with the same topics and the same behaviour.",
    goal: "Move our robot from ROS 1 to ROS 2 without changing how it behaves." },
];

export const GOALS = [
  "Update this application while keeping its current behaviour.",
  "Move the database without changing the customer-facing app.",
  "Replace this old service while preserving its existing connections.",
  "Fix these maintenance problems and prepare the application for future development.",
];

export const PAIR_ORDER: SampleKey[] = ["flask-fastapi", "ros", "cpp-rust", "flask-react"];
export const SAMPLE_TITLES: Record<SampleKey, string> = {
  "flask-fastapi": "Order service", ros: "Obstacle guard", "cpp-rust": "Inventory library", "flask-react": "Order pages",
};


export const PAIRS: Record<SampleKey, Sample> = {
  "flask-fastapi": {
    from: "Flask + SQLite", to: "FastAPI + PostgreSQL", fileOld: "app.py", fileNew: "main.py", meta: "Python 3.8 · Flask 1.1 · SQLite",
    old: [
      "from flask import Flask, jsonify, request, g",
      "from flask.ext.cache import Cache",
      "import sqlite3",
      "",
      "app = Flask(__name__)",
      'DATABASE = "shop.db"',
      "",
      "def get_db():",
      '    db = getattr(g, "_database", None)',
      "    if db is None:",
      "        db = g._database = sqlite3.connect(DATABASE)",
      "    return db",
      "",
      '@app.route("/orders", methods=["GET"])',
      "def list_orders():",
      '    cur = get_db().execute("SELECT id, total FROM orders")',
      "    return jsonify([dict(id=r[0], total=r[1]) for r in cur])",
      "",
      '@app.route("/orders", methods=["POST"])',
      "def create_order():",
      '    total = request.json["total"]',
      '    get_db().execute("INSERT INTO orders (total) VALUES (?)", (total,))',
      "    get_db().commit()",
      "    return jsonify(ok=True), 201"
    ],
    neu: [
      "from fastapi import FastAPI, Depends",
      "# removed: flask.ext.cache (gone since Flask 1.0)",
      "import asyncpg, os",
      "",
      "app = FastAPI()",
      'DSN = os.environ["DATABASE_URL"]',
      "",
      "async def get_db():",
      "    conn = await asyncpg.connect(DSN)",
      "    try:",
      "        yield conn",
      "    finally: await conn.close()",
      "",
      '@app.get("/orders")',
      "async def list_orders(db=Depends(get_db)):",
      '    rows = await db.fetch("SELECT id, total FROM orders")',
      '    return [dict(id=r["id"], total=r["total"]) for r in rows]',
      "",
      '@app.post("/orders", status_code=201)',
      "async def create_order(order: OrderIn, db=Depends(get_db)):",
      "    total = order.total",
      '    await db.execute("INSERT INTO orders (total) VALUES ($1)", total)',
      "    # asyncpg commits each statement on its own",
      '    return {"ok": True}'
    ],
    removed: [1],
    notes: { 0: "Flask imports become FastAPI", 1: "Removed flask.ext.cache, gone since Flask 1.0", 2: "sqlite3 becomes asyncpg", 4: "App object becomes FastAPI()", 5: "Database file becomes DATABASE_URL", 7: "One connection per request, as a dependency", 8: "Connection opened per request", 9: "try/finally guards the connection", 10: "Connection handed to the route", 11: "Connection closed after the request", 13: "GET /orders keeps its path", 14: "Handler is async and gets the connection", 15: "Same SQL, now on PostgreSQL", 16: "Same JSON shape in the response", 18: "POST /orders keeps its 201", 19: "Handler takes a typed body", 20: "Body read through a typed model", 21: "? placeholders become $1", 22: "Commit handled per statement", 23: "Same response body" },
    logs: { Inspect: "14 files · 2 entry points · SQLite, 3 tables", Plan: "FastAPI + PostgreSQL, SQL kept as written", Quote: "Fixed price accepted", Record: "1,240 requests recorded on a copy", Freeze: "38 checks hashed and locked" },
    verify: { n: 1240, label: "responses match" },
    findings: [["Checked", "1,240 of 1,240 responses match the original", "verify · replayed requests"], ["Data", "14,212 rows moved, 0 mismatches", "verify · every row and field"], ["Removed", "flask.ext.cache, gone since Flask 1.0", "app.py · line 2"], ["Changed", "{n} lines rewritten, SQL kept as written", "main.py"]]
  },
  "ros": {
    from: "ROS", to: "ROS 2 Jazzy", fileOld: "obstacle_guard.py", fileNew: "obstacle_guard.py", meta: "ROS 1 Melodic · Python 2.7 · catkin",
    old: [
      "#!/usr/bin/env python",
      "import rospy",
      "from std_msgs.msg import Float32",
      "from sensor_msgs.msg import LaserScan",
      "",
      "class ObstacleGuard(object):",
      "    def __init__(self):",
      '        rospy.init_node("obstacle_guard")',
      '        self.limit = rospy.get_param("~limit", 0.5)',
      '        self.pub = rospy.Publisher("nearest", Float32, queue_size=10)',
      '        rospy.Subscriber("scan", LaserScan, self.on_scan)',
      "",
      "    def on_scan(self, msg):",
      "        nearest = min(msg.ranges)",
      "        if nearest < self.limit:",
      '            rospy.logwarn("obstacle at %.2f m", nearest)',
      "        self.pub.publish(Float32(nearest))",
      "",
      'if __name__ == "__main__":',
      "    ObstacleGuard()",
      "    rospy.spin()"
    ],
    neu: [
      "#!/usr/bin/env python3",
      "import rclpy",
      "from std_msgs.msg import Float32",
      "from sensor_msgs.msg import LaserScan",
      "from rclpy.node import Node",
      "class ObstacleGuard(Node):",
      "    def __init__(self):",
      '        super().__init__("obstacle_guard")',
      '        self.limit = self.declare_parameter("limit", 0.5).value',
      '        self.pub = self.create_publisher(Float32, "nearest", 10)',
      '        self.create_subscription(LaserScan, "scan", self.on_scan, 10)',
      "",
      "    def on_scan(self, msg):",
      "        nearest = min(msg.ranges)",
      "        if nearest < self.limit:",
      '            self.get_logger().warning(f"obstacle at {nearest:.2f} m")',
      "        self.pub.publish(Float32(data=nearest))",
      "",
      'if __name__ == "__main__":',
      "    rclpy.init(); node = ObstacleGuard()",
      "    rclpy.spin(node)"
    ],
    removed: [1, 7, 8, 9, 10, 15, 19, 20],
    notes: { 0: "Python 2 becomes Python 3", 1: "rospy is gone in ROS 2; rclpy", 4: "Nodes are classes in ROS 2", 5: "ObstacleGuard is now a Node", 7: "init_node() becomes the Node constructor", 8: "Private ~ parameters are declared", 9: "Publisher: type first, queue depth as QoS", 10: "Subscriber() becomes create_subscription()", 15: "logwarn() becomes the node logger", 16: "Messages take keyword fields", 19: "rclpy.init() before the node starts", 20: "spin() takes the node" },
    logs: { Inspect: "23 packages · catkin · Python 2.7", Plan: "ROS 2 Jazzy, Python 3.12, colcon", Quote: "Fixed price accepted", Record: "3 rosbag runs recorded on a copy", Freeze: "38 checks hashed and locked" },
    verify: { n: 1240, label: "messages match" },
    findings: [["Checked", "1,240 of 1,240 output messages match the recorded runs", "verify · replayed rosbags"], ["Removed", "rospy calls rewritten for rclpy", "init_node · get_param · Publisher · Subscriber · logwarn · spin"], ["Interfaces", "Topic names and message types unchanged", "scan → nearest"], ["Changed", "{n} lines changed, everything else kept", "obstacle_guard.py"]]
  },
  "cpp-rust": {
    from: "C++", to: "Rust", fileOld: "inventory.cpp", fileNew: "inventory.rs", meta: "C++17 · CMake · 212 tests",
    old: [
      "#include <map>",
      "#include <string>",
      "#include <stdexcept>",
      "",
      "class Inventory {",
      "  std::map<std::string, int> stock;",
      " public:",
      "  void add(const std::string& sku, int qty) {",
      '    if (qty <= 0) throw std::invalid_argument("qty");',
      "    stock[sku] += qty;",
      "  }",
      "  int take(const std::string& sku, int qty) {",
      "    auto it = stock.find(sku);",
      "    if (it == stock.end() || it->second < qty)",
      '      throw std::runtime_error("out of stock");',
      "    it->second -= qty;",
      "    return it->second;",
      "  }",
      "};"
    ],
    neu: [
      "use std::collections::HashMap;",
      "#[derive(Debug)]",
      "pub enum StockError { BadQty, OutOfStock }",
      "",
      "#[derive(Default)] pub struct Inventory {",
      "    stock: HashMap<String, u32>,",
      "} impl Inventory {",
      "    pub fn add(&mut self, sku: &str, qty: u32) -> Result<(), StockError> {",
      "        if qty == 0 { return Err(StockError::BadQty); }",
      "        *self.stock.entry(sku.into()).or_insert(0) += qty;",
      "        Ok(()) }",
      "    pub fn take(&mut self, sku: &str, qty: u32) -> Result<u32, StockError> {",
      "        let left = self.stock.get_mut(sku).ok_or(StockError::OutOfStock)?;",
      "        if *left < qty {",
      "            return Err(StockError::OutOfStock); }",
      "        *left -= qty;",
      "        Ok(*left)",
      "    }",
      "}"
    ],
    removed: [],
    notes: { 0: "std::map becomes HashMap", 1: "Errors can be printed", 2: "Exceptions become a StockError enum", 4: "Class becomes a struct", 5: "Stock held as HashMap<String, u32>", 6: "Methods move to an impl block", 7: "add() returns a Result", 8: "Bad quantity is an error value", 9: "entry().or_insert() adds stock", 10: "Success is Ok(())", 11: "take() returns a Result", 12: "Missing SKU is OutOfStock", 13: "Same stock check", 14: "No throw: an error value", 15: "Same subtraction", 16: "Returns what is left", 17: "Method closes", 18: "impl block closes" },
    logs: { Inspect: "9 files · CMake · 212 unit tests", Plan: "Port Inventory to Rust, same interface", Quote: "Fixed price accepted", Record: "5,000 calls recorded on the C++ build", Freeze: "27 checks hashed and locked" },
    verify: { n: 5000, label: "calls give the same result" },
    findings: [["Checked", "5,000 of 5,000 recorded calls give the same result", "verify · old vs new"], ["Checked", "212 unit tests ported and passing", "cargo test"], ["Changed", "Exceptions became Result errors", "inventory.rs"], ["Changed", "{n} lines rewritten", "inventory.rs"]]
  },
  "flask-react": {
    from: "Flask templates", to: "React", fileOld: "templates/orders.html", fileNew: "Orders.jsx", meta: "Flask 2.3 · Jinja · 6 templates",
    old: [
      '{% extends "base.html" %}',
      "{% block content %}",
      "<h1>Orders</h1>",
      '<form method="post" action="{{ url_for(\'create_order\') }}">',
      '  <input name="total" type="number" step="0.01">',
      "  <button>Add order</button>",
      "</form>",
      "<table>",
      "  {% for o in orders %}",
      "  <tr><td>#{{ o.id }}</td><td>{{ o.total|currency }}</td></tr>",
      "  {% else %}",
      '  <tr><td colspan="2">No orders yet</td></tr>',
      "  {% endfor %}",
      "</table>",
      "{% endblock %}"
    ],
    neu: [
      'import { useOrders, createOrder, currency } from "./api";',
      "export default function Orders() { const { orders, reload } = useOrders();",
      "  return (<><h1>Orders</h1>",
      "    <form onSubmit={async (e) => { e.preventDefault(); await createOrder(new FormData(e.currentTarget)); reload(); }}>",
      '      <input name="total" type="number" step="0.01" />',
      "      <button>Add order</button>",
      "    </form>",
      "    <table><tbody>",
      "      {orders.map((o) => (",
      "        <tr key={o.id}><td>#{o.id}</td><td>{currency(o.total)}</td></tr>))}",
      "      {orders.length === 0 && (",
      "        <tr><td colSpan={2}>No orders yet</td></tr>)}",
      "",
      "    </tbody></table>",
      "  </>); }"
    ],
    removed: [0, 12, 14],
    notes: { 0: "Template becomes a component", 1: "Data loads through useOrders()", 2: "Same heading", 3: "Form posts to the same API", 4: "Same input, self-closing", 5: "Same button", 6: "Form closes", 7: "Table gets a tbody", 8: "Jinja loop becomes orders.map()", 9: "Same row markup", 10: "Empty state kept", 11: "Same empty-state row", 12: "Template-only tags removed", 13: "Table closes", 14: "Template block removed" },
    logs: { Inspect: "6 templates · 4 routes · base layout", Plan: "React pages on the existing JSON API", Quote: "Fixed price accepted", Record: "36 pages captured as screenshots", Freeze: "19 checks hashed and locked" },
    verify: { n: 72, label: "screenshots match" },
    findings: [["Checked", "72 of 72 screenshots match the original pages", "verify · visual diff"], ["Removed", "Jinja template inheritance", "orders.html · lines 1, 13, 15"], ["Changed", "The form posts through the same API", "Orders.jsx"], ["Changed", "{n} lines rewritten", "Orders.jsx"]]
  }
};
