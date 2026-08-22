#!/usr/bin/env bash
#
# delegate-to-opencode.sh <slug> <task-file>
#
# Delegates one scoped implementation task to opencode (running a local model),
# inside an isolated git worktree, gated by lint/typecheck/test checks, with
# bounded, feedback-driven retries. Prints a JSON summary to stdout and appends
# it to the delegate log.
#
# stdout carries ONLY the final JSON summary — by design, so a caller with a
# limited context budget (e.g. a Claude Code subagent) never has to read
# anything else to know what happened. Routine progress goes to a log file in
# the worktree; only setup/config errors (exit 2, before any worktree exists)
# go to stderr, since those are real failures with nowhere else to land.
#
# Exit 0 = passed all gates
# Exit 1 = retries exhausted, needs escalation
# Exit 2 = setup/config error
#
# Config comes from .delegate.conf at the repo root. See delegate.conf.example.

set -euo pipefail

SLUG="${1:-}"
TASK_FILE="${2:-}"

if [ -z "$SLUG" ] || [ -z "$TASK_FILE" ]; then
  echo "Usage: $0 <slug> <task-file>" >&2
  exit 2
fi
if [ ! -f "$TASK_FILE" ]; then
  echo "Error: task file not found: $TASK_FILE" >&2
  exit 2
