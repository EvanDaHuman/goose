"""Give every user on Goose's disposable copy of a SuiteCRM database the same recording password (SuiteCRM 7's own
hash format: bcrypt of the lower-case MD5). Only ever used on a workbench copy; the snapshot keeps the customer's hashes.

    python -m goose_engine.suitecrm.recordpw --db pw_1030_original --password-file F
"""
import argparse
import hashlib
import json
from pathlib import Path

import bcrypt

from . import db as D


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--password-file", required=True)
    a = ap.parse_args(argv)
    if not a.db.endswith("_original"):
        raise SystemExit("refusing: recording passwords are only set on a disposable *_original copy")
    pw = Path(a.password_file).read_text().strip()
    h = bcrypt.hashpw(hashlib.md5(pw.encode()).hexdigest().lower().encode(), bcrypt.gensalt(10)).decode().replace("$2b$", "$2y$", 1)
    c = D.connect(a.db, user="root")
    with c.cursor() as cur:
        n = cur.execute("UPDATE users SET user_hash = %s WHERE deleted = 0", (h,))
    print(json.dumps({"users": n, "db": a.db}))


if __name__ == "__main__":
    main()
