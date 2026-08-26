# sessionkit

Fleet-wide analysis of Claude Code sessions: parses every reachable transcript into a
normalised SQLite cache and emits reports sized for an agent's context window.

It exists because the corpus is ~37 MB across 86 files and growing monotonically — the skills
that analyse it cannot read it directly, so this does the reading and hands back kilobytes.

**Status:** Phase 0 (scaffolding) and Phase 1 (`error-patterns`) complete. See `PLAN.md` for the
remaining phases and the full eleven-skill scope.

## Quick start

```bash
tools/sessionkit/sk doctor                  # what's reachable, what's cached, corpus totals
tools/sessionkit/sk index --since 7d        # one line per session
tools/sessionkit/sk errors                  # cluster every failure across the fleet
tools/sessionkit/sk show <sid> --mode errors
```

The cache refreshes incrementally before every read command (stat-only for unchanged files),
so there is no separate setup step. Pass `--no-refresh` to skip it.

## Requirements

System Python 3.11+ and nothing else. No pip install, no virtualenv, no network. This is
deliberate: the skills must work from any session, including ones where the dev container is
down and `pnpm`/`ruff`/`pytest` are unavailable.

## The three-layer output contract

Every consumer descends these layers and never reads raw JSONL. This is what makes the corpus
tractable.

| Layer | Command | Budget | Content |
|---|---|---|---|
| **1 — index** | `sk index` | ~12 KB | one line per session |
| **2 — aggregate** | `sk errors`, `sk doctor` | ~4 KB | clusters and counts, one exemplar each |
| **3 — excerpt** | `sk show <sid> --mode …` | ~8 KB | one session, surgically |

Every command takes `--budget-kb` and `--json`. **Truncation is never silent** — a capped table
ends with `… N more row(s) omitted`, because a partial report that reads as complete is worse
than no report.

## Commands

| Command | Purpose |
|---|---|
| `doctor` | Source reachability, cache state, corpus totals, unpriced models |
| `ingest` | Refresh the cache (`--full` to re-parse everything) |
| `index` | Layer 1 session list; `--since --project --source --state --subagents` |
| `show <sid>` | Layer 3 excerpt; `--mode summary\|timeline\|messages\|tools\|errors` |
| `errors` | Layer 2 failure clusters; `--group-by class\|tool\|signature\|session` |

Session ids accept a unique prefix: `sk show 95f3a6a6`.

## Layout

```
tools/sessionkit/
  sk                    launcher (absolute path; skills invoke this)
  sessionkit/           the package — zero third-party imports
  skills/               skill definitions, symlinked into ~/.claude/skills/
  tests/                stdlib unittest, no install step
  PLAN.md               phased build plan and scope
```

The derived cache lives **outside** the repo at `~/.cache/sessionkit/cache.db`
(override with `$SESSIONKIT_CACHE`). It holds redacted transcript previews, so it is kept out
of version control on purpose.

## Installing a skill

Skills are versioned here and symlinked into the discovery path:

```bash
ln -sfn /workspace/tools/sessionkit/skills/error-patterns ~/.claude/skills/error-patterns
```

## Tests

```bash
cd tools/sessionkit && PYTHONPATH=. python3 -m unittest discover -s tests -t .
```

84 tests, no dependencies. Fixtures are built inline so each test shows the exact transcript
shape it asserts against. Every anomaly detector has a positive *and* a negative case — a
detector that can never return false is not tested.

## Design notes

**Why not reuse `server/src/parser.ts`?** It would couple every skill to the dev container
being up (it was down when this was written) or to the HTTP API, which serves UI-shaped
`Session` objects rather than error clusters. The duplication is narrower than it looks:
sessionkit needs a normalised event stream, not the tracker's rich session model.

**Pricing is not shared with the tracker.** `server/src/pricing.ts` predates the Claude 5
family, so every `claude-sonnet-5` session there falls through to a Sonnet-4 default, and its
Opus row still carries Opus-4.5-era rates. `sessionkit/pricing.py` carries current rates and
reports unpriced models via `sk doctor` instead of silently defaulting.

**Two transcript layouts.** Top-level sessions live at `projects/<project>/<session>.jsonl`;
subagent transcripts live one level deeper at
`projects/<project>/<parent-session>/subagents/agent-*.jsonl` and carry the **parent's**
`sessionId` — they are keyed by `agentId` instead. 36 of this corpus's 86 files are subagents,
so missing either fact loses 42% of the data.

**Safety.** Read-only everywhere except its own cache; `tracker.db` is opened `mode=ro`; every
stored preview passes through secret redaction first; no network calls.
