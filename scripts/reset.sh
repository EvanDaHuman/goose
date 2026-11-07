#!/bin/bash
# Remove every job, its files and its databases, then re-seed settings and prospects.
# Keeps the PostgreSQL cluster, the Python runtimes and .env. Asks first.
set -euo pipefail
PGPORT_PW="${GOOSE_PG_PORT:-54329}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "${1:-}" != "--yes" ]; then
  read -r -p "Delete all jobs, job files and job databases? [y/N] " ans
  [ "$ans" = "y" ] || { echo "cancelled"; exit 1; }
fi
pkill -f "worker/index.ts" || true
pkill -f "var/jobs/.*/showroom" || true
bash scripts/pg.sh start >/dev/null
ADMIN_PW="$(cat var/pg/admin-password)"
PGBIN=/opt/homebrew/opt/postgresql@17/bin
for db in $(PGPASSWORD="$ADMIN_PW" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_PW" -U goose_admin -d postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'job_%'"); do
  PGPASSWORD="$ADMIN_PW" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_PW" -U goose_admin -d postgres -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db';" -c "DROP DATABASE IF EXISTS $db;" -c "DROP ROLE IF EXISTS $db;" >/dev/null
done
PGPASSWORD="$ADMIN_PW" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_PW" -U goose_admin -d goose -q -v ON_ERROR_STOP=1 -c "
  DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION goose_app;" >/dev/null
chmod -R u+w var/jobs 2>/dev/null || true
rm -rf var/jobs
npx tsx --env-file=.env scripts/migrate.ts
npx tsx --env-file=.env scripts/seed.ts
echo "Reset done. Start with: npm start   then (another terminal) npm run demo"
