"""Small shared helpers for the Goose engine (no third-party imports)."""
import hashlib
import json
import os
import sqlite3
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

CENT = Decimal("0.01")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False, default=str)
        f.write("\n")
    os.replace(tmp, path)


def open_sqlite_readonly(path):
    """Open a database file without any chance of writing to it."""
    uri = f"file:{Path(path).resolve()}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def money_from_float(value):
    """A REAL money value to an exact Decimal cent, rounding half up (the agreed rule)."""
    if value is None:
        return None
    return Decimal(repr(float(value))).quantize(CENT, rounding=ROUND_HALF_UP)


def emit(event, **fields):
    """One JSON line on stdout - the worker reads these as progress."""
    print(json.dumps({"event": event, **fields}, default=str), flush=True)
