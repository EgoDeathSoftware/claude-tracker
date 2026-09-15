# Session manager: a board of unfinished work across every project

**Date:** 2026-09-07
**Status:** Design, awaiting approval
**Spans two repos:** `agent-analyzer` (sessionkit — the new `sk board` command and the
`session-manager` skill) and `claude-project-tracker` (the Manager panel over it).
**Builds on:** `agent-analyzer/SPEC.md` (the filesystem is the store of record) and
`2026-09-03-session-archive-database-design.md`.

## Problem

Work is abandoned mid-thought across dozens of sessions and a dozen projects, and there is
no way to see it. The corpus records exactly what was left hanging — an unmatched tool call,
a stated next step, a file edited but never committed — but reading it means opening one
session at a time and remembering which ones to open.

Two partial answers already exist and neither is the thing:

- **`sk tail --all`** classifies each session's tail (`mid_tool`, `error_tail`, `apology`,
  `completion_marker`, `next_step_stated`, `silent`, `neutral`). It is per-session, it
  deliberately drops every `complete` session, and it returns row excerpts rather than the
  last thing actually said.
- **The `unfinished-work` skill** composes `sk tail --all` + `sk files --uncommitted` +
  `sk tail <sid>` into handoff briefs. It works, but its bucketing table lives in prose in a
  markdown file, so the classification is re-derived by a model on every run and cannot be
  tested.

Neither rolls up to the **project**, which is the unit a person actually returns to. "Which
of my projects has something waiting in it, and what was the last thing said there" is not a
question either can answer.

## Goal

One deterministic command that reads the last N days of the corpus and emits, per project,
every thread's final exchange plus a reproducible judgment of how recoverable it is. Two
surfaces over that one command: a **manager agent** for the terminal, and a **Manager
panel** in the tracker that adds memory (dismiss, snooze, done) and LLM-written project
briefs.

## Scope

In scope: `kind: claude-code` sources at every location (host, container store-set children,
subagents), read-only analysis, and the two surfaces above.

Out of scope, deliberately:

- **Resuming anything.** Both surfaces print `claude --resume <sid>`; neither runs it.
  Deciding to re-enter a session is the user's call.
- **Writing state from the CLI.** `sk` keeps its no-cache, no-database, nothing-is-written
  invariant (`agent-analyzer/SPEC.md` §1). Dismiss/snooze/done live only in `tracker.db`.
- **opencode sources.** `sk` does not parse them today; adding that is its own feature.
- **Scheduling.** No cron, no daemon, no notifications. The board is computed when asked
  for.
- **A second ranking implementation.** The tracker never re-derives the heuristic; it
  spawns the same `sk` binary.

## Approach

One heuristic, two consumers. `sk` owns all extraction and ranking and stays pure and
stateless; judgment and memory live above it.

```
agent-analyzer/                       claude-project-tracker/
  sessionkit/board.py  ──┐              server/src/board.ts       spawns `sk board --json`
  sk board --json        ├───────────▶  server/src/board-state.ts dismiss / snooze / done
  skills/session-manager ┘              client/.../Board.tsx      the Manager panel
   (the agent)                          llm.ts generateProjectBrief
```

The agent reads `sk board` on the host. The tracker container runs the *same binary* over
the same mounted corpus. There is exactly one implementation of the ranking, so the terminal
and the UI cannot disagree.

## Part 1 — `sk board`

A layer-2 aggregate command, project-grouped, in the existing three-layer output contract.

```
sk board [--since 7d] [--project NAME] [--source ID] [--only-open]
         [--reply-chars 400] [--no-uncommitted] [--json] [--budget-kb N]
```

It differs from `sk tail --all` in three ways, each of which the goal requires:

1. **It covers every session in the window, including `complete` ones.** The request is the
   last message from *each* conversation. A session that ended on "done" is still reported —
   it lands in the `done` bucket and sorts to the bottom, rather than being invisible.
