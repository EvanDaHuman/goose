#!/bin/bash
# Process names alone are shared by every checkout. Only manage this project's processes.
# The caller sets ROOT to its physical checkout path before sourcing this file.
project_pids() {
  local pid process_cwd
  while IFS= read -r pid; do
    [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ] || continue
    process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    case "$process_cwd" in
      "$ROOT"|"$ROOT/var/jobs/"*) printf '%s\n' "$pid" ;;
    esac
  done < <(pgrep -f "$1" || true)
}

stop_project_processes() {
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done < <(project_pids "$1")
}
