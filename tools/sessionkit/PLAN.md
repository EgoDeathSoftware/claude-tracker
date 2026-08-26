# sessionkit — implementation plan

Scaffolding + 11 skills for fleet-wide analysis of Claude Code sessions.

**Status:** Phase 0 (scaffolding) and Phase 1 (`error-patterns`) are **complete and verified
against the live corpus**. Phases 2–8 are planned. Last updated 2026-08-26.

---

## 1. Goal

Give any Claude session the ability to analyse *every other* session on this machine — across
host, WSL, Windows, agent containers, and opencode — without reading raw transcripts into
context.

The corpus is **37 MB / 86 JSONL files** today and grows monotonically. Naive reading is
impossible, so the scaffolding is not a convenience: it is the thing that makes these skills
exist at all.

**11 skills in scope:**

| # | Skill | Tier | Phase | Status |
|---|---|---|---|---|
| 1 | `error-patterns` | 1 | 1 | **done** |
| 2 | `session-forensics` | user | 2 | planned |
| 3 | `unfinished-work` | user | 3 | planned |
| 4 | `prior-art` | 1 | 4 | planned |
| 5 | `cost-forensics` | user | 5 | planned |
| 6 | `delegation-roi` | 3 | 5 | planned |
| 7 | `uncommitted-work` | 1 | 6 | planned |
| 8 | `store-reaper` | 2 | 6 | planned |
| 9 | `session-digest` | user | 7 | planned |
| 10 | `corrections-to-rules` | 2 | 7 | planned |
| 11 | `suggest-skills` | user | 8 | planned |

Explicitly **out of scope** (deferred, not cut): `fleet-status`, `collision-check`,
`prompt-autopsy`.

---

## 2. Constraints (verified, not assumed)

| Constraint | Evidence | Consequence |
|---|---|---|
| No `sqlite3` CLI, no `pnpm`, no `fd` binary | `command -v` all fail; `fd` is a zsh alias to `fdfind`, invisible to scripts | Python stdlib only; no shelling out to these |
| Python 3.12.3, sqlite 3.45.1, **FTS5 available** | verified in-process | Cache + search layer is free |
| `uv` present, `ruff`/`pytest` absent | `ruff not found` in prior transcripts | Runtime = stdlib only; tests are `unittest` |
| Corpus 37 MB, 86 files | `du -sh ~/.claude/projects` | Incremental mtime-keyed cache is mandatory |
| Sources in `sources.json` are **container paths** | read config | Host-side resolution needed; never hardcode |
| `.env` names `/home/david/…`, unreachable as user `agent` | `[ -e ]` checks fail | Discovery must probe and report what it can't see |
| Tracker API **down** on `localhost:3001` | `curl` refused | Skills must not depend on the server |
| `tracker.db` has `session_fts` (FTS5) | schema dump | `prior-art` reuses it; opened `mode=ro` |
| `history.jsonl`: 240 rows `{display, project, sessionId, timestamp}` | `jq keys` | Prompt→session mapping is free |

### Discovered during Phase 0 — each cost a bug

| Finding | Impact |
|---|---|
| **Two transcript layouts.** Subagents live at `projects/<project>/<parent-session>/subagents/agent-*.jsonl`, one level below top-level sessions. | A top-level-only glob silently dropped **36 of 86 files (42%)**. `delegation-roi` would have had nothing to measure. |
| **Subagent transcripts carry the *parent's* `sessionId`**, and their own identity in `agentId`. | Keying on `sessionId` collapsed all 86 files into 50 rows. Subagents are keyed by `agentId`, with `parent_sid` recorded. |
| **`agentType` lives in a `.meta.json` sidecar** beside each subagent transcript. | The only source of the subagent's type (`Explore`, `general-purpose`, …). |
| **A `progress` record type** exists in subagent transcripts, carrying hook events. | Not in the top-level schema; would have been dropped. |
| **Session ids are not guaranteed unique per file.** | Two files sharing an id made the cache delete one and re-parse both forever. Now disambiguated with a path-derived suffix. |
| **`server/src/pricing.ts` is stale.** No Claude 5 entries, Opus priced at Opus-4.5 rates ($15/$75). | Every `claude-sonnet-5` session in the corpus silently priced as Sonnet 4. sessionkit carries its own current table and reports unpriced models. |
| **`<synthetic>` appears as a model id** for locally-injected messages. | Treated as non-billable, or every corpus looks misconfigured. |

### Live evidence the toolkit is worth building

Clustering all 269 failed tool calls across 86 transcripts:

```
 73  hook-block         (27.1%)  across 43 of 86 sessions   ← largest by count AND reach
 61  exit-code          (22.7%)  across 21 sessions
 25  not-found          ( 9.3%)
 25  other              ( 9.3%)
 19  user-rejected      ( 7.1%)
 19  permission-denied  ( 7.1%)
 16  missing-tool       ( 5.9%)
```

A **single signature** — the `PreToolUse:Bash` hook rejecting `grep`/`find` — accounts for 68
failures across 41 sessions, 3.5× the next-largest signature and entirely self-inflicted. The
fix is a CLAUDE.md line, not a better hook: the hook fires at execution time and teaches
nothing at generation time.