fi
if [[ ! "$SLUG" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Error: slug must be alphanumeric/dash/underscore only (used as branch + dir name): $SLUG" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not inside a git repo." >&2
  exit 2
}
cd "$REPO_ROOT"

# ---- config (defaults, overridden by .delegate.conf) ----
OPENCODE_MODEL="ollama/qwen3-coder-30b"
OPENCODE_AGENT="implementer"
BASE_BRANCH="main"
MAX_RETRIES=2
TEST_CMD=""
LINT_CMD=""
TYPECHECK_CMD=""
DIFF_SIZE_ESCALATE_LINES=400
LOG_FILE=".claude/logs/opencode-delegate.jsonl"
# Hard backstop per opencode invocation, independent of whatever timeout the
# caller (e.g. Claude Code's Bash tool) enforces on the whole script. Exists
# because a headless run can in principle hang waiting on a permission prompt
# that will never come — this guarantees the process dies instead of sitting
# on the GPU indefinitely. 300s is a starting guess, not a measured value —
# check `log-summary.sh`'s suggested-timeout line after a few real runs and
# raise this if your model/endpoint is slower than that.
OPENCODE_TIMEOUT_SECONDS=300
EXTRA_PATH=""

if [ -f "$REPO_ROOT/.delegate.conf" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.delegate.conf"
fi

if [ -z "$TEST_CMD" ]; then
  echo "Error: TEST_CMD is not set. Edit .delegate.conf before running this." >&2
  exit 2
fi

# Gate commands (LINT_CMD/TYPECHECK_CMD/TEST_CMD) run via `eval` in a subshell
# of this script, so this script's own PATH — not your interactive shell's —
# is what matters. Set EXTRA_PATH in .delegate.conf if your package manager
# lives behind a shim not on the default PATH (e.g. a corepack-managed pnpm
# in a user-writable dir, because the system node install is root-owned).
if [ -n "$EXTRA_PATH" ]; then
  export PATH="$EXTRA_PATH:$PATH"
fi

command -v jq >/dev/null 2>&1 || { echo "Error: jq is required." >&2; exit 2; }
command -v opencode >/dev/null 2>&1 || { echo "Error: opencode not found on PATH." >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "Error: 'timeout' (coreutils) is required." >&2; exit 2; }
command -v setsid >/dev/null 2>&1 || { echo "Error: 'setsid' (util-linux) is required." >&2; exit 2; }

mkdir -p "$(dirname "$LOG_FILE")"

# Keep this script's own bookkeeping files out of git entirely — otherwise they
# pollute `git add -A` and the diff-stat used for the summary. info/exclude is
# shared across all worktrees of this repo, so this only needs doing once.
git_common_dir="$(git rev-parse --absolute-git-dir)"
mkdir -p "$git_common_dir/info"
exclude_file="$git_common_dir/info/exclude"
touch "$exclude_file"
for pattern in ".delegate-prompt-*.md" ".delegate-opencode-*.log" ".delegate-feedback.md" ".delegate-progress.log"; do
  grep -qxF "$pattern" "$exclude_file" 2>/dev/null || echo "$pattern" >> "$exclude_file"
done

# Inside the repo (.worktrees/), not a sibling of it (../wt-*) — a sibling
# directory assumes the repo's parent is writable, which isn't true on every
# host (e.g. a sandboxed environment where only the repo itself is). The
# installer gitignores .worktrees/ so this never pollutes `git status`.
WORKTREE_DIR=".worktrees/wt-${SLUG}"
BRANCH="task/${SLUG}"
START_TIME=$(date +%s)
PROGRESS_LOG="" # set once WORKTREE_DIR exists, below

# ---- worktree setup (idempotent — reruns on the same slug reuse the worktree) ----
if [ -d "$WORKTREE_DIR" ]; then
  reused="true"
else
  if ! worktree_output="$(git worktree add "$WORKTREE_DIR" -b "$BRANCH" "$BASE_BRANCH" 2>&1)"; then
    echo "Error: git worktree add failed:" >&2
    echo "$worktree_output" >&2
    exit 2
  fi
  reused="false"
fi

PROGRESS_LOG="$WORKTREE_DIR/.delegate-progress.log"
{
  echo "--- run started $(date -u +%Y-%m-%dT%H:%M:%SZ) (slug: $SLUG, reused worktree: $reused) ---"
} >> "$PROGRESS_LOG"

cp "$TASK_FILE" "$WORKTREE_DIR/TASK.md"

# Share one conventions file between Claude Code and opencode, don't maintain two.
if [ -f "$WORKTREE_DIR/CLAUDE.md" ] && [ ! -e "$WORKTREE_DIR/AGENTS.md" ]; then
  ln -s CLAUDE.md "$WORKTREE_DIR/AGENTS.md"
fi

rm -f "$WORKTREE_DIR/.delegate-feedback.md"

# ---- attempt loop ----
attempt=1
max_attempts=$((MAX_RETRIES + 1))
status="escalate"
attempts_log="[]"

while [ "$attempt" -le "$max_attempts" ]; do
  echo "=== attempt $attempt/$max_attempts ===" >> "$PROGRESS_LOG"

  prompt_file="$WORKTREE_DIR/.delegate-prompt-${attempt}.md"
  cp "$WORKTREE_DIR/TASK.md" "$prompt_file"
  if [ -f "$WORKTREE_DIR/.delegate-feedback.md" ]; then
    {
      echo ""
      echo "## Feedback from previous attempt — fix this specifically, don't start over"
      cat "$WORKTREE_DIR/.delegate-feedback.md"
    } >> "$prompt_file"
  fi
  prompt_content="$(cat "$prompt_file")"

  opencode_start=$(date +%s)
  set +e
  ( cd "$WORKTREE_DIR" && \
    setsid timeout --signal=KILL "${OPENCODE_TIMEOUT_SECONDS}s" \
      opencode run --agent "$OPENCODE_AGENT" --model "$OPENCODE_MODEL" \
        --format json "$prompt_content" \
      > ".delegate-opencode-${attempt}.log" 2>&1 )
  opencode_exit=$?
  set -e
  opencode_duration=$(( $(date +%s) - opencode_start ))
  if [ "$opencode_exit" -eq 137 ] || [ "$opencode_exit" -eq 143 ]; then
    echo "opencode killed after ${OPENCODE_TIMEOUT_SECONDS}s (attempt $attempt)" >> "$PROGRESS_LOG"
  fi

  gate_failed=""
  gate_output=""

  # A model that makes no edits still leaves lint/typecheck/test passing
  # trivially on unmodified code — without this check that reads as "pass".
  # TASK.md and AGENTS.md are the script's own bookkeeping (copied/symlinked
  # in above), excluded via pathspec so a diff containing only those two is
  # a no-op, not progress. Deliberately `git status --porcelain`, NOT
  # `git diff --name-only $BASE_BRANCH`: diff against a ref only shows
  # changes to already-tracked files, so a brand-new file opencode creates
  # (common — e.g. a new module) is invisible to it and would be
  # misdetected as a no-op even though real work happened. `git status`
  # shows untracked files too.
  real_changes="$(cd "$WORKTREE_DIR" && git status --porcelain -- . ':!TASK.md' ':!AGENTS.md' 2>/dev/null || true)"
  timed_out="false"
  if [ -z "$real_changes" ]; then
    if [ "$opencode_exit" -eq 137 ] || [ "$opencode_exit" -eq 143 ]; then
      gate_failed="timeout"
      timed_out="true"
      gate_output="opencode was killed by the ${OPENCODE_TIMEOUT_SECONDS}s per-attempt timeout (OPENCODE_TIMEOUT_SECONDS in .delegate.conf) before producing any change. This is deterministic — the same model/prompt/timeout will hang at the same point again, so retrying identically wastes time. Raise OPENCODE_TIMEOUT_SECONDS, or split the task smaller, rather than re-running as-is."
    else
      gate_failed="no-op"
      gate_output="opencode made no changes to any file other than TASK.md/AGENTS.md (this script's own bookkeeping files). opencode exited with code ${opencode_exit}. Raw opencode output for this attempt (tail):
$(tail -c 2000 "$WORKTREE_DIR/.delegate-opencode-${attempt}.log" 2>/dev/null || echo '(log unavailable)')"
    fi
  fi

  if [ -n "$LINT_CMD" ] && [ -z "$gate_failed" ]; then
    if ! gate_output="$(cd "$WORKTREE_DIR" && eval "$LINT_CMD" 2>&1)"; then
      gate_failed="lint"
    fi
  fi

  if [ -n "$TYPECHECK_CMD" ] && [ -z "$gate_failed" ]; then
    if ! gate_output="$(cd "$WORKTREE_DIR" && eval "$TYPECHECK_CMD" 2>&1)"; then
      gate_failed="typecheck"
    fi
  fi

  if [ -z "$gate_failed" ]; then
    if ! gate_output="$(cd "$WORKTREE_DIR" && eval "$TEST_CMD" 2>&1)"; then
      gate_failed="test"
    fi
  fi

  attempts_log=$(jq -c --arg n "$attempt" --arg gate "${gate_failed:-none}" \
    --arg oc_exit "$opencode_exit" --arg oc_duration "$opencode_duration" \
    '. + [{attempt: ($n|tonumber), failed_gate: $gate, opencode_exit: ($oc_exit|tonumber), opencode_duration_seconds: ($oc_duration|tonumber)}]' \
    <<< "$attempts_log")

  if [ -z "$gate_failed" ]; then
    status="pass"
    # Commit opencode's changes so the branch is actually mergeable — opencode
    # itself may or may not commit, so this is a no-op if it already did.
    if [ -n "$(cd "$WORKTREE_DIR" && git status --porcelain)" ]; then
      ( cd "$WORKTREE_DIR" && git add -A && git commit -q -m "opencode: implement ${SLUG} (attempt ${attempt})" )
    fi
    break
  fi

  echo "gate failed: $gate_failed (attempt $attempt/$max_attempts)" >> "$PROGRESS_LOG"
  {
    echo "$gate_output" | tail -c 4000   # keep feedback bounded
    echo ""
    echo "(failed gate: $gate_failed, attempt $attempt of $max_attempts)"
  } > "$WORKTREE_DIR/.delegate-feedback.md"

  # A timeout with zero real changes is deterministic (same model, same
  # prompt, same timeout => same hang point) — burning the remaining
  # retries on an identical re-run just wastes GPU time. Escalate now.
  if [ "$timed_out" = "true" ]; then
    echo "timeout is deterministic, skipping remaining retries" >> "$PROGRESS_LOG"
    break
  fi

  attempt=$((attempt + 1))
done

# ---- summary ----
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Single-ref diff (working tree vs base branch) rather than double/triple-dot —
# this correctly captures opencode's changes whether or not it committed them,
# and whether or not the pass-case auto-commit above ran. TASK.md/AGENTS.md
# excluded via pathspec so this script's own bookkeeping files (which do get
# swept into the pass-case auto-commit alongside real changes) don't inflate
# the reported diff size or spuriously trip DIFF_SIZE_ESCALATE_LINES.
diffstat="$(cd "$WORKTREE_DIR" && git diff --shortstat "$BASE_BRANCH" -- . ':!TASK.md' ':!AGENTS.md' 2>/dev/null || true)"
files_changed=$(echo "$diffstat" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo 0)
insertions=$(echo "$diffstat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
deletions=$(echo "$diffstat" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
total_lines=$((insertions + deletions))

recommend_review="false"
if [ "$status" = "escalate" ] || [ "$total_lines" -gt "$DIFF_SIZE_ESCALATE_LINES" ]; then
  recommend_review="true"
fi

final_attempt_count=$attempt
if [ "$attempt" -gt "$max_attempts" ]; then
  final_attempt_count=$max_attempts
fi

summary=$(jq -n \
  --arg slug "$SLUG" \
  --arg branch "$BRANCH" \
  --arg worktree_dir "$WORKTREE_DIR" \
  --arg model "$OPENCODE_MODEL" \
  --arg agent "$OPENCODE_AGENT" \
  --arg base_branch "$BASE_BRANCH" \
  --arg status "$status" \
  --argjson attempts "$attempts_log" \
  --argjson attempt_count "$final_attempt_count" \
  --argjson files_changed "$files_changed" \
  --argjson insertions "$insertions" \
  --argjson deletions "$deletions" \
  --argjson duration_seconds "$DURATION" \
  --argjson recommend_full_diff_review "$recommend_review" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    timestamp: $timestamp, slug: $slug, branch: $branch, worktree_dir: $worktree_dir,
    model: $model, agent: $agent, base_branch: $base_branch,
    status: $status, attempt_count: $attempt_count, attempts: $attempts,
    files_changed: $files_changed, insertions: $insertions, deletions: $deletions,
    duration_seconds: $duration_seconds,
    recommend_full_diff_review: $recommend_full_diff_review
  }')
echo "$summary" | tee -a "$LOG_FILE"

if [ "$status" = "pass" ]; then
  exit 0
else
  exit 1
fi
