# Claude Project Tracker

## Architecture

Monorepo with two pnpm workspace packages:

- **`server/`** — Hono 4 backend on Node 22. Parses `~/.claude/projects/**/*.jsonl` session files, serves REST + SSE endpoints, SQLite for FTS search/tags/prompts.
- **`client/`** — React 19 + Vite 6 + Tailwind 4 frontend. Three-panel layout (projects, sessions, detail) with config management.

Shared TypeScript strict mode settings in `tsconfig.base.json`. Each package has its own `tsconfig.json`.

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

- `server/src/parser.ts` — Core JSONL parsing. Extracts messages, tool calls, file changes, hooks, permissions, subagents.
- `server/src/watcher.ts` — Chokidar file watcher + in-memory session index. Emits SSE events.
- `server/src/db.ts` — SQLite with better-sqlite3. FTS5 search, tags, prompts.
- `server/src/config.ts` — Read/write for settings.json, .claude.json, CLAUDE.md, hook scripts.
- `server/src/routes.ts` — All API endpoints. `buildApp(watcher, db, claudeDir)`.
- `server/src/pricing.ts` — Model pricing table and cost computation.
- `client/src/App.tsx` — Root component. Manages project/session selection, config mode, compare mode.
- `client/src/components/SessionDetail.tsx` — 7-tab detail view (Conversation, Tools, Files, Costs, Hooks, Agents, Raw Log).
- `client/src/components/config/ConfigPanel.tsx` — 4-tab config editor (Settings, CLAUDE.md, MCP, Hooks).

## Testing

Tests are in `server/test/`. Run with `pnpm test` or `cd server && npx vitest run`.

- `parser.test.ts` — 34 tests covering all JSONL record types, tool extraction, file changes, hooks, permissions, subagents, raw lines
- `watcher.test.ts` — 2 tests for subagent scanning and linking

Test files use relative imports (`../src/parser.js`) which is necessary for NodeNext module resolution. A pre-tool hook blocks relative imports in source files but test files require them.

## Important Notes

- The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in Write/Edit tools for .ts/.tsx files. Use `Bash` with `cat >` or `sed` to write test files that need relative imports.
- Docker mounts `CLAUDE_DIR` as read-only. Config management endpoints write to the host filesystem, not the container — this only works in local dev or with the volume mounted read-write.
- Session status (live/waiting/done) is derived from file mtime, not from the JSONL content.
- The `pnpm-lock.yaml` is at the workspace root. Always run `pnpm install` from the root.
