# Claude Project Tracker

## Architecture

Monorepo with two pnpm workspace packages:

- **`server/`** — Hono 4 backend on Node 22. Parses `~/.claude/projects/**/*.jsonl` session files, serves REST + SSE endpoints, SQLite for FTS search/tags/prompts.
- **`client/`** — React 19 + Vite 6 + Tailwind 4 frontend. Three-panel layout (projects, sessions, detail) with config management.

Shared TypeScript strict mode settings in `tsconfig.base.json`. Each package has its own `tsconfig.json`.

## Multi-source setup

The tracker can watch multiple `.claude` directories (e.g. WSL and Windows on the same host). Copy `server/config/sources.example.json` to `server/config/sources.json` and edit the paths to match your setup. Sessions for the same folder basename (case-insensitive) merge into one project regardless of which source recorded them.

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

## sessionkit (`tools/sessionkit/`)

A **separate, self-contained Python toolkit** that analyses Claude Code transcripts from the
command line — the analysis counterpart to the tracker's UI. It backs a set of session-analysis
skills (`error-patterns` shipped; see `tools/sessionkit/PLAN.md` for the remaining phases).

It is deliberately **not** part of the pnpm workspace and shares no code with `server/`:

- **Stdlib Python only** (3.11+). No pip, no venv, no network. The skills must work from any
  session, including when the dev container is down and `pnpm`/`ruff`/`pytest` are unavailable.
- **Runs on the host**, unlike every `pnpm` command in this repo. `tools/sessionkit/sk <cmd>`.
- **Duplicates transcript parsing on purpose.** Reusing `server/src/parser.ts` would couple
  every skill to `docker compose` being up, or to the HTTP API, which serves UI-shaped
  `Session` objects rather than error clusters. See PLAN.md §3.3.
- **Carries its own pricing table.** `server/src/pricing.ts` predates the Claude 5 family, so
  `claude-sonnet-5` sessions fall through to a Sonnet-4 default there. Keep the two in mind
  when comparing cost figures between the UI and `sk cost`.
- **Read-only**, except its own cache at `~/.cache/sessionkit/cache.db` (gitignored by
  location, holds redacted previews). `~/.claude/tracker/tracker.db` is opened `mode=ro`.

Two transcript facts that are easy to miss and cost 42% of the corpus if you do: subagent
transcripts live at `projects/<project>/<parent-session>/subagents/agent-*.jsonl` (one level
deeper than top-level sessions), and they record the **parent's** `sessionId` — their own
identity is `agentId`.

## Key Conventions

- TypeScript strict mode with `exactOptionalPropertyTypes` — optional props must include `| undefined` (e.g., `foo?: string | undefined`)
- `verbatimModuleSyntax` — use `import type` for type-only imports
- `noUncheckedIndexedAccess` — index access returns `T | undefined`
- Frontend path alias: `@/*` maps to `client/src/*`
- Server imports use `.js` extensions (TypeScript with NodeNext resolution)
- Server types are in `server/src/types.ts`, mirrored to `client/src/types.ts` — keep them in sync

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

