# Claude Project Tracker

## Architecture

Monorepo with two pnpm workspace packages:

- **`server/`** — Hono 4 backend on Node 22. Parses `~/.claude/projects/**/*.jsonl` session files, serves REST + SSE endpoints, SQLite for FTS search/tags/prompts.
- **`client/`** — React 19 + Vite 6 + Tailwind 4 frontend. Three-panel layout (projects, sessions, detail) with config management.

Shared TypeScript strict mode settings in `tsconfig.base.json`. Each package has its own `tsconfig.json`.

## Multi-source setup

The tracker can watch multiple `.claude` directories (e.g. two machines, or WSL and Windows on the same host). Copy `server/config/sources.example.json` to `server/config/sources.json` and edit the paths to match your setup. Sessions for the same folder basename (case-insensitive) merge into one project regardless of which source recorded them.

Without a `sources.json`, the tracker falls back to the `CLAUDE_DIR` env var (or `~/.claude`) as a single source.

Sources also carry a `kind` (`claude-code` | `opencode`, defaults to `claude-code`). An opencode source reads
sessions directly from opencode's own SQLite DB (`~/.local/share/opencode/opencode.db`) instead of watching
JSONL files, and needs an additional `configPath` pointing at `~/.config/opencode` to enable the read-only
OpenCode config tab. See the `opencode` entry in `sources.example.json`. The left sidebar shows a "Claude
Code" / "OpenCode" checkbox pair (only when more than one kind is configured) to filter the project/session
list by kind; the same filter is available server-side via `?kinds=claude-code,opencode` on `GET
/api/projects` and `GET /api/sessions`.