2. **It groups by project.** `project_key` is the unit; sessions become threads inside it.
3. **It extracts the last exchange as text.** `last_user` and `last_assistant` are real
   message text (uncapped read via `parse.read_line`, then truncated to `--reply-chars`),
   not the 200-char preview and not an interleaved row dump.

### JSON shape

Two **flat** tables, not one nested tree. `render.Report` renders a document as named tables
of flat rows and has no nested-object mode; adding one would mean reworking its budget
accounting, which drops rows per table. Threads therefore carry `project_key` and the
consumer joins on it — a two-line join in both consumers, against a renderer change that
would touch every existing command.

```json
{
  "since": "7d",
  "window_from": "2026-08-31T21:00:00Z",
  "generated_at": "2026-09-07T21:00:00Z",
  "projects": [
    {
      "project_key": "claude-tracker",
      "sessions": 4,
      "open_sessions": 2,
      "last_active": "2026-09-08T01:37:55.970Z",
      "cost_usd": 3.12,
      "score": 78
    }
  ],
  "threads": [
    {
      "project_key": "claude-tracker",
      "sid": "949d169f",
      "label": "Agent analyzer for Claude sessions",
      "ended_at": "2026-09-08T01:37:55.970Z",
      "end_state": "interrupted-tool",
      "tail_signal": "next_step_stated",
      "bucket": "resume",
      "score": 78,
      "live": false,
      "parent_sid": "",
      "agent_type": "",
      "turns": 3,
      "cost_usd": 1.28,
      "cwd": "/home/user/Projects/claude-tracker",
      "last_user": "…",
      "last_assistant": "…",
      "next_step": "I'll wire the board route into App.tsx next.",
      "in_flight_tool": "Bash: pnpm test",
      "uncommitted": ["server/src/board.ts"],
      "resume": "claude --resume 949d169f"
    }
  ],
  "omitted": {"threads": 0}
}
```

`omitted` is populated per table by `Report` whenever `--budget-kb` cut rows, and the text
renderer prints `… N more row(s) omitted`. Truncation is never silent. Absent string fields
are `""` rather than `null`, matching every existing sessionkit row; `uncommitted` is the one
field where `null` is meaningful, and it is a list, not a string.

### `sessionkit/board.py`

A new module of pure functions, no I/O beyond the corpus reads sessionkit already does:

| Function | Returns |
|---|---|
| `last_exchange(entry, reply_chars)` | `(last_user, last_assistant)` full text, truncated |
| `next_step_quote(text)` | the single sentence matching `classify._NEXT_STEP_RE`, or `""` |
| `in_flight_tool(entry)` | `"<name>: <input_preview>"` for the unmatched `tool_use`, or `""` |
| `score(thread)` | `int` |
| `bucket(thread)` | one of `resume`, `review`, `done`, `sunk` |
| `thread_rows(corpus, scope, opts)` | one row per in-scope session |
| `project_rows(threads)` | grouped, scored, ranked |

### Scoring

`score` is a documented pure function so "worth jumping back into" is reproducible and
unit-testable rather than a model's mood on the day:

```
score = signal_weight + dirty_weight + recency_weight + investment_weight + open_bonus

signal_weight   mid_tool 40 · error_tail 30 · next_step_stated 30 · silent 25
                apology 20 · neutral 10 · completion_marker 0
dirty_weight    min(len(uncommitted), 5) * 6            →  0..30
recency_weight  max(0, 20 - floor(age_days) * 2)        →  0..20
investment_wt   min(turns, 20) // 2                     →  0..10
open_bonus      10 when end_state != "complete"
```

Project score is the max of its threads' scores plus `min(open_sessions - 1, 3) * 2`, so a
project with several live threads outranks one with a single equally-stale thread. Projects
sort by score descending, threads within a project likewise.

### Bucketing

The `unfinished-work` skill's prose table becomes tested code, evaluated in order:

