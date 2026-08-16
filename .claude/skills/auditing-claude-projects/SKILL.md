---
name: auditing-claude-projects
description: Use when asked to audit, review, or evaluate a Claude Code project's setup — its CLAUDE.md files, skills, hooks, permissions, or MCP servers — or its actual usage: session cost, token/cache efficiency, tool failure rates, or wasted context. Also use when asked why a project is expensive, slow, or failing often.
---

# Auditing Claude Projects

## Overview

Full audit of a Claude Code project: static setup (CLAUDE.md, skills, hooks, permissions, MCP
servers) plus dynamic usage from real session transcripts (cost, cache efficiency, tool
failures, dead skills). Produces one ranked report with concrete recommendations.

## When to use

- "audit/review this Claude project setup"
- "why is this project expensive / slow / failing a lot"
- "are these skills/hooks actually being used"
- "how much context are we wasting"

Not for: a single CLAUDE.md quality pass (use claude-md-improver), or automation
recommendations only (use claude-automation-recommender). This skill composes both plus
session-level cost/failure data — use it when the ask spans more than one of those axes.

## Workflow

1. **Resolve target** — determine the project directory to audit (cwd, or user-specified path)
   and its `~/.claude/projects/<slug>/` session directory (slug = absolute path with `/` → `-`).

2. **Static config audit** — read global (`~/.claude/CLAUDE.md`) + project CLAUDE.md,
   enumerate `~/.claude/skills/` and `<project>/.claude/skills/`, inspect
   `~/.claude/settings.json` / project `.claude/settings*.json` for hooks and permissions, and
   MCP servers from `~/.claude.json`. Checklist: `references/dimensions.md` §1.

3. **Dynamic session audit** — run `scripts/query-tracker-api.sh <projectId>`. If it exits
   non-zero (tracker not running), run
   `node scripts/analyze-sessions.mjs <path-to-session-dir>` instead. Either path yields
   cost/model/tool breakdown, cache hit ratio, tool error rate, hook blocks, and skills actually
   invoked. Checklist: `references/dimensions.md` §2.

4. **Synthesize** — merge findings using `references/report-template.md`, rank by cost/impact,
   and write the report to a file (e.g. `claude-project-audit-<date>.md`) instead of only
   replying inline.

## Quick reference

| Dimension | Source | Details |
|---|---|---|
| CLAUDE.md quality | static | dimensions.md §1.1 |
| Skill inventory & dead skills | static + dynamic | dimensions.md §1.2, §2 |
| Hooks & permissions tuning | static | dimensions.md §1.3 |
| MCP context overhead | static | dimensions.md §1.4 |
| Cost & cache efficiency | dynamic | analyze-sessions.mjs / tracker API |
| Tool failure rate | dynamic | analyze-sessions.mjs / tracker API |
| Report structure | — | report-template.md |

## Common mistakes

- Skipping the tracker-API probe and always falling back to JSONL — the API is faster and
  richer when available; always try it first.
- Reporting raw token counts without cost — convert to dollars so findings are rankable.
- Flagging a skill as "unused" from static inspection alone — cross-check against actual
  `Skill` tool invocations from phase 3 before calling it dead.