Sources also carry a `layout` (`single` | `store-set`, defaults to `single`) and a `location`
(`host` | `container`, defaults to `host`). A `single`-layout source is one ordinary `.claude` directory. A
`store-set`-layout source is a directory holding one such store per agent container (as written by
agent-shell's host-backed bind mount) — `StoreSetWatcher` expands it into one child `Source` per
subdirectory (`id: "<parentId>:<storeName>"`, `location: "container"`) instead of the parent ever getting an
ordinary watcher itself. Each container store's transcripts record `cwd: "/workspace"`; the child source's
`origin` (read from a `.tracker-origin.json` marker the container writes, or synthesized from the store name
if the marker is missing/incomplete) is used to rewrite that cwd to the real host path before the project key
is derived, so a container session merges into the same project as host sessions for that folder. See the
`agents` entry in `sources.example.json`, and `AGENT_CLAUDE_ROOT` in `.env.example` for the host-side mount.
Live watching is rationed by store activity — only stores with a transcript or marker newer than
`STORE_ACTIVE_DAYS` (env, default 14) get a live filesystem watcher; older stores are still fully scanned and
browsable, just not watched, and a container relaunch (which rewrites the marker) promotes its store back to
watched on the next poll (`STORE_POLL_MS`-driven, default 30s). The sidebar gains a second "Host" /
"Containers" checkbox pair (only when both locations are present) alongside the kind pair; the same filter is
available server-side via `?locations=host,container`, combinable with `?kinds=`.

## Session archive

Session transcripts are persisted in SQLite (`archive_sessions` +
`archive_raw_lines` in `tracker.db`) rather than living only in the `.jsonl`
files on disk. The database is the archive of record: `SessionRegistry`
hydrates its in-memory `SessionMeta` map from the archive at startup — before
any file is read — and loads message/tool-call bodies on demand when a session
is opened. Watchers are ingestion feeds that write through.

A session whose source is no longer connected (container destroyed, host
unmounted, Claude Code's own 30-day cleanup) stays listed and fully browsable
with `archived: true`, badged in the UI. `removeSource` marks rather than
purges; the only path that destroys data is
`DELETE /api/archive/sessions/:id`. Raw lines are stored verbatim, so a future
`parser.ts` change can re-derive every archived body via
`POST /api/archive/reparse` (`PARSER_VERSION` in `parser.ts` gates which rows
are stale). `GET /api/archive/stats` reports size.

`ARCHIVE_FLUSH_MS` (default 15000) throttles body rewrites for live sessions;
raw lines always append immediately. `ARCHIVE_RESCAN=1` forces a full
re-parse at startup instead of skipping files whose size and mtime match the
archive's fingerprint.

## sessionkit

The command-line analysis toolkit that used to live at `tools/sessionkit/` has moved to its own
repository, `claude-session-analyzer` (a sibling of this repo). It is a separate surface over the
same `~/.claude/projects/**` corpus and shares no code with `server/`. See that repo's README.md
and PLAN.md for details; there is nothing sessionkit-specific left in this repo to document.
`server/src/pricing.ts`'s rates are kept in sync with that repo's `pricing.py` by hand — see the
comment atop `pricing.ts` for the current sync date.

## Key Conventions

- TypeScript strict mode with `exactOptionalPropertyTypes` — optional props must include `| undefined` (e.g., `foo?: string | undefined`)
- `verbatimModuleSyntax` — use `import type` for type-only imports
- `noUncheckedIndexedAccess` — index access returns `T | undefined`
- Frontend path alias: `@/*` maps to `client/src/*`
- Server imports use `.js` extensions (TypeScript with NodeNext resolution)
- Server types are in `server/src/types.ts`, mirrored to `client/src/types.ts` — keep them in sync. Sessions are split into `SessionMeta` (small, list/filter fields, always in memory) and `SessionBody` (the heavy message/tool-call arrays, loaded on demand from the archive); `Session = SessionMeta & SessionBody` is the full shape a detail view gets. `ParsedSession` is what `parser.ts` returns before a `SourceSnapshot` (name/kind/location/origin) is attached by `decorateSession`.

## Commands

```bash
pnpm dev                    # Start both server (:3001) and client (:5173)
pnpm build                  # Build both packages
pnpm test                   # Run server tests (vitest)
pnpm typecheck              # Type check both packages
pnpm lint                   # Lint with oxlint

# Package-specific
pnpm --filter @claude-tracker/server build    # Server only
pnpm --filter @claude-tracker/server test     # Server tests only
cd client && npx tsc --noEmit --allowImportingTsExtensions  # Client typecheck
```

## File Layout

- `server/src/parser.ts` — Core JSONL parsing. Extracts messages, tool calls, file changes, hooks, permissions, subagents. `parseSessionDetailed(filePath, sourceId, dirName)` reads a file once and returns both the parsed `ParsedSession` and its raw lines/size/mtime (`ParsedFile`) so callers can write through to the archive without re-reading the file; `parseSession` is the session-only convenience wrapper. `parseLines(lines, fileStat, filePath, sourceId, dirName)` is the pure parse underneath both — it derives `projectId` via `deriveProjectKey(cwd, sourceId, dirName)` — and is also what `POST /api/archive/reparse` feeds archived raw lines through to re-derive a stale body. `PARSER_VERSION` is bumped by hand whenever parsing semantics change; archived rows record the version they were parsed with, and `ArchiveStore.listStale`/`POST /api/archive/reparse` use it to find rows to re-derive. `readRawLines(filePath, offset, limit)` paginates a live file's raw lines in the same shape `ArchiveStore.getRawLines` returns for an archived one.
- `server/src/project-key.ts` — Pure utilities for project identity: `basenameOf`, `deriveProjectKey` (lowercased basename of cwd, or `<sourceId>:<dirName>` fallback), `displayNameFromCwd` (casing-preserving display name).
- `server/src/sources.ts` — Loads `server/config/sources.json` (with `CLAUDE_DIR` env-var fallback), validates entries, skips unreachable paths. Exports `Source`/`SourceKind`/`SourceLayout`/`SourceLocation` interfaces.
- `server/src/store-origin.ts` — Pure: `readStoreOrigin(storePath, storeName)` reads a container's `.tracker-origin.json` marker (or synthesizes a fallback rooted at the store name for a missing/incomplete one), `rewriteCwd` maps a container's `/workspace`-relative cwd to the marker's real host path, `applyOrigin` applies both to a parsed `Session` and recomputes its `projectId`.
- `server/src/store-set-watcher.ts` — `StoreSetWatcher` expands a `layout: 'store-set'` source (a directory of per-container stores) into one child `Source` per subdirectory, driving a `SourceSink` (the registry's own `addSource`/`removeSource`). Polls (`pollMs`, default 30s) to pick up new/removed stores and to promote/demote a store's live watch based on `isActive` (marker or newest transcript mtime within `activeDays`, default 14) — an inactive store is still scanned and browsable, just not chokidar-watched, since stores accumulate forever and one watcher per store would poll dozens of dead trees.
- `server/src/source-watcher.ts` — Per-source `SourceWatcher` class for `kind: 'claude-code'` sources. Scans existing JSONL files, watches via chokidar (directory-level watch with a `.jsonl` filter — chokidar v4 dropped glob support), links subagents within the source, tags every parsed `Session` with its `sourceId`. Every parse (initial scan or a live file event) writes through to `db.archive.put()` with the raw lines and file fingerprint, and indexes non-subagent sessions into FTS; `stop()` flushes any deferred archive body writes. On the initial scan, a file whose fingerprint (size + mtime) still matches the archive's stored one skips a full re-parse and is served straight from the archived summary and body instead. Optional constructor options (`{ watch, transformSession, rescan }`) let a `StoreSetWatcher`-driven child disable live watching, rewrite each session via `applyOrigin`, and (`rescan: true`) force a full re-parse instead of trusting the fingerprint.
- `server/src/archive-store.ts` — `ArchiveStore`: all archive SQL. Shares `TrackerDB`'s connection (exposed as `db.archive`). `loadSummaries`/`loadSummary` hydrate `SessionMeta`, `getBody` loads a `SessionBody` on demand, `put` write-throughs a session and its verbatim lines (appending only new lines when the head hash matches and the file grew; replacing all on a rewrite), `fileFingerprint` drives the startup skip, and body writes for `live` sessions coalesce to at most one per `ARCHIVE_FLUSH_MS` (`flush`/`flushAll` force them out).
- `server/src/session-shape.ts` — Pure conversions: `sourceSnapshot`, `decorateSession` (parser output + `Source` → `Session`), `toMeta`, `toBody`.
- `server/src/opencode-parser.ts` — `listOpenCodeSessions(dbPath, sourceId)`: reads opencode's own SQLite DB (session/message/part tables — `part` is a *separate* table keyed by `message_id`, not embedded in `message.data`) and maps rows to the same `Session` shape `parser.ts` produces.
- `server/src/opencode-watcher.ts` — `OpenCodeWatcher` class for `kind: 'opencode'` sources. Polls `opencode.db` and its `-wal` file's mtime instead of watching a directory; `pollOnce()` is public for deterministic tests.
- `server/src/opencode-config.ts` — Read-only `readOpenCodeConfig`/`listOpenCodeAgents` for opencode's own `opencode.json` (JSONC — comments are stripped with a string-literal-aware scanner, not a naive regex) and agent markdown files.
- `server/src/registry.ts` — `SessionRegistry` aggregator. `start()` first hydrates `SessionMeta` from `TrackerDB.archive.loadSummaries()` so the UI is browsable before any file is read, then builds one watcher per ordinary source (`createWatcher(source, db, options)` dispatches to `SourceWatcher` or `OpenCodeWatcher` by `source.kind`; both satisfy a shared `AgentWatcher` interface) and hands each `layout: 'store-set'` source to its own `StoreSetWatcher`. `addSource`/`removeSource` register/deregister a source at runtime (not just at startup) — `removeSource` is non-destructive: it stops the watcher and flags the source's sessions `archived: true` in place, keeping their FTS rows, tags, cached summaries and archived body; only `DELETE /api/archive/sessions/:id` (in `routes.ts`, via `TrackerDB.removeSession` and `ArchiveStore.deleteSession`) actually deletes anything. `getSessionDetail(id)` loads a session's body from the archive on demand, degrading to empty arrays (with a warning) instead of 404ing if the body row is unexpectedly missing. `forgetSession(id)` drops a session from the in-memory map, for the hard-delete route only. `SessionFilter` (`{ kinds?, locations? }`) is the single filter object `getProjects`/`getSessions` take, matched against each session's own snapshot so a session whose source has been removed still filters correctly; `matches()` is the shared predicate. Third constructor arg (`RegistryOptions`, extending `StoreSetWatcherOptions` with `rescan`) threads `STORE_ACTIVE_DAYS`/`STORE_POLL_MS`/`ARCHIVE_RESCAN` down to every watcher. Ingests all watchers' sessions into a unified map, groups projects by basename slug across sources, handles session-id collisions, re-emits SSE events including `sources-changed`.
- `server/src/db.ts` — SQLite with better-sqlite3. FTS5 search, tags, prompts, and the durable session archive: the constructor creates the `archive_sessions`/`archive_raw_lines` tables alongside FTS/tags/prompts and builds `this.archive` (an `ArchiveStore`, exposed readonly as `db.archive`) sharing the same connection. `SCHEMA_VERSION` + `maybeRebuildFts()` runs on construction; rebuilds the FTS table on schema bump. `removeSession(sessionId)` — called only by the hard-delete route, not by `removeSource`'s non-destructive path — reverses `indexSession`: deletes the FTS row, the session's tag links (sweeping any tag left with zero sessions), and any cached AI summary, all in one transaction.
- `server/src/config.ts` — Read/write for settings.json, .claude.json, CLAUDE.md, hook scripts.
- `server/src/routes.ts` — All API endpoints. `buildApp(registry, db, llmConfigPath)`. `?kinds=`/`?locations=` filter `/api/projects`/`/api/sessions` (a present-but-empty param, e.g. `?kinds=`, filters to zero results — distinct from an absent param, which applies no filter). `/api/sessions/:id/raw` branches three ways: a synthesized paginated transcript from already-parsed messages for opencode (which never had a JSONL file), `db.archive.getRawLines()` for an `archived` session (no file left on disk), otherwise `readRawLines()` tailing the live JSONL file directly — a container session needs no branch of its own here, since `session.filePath` already points at the real bind-mounted file while its source is live. Archive routes: `GET /api/archive/stats` reports `ArchiveStore.stats()`; `DELETE /api/archive/sessions/:id` is the one route that destroys archive data — it calls `archive.deleteSession`, `db.removeSession` (FTS/tags/summary) and `registry.forgetSession` together; `POST /api/archive/reparse` re-derives stale bodies (`ArchiveStore.listStale(PARSER_VERSION, limit)`) from their stored raw lines via `parseLines()` and writes them back with `archive.replaceBody()`. Config-management routes (`/api/config/*`) target the first configured source and 503 when no source exists; the opencode config routes are registered separately so they work independent of that gate. `GET /api/sources` returns full `Source` objects including `location`/`origin`/`parentId`; the SSE stream relays the registry's `sources-changed` event so the client knows to refetch when a container appears/disappears.
- `server/src/env-config.ts` — `parseOptionalNumberEnv(name, env?)`: absent, empty, or whitespace-only means "not set" (silent); a present-but-non-numeric value warns and falls back — both resolve to `undefined` so the caller's default takes over.
- `server/src/index.ts` — Server entrypoint. Loads sources via `loadSources`, reads `STORE_ACTIVE_DAYS`/`STORE_POLL_MS` via `parseOptionalNumberEnv`, starts `SessionRegistry`, starts Hono server. `docker-compose.yml` forwards both into the container's `environment:` (empty string if unset in `.env`, which the parser treats as absent).
- `server/src/pricing.ts` — Model pricing table and cost computation. Rates mirror `pricing.py` in the sibling `claude-session-analyzer` repo's sessionkit toolkit; cache rates are derived (write 1.25x input, read 0.1x) rather than stored per row. `getUnpricedModels()` records unknown ids instead of silently defaulting.
- `client/src/App.tsx` — Root component. Manages project/session selection, config mode, compare mode, `enabledKinds`/`enabledLocations` filter state (each a `null`-sentinel array — `null` means "not yet toggled by the user", so a newly-appearing kind/location defaults to enabled).
- `client/src/hooks/useSources.ts` — Fetches `/api/sources` on mount and again whenever a `tracker:sources-changed` window event fires (relayed from the server's `sources-changed` SSE event by `useSSE.ts`); exports `SourceKind`/`SourceLocation`/`StoreOrigin`. Consumed by `SessionList` (per-session badge), `SessionDetail` (provenance line), `ConfigPanel` (active-source label, OpenCode tab visibility), `ProjectList` (kind/location checkboxes).
- `client/src/components/SessionList.tsx` — Renders a small source badge next to each session: the container name (from `source.origin.container`) for a container session, the source name otherwise. Shown when more than one source is configured, OR unconditionally for a container session (container identity matters even with a single source).
- `client/src/components/ProjectList.tsx` — Renders the "Claude Code" / "OpenCode" and "Host" / "Containers" filter checkbox rows below the project count, each only when there's more than one value to choose between.
- `client/src/components/SessionDetail.tsx` — 7-tab detail view (Conversation, Tools, Files, Costs, Hooks, Agents, Raw Log). Header shows a provenance line (container name, image, host workspace — each independently optional) when the session's source is a container.
- `client/src/components/config/ConfigPanel.tsx` — Config editor tab bar (Settings, CLAUDE.md, MCP, Hooks, AI Summaries, and a read-only OpenCode tab shown only when an opencode source with `configPath` is configured). Header shows "Editing: \<source name\>".
- `client/src/components/config/OpenCodeConfigPanel.tsx` — Read-only render of opencode's `opencode.json` and agent markdown files; no save wiring.

## Testing

Tests are in `server/test/`. Run with `pnpm test` or `cd server && npx vitest run`. Total: 303 tests across 21 files.

- `parser.test.ts` — 43 tests covering all JSONL record types, tool extraction, file changes, hooks, permissions, subagents, raw lines.
- `project-key.test.ts` — 13 tests for path basename extraction, cross-platform merging, and fallback behavior.
- `store-origin.test.ts` — 22 tests for `readStoreOrigin`/`rewriteCwd`/`applyOrigin`/`synthesizeOrigin`: mount-boundary rewriting (including the prefix-vs-boundary edge case), a missing/malformed/incomplete marker falling back correctly (keyed on the `hostWorkspace` field being unusable, not the file being absent — so a marker that names a real container but omits `hostWorkspace` keeps the real name), Windows-style host paths, non-mutation.
- `store-set-watcher.test.ts` — 13 tests for `StoreSetWatcher`: initial expansion, tolerating a missing root/a store with no `projects/` dir/files at the root, store churn (a store appearing/disappearing between polls), activity-based watch promotion/demotion (including reactivation via a rewritten marker), per-store error isolation in a poll pass, and `stop()` actually clearing the poll timer.
- `sources.test.ts` — 14 tests for the config loader: happy path, env-var fallback, unreachable-source skip, duplicate ids, invalid ids, malformed JSON, non-array roots, null root, `kind`/`configPath`/`layout` validation and defaulting.
- `source-watcher.test.ts` — 13 tests for per-source subagent scanning/linking, the `watch`/`transformSession`/`rescan` constructor options (including that the transform is applied on both the initial scan and the live-file-event path, and that `watch: false` genuinely starts no filesystem watcher), archive write-through on scan and on live events (including the source snapshot and subagent sessions), and the startup fingerprint skip (unchanged file skips the parse, a grown file re-parses, `rescan: true` forces a re-parse regardless, and a skipped session still serves correctly from the archive).
- `db.test.ts` — 5 tests for `TrackerDB.removeSession`: a removed session drops out of `search()`, an orphaned tag (its only session removed) is swept while a tag shared with another session survives, a cached AI summary is removed, and removing a never-indexed session doesn't throw.
- `pricing.test.ts` — 10 tests for the model pricing table: Claude 5 rates (Fable/Opus/Sonnet/Haiku), the Opus $15/$75 → $5/$25 regression specifically, cache rates derived from the input rate (write 1.25x, read 0.1x), id normalization (`[1m]`/`-fast` suffixes, `anthropic.` prefix, dated snapshots), `<synthetic>` billed as free, and an unknown model being *both* priced at the Sonnet fallback and recorded by `getUnpricedModels()`.
- `archive-store.test.ts` — 38 tests for `ArchiveStore`: summary/body roundtrip, status coercion on load, source-snapshot and origin persistence, `exactOptionalPropertyTypes`-correct omission of absent optionals, incremental line append vs. full replace on a rewrite or truncation, raw-line pagination matching `readRawLines`' shape, fingerprints, cascade delete, stats, live-write coalescing, and archive rows surviving an FTS rebuild.
- `session-shape.test.ts` — 9 tests for the pure shape conversions.
- `opencode-parser.test.ts` — 14 tests: SQLite row → `Session` mapping against the real (verified-live) schema, file-op tool mapping, malformed-row/malformed-part resilience, subagent linking via `parent_id`, `logEntries` population.
- `opencode-watcher.test.ts` — 8 tests for polling: initial scan doesn't emit, `pollOnce()` detects new/changed sessions, no re-emit when unchanged, subagent linking, missing-DB resilience, clean `stop()`, and archive write-through on a scan.
- `opencode-config.test.ts` — 7 tests for the read-only config readers, including the JSONC string-literal-vs-comment edge case (`"https://..."` must not be treated as a comment).
- `registry.test.ts` — 36 tests for cross-source merging, single-source grouping, no-cwd fallback, case-insensitive basenames, unreachable-source resilience, `kind`-based watcher dispatch, `kinds`/`locations`/combined `SessionFilter` filtering (including that an explicit empty array matches nothing, unlike an absent filter), runtime `addSource`/`removeSource` (idempotent replace on a duplicate id, `sources-changed` emission), `store-set`-layout sources expanding into child sources at `start()`, the registry's third constructor argument (`RegistryOptions`) actually reaching every `StoreSetWatcher` it builds, archive hydration at startup (projects/sessions served with no watcher, hydrated sessions marked `archived`, a live watcher clearing that flag, `getSessionDetail` merging meta with archived body or degrading gracefully, subagents hydrating without appearing as top-level sessions), non-destructive source removal (a removed source's sessions stay listed and `archived` while keeping their FTS rows/tags/summaries and readable body, and still drop out of `getSources()`), and filtering archived sessions by their own snapshot.
- `env-config.test.ts` — 7 tests for `parseOptionalNumberEnv` (`STORE_ACTIVE_DAYS`/`STORE_POLL_MS`'s parser): absent, empty-string, and whitespace-only all silently mean "use the default"; a non-numeric value warns and falls back; valid integer/decimal values parse; defaults to reading `process.env` when no env object is passed.
- `routes.test.ts` — 20 tests for `?kinds=`/`?locations=` filtering (including the present-but-empty-vs-absent distinction), the raw-log kind branch, opencode config 503/200 paths, `/api/sources` exposing `location`/`origin`/`parentId`, and the archive routes (`GET /api/archive/stats`, `DELETE /api/archive/sessions/:id`, `POST /api/archive/reparse` re-deriving a stale body and reporting zero when nothing is stale), via Hono's `app.request()`.
- `multi-source.integration.test.ts` — 3 tests using committed fixtures under `server/test/fixtures/sources/{wsl,windows}/` to exercise end-to-end merge of WSL + Windows sessions.
- `multi-agent.integration.test.ts` — 4 tests merging a committed claude-code JSONL fixture with a seeded opencode SQLite fixture (`server/test/fixtures/opencode/seed.ts`) into one project, and filtering by kind.
- `container-ingestion.integration.test.ts` — 8 tests using committed fixtures under `server/test/fixtures/agent-stores/` (a `vercel.ai` store with a real `.tracker-origin.json` marker, a markerless `legacy-shared` store): a container session merges into the same project as a host session for the same folder, a markerless store keeps its own project instead of joining anything, the container cwd is rewritten to the real host path, `?locations=` isolates container vs. host sessions, the raw log resolves to the real committed fixture file (proving `/api/sessions/:id/raw` needs no container-specific branch), and — the end-to-end case the whole archive feature exists for — a destroyed container's session keeps serving its detail/body/raw log and stays in its project after `removeSource`, an archived container session still merges into its host project, and a session survives a full process restart with its source gone entirely.
- `llm.test.ts` — 11 tests for the LLM client (model listing, connection testing, summary generation).
- `llm-config.test.ts` — 5 tests for the LLM config reader/writer, including malformed-JSON fallback.

Test files use relative imports (`../src/parser.ts`) which is necessary for NodeNext module resolution. A pre-tool hook blocks relative imports in source files but test files require them.

## Important Notes

- The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in Write/Edit tools for .ts/.tsx files. Use `Bash` with `cat >` or `sed` to write test files that need relative imports.
- Docker mounts `CLAUDE_DIR` as read-only. Config management endpoints write to the host filesystem, not the container — this only works in local dev or with the volume mounted read-write.
- Session status (live/waiting/done) is derived from file mtime, not from the JSONL content.
- The `pnpm-lock.yaml` is at the workspace root. Always run `pnpm install` from the root.
- Do NOT install dependencies or run `pnpm dev`/`pnpm build`/`pnpm test`/etc. locally — `pnpm` isn't set up on the host. The dev container (`docker compose up`, service `app`) is the only place these commands run; it mounts `client/src`, `server/src`, `server/test`, and `server/config` read-write for live reload, so edits made on the host are picked up automatically by the already-running container. Verify UI changes through the container's exposed ports (5173 client, 3001 server) rather than starting a second local dev server.