> **Correction to the original plan.** The first draft claimed "hook-block ranks #1 at ~47".
> That number came from top-level files only and compared a merged `hook-block` class against
> *unmerged* `exit-code` prefixes. With subagents included and both properly merged, hook-block
> is #1 at 73 — the conclusion held, the arithmetic behind it did not.

---

## 3. Architecture

### 3.1 The three-layer output contract

Every skill descends through layers and **never** reads raw JSONL.

| Layer | Command shape | Budget | Content |
|---|---|---|---|
| **1 index** | `sk index` | ~12 KB (all 86 sessions ≈ 10 KB) | one line per session |
| **2 aggregate** | `sk errors`, `sk cost`, `sk digest` … | ≤4 KB | clusters, counts, **one exemplar each** |
| **3 excerpt** | `sk show <sid> --mode …` | ≤8 KB | one session, surgically |

Rules, all implemented and tested:
- Every subcommand accepts `--json` and `--budget-kb`.
- Global flags parse **before or after** the subcommand — skills compose invocations as
  strings, and a flag that only works in one position is a trap.
- **No silent truncation.** A capped table ends with
  `… N more row(s) omitted (raise --budget-kb or narrow --since)`.

### 3.2 The cache

`sk ingest` walks reachable sources and re-parses only files whose `(mtime, size)` changed,
writing to `~/.cache/sessionkit/cache.db` (override `$SESSIONKIT_CACHE`). Read commands refresh
incrementally first, so no skill has to remember to ingest. Warm pass over the corpus re-parses
only the live session.

`tracker.db` is opened **read-only, always**.

### 3.3 Language decision, and the duplication it costs

Standalone Python, accepting duplication of `parser.ts`. Rejected: reusing the parser via the
dev container (couples every skill to `docker compose` being up — it was down) or via the HTTP
API (same availability problem, and it serves UI-shaped `Session` objects, not error clusters).

Phase 0 largely settled the concern: the two parsers turned out to need genuinely different
things. sessionkit wants a normalised event stream with digests and error classes; the tracker
wants a rich `Session` for rendering. A parity test against `server/test/fixtures/` remains
worthwhile in a later phase but is no longer urgent.

### 3.4 Layout

```
/workspace/tools/sessionkit/          # in-repo, versioned with the tracker
  README.md  PLAN.md
  sk                                  # launcher; skills invoke this absolute path
  sessionkit/
    __init__.py  __main__.py  cli.py
    sources.py                        # discovery + reachability probing
    ingest.py                         # incremental JSONL → cache.db
    parse.py                          # record → normalised events
    classify.py                       # error taxonomy, end-state, anomaly detectors
    pricing.py                        # current model rates
    redact.py                         # secret scrubbing before anything is stored
    cache.py                          # schema, migrations, queries
    render.py                         # budget-enforced emitters
  skills/<name>/SKILL.md              # symlinked into ~/.claude/skills/
  tests/                              # stdlib unittest
~/.cache/sessionkit/cache.db          # derived; outside the repo by design
```

---

## 4. Cache schema

`meta`, `sources`, `sessions`, `messages`, `tools`, `files`, `sysev`, `attach`, `anomalies`,
`prompts`. Indexed on `tools(err_class)`, `tools(sid, input_digest)`, `files(path)`,
`files(sid)`, `messages(sid, line)`, `sessions(ended_at)`, `anomalies(sid)`.

`tools.input_digest` is a sha1 of the canonicalised tool input. Repeated identical digests
within a session **are** the loop signal — this column is why forensics is cheap.

`sessions.end_state` ∈ `complete | interrupted-tool | interrupted-user | killed-agents |
compacted-idle | error-cascade | unknown`.

A schema bump **drops** tables rather than emptying them — `CREATE TABLE IF NOT EXISTS` would
otherwise leave a stale column shape in place. Every row is derived; a rebuild is one re-parse.

---

## 5. Classifiers

### 5.1 Error taxonomy (implemented)

`hook-block`, `user-rejected`, `file-too-large`, `read-truncated`, `stale-read`,
`missing-tool`, `permission-denied`, `not-a-repo`, `not-found`, `rate-limit`, `api-error`,
`mcp-error`, `timeout`, `exit-code`, `no-result`, `other`.

Order matters: `permission-denied` precedes `exit-code` because a denied `mkdir` arrives
wrapped as `Exit code 1 … Permission denied`. Unmatched text lands in `other` **with its
normalised signature retained**, so a large `other` bucket is itself a reportable finding — that
is how `permission-denied` and `stale-read` were added during Phase 1.

### 5.2 Anomaly detectors (implemented)

`repeat-tool`, `file-thrash`, `read-loop`, `error-cascade`, `hook-pingpong`, `agent-kill`,
`orphan-subagent`, `compaction-churn`, `stall`, `rejection-persist`. Thresholds live in one
`THRESHOLDS` dict.

---

## 6. CLI surface

Implemented: `doctor`, `ingest`, `index`, `show`, `errors`.

