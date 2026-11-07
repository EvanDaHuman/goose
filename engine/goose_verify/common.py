"""Shared helpers for independent verification.

This package deliberately imports nothing from goose_engine (the code that builds the
upgrade). Every agreed rule is implemented again here, from the scope, so two independent
implementations have to agree before a check passes.
"""
import hashlib
import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zoneinfo import ZoneInfo

CENT = Decimal("0.01")
UTC = timezone.utc
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)
        f.write("\n")
    os.replace(tmp, path)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, default=str), flush=True)


def sqlite_ro(path):
    conn = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


# ------------------------------------------------------------------ agreed conversions

def cents(value):
    """A stored binary-float money value as exact cents, rounded half up (the agreed rule)."""
    if value is None:
        return None
    return Decimal(repr(float(value))).quantize(CENT, rounding=ROUND_HALF_UP)


def parse_local(text, formats):
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"unreadable timestamp {text!r}")


def local_to_utc(text, zone, formats, rule):
    if text is None:
        return None
    naive = parse_local(text, formats)
    aware = naive.replace(tzinfo=ZoneInfo(zone), fold=1 if rule == "later" else 0)
    return aware.astimezone(UTC).isoformat()


def apply_rule(rule, subtotal):
    """The agreed discount rule from the scope, in exact decimal arithmetic."""
    sub = Decimal(subtotal).quantize(CENT, rounding=ROUND_HALF_UP)
    discount = Decimal("0.00")
    for tier in sorted(rule["tiers"], key=lambda t: -Decimal(t["min"])):
        hit = sub >= Decimal(tier["min"]) if tier.get("inclusive", True) else sub > Decimal(tier["min"])
        if hit:
            discount = (sub * Decimal(tier["rate"])).quantize(CENT, rounding=ROUND_HALF_UP)
            break
    total = (sub - discount).quantize(CENT, rounding=ROUND_HALF_UP)
    return sub, discount, total


# ------------------------------------------------------------------ HTTP

def http(base, method, path, body=None, headers=None, timeout=20):
    url = base.rstrip("/") + path
    data = None
    hdrs = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw, rh = r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        status, raw, rh = e.code, e.read(), dict(e.headers)
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        return {"status": None, "error": str(e), "body": None}
    text = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text) if text.strip() else None
        kind = "json"
    except ValueError:
        parsed, kind = text[:500], "text"
    return {"status": status, "body": parsed, "kind": kind,
            "headers": {k.lower(): v for k, v in rh.items() if k.lower() in ("content-type", "idempotent-replay")}}


# ------------------------------------------------------------------ comparison

HTTP_DATE = re.compile(r"^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$")


def _instant(v, zone):
    """A timestamp string as an aware instant: shop-time text, or an HTTP date (which says GMT)."""
    if not isinstance(v, str):
        return None
    if HTTP_DATE.match(v):
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(v)
    if TS_RE.match(v):
        try:
            return datetime.strptime(v[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo(zone))
        except ValueError:
            return None
    return None


def in_window(v, window):
    """window = (start, end, zone), start/end aware."""
    if window is None:
        return False
    dt = _instant(v, window[2])
    return dt is not None and window[0] <= dt <= window[1]


def diff(expected, actual, path="$", out=None, windows=None):
    """Differences between two JSON values. Floats compare to the cent. A timestamp that each run
    wrote while it was running ("now") is not compared, because two runs cannot share a clock;
    `windows` is ((start, end) of the recorded run, (start, end) of this run) in shop time."""
    out = [] if out is None else out
    if isinstance(expected, dict) and isinstance(actual, dict):
        for k in sorted(set(expected) | set(actual)):
            if k not in actual:
                out.append({"path": f"{path}.{k}", "expected": expected[k], "actual": "<missing>"})
            elif k not in expected:
                out.append({"path": f"{path}.{k}", "expected": "<missing>", "actual": actual[k]})
            else:
                diff(expected[k], actual[k], f"{path}.{k}", out, windows)
    elif isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            out.append({"path": f"{path}.length", "expected": len(expected), "actual": len(actual)})
        for i, (a, b) in enumerate(zip(expected, actual)):
            diff(a, b, f"{path}[{i}]", out, windows)
    elif isinstance(expected, bool) or isinstance(actual, bool):
        if expected != actual:
            out.append({"path": path, "expected": expected, "actual": actual})
    elif isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if isinstance(expected, float) or isinstance(actual, float):
            if cents(expected) != cents(actual):
                out.append({"path": path, "expected": expected, "actual": actual})
        elif expected != actual:
            out.append({"path": path, "expected": expected, "actual": actual})
    elif expected != actual:
        if windows and in_window(expected, windows[0]) and in_window(actual, windows[1]):
            return out
        out.append({"path": path, "expected": expected, "actual": actual})
    return out
