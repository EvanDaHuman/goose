"""Goose's workbench for SuiteCRM jobs, inside the local Linux VM (colima + Docker).

- A MariaDB 10.3 server owned by Goose (container gs-workbench-db, 127.0.0.1:3327) into which customers' database
  dumps are restored, one database per job and purpose (snapshot, original copy). Goose never connects to a
  customer's live database.
- Disposable copies of the original application (PHP 7.4 + Apache containers on the job's own copy of the code and data),
  used to record how the original behaves before anything is changed.
- An isolated PHP run (no network, code mounted read-only) that reads SuiteCRM's configuration and metadata files.

    python -m goose_engine.suitecrm.workbench up
    python -m goose_engine.suitecrm.workbench restore --dump X.sql.gz --db pw_1030_snapshot
    python -m goose_engine.suitecrm.workbench php-meta --src DIR --out meta.json
    python -m goose_engine.suitecrm.workbench runtime-start --name pw-1030-original --app DIR --db pw_1030_original --port 8181
"""
import argparse
import gzip
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STATE = ROOT / "var" / "workbench"
NET = "gs-workbench"
DB_CONTAINER = "gs-workbench-db"
DB_PORT = 3327
DB_IMAGE = "mariadb:10.3.39@sha256:4f08c16ef56f0b097139c917e68d60f2c65d9f2b2defb770ee7e4d3a51bb7864"
RUNTIME_IMAGE = "goose-runtime/php74-apache:1"
RUNTIME_DIR = ROOT / "engine" / "runtimes" / "php74-apache"
PHP_META = Path(__file__).with_name("php_meta.php")


def sh(args, input_bytes=None, check=True, capture=True, timeout=1800):
    r = subprocess.run(args, input=input_bytes, capture_output=capture, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args[:4]))}... failed ({r.returncode}): {(r.stderr or b'').decode()[-800:]}")
    return r


def creds():
    STATE.mkdir(parents=True, exist_ok=True)
    f = STATE / "credentials.json"
    if not f.exists():
        f.write_text(json.dumps({"root_password": secrets.token_hex(16), "reader_password": secrets.token_hex(16)}))
        f.chmod(0o600)
    return json.loads(f.read_text())


def dsn(db, user="root"):
    c = creds()
    return {"host": "127.0.0.1", "port": DB_PORT, "user": user,
            "password": c["root_password"] if user == "root" else c["reader_password"], "database": db}


def running(name):
    r = sh(["docker", "inspect", "-f", "{{.State.Running}}", name], check=False)
    return r.returncode == 0 and r.stdout.decode().strip() == "true"


def mysql(sql, db=None, input_bytes=None):
    pw = creds()["root_password"]
    args = ["docker", "exec", "-i", "-e", f"MYSQL_PWD={pw}", DB_CONTAINER, "mysql", "-uroot", "--batch", "--skip-column-names"]
    if db:
        args.append(db)
    if sql is not None:
        args += ["-e", sql]
    return sh(args, input_bytes=input_bytes).stdout.decode()


def up():
    c = creds()
    if sh(["docker", "network", "inspect", NET], check=False).returncode != 0:
        sh(["docker", "network", "create", NET])
    if not running(DB_CONTAINER):
        sh(["docker", "rm", "-f", DB_CONTAINER], check=False)
        sh(["docker", "run", "-d", "--name", DB_CONTAINER, "--network", NET, "-p", f"127.0.0.1:{DB_PORT}:3306",
            "-e", f"MARIADB_ROOT_PASSWORD={c['root_password']}", "-v", "gs-workbench-data:/var/lib/mysql", DB_IMAGE,
            "--character-set-server=utf8mb4", "--collation-server=utf8mb4_general_ci", "--sql-mode=NO_ENGINE_SUBSTITUTION",
            "--max-allowed-packet=256M"])
    for _ in range(90):
        r = sh(["docker", "exec", "-e", f"MYSQL_PWD={c['root_password']}", DB_CONTAINER, "mysqladmin", "ping", "-uroot", "-h127.0.0.1"], check=False)
        if r.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("workbench database did not start")
    mysql(f"CREATE USER IF NOT EXISTS 'gs_reader'@'%' IDENTIFIED BY '{c['reader_password']}'")
    return {"container": DB_CONTAINER, "port": DB_PORT}


