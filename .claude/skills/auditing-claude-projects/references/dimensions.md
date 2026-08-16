# Audit Dimensions

## 1. Static config audit

### 1.1 CLAUDE.md quality

- Locate global (`~/.claude/CLAUDE.md`) and every project CLAUDE.md (repo root plus any
  nested ones, e.g. `server/CLAUDE.md`).
- **Length:** files over ~200 lines are candidates for trimming — every line loads into every
  conversation in that project.
- **Redundancy:** does the project CLAUDE.md repeat rules already stated in global CLAUDE.md?
  Duplicated context costs tokens twice for no benefit.
- **Dead/broken `@`-references:** does the file force-load other files with `@path`? Verify
  they exist. Force-loaded files always cost tokens, even on tasks where they're irrelevant.
- **Conflicting instructions:** do global and project files disagree (e.g. global says
  "always X", project says "never X")? Project instructions win, but the conflict itself is a
  maintenance smell worth flagging.
- **Vague vs. actionable:** "write good code" / "be careful" vs. a specific tool, limit, or
  command. Vague rules don't change model behavior and are wasted tokens.
- **Phantom references:** does it document commands, scripts, or files that no longer exist in
  the repo?

### 1.2 Skill inventory

- List all skills visible to this project: `~/.claude/skills/*/SKILL.md` (personal),
  `<project>/.claude/skills/*/SKILL.md` (project), and any plugin-provided skills relevant to
  the work being done here.
- For each skill: does its `description` start with "Use when" (third person, triggers only,
  no workflow summary)? Descriptions that summarize the workflow cause Claude to follow the
  description instead of reading the skill body — flag these for rewrite.
- **Overlap:** do two skills' descriptions cover the same triggering conditions? Overlap
  creates ambiguity about which skill should fire.
- **Dead skills:** cross-reference against phase 2's actual `Skill` tool invocations. A skill
  present but never invoked across sampled sessions is a candidate for removal or a description
  rewrite (its trigger isn't firing).

### 1.3 Hooks & permissions

- `~/.claude/settings.json` and project `.claude/settings.json` / `.claude/settings.local.json`:
  list configured hooks (PreToolUse, PostToolUse, etc.) and what they match.
- **Broad matchers:** a hook matching every Bash call (or every tool call) runs constantly.
  Cross-check phase 2's hook-block/pass counts — a hook that almost never blocks is either
  working invisibly or is dead weight; a hook that blocks often may be miscalibrated or
  training the user/agent to route around it.
- **Permission friction:** an `allow` list that's too narrow causes repeated identical
  permission prompts (visible in session logs as repeated `permission-mode`/prompt events); one
  that's too broad grants risk without benefit. Compare against tools actually used in phase 2.

### 1.4 MCP servers

- `~/.claude.json` → `mcpServers`: each configured server injects its full tool schema into
  every request's context, whether used or not.
- Cross-reference tool calls found in phase 2 — an MCP server whose tools never appear in any
  sampled session is pure context overhead. Recommend disabling it for this project, or scoping
  it to a project-local config instead of the global one.

## 2. Dynamic session/usage audit

Run via `scripts/query-tracker-api.sh` (preferred, when the claude-project-tracker dev server
is reachable) or `scripts/analyze-sessions.mjs` (dependency-free fallback, parses raw JSONL).
Either yields, aggregated across sampled sessions:

- **Cost:** total $, broken down by model and by tool. Compare model choice to task complexity
  seen in the transcripts — Opus-tier cost on trivial edits, or Haiku-tier struggling on
  complex tasks (visible as high tool-error/retry rates), are both tuning issues.
- **Cache efficiency:** ratio of `cache_read_input_tokens` to
  `cache_creation_input_tokens + input_tokens + cache_read_input_tokens`. A low ratio means
  context isn't being reused between turns — e.g. CLAUDE.md or the system prompt changing every
  turn, or conversations restarting instead of continuing — and is direct wasted spend.
- **Tool failure rate:** `is_error: true` tool_result blocks, tallied by tool name. A tool with
  a high failure rate signals a bad tool description/schema, a flaky script, or the model
  mis-using it — all fixable once named.
- **Hook friction:** count of `hook-block` vs. `hook-pass` events. Frequent blocks on the same
  hook indicate an overly strict or miscalibrated hook (see 1.3).
- **Skill usage:** distinct skill names actually invoked (`Skill` tool calls) — feed back into
  1.2's dead-skill check.
- **Turn/session shape:** very high turn counts that never resolve can indicate ambiguous
  CLAUDE.md instructions causing back-and-forth correction loops — a prompt-engineering signal,
  not just a cost one.

Sample enough sessions to be representative — for an active project, the most recent 20-30
sessions or everything from the last 2 weeks is usually enough; for a quiet project, use
everything available.