Planned: `forensics`, `unfinished`, `handoff`, `search`, `cost`, `subagents`, `files`,
`stores`, `digest`, `corrections`, `procedures`.

---

## 7. Build phases

### Phase 0 — core scaffolding ✅

Delivered `sources.py`, `parse.py`, `pricing.py`, `redact.py`, `cache.py`, `ingest.py`,
`render.py`, `cli.py`, and `doctor`/`ingest`/`index`/`show`.

Acceptance, all met:
- `sk doctor` names every unreachable source (as user `agent`: host reachable; wsl, windows,
  agents, opencode absent) and says the totals cover only what it could see.
- Cold ingest parses **86/86** files; warm ingest re-parses only the live transcript.
- `sk index` fits all sessions in ≤12 KB; `sk show --timeline` fits the 227-line session in 8 KB.

### Phase 1 — `error-patterns` ✅

Delivered the taxonomy, `sk errors` (`--group-by class|tool|signature|session`), and the skill.

Acceptance, met: run against the live corpus, `hook-block` ranks **#1 at 73/269 (27.1%) across
43 of 86 sessions**, and the report's headline recommends a CLAUDE.md rule rather than a hook
change. Output ≤4 KB.

### Phase 2 — `session-forensics`

Deliver `sk forensics`, skill. Detectors already exist and are unit-tested; this phase is the
report shape.

Acceptance: on a session containing `agents_killed`, the report names it, gives a
line-anchored timeline, and ends with a **prevention diff**, not a narrative.

### Phase 3 — `unfinished-work`

Deliver `sk unfinished`, `sk handoff`, skill. `end_state` already lands correctly —
`interrupted-tool` is populated in the live corpus today.

Acceptance: ranks by recoverability, not recency; each row carries a paste-ready
`claude --resume <sid>` **and** a cold-start handoff brief.

### Phase 4 — `prior-art`

Deliver `sk search` over `tracker.db` FTS5 joined to the cache, skill.

Acceptance: a known past error returns the session that hit it **and the resolution excerpt**
in ≤4 KB; degrades with a clear message if `tracker.db` is absent.

### Phase 5 — cost pair

Deliver `sk cost`, `sk subagents`, skills `cost-forensics` + `delegation-roi`.

Acceptance: `--bloat` surfaces repeat-reads, truncation notices, unbounded Bash output and the
cache-read/create ratio, attributing dollars to each. `delegation-roi` compares subagent cost
against parent cost and **states the sample size**, so a thin result isn't read as a conclusion.

### Phase 6 — filesystem pair

Deliver `gitlink.py`, `sk files --uncommitted`, `sk stores`, skills `uncommitted-work` +
`store-reaper`.

Acceptance: `uncommitted-work` cross-references `files` against `git log` in the session window,
respecting `.gitignore`. `store-reaper` **reports only, never deletes**, and emits a
copy-pasteable removal command the user runs.

### Phase 7 — narrative pair

Deliver `sk digest`, `sk corrections`, skills `session-digest` + `corrections-to-rules`.

Acceptance: `digest --since 1d` covers all reachable sources in one ≤4 KB rollup.
`corrections-to-rules` emits **candidate** CLAUDE.md lines for approval and never edits.

### Phase 8 — `suggest-skills`

Deliver `sk procedures` (tool n-gram mining), skill.

Acceptance: identifies repeated multi-step sequences across ≥3 sessions and hands off to the
existing `build-agent` skill rather than authoring skills itself.

---

## 8. Testing

- **Runtime stdlib-only; tests stdlib-only.**
  `cd tools/sessionkit && PYTHONPATH=. python3 -m unittest discover -s tests -t .`
- 84 tests today across parsing, taxonomy, detectors, pricing, budget enforcement, and
  end-to-end ingestion.
- Fixtures are built inline, so each test shows the transcript shape it asserts against.
- Every detector has a positive **and** a negative case.

---

## 9. Guardrails

- **Read-only by default.** `store-reaper` and `corrections-to-rules` propose; they never
  delete or edit. Only `cache.db` is written.
- `tracker.db` opened `mode=ro` always.
- Every stored preview passes through `redact.py` (API keys, tokens, JWTs, connection strings)
  and is length-capped. The cache lives outside the repo.
- No network calls anywhere in sessionkit.

---

## 10. Open decisions

1. **Cron.** `error-patterns` and `session-digest` are natural recurring jobs. *Recommend:
   manual until Phase 7, then revisit once signal-to-noise is known.*
2. **Scope when run as `agent`.** Today 1 of 5 sources is visible. *Recommend: ship honest
   `doctor` output; revisit if it bites.*
3. **Skill routing.** 11 new skills against a 19-skill directory. `error-patterns` ships with an
   explicit boundary table against `session-forensics`, `cost-forensics`,
   `auditing-claude-projects`, and `fewer-permission-prompts`. **Validate routing after Phase 2**
   before Phases 5–8 add three more overlapping candidates.
4. **Parity test vs `parser.ts`.** Deferred — the two parsers want different shapes. Worth adding
   in Phase 5 when cost figures start being compared against the tracker UI.
