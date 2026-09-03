# Durable session archive

**Date:** 2026-09-03
**Status:** Design, awaiting approval
**Builds on:** `2026-08-21-container-session-ingestion-design.md`

## Problem

Every session the tracker shows exists only as a `.jsonl` file on a filesystem
someone else controls, and only for as long as that filesystem does. Agent
containers are created and destroyed continuously; remote hosts come and go;
reinstalling the agent wipes its store. Claude Code itself deletes transcripts
older than `cleanupPeriodDays` (30 by default). When the file goes, the session
goes — the tracker has no copy.

The tracker's own SQLite database does not help. `TrackerDB` holds only derived
state: an FTS index, tags, prompts, and cached AI summaries, all keyed on a
`session_id` whose actual content lives elsewhere. `SessionRegistry` holds every
fully-parsed `Session` in memory, rebuilt from scratch on every boot by
re-reading and re-parsing each JSONL file. Nothing is persisted. Worse, when a
source disappears, `removeSource` actively purges even the derived state —
FTS rows, tag links, cached summaries — so a destroyed container currently
leaves no trace at all.

## Goal

The database becomes the archive of record for session transcripts. Sessions are
read from it, filesystem watchers become ingestion feeds, and a session whose
underlying file is gone stays fully browsable — same list, same detail tabs,
same raw log — visibly marked as archived.

## Scope

In scope: full transcripts for `claude-code` sources at every location (host,
container store-set children, subagents) and for `opencode` sources.

Out of scope, deliberately:

- **Network ingestion.** Everything archived is already visible to the tracker
  as a local or mounted path. No ingest API, no auth token, no shipper to
  install on remote hosts.
- **Postgres or any separate service.** The archive lives in the existing
  `tracker.db` via the existing `better-sqlite3` dependency.
- **Non-transcript `.claude` files** (`settings.json`, `CLAUDE.md`, hook
  scripts, MCP config). Useful for a destroyed container, but a separate
  feature with its own versioning story.
- **Retention and pruning.** Nothing is ever deleted automatically. Bounding
  disk growth reintroduces the exact data-loss problem on a longer timescale.
- **Export back to a `.claude` directory.**
- **Body compression.** Deferred; the schema reserves a codec column so it can
  be added later with no migration.

## Approach

The archive is a write-through store beneath the registry.

```
watchers ──parse──> registry.ingest() ──> ArchiveStore.put()
                          │
                          └──> in-memory SessionSummary map (list views)

routes ──detail read──> ArchiveStore.getBody()
```

The registry keeps a *summary* per session in memory — small, bounded, and
enough for every list view and filter — and loads message/tool-call bodies from
SQLite only when a session is opened. Memory stays flat as the archive grows.
`getProjects`, `getSessions`, and the kind/location filters continue to operate
on the in-memory map exactly as today; only `getSession` becomes asynchronous.

Two alternatives were considered and rejected. Making the registry a thin SQL
query layer with no in-memory map scales further but rewrites the registry's
core and its 21 tests to buy nothing at this corpus size. Modelling the archive
as a new `kind: 'archive'` source reuses the multi-source machinery but
reintroduces archive-copy-versus-live-copy precedence rules — the same
subtlety that ruled out a fallback-tier design.

## Data model

`Session` splits in two. `Session` remains the name of the full object, so
`SessionDetail.tsx` is unaffected; only list-view code narrows to the summary.

```ts
// server/src/types.ts, mirrored to client/src/types.ts
export interface SessionSummary {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  sourceLocation: SourceLocation;
  origin?: StoreOrigin | undefined;
  projectId: string;
  filePath: string;
  slug: string;
  title: string;
  status: SessionStatus;
  turnCount: number;
  costUsd: number;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  cwd: string;
  isSubagent: boolean;
  parentSessionId?: string | undefined;
  costBreakdown: CostBreakdown;
  subagents: SubagentInfo[];
  archived: boolean;
  aiSummary?: AiSummary | undefined;
}

export interface SessionBody {
  messages: SessionMessage[];
  logEntries: RawLogEntry[];
  toolCalls: ToolCallEntry[];
  fileChanges: FileChangeEntry[];
  hookEvents: HookEvent[];
  permissionEvents: PermissionEvent[];
  recaps: RecapEntry[];
}

export type Session = SessionSummary & SessionBody;
```

