#!/usr/bin/env bash
#
# preflight.sh
#
# Fast sanity check for the opencode-delegate setup, run once before the
# first real delegation (and again after changing .delegate.conf or
# .opencode/ config). Catches the environment/config problems that
# otherwise only surface after a full, slow, live delegation cycle:
# missing PATH entries, an agent that doesn't resolve, a model that can't
# actually make tool calls, a worktree dir that can't be created, and
# .opencode/ not being tracked in git (so `git worktree add` never
# materializes it).
#
# Exit 0 = all checks passed. Exit 1 = at least one check failed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "FAIL: not inside a git repo." >&2
  exit 1
}
cd "$REPO_ROOT"

fail=0
check() {
  local desc="$1"
  shift
  if "$@" >/tmp/preflight-check.$$ 2>&1; then
    echo "OK   $desc"
    rm -f /tmp/preflight-check.$$
  else
    echo "FAIL $desc"
    sed 's/^/       /' /tmp/preflight-check.$$
    rm -f /tmp/preflight-check.$$
    fail=1
  fi
}

echo "=== dependencies ==="
check "jq on PATH" command -v jq
check "opencode on PATH" command -v opencode
check "timeout (coreutils) on PATH" command -v timeout
check "setsid (util-linux) on PATH" command -v setsid

echo ""
echo "=== config ==="
if [ ! -f "$REPO_ROOT/.delegate.conf" ]; then
  echo "FAIL .delegate.conf exists"
  fail=1
else
  echo "OK   .delegate.conf exists"
  # shellcheck disable=SC1091
  OPENCODE_MODEL=""; OPENCODE_AGENT=""; TEST_CMD=""; EXTRA_PATH=""
  source "$REPO_ROOT/.delegate.conf"
  if [ -n "$EXTRA_PATH" ]; then
    export PATH="$EXTRA_PATH:$PATH"
  fi
  if [ -z "$TEST_CMD" ]; then
    echo "FAIL TEST_CMD is set in .delegate.conf"
    fail=1
  else
    echo "OK   TEST_CMD is set (\"$TEST_CMD\")"
    check "TEST_CMD's command is reachable from this script's PATH" \
      bash -c "command -v \"\$(echo \"$TEST_CMD\" | awk '{print \$1}')\""
  fi
fi

echo ""
echo "=== git / worktree ==="
check ".opencode/ is tracked in git (worktrees only see tracked files)" \
  bash -c "[ -n \"\$(git ls-files .opencode/ 2>/dev/null)\" ]"
TEST_WT=".worktrees/wt-preflight-$$"
if git worktree add "$TEST_WT" -b "preflight-test-$$" HEAD >/tmp/preflight-wt.$$ 2>&1; then
  echo "OK   can create a worktree under .worktrees/"
  rm -f /tmp/preflight-wt.$$
  git worktree remove "$TEST_WT" --force >/dev/null 2>&1
  git branch -D "preflight-test-$$" >/dev/null 2>&1
else
  echo "FAIL can create a worktree under .worktrees/"
  sed 's/^/       /' /tmp/preflight-wt.$$
  rm -f /tmp/preflight-wt.$$
  fail=1
fi

echo ""
echo "=== opencode agent + model ==="
if [ -n "${OPENCODE_AGENT:-}" ]; then
  if opencode agent list 2>/dev/null | grep -q "^${OPENCODE_AGENT} "; then
    echo "OK   agent \"$OPENCODE_AGENT\" resolves (opencode agent list)"
  else
    echo "FAIL agent \"$OPENCODE_AGENT\" resolves (opencode agent list)"
    echo "       not found — check .opencode/agent(s)/${OPENCODE_AGENT}.md exists and is tracked"
    fail=1
  fi
fi

if [ -n "${OPENCODE_MODEL:-}" ]; then
  # Bounded: a model that hangs instead of erroring (e.g. stuck waiting on a
  # malformed request the server never rejects) would otherwise hang this
  # check indefinitely — exactly the failure mode this whole tool exists to
  # catch early, so it can't be allowed to happen here too.
  tool_call_result="$(timeout --signal=KILL 60s opencode run --model "$OPENCODE_MODEL" \
    "Call the bash tool to run: echo preflight-ok" 2>&1)"
  tool_call_exit=$?
  if [ "$tool_call_exit" -eq 137 ] || [ "$tool_call_exit" -eq 143 ]; then
    echo "FAIL model \"$OPENCODE_MODEL\" can make a real tool call"
    echo "       timed out after 60s with no response at all — the model or"
    echo "       endpoint may be unreachable, overloaded, or hanging rather"
    echo "       than erroring"
    fail=1
  elif echo "$tool_call_result" | grep -q "preflight-ok"; then
    echo "OK   model \"$OPENCODE_MODEL\" can make a real tool call"
  else
    echo "FAIL model \"$OPENCODE_MODEL\" can make a real tool call"
    echo "       got instead:"
    echo "$tool_call_result" | sed 's/^/       /' | tail -10
    echo "       common causes: model not declared in provider.models in"
    echo "       .opencode/opencode.json, or the backing server needs a"
    echo "       tool-call flag (vLLM: --enable-auto-tool-choice --tool-call-parser <parser>)"
    fail=1
  fi
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "All checks passed."
else
  echo "One or more checks failed — fix these before running a real delegation."
fi
exit "$fail"
