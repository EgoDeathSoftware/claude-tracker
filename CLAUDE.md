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
```

## File Layout

- `server/src/parser.ts` — Core JSONL parsing. Extracts messages, tool calls, file changes, hooks, permissions, subagents. `parseSession(filePath, sourceId, dirName)` derives `projectId` via `deriveProjectKey(cwd, sourceId, dirName)`.
- `server/src/project-key.ts` — Pure utilities for project identity: `basenameOf`, `deriveProjectKey` (lowercased basename of cwd, or `<sourceId>:<dirName>` fallback), `displayNameFromCwd` (casing-preserving display name).
- `server/src/sources.ts` — Loads `server/config/sources.json` (with `CLAUDE_DIR` env-var fallback), validates entries, skips unreachable paths. Exports `Source`/`SourceKind` interfaces.
- `server/src/source-watcher.ts` — Per-source `SourceWatcher` class for `kind: 'claude-code'` sources. Scans existing JSONL files, watches via chokidar, links subagents within the source, tags every parsed `Session` with its `sourceId`.
- `server/src/opencode-parser.ts` — `listOpenCodeSessions(dbPath, sourceId)`: reads opencode's own SQLite DB (session/message/part tables — `part` is a *separate* table keyed by `message_id`, not embedded in `message.data`) and maps rows to the same `Session` shape `parser.ts` produces.
- `server/src/opencode-watcher.ts` — `OpenCodeWatcher` class for `kind: 'opencode'` sources. Polls `opencode.db` and its `-wal` file's mtime instead of watching a directory; `pollOnce()` is public for deterministic tests.
- `server/src/opencode-config.ts` — Read-only `readOpenCodeConfig`/`listOpenCodeAgents` for opencode's own `opencode.json` (JSONC — comments are stripped with a string-literal-aware scanner, not a naive regex) and agent markdown files.
- `server/src/registry.ts` — `SessionRegistry` aggregator. `createWatcher(source, db)` dispatches to `SourceWatcher` or `OpenCodeWatcher` by `source.kind`; both satisfy a shared `AgentWatcher` interface. Ingests all watchers' sessions into a unified map, groups projects by basename slug across sources, handles session-id collisions, filters by `kinds` in `getProjects`/`getSessions`, re-emits SSE events.
- `server/src/db.ts` — SQLite with better-sqlite3. FTS5 search, tags, prompts. `SCHEMA_VERSION` + `maybeRebuildFts()` runs on construction; rebuilds the FTS table on schema bump.
- `server/src/config.ts` — Read/write for settings.json, .claude.json, CLAUDE.md, hook scripts.
- `server/src/routes.ts` — All API endpoints. `buildApp(registry, db)`. `?kinds=` filters `/api/projects`/`/api/sessions`. `/api/sessions/:id/raw` branches by source kind (tails the JSONL file for claude-code, synthesizes a paginated transcript from already-parsed messages for opencode). Config-management routes (`/api/config/*`) target the first configured source and 503 when no source exists; the opencode config routes are registered separately so they work independent of that gate. Includes `GET /api/sources`.
- `server/src/index.ts` — Server entrypoint. Loads sources via `loadSources`, starts `SessionRegistry`, starts Hono server.
- `server/src/pricing.ts` — Model pricing table and cost computation.
- `client/src/App.tsx` — Root component. Manages project/session selection, config mode, compare mode, `enabledKinds` filter state.
- `client/src/hooks/useSources.ts` — Fetches `/api/sources` once on mount; exports `SourceKind`. Consumed by `SessionList` (per-session badge), `ConfigPanel` (active-source label, OpenCode tab visibility), `ProjectList` (kind checkboxes).
- `client/src/components/SessionList.tsx` — Renders a small source badge (with a kind-colored dot) next to each session when more than one source is configured.
- `client/src/components/ProjectList.tsx` — Renders the "Claude Code" / "OpenCode" filter checkboxes below the project count, only when more than one kind is configured.
- `client/src/components/SessionDetail.tsx` — 7-tab detail view (Conversation, Tools, Files, Costs, Hooks, Agents, Raw Log).
- `client/src/components/config/ConfigPanel.tsx` — Config editor tab bar (Settings, CLAUDE.md, MCP, Hooks, AI Summaries, and a read-only OpenCode tab shown only when an opencode source with `configPath` is configured). Header shows "Editing: \<source name\>".
- `client/src/components/config/OpenCodeConfigPanel.tsx` — Read-only render of opencode's `opencode.json` and agent markdown files; no save wiring.

## Testing

Tests are in `server/test/`. Run with `pnpm test` or `cd server && npx vitest run`. Total: 130 tests across 13 files.

- `parser.test.ts` — 38 tests covering all JSONL record types, tool extraction, file changes, hooks, permissions, subagents, raw lines.
- `project-key.test.ts` — 13 tests for path basename extraction, cross-platform merging, and fallback behavior.
- `sources.test.ts` — 10 tests for the config loader: happy path, env-var fallback, unreachable-source skip, duplicate ids, invalid ids, malformed JSON, non-array roots, null root, `kind`/`configPath` validation.
- `source-watcher.test.ts` — 5 tests for per-source subagent scanning/linking and the `watch`/`transformSession` constructor options.
- `opencode-parser.test.ts` — 14 tests: SQLite row → `Session` mapping against the real (verified-live) schema, file-op tool mapping, malformed-row/malformed-part resilience, subagent linking via `parent_id`, `logEntries` population.
- `opencode-watcher.test.ts` — 7 tests for polling: initial scan doesn't emit, `pollOnce()` detects new/changed sessions, no re-emit when unchanged, subagent linking, missing-DB resilience, clean `stop()`.
- `opencode-config.test.ts` — 7 tests for the read-only config readers, including the JSONC string-literal-vs-comment edge case (`"https://..."` must not be treated as a comment).
- `registry.test.ts` — 7 tests for cross-source merging, single-source grouping, no-cwd fallback, case-insensitive basenames, unreachable-source resilience, `kind`-based watcher dispatch, and `kinds` filtering.
- `routes.test.ts` — 6 tests for `?kinds=` filtering, the raw-log kind branch, and opencode config 503/200 paths, via Hono's `app.request()`.
- `multi-source.integration.test.ts` — 3 tests using committed fixtures under `server/test/fixtures/sources/{wsl,windows}/` to exercise end-to-end merge of WSL + Windows sessions.
- `multi-agent.integration.test.ts` — 4 tests merging a committed claude-code JSONL fixture with a seeded opencode SQLite fixture (`server/test/fixtures/opencode/seed.ts`) into one project, and filtering by kind.
- `llm.test.ts` — 11 tests for the LLM client (model listing, connection testing, summary generation).
- `llm-config.test.ts` — 5 tests for the LLM config reader/writer, including malformed-JSON fallback.

Test files use relative imports (`../src/parser.ts`) which is necessary for NodeNext module resolution. A pre-tool hook blocks relative imports in source files but test files require them.

## Important Notes

- The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in Write/Edit tools for .ts/.tsx files. Use `Bash` with `cat >` or `sed` to write test files that need relative imports.
- Docker mounts `CLAUDE_DIR` as read-only. Config management endpoints write to the host filesystem, not the container — this only works in local dev or with the volume mounted read-write.
- Session status (live/waiting/done) is derived from file mtime, not from the JSONL content.
- The `pnpm-lock.yaml` is at the workspace root. Always run `pnpm install` from the root.
- Do NOT install dependencies or run `pnpm dev`/`pnpm build`/`pnpm test`/etc. locally — `pnpm` isn't set up on the host. The dev container (`docker compose up`, service `app`) is the only place these commands run; it mounts `client/src`, `server/src`, `server/test`, and `server/config` read-write for live reload, so edits made on the host are picked up automatically by the already-running container. Verify UI changes through the container's exposed ports (5173 client, 3001 server) rather than starting a second local dev server.