`sourceName`/`sourceKind`/`sourceLocation`/`origin` are on the summary, not
looked up from the source registry, because for an archived session the source
no longer exists. See "Provenance survives its source" below.

## Schema

Added to `TrackerDB.migrate()` alongside the existing tables.

```sql
CREATE TABLE IF NOT EXISTS archive_sessions (
  session_id        TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  source_location   TEXT NOT NULL,
  origin_json       TEXT,
  project_id        TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL,
  is_subagent       INTEGER NOT NULL,
  parent_session_id TEXT,
  turn_count        INTEGER NOT NULL,
  cost_usd          REAL NOT NULL,
  started_at        TEXT NOT NULL,
  last_activity_at  TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  summary_json      TEXT NOT NULL,
  body_json         TEXT NOT NULL,
  body_codec        TEXT NOT NULL DEFAULT 'json',
  parser_version    INTEGER NOT NULL,
  file_size         INTEGER,
  file_mtime_ms     INTEGER,
  head_hash         TEXT,
  raw_line_count    INTEGER NOT NULL DEFAULT 0,
  first_seen_at     TEXT NOT NULL,
  last_ingested_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_project
  ON archive_sessions(project_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_parent
  ON archive_sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS archive_raw_lines (
  session_id  TEXT NOT NULL
    REFERENCES archive_sessions(session_id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  content     TEXT NOT NULL,
  PRIMARY KEY (session_id, line_number)
) WITHOUT ROWID;
```

`summary_json` holds the two structured summary fields (`costBreakdown`,
`subagents`); every scalar summary field is a real column, so list hydration is
one query with one small JSON parse per row rather than a full-transcript one.
`body_json` holds the whole `SessionBody`.

`aiSummary` is deliberately absent from both. It already lives in
`session_summaries` and is merged at read time by the routes, exactly as today.

Four decisions worth stating explicitly:

**Source identity is denormalized onto the row.** The premise of the feature is
that the source may not exist later, so `source_name`, `source_kind`,
`source_location` and `origin_json` are snapshotted at ingest. `project_id` and
`cwd` are stored *after* `applyOrigin` has run, so an archived container session
still merges into the correct host project long after its store is gone.

**`archived` is not a column.** It is derived at runtime: any session in the
archive that no live watcher has claimed during this process's lifetime. A
persisted flag would go stale after a crash or an unclean shutdown. `status` is
likewise coerced on hydration — an archived session is never `live`, because
status is derived from file mtime and there is no file.

**Raw lines are one row per line, not one blob.** A live session's file is
appended to constantly. Per-line rows make ingest an insert of only the new
lines rather than a rewrite of a multi-megabyte blob every second, and make
`/api/sessions/:id/raw` a straight `LIMIT`/`OFFSET`.

**`parser_version` plus verbatim raw lines** are what allow a future
`parser.ts` improvement to re-derive every archived session, including fields
today's parser drops. `PARSER_VERSION` is an exported constant in `parser.ts`,
bumped by hand whenever parsing semantics change. v1 stores the column and
exposes a reparse route; it does not re-derive automatically on boot.

## ArchiveStore

New module `server/src/archive-store.ts`. Pure SQLite; no filesystem access, no
watcher knowledge, no `parser.ts` import.

It shares `TrackerDB`'s connection rather than opening a second one: `TrackerDB`
constructs an `ArchiveStore` over its own private `Database` handle after
`migrate()` and exposes it as a readonly `archive` property. This keeps the
handle private, keeps WAL and pragma configuration in one place, and lets a
future deletion path wrap archive and FTS writes in a single transaction.

```ts
export class ArchiveStore {
  loadSummaries(): SessionSummary[];
  getBody(sessionId: string): SessionBody | null;
  getRawLines(
    sessionId: string, offset: number, limit: number,
  ): { lines: { lineNumber: number; content: unknown }[]; total: number };
  put(session: Session, opts: ArchivePutOptions): void;
  fileFingerprint(sessionId: string):
    { size: number; mtimeMs: number; headHash: string; lineCount: number } | null;
  deleteSession(sessionId: string): void;
  stats(): { sessionCount: number; rawLineCount: number; bytes: number };
}

export interface ArchivePutOptions {
  source: Source;
  lines?: string[] | undefined;
  fileSize?: number | undefined;
  fileMtimeMs?: number | undefined;
}
```

