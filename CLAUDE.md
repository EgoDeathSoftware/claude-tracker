# Claude Project Tracker

## Architecture

Monorepo with two pnpm workspace packages:

- **`server/`** — Hono 4 backend on Node 22. Parses `~/.claude/projects/**/*.jsonl` session files, serves REST + SSE endpoints, SQLite for FTS search/tags/prompts.
- **`client/`** — React 19 + Vite 6 + Tailwind 4 frontend. Three-panel layout (projects, sessions, detail) with config management.

Shared TypeScript strict mode settings in `tsconfig.base.json`. Each package has its own `tsconfig.json`.

## Multi-source setup

The tracker can watch multiple `.claude` directories (e.g. WSL and Windows on the same host). Copy `server/config/sources.example.json` to `server/config/sources.json` and edit the paths to match your setup. Sessions for the same folder basename (case-insensitive) merge into one project regardless of which source recorded them.

Without a `sources.json`, the tracker falls back to the `CLAUDE_DIR` env var (or `~/.claude`) as a single source.

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
- `server/src/sources.ts` — Loads `server/config/sources.json` (with `CLAUDE_DIR` env-var fallback), validates entries, skips unreachable paths. Exports `Source` interface.
- `server/src/source-watcher.ts` — Per-source `SourceWatcher` class. One instance per configured `.claude` directory. Scans existing JSONL files, watches via chokidar, links subagents within the source, tags every parsed `Session` with its `sourceId`.
- `server/src/registry.ts` — `SessionRegistry` aggregator. Owns one `SourceWatcher` per source, ingests their sessions into a unified map, groups projects by basename slug across sources, handles session-id collisions, re-emits SSE events.
- `server/src/db.ts` — SQLite with better-sqlite3. FTS5 search, tags, prompts. `SCHEMA_VERSION` + `maybeRebuildFts()` runs on construction; rebuilds the FTS table on schema bump.
- `server/src/config.ts` — Read/write for settings.json, .claude.json, CLAUDE.md, hook scripts.
- `server/src/routes.ts` — All API endpoints. `buildApp(registry, db)`. Config-management routes (`/api/config/*`) target the first configured source and 503 when no source exists. Includes `GET /api/sources`.
- `server/src/index.ts` — Server entrypoint. Loads sources via `loadSources`, starts `SessionRegistry`, starts Hono server.
- `server/src/pricing.ts` — Model pricing table and cost computation.
- `client/src/App.tsx` — Root component. Manages project/session selection, config mode, compare mode.
- `client/src/hooks/useSources.ts` — Fetches `/api/sources` once on mount; consumed by `SessionList` (per-session badge) and `ConfigPanel` (active-source label).
- `client/src/components/SessionList.tsx` — Renders a small source badge next to each session when more than one source is configured.
- `client/src/components/SessionDetail.tsx` — 7-tab detail view (Conversation, Tools, Files, Costs, Hooks, Agents, Raw Log).
- `client/src/components/config/ConfigPanel.tsx` — 4-tab config editor (Settings, CLAUDE.md, MCP, Hooks). Header shows "Editing: \<source name\>".

## Testing

Tests are in `server/test/`. Run with `pnpm test` or `cd server && npx vitest run`. Total: 67 tests across 6 files.

- `parser.test.ts` — 36 tests covering all JSONL record types, tool extraction, file changes, hooks, permissions, subagents, raw lines.
- `project-key.test.ts` — 13 tests for path basename extraction, cross-platform merging, and fallback behavior.
- `sources.test.ts` — 8 tests for the config loader: happy path, env-var fallback, unreachable-source skip, duplicate ids, invalid ids, malformed JSON, non-array roots, null root.
- `source-watcher.test.ts` — 2 tests for per-source subagent scanning and linking.
- `registry.test.ts` — 5 tests for cross-source merging, single-source grouping, no-cwd fallback, case-insensitive basenames, and unreachable-source resilience.
- `multi-source.integration.test.ts` — 3 tests using committed fixtures under `server/test/fixtures/sources/{wsl,windows}/` to exercise end-to-end merge of WSL + Windows sessions.

Test files use relative imports (`../src/parser.ts`) which is necessary for NodeNext module resolution. A pre-tool hook blocks relative imports in source files but test files require them.

## Important Notes

- The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in Write/Edit tools for .ts/.tsx files. Use `Bash` with `cat >` or `sed` to write test files that need relative imports.
- Docker mounts `CLAUDE_DIR` as read-only. Config management endpoints write to the host filesystem, not the container — this only works in local dev or with the volume mounted read-write.
- Session status (live/waiting/done) is derived from file mtime, not from the JSONL content.
- The `pnpm-lock.yaml` is at the workspace root. Always run `pnpm install` from the root.