# sessionkit (tools/sessionkit) — runs on the HOST, not in the container
tools/sessionkit/sk doctor                                        # what it can see
cd tools/sessionkit && PYTHONPATH=. python3 -m unittest discover -s tests -t .
```

## File Layout

- `server/src/parser.ts` — Core JSONL parsing. Extracts messages, tool calls, file changes, hooks, permissions, subagents. `parseSession(filePath, sourceId, dirName)` derives `projectId` via `deriveProjectKey(cwd, sourceId, dirName)`.
- `server/src/project-key.ts` — Pure utilities for project identity: `basenameOf`, `deriveProjectKey` (lowercased basename of cwd, or `<sourceId>:<dirName>` fallback), `displayNameFromCwd` (casing-preserving display name).
- `server/src/sources.ts` — Loads `server/config/sources.json` (with `CLAUDE_DIR` env-var fallback), validates entries, skips unreachable paths. Exports `Source`/`SourceKind`/`SourceLayout`/`SourceLocation` interfaces.
- `server/src/store-origin.ts` — Pure: `readStoreOrigin(storePath, storeName)` reads a container's `.tracker-origin.json` marker (or synthesizes a fallback rooted at the store name for a missing/incomplete one), `rewriteCwd` maps a container's `/workspace`-relative cwd to the marker's real host path, `applyOrigin` applies both to a parsed `Session` and recomputes its `projectId`.
- `server/src/store-set-watcher.ts` — `StoreSetWatcher` expands a `layout: 'store-set'` source (a directory of per-container stores) into one child `Source` per subdirectory, driving a `SourceSink` (the registry's own `addSource`/`removeSource`). Polls (`pollMs`, default 30s) to pick up new/removed stores and to promote/demote a store's live watch based on `isActive` (marker or newest transcript mtime within `activeDays`, default 14) — an inactive store is still scanned and browsable, just not chokidar-watched, since stores accumulate forever and one watcher per store would poll dozens of dead trees.
- `server/src/source-watcher.ts` — Per-source `SourceWatcher` class for `kind: 'claude-code'` sources. Scans existing JSONL files, watches via chokidar (directory-level watch with a `.jsonl` filter — chokidar v4 dropped glob support), links subagents within the source, tags every parsed `Session` with its `sourceId`. Optional 4th constructor arg (`{ watch, transformSession }`) lets a `StoreSetWatcher`-driven child disable live watching and rewrite each session via `applyOrigin`.
- `server/src/opencode-parser.ts` — `listOpenCodeSessions(dbPath, sourceId)`: reads opencode's own SQLite DB (session/message/part tables — `part` is a *separate* table keyed by `message_id`, not embedded in `message.data`) and maps rows to the same `Session` shape `parser.ts` produces.
- `server/src/opencode-watcher.ts` — `OpenCodeWatcher` class for `kind: 'opencode'` sources. Polls `opencode.db` and its `-wal` file's mtime instead of watching a directory; `pollOnce()` is public for deterministic tests.
- `server/src/opencode-config.ts` — Read-only `readOpenCodeConfig`/`listOpenCodeAgents` for opencode's own `opencode.json` (JSONC — comments are stripped with a string-literal-aware scanner, not a naive regex) and agent markdown files.
- `server/src/registry.ts` — `SessionRegistry` aggregator. `createWatcher(source, db, options)` dispatches to `SourceWatcher` or `OpenCodeWatcher` by `source.kind`; both satisfy a shared `AgentWatcher` interface. `start()` hands each `layout: 'store-set'` source to its own `StoreSetWatcher` instead of building it an ordinary watcher. `addSource`/`removeSource` register/deregister a source at runtime (not just at startup) — `removeSource` also purges the source's sessions from `TrackerDB` (FTS index, tags, cached summaries), not just the in-memory map. `SessionFilter` (`{ kinds?, locations? }`) is the single filter object `getProjects`/`getSessions` take; `matches()` is the shared predicate. Third constructor arg (`StoreSetWatcherOptions`) threads `STORE_ACTIVE_DAYS`/`STORE_POLL_MS` down to every `StoreSetWatcher`. Ingests all watchers' sessions into a unified map, groups projects by basename slug across sources, handles session-id collisions, re-emits SSE events including `sources-changed`.
- `server/src/db.ts` — SQLite with better-sqlite3. FTS5 search, tags, prompts. `SCHEMA_VERSION` + `maybeRebuildFts()` runs on construction; rebuilds the FTS table on schema bump. `removeSession(sessionId)` reverses `indexSession` — deletes the FTS row, the session's tag links (sweeping any tag left with zero sessions), and any cached AI summary, all in one transaction.
- `server/src/config.ts` — Read/write for settings.json, .claude.json, CLAUDE.md, hook scripts.
- `server/src/routes.ts` — All API endpoints. `buildApp(registry, db)`. `?kinds=`/`?locations=` filter `/api/projects`/`/api/sessions` (a present-but-empty param, e.g. `?kinds=`, filters to zero results — distinct from an absent param, which applies no filter). `/api/sessions/:id/raw` branches by source kind (tails the JSONL file for claude-code, synthesizes a paginated transcript from already-parsed messages for opencode) — this needs no branch for container sessions, since `session.filePath` already points at the real bind-mounted file. Config-management routes (`/api/config/*`) target the first configured source and 503 when no source exists; the opencode config routes are registered separately so they work independent of that gate. `GET /api/sources` returns full `Source` objects including `location`/`origin`/`parentId`; the SSE stream relays the registry's `sources-changed` event so the client knows to refetch when a container appears/disappears.
- `server/src/env-config.ts` — `parseOptionalNumberEnv(name, env?)`: absent, empty, or whitespace-only means "not set" (silent); a present-but-non-numeric value warns and falls back — both resolve to `undefined` so the caller's default takes over.
- `server/src/index.ts` — Server entrypoint. Loads sources via `loadSources`, reads `STORE_ACTIVE_DAYS`/`STORE_POLL_MS` via `parseOptionalNumberEnv`, starts `SessionRegistry`, starts Hono server. `docker-compose.yml` forwards both into the container's `environment:` (empty string if unset in `.env`, which the parser treats as absent).
- `server/src/pricing.ts` — Model pricing table and cost computation.
- `client/src/App.tsx` — Root component. Manages project/session selection, config mode, compare mode, `enabledKinds`/`enabledLocations` filter state (each a `null`-sentinel array — `null` means "not yet toggled by the user", so a newly-appearing kind/location defaults to enabled).
- `client/src/hooks/useSources.ts` — Fetches `/api/sources` on mount and again whenever a `tracker:sources-changed` window event fires (relayed from the server's `sources-changed` SSE event by `useSSE.ts`); exports `SourceKind`/`SourceLocation`/`StoreOrigin`. Consumed by `SessionList` (per-session badge), `SessionDetail` (provenance line), `ConfigPanel` (active-source label, OpenCode tab visibility), `ProjectList` (kind/location checkboxes).
- `client/src/components/SessionList.tsx` — Renders a small source badge next to each session: the container name (from `source.origin.container`) for a container session, the source name otherwise. Shown when more than one source is configured, OR unconditionally for a container session (container identity matters even with a single source).
- `client/src/components/ProjectList.tsx` — Renders the "Claude Code" / "OpenCode" and "Host" / "Containers" filter checkbox rows below the project count, each only when there's more than one value to choose between.
- `client/src/components/SessionDetail.tsx` — 7-tab detail view (Conversation, Tools, Files, Costs, Hooks, Agents, Raw Log). Header shows a provenance line (container name, image, host workspace — each independently optional) when the session's source is a container.
- `client/src/components/config/ConfigPanel.tsx` — Config editor tab bar (Settings, CLAUDE.md, MCP, Hooks, AI Summaries, and a read-only OpenCode tab shown only when an opencode source with `configPath` is configured). Header shows "Editing: \<source name\>".
- `client/src/components/config/OpenCodeConfigPanel.tsx` — Read-only render of opencode's `opencode.json` and agent markdown files; no save wiring.

## Testing

Tests are in `server/test/`. Run with `pnpm test` or `cd server && npx vitest run`. Total: 206 tests across 18 files.

- `parser.test.ts` — 38 tests covering all JSONL record types, tool extraction, file changes, hooks, permissions, subagents, raw lines.
- `project-key.test.ts` — 13 tests for path basename extraction, cross-platform merging, and fallback behavior.
- `store-origin.test.ts` — 22 tests for `readStoreOrigin`/`rewriteCwd`/`applyOrigin`/`synthesizeOrigin`: mount-boundary rewriting (including the prefix-vs-boundary edge case), a missing/malformed/incomplete marker falling back correctly (keyed on the `hostWorkspace` field being unusable, not the file being absent — so a marker that names a real container but omits `hostWorkspace` keeps the real name), Windows-style host paths, non-mutation.
- `store-set-watcher.test.ts` — 13 tests for `StoreSetWatcher`: initial expansion, tolerating a missing root/a store with no `projects/` dir/files at the root, store churn (a store appearing/disappearing between polls), activity-based watch promotion/demotion (including reactivation via a rewritten marker), per-store error isolation in a poll pass, and `stop()` actually clearing the poll timer.
- `sources.test.ts` — 14 tests for the config loader: happy path, env-var fallback, unreachable-source skip, duplicate ids, invalid ids, malformed JSON, non-array roots, null root, `kind`/`configPath`/`layout` validation and defaulting.
- `source-watcher.test.ts` — 5 tests for per-source subagent scanning/linking and the `watch`/`transformSession` constructor options (including that the transform is applied on both the initial scan and the live-file-event path, and that `watch: false` genuinely starts no filesystem watcher).
- `db.test.ts` — 5 tests for `TrackerDB.removeSession`: a removed session drops out of `search()`, an orphaned tag (its only session removed) is swept while a tag shared with another session survives, a cached AI summary is removed, and removing a never-indexed session doesn't throw.
- `opencode-parser.test.ts` — 14 tests: SQLite row → `Session` mapping against the real (verified-live) schema, file-op tool mapping, malformed-row/malformed-part resilience, subagent linking via `parent_id`, `logEntries` population.
- `opencode-watcher.test.ts` — 7 tests for polling: initial scan doesn't emit, `pollOnce()` detects new/changed sessions, no re-emit when unchanged, subagent linking, missing-DB resilience, clean `stop()`.
- `opencode-config.test.ts` — 7 tests for the read-only config readers, including the JSONC string-literal-vs-comment edge case (`"https://..."` must not be treated as a comment).
- `registry.test.ts` — 21 tests for cross-source merging, single-source grouping, no-cwd fallback, case-insensitive basenames, unreachable-source resilience, `kind`-based watcher dispatch, `kinds`/`locations`/combined `SessionFilter` filtering (including that an explicit empty array matches nothing, unlike an absent filter), runtime `addSource`/`removeSource` (idempotent replace on a duplicate id, `sources-changed` emission, dropping only the removed source's sessions including their SQLite state), `store-set`-layout sources expanding into child sources at `start()`, and the registry's third constructor argument (`StoreSetWatcherOptions`) actually reaching every `StoreSetWatcher` it builds.
- `env-config.test.ts` — 7 tests for `parseOptionalNumberEnv` (`STORE_ACTIVE_DAYS`/`STORE_POLL_MS`'s parser): absent, empty-string, and whitespace-only all silently mean "use the default"; a non-numeric value warns and falls back; valid integer/decimal values parse; defaults to reading `process.env` when no env object is passed.
- `routes.test.ts` — 12 tests for `?kinds=`/`?locations=` filtering (including the present-but-empty-vs-absent distinction), the raw-log kind branch, opencode config 503/200 paths, and `/api/sources` exposing `location`/`origin`/`parentId`, via Hono's `app.request()`.
- `multi-source.integration.test.ts` — 3 tests using committed fixtures under `server/test/fixtures/sources/{wsl,windows}/` to exercise end-to-end merge of WSL + Windows sessions.
- `multi-agent.integration.test.ts` — 4 tests merging a committed claude-code JSONL fixture with a seeded opencode SQLite fixture (`server/test/fixtures/opencode/seed.ts`) into one project, and filtering by kind.
- `container-ingestion.integration.test.ts` — 5 tests using committed fixtures under `server/test/fixtures/agent-stores/` (a `vercel.ai` store with a real `.tracker-origin.json` marker, a markerless `legacy-shared` store): a container session merges into the same project as a host session for the same folder, a markerless store keeps its own project instead of joining anything, the container cwd is rewritten to the real host path, `?locations=` isolates container vs. host sessions, and the raw log resolves to the real committed fixture file (proving `/api/sessions/:id/raw` needs no container-specific branch).
- `llm.test.ts` — 11 tests for the LLM client (model listing, connection testing, summary generation).
- `llm-config.test.ts` — 5 tests for the LLM config reader/writer, including malformed-JSON fallback.

Test files use relative imports (`../src/parser.ts`) which is necessary for NodeNext module resolution. A pre-tool hook blocks relative imports in source files but test files require them.

**sessionkit tests are separate** — stdlib `unittest`, not vitest, and they run on the host:
`cd tools/sessionkit && PYTHONPATH=. python3 -m unittest discover -s tests -t .` (84 tests
across parsing, error taxonomy, anomaly detectors, pricing, budget enforcement, and end-to-end
ingestion). Fixtures are built inline in `tests/fixtures.py` rather than committed, so each
test shows the transcript shape it asserts against; every anomaly detector has a positive **and**
a negative case.

## Important Notes

- The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in Write/Edit tools for .ts/.tsx files. Use `Bash` with `cat >` or `sed` to write test files that need relative imports.
- Docker mounts `CLAUDE_DIR` as read-only. Config management endpoints write to the host filesystem, not the container — this only works in local dev or with the volume mounted read-write.
- Session status (live/waiting/done) is derived from file mtime, not from the JSONL content.
- The `pnpm-lock.yaml` is at the workspace root. Always run `pnpm install` from the root.
- Do NOT install dependencies or run `pnpm dev`/`pnpm build`/`pnpm test`/etc. locally — `pnpm` isn't set up on the host. The dev container (`docker compose up`, service `app`) is the only place these commands run; it mounts `client/src`, `server/src`, `server/test`, and `server/config` read-write for live reload, so edits made on the host are picked up automatically by the already-running container. Verify UI changes through the container's exposed ports (5173 client, 3001 server) rather than starting a second local dev server.
