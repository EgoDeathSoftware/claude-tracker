#!/usr/bin/env bash
# Probes the claude-project-tracker dev server for session/cost data. Preferred data source for
# the auditing-claude-projects skill's dynamic phase. Exits 1 when the tracker isn't reachable,
# which the skill treats as a signal to fall back to scripts/analyze-sessions.mjs.
set -euo pipefail

base_url="${TRACKER_API_URL:-http://localhost:3001}"
project_id="${1:-}"
timeout_s=2

if ! curl -sf --max-time "$timeout_s" "$base_url/api/projects" >/dev/null; then
  echo "tracker API unreachable at $base_url (is 'pnpm dev' running?)" >&2
  exit 1
fi

if [[ -z "$project_id" ]]; then
  echo "No projectId given — listing available projects:" >&2
  curl -sf --max-time "$timeout_s" "$base_url/api/projects"
  exit 0
fi

curl -sf --max-time "$timeout_s" -G "$base_url/api/sessions" --data-urlencode "projectId=$project_id"