| # | Condition | Bucket |
|---|---|---|
| 1 | `live` — the session is running right now | `review` |
| 2 | `tail_signal == "completion_marker"` and `uncommitted == []` | `done` |
| 3 | `end_state` in {`killed-agents`, `interrupted-user`} and `uncommitted == []` | `sunk` |
| 4 | `tail_signal == "mid_tool"` and `uncommitted` non-empty and age < 24h | `resume` |
| 5 | anything else | `review` |

Rules 2–4 all read `uncommitted`, so they require it to be *known*. When it is `null` the
rule does not fire and the thread falls through to `review` — see the `--no-uncommitted`
note below. The catch-all is `review` rather than a drop: an ambiguous candidate is
reported, never hidden, per the existing skill's rule.

### Behaviour notes

- **Live sessions are marked, not excluded.** `sk tail --all` excludes them because a running
  session always carries an unmatched `tool_use` and would look abandoned. A board that
  hides the session you are sitting in is confusing, so `board` sets `live: true`, buckets it
  `review` (rule 1), and the renderer marks the row.
- **Uncommitted-file detection is on by default; `--no-uncommitted` turns it off.** Three of
  the five bucket rules read it, so a board computed without it classifies almost everything
  as `review` and is close to useless — it has to be the default. The cost is bounded: it
  runs at most one `git status` per unique `cwd`, not per session, and a board spans a
  handful of directories. `uncommitted` distinguishes `null` (not determined — the flag was
  off, the `cwd` does not exist in this filesystem, or it is not a git repo) from `[]`
  (determined, and clean). Only `[]` satisfies rules 2 and 3.
- **Subagent threads report `parent_sid`.** A subagent has no independent `--resume` handle,
  so `resume` carries the parent's sid and the row is labelled as a subagent.

### Tests — `tests/test_board.py`

stdlib unittest over the existing fixtures: score component precedence, bucket rule ordering
(each of the four rules fired in isolation and in conflict), `complete` sessions present and
sorted last, last-exchange extraction preferring full text over preview, next-step quote
extraction, `uncommitted: null` vs `[]` changing the bucket, subagent parent resolution, a
live session forced to `review`, empty corpus, and `--budget-kb` producing a non-zero
`omitted` plus the notice.

## Part 2 — the agent

Per "replace, don't deprecate": `skills/unfinished-work/` is **renamed** to
`skills/session-manager/` and rewritten around one `sk board` call in place of its current
three-command composition. Two skills answering "what's unfinished" would only confuse
dispatch.

What changes in the skill body:

- Its bucketing table is deleted; `sk board` now emits `bucket` directly. The skill's job
  becomes selecting, briefing, and ordering, not classifying.
- It gains the project rollup as its top-level report shape: projects ranked, with each
  project's threads beneath.
- It keeps the per-session handoff brief (last completed step, in-flight call, uncommitted
  paths, stated next step quoted) as the drill-down for `resume` and `review` threads, and
  keeps the `$SK` resolution block and the "never read transcripts directly" rule.
- It keeps the boundary table routing single-session "why did this fail" to
  `session-forensics` and fleet-wide failure questions to `error-patterns`.
- It stays read-only: prints `claude --resume`, never runs it.

`PLAN.md`'s skill roster, `README.md`'s command table, and `NOTES.md` are updated to match.

## Part 3 — the Manager panel

### Server

- **`server/src/board.ts`** — `runBoard(opts)` spawns `${SK_PATH}` (default `/sk/sk`) with
  `board --json` and a timeout. A non-zero exit, a timeout, or unparseable stdout surfaces as
  a 503 carrying stderr. It never degrades to an empty board: a board that silently reports
  nothing is indistinguishable from a board that correctly reports nothing, and that is the
  failure mode this whole feature exists to prevent. The spawn is injectable so route tests
  never launch Python.
