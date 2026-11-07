"""Validate what a customer uploaded before anything else touches it.

Repository: a .zip, at most 150 MB compressed / 600 MB uncompressed / 40,000 files, no absolute
paths, no "..", no symlinks, no device files. Extracted into a fresh folder.
Database: a SQLite file (checked by its header, not its name), at most 2 GB, opened read-only,
PRAGMA integrity_check must pass; or a MySQL/MariaDB dump (.sql or .sql.gz from mysqldump), checked by
its header and statements, never executed here (it is restored only into Goose's workbench database).
The upload itself is never modified.

Usage:  python -m goose_engine.intake --repo FILE.zip --source-dir DIR [--db FILE] --out intake.json
"""
import argparse
import stat
import zipfile
from pathlib import Path, PurePosixPath

from .util import emit, open_sqlite_readonly, sha256_file, write_json

MAX_ZIP = 150 * 1024 ** 2
MAX_UNZIPPED = 600 * 1024 ** 2
MAX_FILES = 40000
MAX_DB = 2 * 1024 ** 3


def check_zip(path, dest):
    problems, files = [], []
    p = Path(path)
    if p.stat().st_size > MAX_ZIP:
        return [f"Repository archive is larger than 50 MB ({p.stat().st_size} bytes)."], []
    if not zipfile.is_zipfile(p):
        return ["The repository upload is not a .zip archive."], []
    with zipfile.ZipFile(p) as z:
        infos = z.infolist()
        if len(infos) > MAX_FILES:
            problems.append(f"Archive has {len(infos)} entries (limit {MAX_FILES}).")
        total = 0
        for i in infos:
            name = i.filename
            pp = PurePosixPath(name)
            mode = (i.external_attr >> 16) & 0xFFFF
            if name.startswith("/") or ".." in pp.parts or ":" in name:
                problems.append(f"Unsafe path in archive: {name}")
            if stat.S_ISLNK(mode):
                problems.append(f"Symbolic link in archive: {name}")
            if mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                problems.append(f"Special file in archive: {name}")
            total += i.file_size
            if i.compress_size and i.file_size / max(i.compress_size, 1) > 200:
                problems.append(f"Suspicious compression ratio for {name}")
        if total > MAX_UNZIPPED:
            problems.append(f"Archive expands to {total} bytes (limit {MAX_UNZIPPED}).")
        if problems:
            return problems, []
        dest = Path(dest)
        dest.mkdir(parents=True, exist_ok=True)
        for i in infos:
            if i.is_dir():
                continue
            target = (dest / i.filename).resolve()
            if not str(target).startswith(str(dest.resolve())):
                return [f"Unsafe path in archive: {i.filename}"], []
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as src, open(target, "wb") as out:
                out.write(src.read())
            files.append(i.filename)
    # a single top-level folder (GitHub-style archive) is unwrapped
    entries = [e for e in Path(dest).iterdir() if not e.name.startswith("__MACOSX")]
    if len(entries) == 1 and entries[0].is_dir():
        inner = entries[0]
        for child in inner.iterdir():
            child.rename(Path(dest) / child.name)
        inner.rmdir()
    return [], files


def check_db(path):
    p = Path(path)
    if p.stat().st_size > MAX_DB:
        return [f"Database copy is larger than 2 GB ({p.stat().st_size} bytes)."], {}
    with open(p, "rb") as f:
        header = f.read(16)
    if header[:2] == b"\x1f\x8b" or header.startswith(b"-- M"):
        return check_mysqldump(p)
    if header != b"SQLite format 3\x00":
        return ["The database upload is not a SQLite database file or a MySQL dump."], {}
    try:
        conn = open_sqlite_readonly(p)
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        conn.close()
    except Exception as e:
        return [f"SQLite could not open the database copy: {e}"], {}
    if integrity != "ok":
        return [f"SQLite integrity check failed: {integrity[:200]}"], {}
    return [], {"tables": tables, "integrity": integrity}


def check_mysqldump(p):
    import gzip
    import re
    opener = gzip.open if open(p, "rb").read(2) == b"\x1f\x8b" else open
    tables, inserts, head = 0, 0, ""
    try:
        with opener(p, "rt", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i < 5:
                    head += line
                if line.startswith("CREATE TABLE"):
                    tables += 1
                elif line.startswith("INSERT INTO"):
                    inserts += 1
    except (OSError, EOFError) as e:
        return [f"The database dump could not be read: {e}"], {}
    m = re.search(r"-- (MySQL|MariaDB) dump ([0-9.]+)", head)
    if not m:
        return ["The database upload is not a mysqldump file (no 'MySQL dump' or 'MariaDB dump' header)."], {}
    if tables == 0:
        return ["The database dump contains no tables."], {}
    return [], {"kind": "mysqldump", "dump_tool": f"{m.group(1)} dump {m.group(2)}", "tables": tables, "insert_statements": inserts}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--source-dir", required=True)
    ap.add_argument("--db")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    repo_problems, files = check_zip(a.repo, a.source_dir)
    out = {"repository": {"sha256": sha256_file(a.repo), "bytes": Path(a.repo).stat().st_size,
                          "files": len(files), "problems": repo_problems}}
    if a.db:
        db_problems, info = check_db(a.db)
        out["database"] = {"sha256": sha256_file(a.db), "bytes": Path(a.db).stat().st_size,
                           "problems": db_problems, **info}
    out["ok"] = not repo_problems and not (a.db and out["database"]["problems"])
    write_json(a.out, out)
    emit("intake.done", ok=out["ok"], files=len(files),
         problems=repo_problems + (out.get("database", {}).get("problems") or []))


if __name__ == "__main__":
    main()