`put()` runs in a single transaction. Raw-line writes are incremental: if
`head_hash` matches the stored value and the file only grew, it inserts lines
past `raw_line_count`; on any mismatch (truncation, rewrite, hash change) it
deletes and reinserts all lines for that session. `head_hash` is a SHA-256 of
the first 4 KiB of the file. `opencode` sessions pass no `lines` and archive the
body only.

## Runtime behaviour

### Startup

`registry.start()` calls `loadSummaries()` before any watcher starts, populating
the map from SQLite in one query. The UI is fully browsable before a single
JSONL file is opened. Every hydrated session begins `archived: true`; watchers
clear the flag as they claim files. This inverts today's startup, where nothing
renders until every transcript has been parsed.

`loadSummaries()` returns subagent sessions too. `getSessions`/`getProjects`
already filter them out with `isSubagent`, but the Agents tab and
`linkSubagents` need them present.

The registry's map narrows to `Map<string, SessionSummary>`. Watchers still
produce a full `Session` — the parser builds everything in one pass regardless —
and `ingest()` archives it, then keeps only the summary portion with
`archived: false`. This is where the memory bound actually comes from.

### Ingest

`parseSession` currently reads the file, builds the `Session`, and discards the
raw lines. A new `parseSessionDetailed(filePath, sourceId, dirName)` returns
`{ session, lines, size, mtimeMs }`; `parseSession` becomes a thin wrapper over
it, so its existing callers and the 38 parser tests are untouched.

`SourceWatcher.parseAndStore` switches to `parseSessionDetailed` and
write-throughs to `ArchiveStore.put()`. `OpenCodeWatcher` write-throughs its
already-parsed sessions the same way, without lines.

### Live-session write coalescing

A live session's file changes every second and would otherwise rewrite
`body_json` on every event. `put()` for a session whose `status` is `live`
coalesces: raw lines still append immediately, since that is cheap and
append-only, but the body and summary columns are rewritten at most once every
`ARCHIVE_FLUSH_MS` (default 15000). A flush is forced when the session leaves
`live` status and on `stop()`. The env var is read through the existing
`parseOptionalNumberEnv` and forwarded in `docker-compose.yml` alongside
`STORE_ACTIVE_DAYS`/`STORE_POLL_MS`.

### Source removal becomes non-destructive

`SessionRegistry.removeSource` today deletes the source's sessions from the map
and calls `db.removeSession()` on each, wiping FTS rows, tag links, and cached
summaries. That is now exactly backwards: this is the path a destroyed container
takes on every `StoreSetWatcher` poll.

New behaviour: removing a source drops the live binding and marks its sessions
`archived: true`. They stay in the map, in the archive, in FTS, and keep their
tags and summaries. `db.removeSession()` keeps its current semantics unchanged
but is now invoked only from explicit deletion.

### Provenance survives its source

`SessionList` and `SessionDetail` resolve provenance today by looking a
session's `sourceId` up in `useSources()`. For an archived session that source
is absent from `/api/sources`, so the lookup misses and the badge and
provenance line vanish precisely when they matter most. Both components read
the snapshot off the session instead, consulting `useSources` only to pick up a
display name that has since been renamed in config for a still-live source.

The same defect exists server-side. `registry.matches()` resolves kind and
location through `kindBySourceId`/`locationBySourceId`, which are keyed on live
sources, and its comment notes that a lookup miss excludes the session from any
active filter. Archived sessions would silently disappear whenever a filter is
on. `matches()` reads kind and location off the session snapshot instead.

### Raw log

`/api/sessions/:id/raw` reads from `archive_raw_lines` for an archived session
and keeps tailing the live file otherwise. The existing `opencode` branch in
that route collapses into the archive path: opencode sessions archive a body
with no raw lines, and the route already synthesizes their raw view from parsed
messages.

## API

| Endpoint | Change |
|---|---|
| `GET /api/sessions` | returns `SessionSummary[]`; payload shrinks substantially |
| `GET /api/sessions/:id` | now async; merges the summary with the body from the archive |
| `GET /api/sessions/:id/raw` | archive-backed when archived; opencode branch collapses into it |
| `DELETE /api/archive/sessions/:id` | new; the only path that destroys data, and also calls `db.removeSession()` |
| `GET /api/archive/stats` | new; session count, raw line count, bytes on disk |
| `POST /api/archive/reparse` | new; re-derives bodies for rows below the current `PARSER_VERSION` |