- **`server/src/board-state.ts`** — one table, created in `TrackerDB`'s constructor with
  `CREATE TABLE IF NOT EXISTS`, exactly as the archive tables are:

  ```sql
  CREATE TABLE IF NOT EXISTS board_state (
    sid         TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    action      TEXT NOT NULL,      -- 'dismissed' | 'snoozed' | 'done'
    until       TEXT,               -- ISO timestamp, snoozed only
    note        TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS board_briefs (
    project_key TEXT PRIMARY KEY,
    last_active TEXT NOT NULL,
    content     TEXT NOT NULL,
    model       TEXT,
    generated_at TEXT NOT NULL
  );
  ```

  **`SCHEMA_VERSION` is deliberately not bumped.** That flag exists to rebuild the FTS
  table; a rebuild drops index rows that archive-hydrated sessions never re-index, so
  bumping it for an unrelated table would quietly break search.

- **Routes** in `routes.ts`:

  | Route | Behaviour |
  |---|---|
  | `GET /api/board?since=&project=&uncommitted=` | runs `sk`, applies `board_state`, returns the board |
  | `POST /api/board/threads/:sid/state` | `{action, until?, note?}` — upsert |
  | `DELETE /api/board/threads/:sid/state` | clear |
  | `POST /api/board/projects/:key/brief` | LLM brief, cached |

  A snoozed thread whose `until` has passed is treated as absent. Dismissed and done threads
  are returned with their state attached rather than filtered out, so the client can offer a
  "show dismissed" toggle without a second round trip.

- **`generateProjectBrief`** in `llm.ts`, alongside the existing `generateSummary`: takes a
  project's threads and writes the "here is where you left off" paragraph. Cached in
  `board_briefs` keyed on `project_key` and invalidated when `last_active` changes, so a
  project that has not moved is never re-billed.

### Client

- `client/src/hooks/useBoard.ts` — fetch, refresh, mutate state.
- `client/src/components/Board.tsx` — a full-width panel opened from a "Manager" button in
  the left rail beside Prompt Library and Compare, mirroring how `configOpen` already works
  in `App.tsx`. Ranked project cards; each expands to its threads showing the last exchange,
  the stated next step, the in-flight call, uncommitted paths, a copyable
  `claude --resume <sid>`, a dismiss/snooze/done control, and an "Open session" link that
  selects the session in the existing detail view.
- `App.tsx` gains `boardOpen` state alongside `configOpen`.

### Container

The tracker runs in `node:22-slim`, which has neither Python nor the corpus's real project
paths. Four changes:

1. `Dockerfile` `dev` stage installs `python3` and `git`.
2. `docker-compose.yml` mounts `${SK_REPO}:/sk:ro`.
3. It mounts `${PROJECTS_ROOT}:${PROJECTS_ROOT}:ro` **at the identical host path**, so the
   `cwd` recorded in a transcript resolves inside the container and `--uncommitted` works.
4. Environment: `SK_PATH=/sk/sk`, `CLAUDE_DIR=/claude/dir1` plus the other source vars so
   `sk` discovers the mounted corpora — verified against `sessionkit/sources.py`, whose
   `load_env()` merges `os.environ` over the `.env` file. Also
   `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=safe.directory / GIT_CONFIG_VALUE_0=*`, without
   which `git status` refuses the uid-mismatched read-only mount as dubious ownership.

`.env.example` gains `SK_REPO` and `PROJECTS_ROOT`. Both are optional: when `SK_REPO` is
unset the board routes return 503 with a message naming the missing mount, and the Manager
button is hidden, exactly as the OpenCode config tab is hidden without its source.

### Tests — `server/test/board.test.ts`

Routes exercised through `app.request()` with an injected runner, so no Python is spawned:
dismiss/snooze/done applied to a fixture board, an expired snooze reappearing, brief cache
hit and invalidation on a changed `last_active`, 503 with stderr on runner failure, 503 when
`SK_PATH` is unconfigured, and the `board_state` table surviving a reopen.

## Verification limits

The dev container is not currently running — there is no `.env`, and `docker compose ps`
fails on the empty mount variables. The sessionkit tests, the server tests, typecheck and
lint can all be verified. The Manager panel end to end, and the container's ability to spawn
`sk`, cannot be verified in this environment and will be reported as unverified rather than
claimed working.
