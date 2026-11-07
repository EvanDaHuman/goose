#!/bin/bash
# Stop the worker, the web UI and the project-local PostgreSQL.
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
source scripts/processes.sh
stop_project_processes 'worker/index[.]ts'
stop_project_processes 'next dev --port 3000|next-server'
stop_project_processes 'var/jobs/.*/showroom'
bash scripts/pg.sh stop
