#!/usr/bin/env bash
#
# log-summary.sh [path-to-log]
#
# Quick triage view over the delegate log: pass rate and average attempts/
# duration per model, plus the most recent escalations. This is the data
# that eventually tells you which task types are actually worth delegating
# to which local model, instead of going on feel.

set -euo pipefail

LOG_FILE="${1:-.claude/logs/opencode-delegate.jsonl}"

if [ ! -f "$LOG_FILE" ]; then
  echo "No log file at $LOG_FILE yet — run a delegation first."
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "jq is required."; exit 1; }

echo "=== by model ==="
jq -s '
  group_by(.model) | map({
    model: .[0].model,
    runs: length,
    pass_rate_pct: ((map(select(.status=="pass")) | length) / length * 100 | floor),
    avg_attempts: ((map(.attempt_count) | add / length) * 100 | floor / 100),
    avg_duration_s: (map(.duration_seconds) | add / length | floor)
  })
' "$LOG_FILE"

echo ""
echo "=== suggested OPENCODE_TIMEOUT_SECONDS per model ==="
echo "(50% headroom over the slowest observed non-killed attempt; models with"
echo "no successful attempt yet have no reliable signal, so none is shown)"
jq -s '
  [.[] | .attempts[]? | select(.opencode_duration_seconds != null) as $a
    | {model: .model, duration: $a.opencode_duration_seconds, timed_out: (.status == "escalate" and $a.failed_gate == "timeout")}]
  | group_by(.model)
  | map(select(any(.[]; .timed_out | not)))
  | map({
      model: .[0].model,
      slowest_completed_s: (map(select(.timed_out | not) | .duration) | max),
      suggested_timeout_s: ((map(select(.timed_out | not) | .duration) | max) * 1.5 | floor)
    })
' "$LOG_FILE"

echo ""
echo "=== last 5 escalations ==="
jq -s '[.[] | select(.status=="escalate")] | .[-5:] | map({timestamp, slug, model, attempts})' "$LOG_FILE"

echo ""
echo "=== overall ==="
jq -s '{
  total_runs: length,
  overall_pass_rate_pct: ((map(select(.status=="pass")) | length) / length * 100 | floor)
}' "$LOG_FILE"
