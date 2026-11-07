#!/bin/bash
# One-time setup. Safe to run again. macOS (Apple silicon) with Homebrew.
#   Needs: Node 20.9+, /usr/bin/python3 (3.9, the legacy runtime), python3.13, uv, postgresql@17, zip.
set -euo pipefail
PGPORT_PW="${GOOSE_PG_PORT:-54329}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || [ -x "$1" ] || { echo "Missing: $1 ($2)"; exit 1; }; }

say "Checking prerequisites"
need node "brew install node"
need /usr/bin/python3 "xcode-select --install"
need /opt/homebrew/bin/python3.13 "brew install python@3.13"
need /opt/homebrew/bin/uv "brew install uv"
need /opt/homebrew/opt/postgresql@17/bin/postgres "brew install postgresql@17"
need /usr/bin/sandbox-exec "macOS sandbox (built in)"
need /usr/bin/zip "zip"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<20||(a===20&&b<9)) {console.error("Node 20.9+ required"); process.exit(1)}'

say "Node packages"
[ -d node_modules/next ] || npm install --no-audit --no-fund

say "PostgreSQL (project-local, 127.0.0.1:$PGPORT_PW)"
bash scripts/pg.sh init
bash scripts/pg.sh start
ADMIN_PW="$(cat var/pg/admin-password)"
PGBIN=/opt/homebrew/opt/postgresql@17/bin
if [ ! -f .env ]; then
  APP_PW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sed -e "s#goose_app:CHANGE_ME#goose_app:${APP_PW}#" -e "s#goose_admin:CHANGE_ME#goose_admin:${ADMIN_PW}#" \
      -e "s#127.0.0.1:54329#127.0.0.1:${PGPORT_PW}#g" .env.example > .env
  chmod 600 .env
fi
APP_PW="$(grep '^DATABASE_URL=' .env | sed -E 's#.*goose_app:([^@]+)@.*#\1#')"
PGPASSWORD="$ADMIN_PW" "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT_PW" -U goose_admin -d postgres -q -v ON_ERROR_STOP=1 <<SQL
DO \$\$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'goose_app') THEN
    CREATE ROLE goose_app LOGIN PASSWORD '${APP_PW}';
  END IF;
END\$\$;
SELECT 'CREATE DATABASE goose OWNER goose_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'goose')\gexec
REVOKE ALL ON DATABASE goose FROM PUBLIC;
SQL

say "Python runtimes"
mkdir -p var/venvs
if [ ! -x var/venvs/engine/bin/python ]; then
  uv venv --python /opt/homebrew/bin/python3.13 var/venvs/engine -q
fi
uv pip install --python var/venvs/engine/bin/python -q "psycopg[binary]==3.3.7" "pytest==8.4.2" "django-upgrade==1.33.0" "PyMySQL==1.2.3"
if [ ! -x var/venvs/legacy-py39/bin/python ]; then
  uv venv --python /usr/bin/python3 var/venvs/legacy-py39 -q
  uv pip install --python var/venvs/legacy-py39/bin/python -q -r engine/runtimes/legacy-py39/requirements.txt
fi

say "Company database"
npx tsx --env-file=.env scripts/migrate.ts
npx tsx --env-file=.env scripts/seed.ts

say "Done. Start everything with: npm start   (web UI on http://localhost:3000)"