def restore(dump, db):
    """Restore a customer's mysqldump into a fresh workbench database; returns table and row counts."""
    up()
    mysql(f"DROP DATABASE IF EXISTS `{db}`; CREATE DATABASE `{db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci")
    data = Path(dump).read_bytes()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    t0 = time.time()
    mysql(None, db=db, input_bytes=data)
    mysql(f"GRANT SELECT ON `{db}`.* TO 'gs_reader'@'%'")
    tables = int(mysql(f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '{db}'").strip())
    return {"database": db, "tables": tables, "bytes": len(data), "seconds": round(time.time() - t0, 2)}


def clone(src, dst):
    up()
    pw = creds()["root_password"]
    dump = sh(["docker", "exec", "-e", f"MYSQL_PWD={pw}", DB_CONTAINER, "mysqldump", "-uroot", "--single-transaction", src]).stdout
    mysql(f"DROP DATABASE IF EXISTS `{dst}`; CREATE DATABASE `{dst}` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci")
    mysql(None, db=dst, input_bytes=dump)
    mysql(f"GRANT SELECT ON `{dst}`.* TO 'gs_reader'@'%'")
    return {"database": dst, "from": src}


def drop(db):
    if running(DB_CONTAINER):
        mysql(f"DROP DATABASE IF EXISTS `{db}`")


def build_runtime():
    if sh(["docker", "image", "inspect", RUNTIME_IMAGE], check=False).returncode != 0:
        sh(["docker", "build", "-q", "-t", RUNTIME_IMAGE, "--build-arg", f"APP_UID={os.getuid()}",
            "--build-arg", f"APP_GID={os.getgid()}", str(RUNTIME_DIR)], timeout=3600)
    return RUNTIME_IMAGE


def php_meta(src, out):
    build_runtime()
    r = sh(["docker", "run", "--rm", "--network", "none", "-v", f"{Path(src).resolve()}:/app:ro",
            "-v", f"{PHP_META}:/pw/php_meta.php:ro", RUNTIME_IMAGE, "php", "/pw/php_meta.php", "/app"])
    Path(out).write_bytes(r.stdout)
    return {"out": str(out), "bytes": len(r.stdout)}


def prepare_copy(src, dest, db, port):
    """A writable copy of the customer's code, pointed at a workbench database. The customer's own files are not changed."""
    dest = Path(dest)
    if dest.exists():
        subprocess.run(["chmod", "-R", "u+w", str(dest)], check=False)
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True, ignore=shutil.ignore_patterns("cache"))
    subprocess.run(["chmod", "-R", "u+w", str(dest)], check=True)
    (dest / "cache").mkdir(exist_ok=True)
    composer = None
    if (dest / "composer.lock").exists() and not (dest / "vendor" / "autoload.php").exists():
        # customers send the code without vendor/; rebuild exactly the versions pinned in their composer.lock
        build_runtime()
        cache = STATE / "composer-cache"
        cache.mkdir(parents=True, exist_ok=True)
        r = sh(["docker", "run", "--rm", "-u", f"{os.getuid()}:{os.getgid()}", "-e", "COMPOSER_HOME=/composer", "-v", f"{cache}:/composer",
                "-v", f"{dest.resolve()}:/app", "-w", "/app", RUNTIME_IMAGE, "composer", "install", "--no-dev", "--no-interaction",
                "--optimize-autoloader", "--no-progress"], timeout=1800)
        composer = {"installed_from": "composer.lock", "tail": r.stderr.decode()[-300:]}
    c = creds()
    override = dest / "config_override.php"
    text = override.read_text() if override.exists() else "<?php\n"
    text += ("\n// Goose: this copy uses the job's workbench database and address.\n"
             f"$sugar_config['dbconfig']['db_host_name'] = '{DB_CONTAINER}';\n"
             f"$sugar_config['dbconfig']['db_name'] = '{db}';\n"
             "$sugar_config['dbconfig']['db_user_name'] = 'root';\n"
             f"$sugar_config['dbconfig']['db_password'] = '{c['root_password']}';\n"
             f"$sugar_config['site_url'] = 'http://localhost:{port}';\n"
             "$sugar_config['host_name'] = 'localhost';\n")
    override.write_text(text)
    return {"copy": str(dest), "db": db, "composer": composer}


def runtime_start(name, app, port):
    up()
    build_runtime()
    sh(["docker", "rm", "-f", name], check=False)
    sh(["docker", "run", "-d", "--name", name, "--network", NET, "-p", f"127.0.0.1:{port}:80",
        "-v", f"{Path(app).resolve()}:/var/www/html", RUNTIME_IMAGE])
    url = f"http://localhost:{port}/index.php?action=Login&module=Users"
    for _ in range(120):
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status == 200:
                    return {"name": name, "url": f"http://localhost:{port}"}
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"{name} did not answer on port {port}")


def runtime_stop(name):
    sh(["docker", "rm", "-f", name], check=False)
    return {"stopped": name}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("up")
    s = sub.add_parser("restore"); s.add_argument("--dump", required=True); s.add_argument("--db", required=True)
    s = sub.add_parser("clone"); s.add_argument("--src", required=True); s.add_argument("--dst", required=True)
    s = sub.add_parser("drop"); s.add_argument("--db", required=True)
    s = sub.add_parser("php-meta"); s.add_argument("--src", required=True); s.add_argument("--out", required=True)
    s = sub.add_parser("prepare-copy"); s.add_argument("--src", required=True); s.add_argument("--dest", required=True)
    s.add_argument("--db", required=True); s.add_argument("--port", type=int, required=True)
    s = sub.add_parser("runtime-start"); s.add_argument("--name", required=True); s.add_argument("--app", required=True)
    s.add_argument("--port", type=int, required=True)
    s = sub.add_parser("runtime-stop"); s.add_argument("--name", required=True)
    s = sub.add_parser("dsn"); s.add_argument("--db", required=True); s.add_argument("--reader", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "up":
        r = up()
    elif a.cmd == "restore":
        r = restore(a.dump, a.db)
    elif a.cmd == "clone":
        r = clone(a.src, a.dst)
    elif a.cmd == "drop":
        drop(a.db); r = {"dropped": a.db}
    elif a.cmd == "php-meta":
        r = php_meta(a.src, a.out)
    elif a.cmd == "prepare-copy":
        r = prepare_copy(a.src, a.dest, a.db, a.port)
    elif a.cmd == "runtime-start":
        r = runtime_start(a.name, a.app, a.port)
    elif a.cmd == "runtime-stop":
        r = runtime_stop(a.name)
    elif a.cmd == "dsn":
        d = dsn(a.db, "gs_reader" if a.reader else "root")
        r = {k: v for k, v in d.items() if k != "password"} | {"password_file": str(STATE / "credentials.json")}
    print(json.dumps(r))


if __name__ == "__main__":
    sys.exit(main())
