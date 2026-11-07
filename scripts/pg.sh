#!/bin/bash
# Project-local PostgreSQL 17 (TCP 127.0.0.1:54329 only, password auth, no Unix socket).
# Usage: scripts/pg.sh init|start|stop|status
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
DATA="$ROOT/var/pg/data"
PW="$ROOT/var/pg/admin-password"
PORT="${GOOSE_PG_PORT:-54349}"

case "${1:-status}" in
  init)
    mkdir -p "$ROOT/var/pg" && chmod 700 "$ROOT/var/pg"
    [ -f "$PW" ] || { python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$PW"; chmod 600 "$PW"; }
    if [ ! -d "$DATA" ]; then
      "$PGBIN/initdb" -D "$DATA" -U goose_admin --auth-host=scram-sha-256 --auth-local=reject --pwfile="$PW" -E UTF8 --locale=en_US.UTF-8 >/dev/null
      printf "listen_addresses = '127.0.0.1'\nport = %s\nunix_socket_directories = ''\nmax_connections = 200\npassword_encryption = 'scram-sha-256'\n" "$PORT" > "$DATA/postgresql.auto.conf"
      printf "# TYPE  DATABASE  USER  ADDRESS        METHOD\nhost    all       all   127.0.0.1/32   scram-sha-256\n" > "$DATA/pg_hba.conf"
      echo "initialised $DATA"
    fi ;;
  start)
    if "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "postgres already running"; else
      LC_ALL=en_US.UTF-8 "$PGBIN/pg_ctl" -D "$DATA" -l "$ROOT/var/pg/server.log" -w start >/dev/null && echo "postgres started on 127.0.0.1:$PORT"; fi ;;
  stop)
    "$PGBIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 && echo "postgres stopped" || echo "postgres was not running" ;;
  status)
    "$PGBIN/pg_ctl" -D "$DATA" status || true ;;
esac
