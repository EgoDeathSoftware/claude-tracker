# Multi-agent tracking: add opencode support

## Context

The tracker currently assumes every configured source is a Claude Code `~/.claude` home directory: it globs `<path>/projects/**/*.jsonl`, parses Claude's specific JSONL record schema, and reads/writes Claude's specific config files (`settings.json`, `.claude.json`, `CLAUDE.md`, `hooks/`). The user wants to track sessions and view configuration from a second AI coding agent, **opencode**, alongside Claude Code — and wants the source-tracking model generalized so a third agent could be added later without another rewrite.

Research into the current codebase found the aggregation layer (`SessionRegistry`, `project-key.ts`) is already agent-agnostic — it operates purely on the common `Session`/`Source` shape. The coupling to Claude Code lives in exactly three places: `sources.ts` (no `kind` field), `source-watcher.ts` (hardcoded `.jsonl`/`projects/` scanning + calls the one parser), and `parser.ts` (Claude's JSONL schema). That's the extension point.

Research into opencode found it stores sessions in a SQLite DB (`~/.local/share/opencode/opencode.db`, Drizzle ORM — confirmed by direct inspection: `project`, `session`, `message`, `part` tables), not JSONL files, and its config lives in `opencode.json` (global at `~/.config/opencode/opencode.json`, project-level overrides, JSONC with `$schema`, `provider`, `mcp`, `agent`, `permission`, `instructions` keys) plus `AGENTS.md`/agent markdown files. The DB schema is an internal, undocumented, already-once-migrated implementation detail, so the parser must degrade gracefully rather than assume permanence.

**Decisions made with the user:**
- Read opencode's SQLite DB directly (read-only, via `better-sqlite3`, already a dependency) rather than shelling out to the `opencode` CLI — mirrors the existing file-watch/poll architecture and doesn't require the opencode binary on the tracker host.
- opencode config support is **read-only** for this plan (view `opencode.json` + agent definitions) — no new write/editing endpoints, matching the literal ask ("read the logs/configuration").

## Architecture

Introduce a `kind` discriminator on `Source` and dispatch to a per-kind watcher, both producing the same `Session` shape `SessionRegistry` already consumes unchanged.

```
Source { id, name, path, kind: 'claude-code' | 'opencode', configPath? }
                    │
        createWatcher(source, db)  ← new factory in registry.ts
           ├─ kind='claude-code' → SourceWatcher (existing, unchanged)
           └─ kind='opencode'    → OpenCodeWatcher (new)
                    │
              both implement the same
              EventEmitter contract:
              start(), stop(), getAllSessions(),
              emits 'session-created' / 'session-updated'
                    │
              SessionRegistry.ingest()  ← unchanged
```

### 1. `server/src/sources.ts` — add `kind`

- Add `export type SourceKind = 'claude-code' | 'opencode';`
- `Source` gains `kind: SourceKind` (defaulted to `'claude-code'` when absent, so existing `sources.json` files and the env-var fallback keep working unmodified) and an optional `configPath?: string` (opencode's config lives under `~/.config/opencode`, a separate XDG dir from the data dir in `path` — no path-string derivation, require it explicit when a caller wants opencode config support).
- Validate `kind` is one of the two known values when present; reject anything else with the same fail-fast error style already used for `id`/`name`/`path`.
- Update `server/config/sources.example.json` with an opencode example:
  ```json
  { "id": "opencode", "name": "OpenCode", "kind": "opencode",
    "path": "/home/YOURUSER/.local/share/opencode",
    "configPath": "/home/YOURUSER/.config/opencode" }
  ```

### 2. `server/src/opencode-parser.ts` (new) — SQLite → `Session`

- Open the DB read-only: `new Database(dbPath, { readonly: true, fileMustExist: true })`.
- Query `session` joined to `project`/`project_directory` for `directory`/`cwd`; query `message` and `part` per session (ordered by `time_created`) to build `messages`, `toolCalls`, `fileChanges`.
- Field mapping to the existing `Session` type (`server/src/types.ts:104-131`) — reuse it as-is, no new agent-specific fields beyond what's below:
  - `id` = `session.id`, `sourceId` = passed in, `projectId` = `deriveProjectKey(session.directory, sourceId, session.project_id)` (reuses the existing agnostic helper in `project-key.ts` unchanged).
  - `cwd` = `session.directory`, `title` = `session.title`, `model` = parsed from `session.model` JSON (`providerID/id`), `costUsd` = `session.cost` (opencode already computes this — no need to extend `pricing.ts` for arbitrary local/self-hosted models).
  - `messages`: one `SessionMessage` per `message` row; `content` built from that message's `part` rows (`type: 'text'` → text, `type: 'tool'` → represented the same way Claude's `tool_use`/`tool_result` blocks are today, so `ToolCallEntry` extraction logic downstream doesn't need to special-case agent kind).
  - `toolCalls`: one `ToolCallEntry` per `part` row with `type: 'tool'`, using `callID` as `toolUseId`, `tool` as `toolName`, `state.input`/`state.output`.
  - `fileChanges`: derived from `tool` parts whose tool name is a known opencode file tool (`read`/`write`/`edit`/`patch` — confirm exact names against a real local DB during implementation, analogous to today's `FILE_TOOLS` map in `parser.ts:175-179`).
  - `hookEvents`/`permissionEvents`: empty arrays — opencode has no equivalent per-session event stream; existing UI empty-states already handle zero-length arrays.
  - `subagents`/`parentSessionId`/`isSubagent`: derived directly from `session.parent_id` — simpler than Claude's heuristic (`source-watcher.ts:118-139` matches on an `'Agent'` tool-call name); opencode gives an explicit FK.
  - `costBreakdown`: `conversationCost`/`totalCost` from `session.cost`; `byTool` call counts only (opencode doesn't attribute cost per tool call) — document this as a known approximation, not a bug.
  - `filePath`: set to the DB file path (there's no per-session file); the raw-log route (below) branches on this instead of tailing it as JSONL.
- Wrap all row parsing in try/catch per session (mirroring `parseAndStore`'s per-file try/catch in `source-watcher.ts:80-100`) — one malformed row must not take down the whole scan, and a schema mismatch (future opencode migration) should log and skip rather than crash the server.

### 3. `server/src/opencode-watcher.ts` (new) — polling watcher

- Same public contract as `SourceWatcher`: `constructor(sourceId, dataDir, db?)`, `start()`, `stop()`, `getAllSessions()`, `EventEmitter` emitting `'session-created'`/`'session-updated'`.
- No filesystem glob to watch (there's no per-session file) — instead poll `opencode.db`'s mtime (and `-wal` file, since WAL-mode writes update that file, not the main DB file) on an interval matching the existing chokidar poll interval (`source-watcher.ts:147`, `interval: 1000`), and on change, query `session` rows with `time_updated > lastPolledAt` to find new/changed sessions to re-parse — avoids re-reading the whole DB every tick.
- `start()`: initial full scan (all sessions), same as `scanExisting`.

### 4. `server/src/registry.ts` — factory dispatch

- Replace the unconditional `new SourceWatcher(...)` at line 23 with a small `createWatcher(source, db)` factory that switches on `source.kind` and returns either a `SourceWatcher` or `OpenCodeWatcher`. Extract a shared `AgentWatcher` interface (constructor excluded, since kind-specific constructors differ) capturing `start`/`stop`/`getAllSessions`/event names, typed against both classes structurally — no other changes needed in `registry.ts`; `ingest`/`getProjects`/`getSessions` already operate on the common `Session` shape.

### 5. Client — surface agent kind

- `client/src/types.ts`: mirror the `Source`/`SourceKind` change.
- `SessionList.tsx`'s existing per-session source badge (`useSources` hook) gains a small icon/label keyed by `source.kind` so opencode vs Claude Code sessions are visually distinguishable in the list — reuse the existing badge component, just add a kind→icon lookup.
- `SessionDetail.tsx`: no structural changes needed — Hooks/Agents tabs already need to handle empty arrays for any session (some Claude sessions have none today), so opencode sessions with empty `hookEvents` will render existing empty states. Raw Log tab's fetch (`/api/sessions/:id/raw`) needs the server-side branch described below.

### 6. Read-only opencode config viewing

- `server/src/opencode-config.ts` (new, mirrors `config.ts`'s read functions only — no `write*` equivalents): `readOpenCodeConfig(configPath)` reads and JSON-parses `<configPath>/opencode.json` (tolerate JSONC comments — reuse or add a minimal comment-stripping step consistent with how `config.ts` already treats malformed reads: return `{}` on failure); `listOpenCodeAgents(configPath)` lists `<configPath>/agents/*.md`.
- `server/src/routes.ts`: find `const primaryOpenCodeSource = sources.find(s => s.kind === 'opencode' && s.configPath)`, add `GET /api/config/opencode` (config JSON) and `GET /api/config/opencode/agents` (agent markdown list), 503 when no such source is configured — same pattern as the existing `primarySource` 503 at `routes.ts:31-35`.
- `server/src/routes.ts`'s `/api/sessions/:id/raw` handler: branch on the session's source kind (look up via `registry.getSources()`) — for `claude-code`, keep calling `readRawLines(session.filePath)` unchanged; for `opencode`, synthesize a pretty-printed JSON transcript from the session's already-parsed `messages`/`toolCalls` (equivalent in shape to what `opencode export` would produce) instead of tailing a file.
- `client/src/components/config/ConfigPanel.tsx`: add a read-only "OpenCode" section (no edit form, just rendered JSON/markdown) shown only when an opencode source with `configPath` is configured — mirrors the existing tab structure but without the save/write wiring the other tabs have.

## Out of scope (explicitly, per YAGNI)

- No plugin/registry architecture for arbitrary future agent kinds — a two-armed `kind` union and one `if`/`switch` is enough for two agents; revisit only when a third is actually added.
- No write/edit support for opencode config.
- No attempt to read opencode's `opencode serve` HTTP API — direct SQLite reads were the chosen approach.
- No per-tool cost attribution for opencode sessions (opencode doesn't track it either).

## Critical files

- `server/src/sources.ts` — add `kind`/`configPath` to `Source`, validation.
- `server/src/opencode-parser.ts` — new, SQLite → `Session` mapping.
- `server/src/opencode-watcher.ts` — new, polling watcher with the `SourceWatcher`-compatible contract.
- `server/src/registry.ts:22-24` — factory dispatch by `source.kind`.
- `server/src/opencode-config.ts` — new, read-only config file readers.
- `server/src/routes.ts:23-37` — new opencode config endpoints, raw-log branch.
- `server/config/sources.example.json` — opencode example entry.
- `client/src/types.ts`, `client/src/components/SessionList.tsx`, `client/src/components/config/ConfigPanel.tsx` — kind badge, read-only config tab.
- `server/test/fixtures/` — new fixture: a small real or hand-built `opencode.db` (or a SQL script that creates one at test setup) exercising `session`/`message`/`part`/`project`/`project_directory` tables, mirroring how `server/test/fixtures/sources/{wsl,windows}` already fixture Claude Code sources.

## Verification

- `pnpm --filter @claude-tracker/server test` — new `opencode-parser.test.ts` (row → `Session` mapping, malformed-row resilience) and `opencode-watcher.test.ts` (polling detects new/changed sessions), plus an extended `sources.test.ts` case for `kind`/`configPath` validation and `registry.test.ts` case confirming the factory dispatches correctly per kind.
- `pnpm typecheck` and `pnpm lint` across both packages.
- Manual end-to-end: point a `sources.json` entry at a real local opencode install (already present on this machine at `~/.local/share/opencode`), run `pnpm dev`, confirm opencode sessions appear in the project/session list with the correct badge, session detail tabs render without errors (including empty Hooks/Agents states and the synthesized Raw Log view), and the read-only OpenCode config tab shows real `opencode.json` content.