No `?archived=` filter in v1: archived sessions are badged and visible by
default. `SessionFilter` can gain one later without disturbing anything.

## Client

- `client/src/types.ts` mirrors the `SessionSummary`/`SessionBody`/`Session`
  split.
- `SessionList` renders an "archived" badge beside the existing source badge and
  reads the source label from the session snapshot.
- `SessionDetail`'s header shows archived state and renders its provenance line
  from the snapshot, so a destroyed container's name, image, and host workspace
  still display.
- SSE `session-created`/`session-updated` payloads carry summaries.

## Migration

`SCHEMA_VERSION` bumps. The new tables are created by `migrate()` via
`CREATE TABLE IF NOT EXISTS`, so an existing `tracker.db` gains them in place.
`maybeRebuildFts()` must continue to drop only `session_fts` and never the
archive tables — the archive is the record, the FTS index is derived from it.

No backfill step is needed: on first boot after the upgrade the archive is
empty, `loadSummaries()` returns nothing, and the watchers' ordinary scan
populates it.

## Testing

New `server/test/archive-store.test.ts`:

- summary and body roundtrip, including `exactOptionalPropertyTypes`-shaped
  optional fields
- incremental append inserts only new lines and leaves existing ones untouched
- a truncated or rewritten file (head hash mismatch) replaces all lines
- raw-line pagination matches `readRawLines`' shape and `total`
- `deleteSession` cascades to `archive_raw_lines`
- `fileFingerprint` returns null for an unknown session
- live-session coalescing defers a body rewrite but not a line append

`registry.test.ts` additions:

- startup hydration populates projects and sessions with no watcher running
- `removeSource` marks sessions archived and leaves FTS, tags, and summaries
  intact
- a live watcher claiming a hydrated session clears `archived`
- `kinds`/`locations` filters match archived sessions via their snapshot

`routes.test.ts` additions: the async detail read, archive-backed raw for an
archived session, `DELETE /api/archive/sessions/:id`, `GET /api/archive/stats`.

`container-ingestion.integration.test.ts` gains the case the feature exists
for: ingest the committed `vercel.ai` fixture store, remove its source, and
assert the session is still listed, still merged into the right project, still
served with `archived: true`, and its raw log still readable in full.

## Phases

Each phase is independently reviewable and leaves the tree working.

1. Schema, `ArchiveStore`, and its unit tests. No wiring; nothing observable
   changes.
2. `parseSessionDetailed` plus write-through from `SourceWatcher` and
   `OpenCodeWatcher`. The archive fills; reads still come from memory.
3. Type split, registry hydration, `archived` derivation, the `matches()` fix,
   and non-destructive `removeSource`.
4. Routes.
5. Client: type mirror, archived badge, provenance from the snapshot.
6. Startup fingerprint skip: `SourceWatcher.scanExisting` stats each file and
   skips the parse entirely when size and mtime match `fileFingerprint`, with
   `ARCHIVE_RESCAN=1` forcing a full re-parse. This is what makes the archive
   pay for itself on every boot rather than costing a write on every scan. It
   is droppable without affecting phases 1-5.

## Risks

**Disk growth is unbounded by design.** v1's only mitigation is visibility via
`GET /api/archive/stats`. `body_codec` is reserved so gzip (roughly 5-8x on
transcript text) can be enabled later without a migration.

**Write amplification during live sessions** is the main performance risk,
addressed by the coalescing described above. `ARCHIVE_FLUSH_MS` exists so the
interval can be tuned without a code change.

**Session-id collisions across sources** overwrite rather than warn:
`archive_sessions`' primary key is `session_id`. This matches the registry's
existing newest-wins collision behaviour, but the loser is now durably gone
rather than merely absent from memory. Acceptable for UUID-keyed Claude
sessions; worth revisiting if collisions are ever observed in practice.

**A stale fingerprint skip** (phase 6) could hide a modified file whose size and
mtime both happen to match. Both must match exactly, and `ARCHIVE_RESCAN=1`
provides an escape hatch.

## What does not change

- `TrackerDB`'s FTS, tags, prompts, and summary tables and their APIs.
- `parseSession`'s signature and behaviour.
- `deriveProjectKey` and project grouping.
- `StoreSetWatcher`'s activity rationing and polling.
- The config-management routes and the OpenCode config tab.
- `sources.json` — no new fields.
