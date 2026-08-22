#!/usr/bin/env bash
#
# test-harness.sh
#
# Fast, self-contained test of delegate-to-opencode.sh's own logic —
# no real opencode invocation, no real model, no network. Runs in
# seconds by stubbing `opencode` with a fake executable that behaves in
# controlled ways (writes a real file, does nothing, or hangs past the
# timeout), and asserts on the resulting JSON summary.
#
# This exists because the no-op false-positive bug (a model that changes
# nothing still scored "pass") was a pure bash logic error in this script —
# it didn't need a live opencode run against a real model to catch, and
# each live run to discover it cost minutes instead of milliseconds. Run
# this after editing delegate-to-opencode.sh, before trusting it against
# a real (slow, costly) delegation.

set -euo pipefail

fail=0
pass_count=0
fail_count=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELEGATE_SCRIPT="$SCRIPT_DIR/delegate-to-opencode.sh"
[ -f "$DELEGATE_SCRIPT" ] || { echo "Error: $DELEGATE_SCRIPT not found." >&2; exit 2; }

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---- fixture repo ----
REPO="$WORKDIR/fixture-repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@test"
git -C "$REPO" config user.name "test"
echo "placeholder" > "$REPO/placeholder.txt"
git -C "$REPO" add placeholder.txt
git -C "$REPO" commit -q -m init
git -C "$REPO" branch -m main

mkdir -p "$REPO/.claude/agents" "$REPO/.opencode/agent"
cp "$DELEGATE_SCRIPT" "$REPO/delegate-to-opencode.sh"
chmod +x "$REPO/delegate-to-opencode.sh"

TASK_FILE="$WORKDIR/task.md"
echo "# Task: fixture task" > "$TASK_FILE"

# ---- fake opencode: behavior controlled by OPENCODE_FAKE_MODE ----
FAKE_BIN="$WORKDIR/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/opencode" <<'FAKE'
#!/usr/bin/env bash
case "${OPENCODE_FAKE_MODE:-noop}" in
  noop)
    echo '{"type":"text","text":"nothing to do here"}'
    exit 0
    ;;
  write)
    echo "fake content" > fake-output.txt
    echo '{"type":"text","text":"wrote fake-output.txt"}'
    exit 0
    ;;
  hang)
    sleep 30
    ;;
  *)
    exit 1
    ;;
esac
FAKE
chmod +x "$FAKE_BIN/opencode"
export PATH="$FAKE_BIN:$PATH"

run_case() {
  local name="$1" fake_mode="$2" timeout_s="$3" max_retries="$4" slug="$5"
  cat > "$REPO/.delegate.conf" <<EOF
OPENCODE_MODEL="fake/fake-model"
OPENCODE_AGENT="implementer"
BASE_BRANCH="main"
MAX_RETRIES=$max_retries
TEST_CMD="true"
LINT_CMD=""
TYPECHECK_CMD=""
LOG_FILE=".claude/logs/opencode-delegate.jsonl"
OPENCODE_TIMEOUT_SECONDS=$timeout_s
EOF
  export OPENCODE_FAKE_MODE="$fake_mode"
  summary="$(cd "$REPO" && ./delegate-to-opencode.sh "$slug" "$TASK_FILE" 2>"$WORKDIR/${slug}.stderr")" || true
  unset OPENCODE_FAKE_MODE
  echo "$summary"
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  OK   $desc"
    pass_count=$((pass_count + 1))
  else
    echo "  FAIL $desc (expected \"$expected\", got \"$actual\")"
    fail_count=$((fail_count + 1))
    fail=1
  fi
}

echo "=== case: real change, all gates pass -> status=pass ==="
summary="$(run_case "write" write 30 1 case-write)"
assert_eq "status" "pass" "$(echo "$summary" | jq -r '.status')"
assert_eq "files_changed" "1" "$(echo "$summary" | jq -r '.files_changed')"
assert_eq "attempt_count" "1" "$(echo "$summary" | jq -r '.attempt_count')"

echo ""
echo "=== case: no real change (silent no-op) -> status=escalate, NOT pass ==="
summary="$(run_case "noop" noop 30 1 case-noop)"
assert_eq "status" "escalate" "$(echo "$summary" | jq -r '.status')"
assert_eq "files_changed" "0" "$(echo "$summary" | jq -r '.files_changed')"
assert_eq "attempt_count" "2" "$(echo "$summary" | jq -r '.attempt_count')"
assert_eq "all attempts labeled no-op" "no-op" "$(echo "$summary" | jq -r '.attempts[0].failed_gate')"

echo ""
echo "=== case: opencode hangs past timeout -> status=escalate, labeled timeout, retries skipped ==="
summary="$(run_case "hang" hang 2 2 case-hang)"
assert_eq "status" "escalate" "$(echo "$summary" | jq -r '.status')"
assert_eq "attempt_count (retries must be skipped, not exhausted)" "1" "$(echo "$summary" | jq -r '.attempt_count')"
assert_eq "failed_gate" "timeout" "$(echo "$summary" | jq -r '.attempts[0].failed_gate')"
assert_eq "opencode_exit" "137" "$(echo "$summary" | jq -r '.attempts[0].opencode_exit')"

echo ""
echo "$pass_count passed, $fail_count failed"
exit "$fail"
