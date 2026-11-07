#!/bin/bash
# Start PostgreSQL, the worker and the web UI. Logs go to var/logs/. Stop with: npm run stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
source scripts/processes.sh
[ -f .env ] || { echo "Run npm run setup first."; exit 1; }
mkdir -p var/logs
if [ -d var/pg/data ]; then bash scripts/pg.sh start; fi
PORT="$(node --env-file=.env -p 'process.env.GOOSE_PORT || 3100')"
if [ -n "$(project_pids 'worker/index[.]ts')" ]; then echo "worker already running"; else
  nohup npx tsx --env-file=.env worker/index.ts >> var/logs/worker.log 2>&1 &
  echo "worker started (log: var/logs/worker.log)"
fi
echo "web UI: http://localhost:$PORT  (Ctrl+C stops the web UI; npm run stop stops this checkout's processes)"
exec npx next dev --port "$PORT"
