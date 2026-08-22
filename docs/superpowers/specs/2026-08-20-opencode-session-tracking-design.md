# OpenCode session tracking

**Status:** Approved — ready for implementation planning
**Date:** 2026-08-20

## Problem

The tracker currently only understands Claude Code's `~/.claude/projects/**/*.jsonl` session
files. The user wants opencode CLI sessions tracked in the same UI: a left-sidebar checkbox
pair to toggle "Claude Code" / "OpenCode" visibility, opencode projects appearing in the same
project list, and the same 7-tab session detail view (Conversation, Tools, Files, Costs, Hooks,
Agents, Raw Log) for opencode conversations.

This is not starting from zero. A prior planning session already produced
`docs/superpowers/plans/make-a-plan-to-prancy-parasol.md` — a near-complete backend
architecture plan for exactly this — and its first step (a `kind` discriminator on `Source`)
is already merged as commit `74ab98e`. That plan was written from direct inspection of a real
opencode install's SQLite schema. This spec re-verifies that inspection against the same local
install (`~/.local/share/opencode/opencode.db`, opencode 1.18.18, 3 projects / 28 sessions /
real tool-call data) and resolves the one thing it left as "confirm during implementation"
(exact file-op tool names). It also adds the UI-facing requirements the user is now asking for
explicitly — the prior plan covers backend architecture only.

## Goals

- Opencode sessions appear in the same Projects/Sessions/Detail UI as Claude Code sessions,
  merged by project-folder basename exactly like today's WSL/Windows multi-source merging.
- Left sidebar has two checkboxes — "Claude Code" / "OpenCode" — toggling visibility of
  sessions and projects by agent kind. Default: both checked. Only rendered when sources of
  more than one kind are actually configured (mirrors the existing ">1 source ⇒ show badge"
  pattern already in `SessionList.tsx`).
- Each opencode session's detail view has the same 7 tabs, populated from opencode's own data
  (Hooks/Agents render existing empty states, same as Claude sessions that have none today).
- Read-only view of opencode's own config (`opencode.json` + agent defs) as a new tab in the
  existing config panel — view only, no editing.
- No opencode CLI subprocess dependency — read directly from its local SQLite DB, mirroring
  the existing filesystem-watch architecture (`better-sqlite3` is already a server dependency).

## Non-goals

- No write/edit support for opencode config.
- No plugin architecture for N agent kinds — a two-armed `kind` switch is enough; revisit only
  when a third agent is actually added.
- No per-tool cost attribution for opencode sessions (opencode doesn't track that either).
- No `opencode serve` HTTP API integration — direct SQLite reads only.
- No persistence of checkbox filter state across reloads — in-memory React state, consistent
  with existing toggles like `compareMode` in `App.tsx`.

## Confirmed facts about opencode's storage

Verified 2026-08-20 against a live local install (opencode 1.18.18):

- DB: `~/.local/share/opencode/opencode.db` (SQLite, WAL mode, Drizzle-managed — an internal,
  undocumented, already-once-migrated implementation detail; the parser must degrade
  gracefully, not assume permanence).
- Relevant tables (schema confirmed via `.schema` dump):
  - `project(id, worktree, vcs, name, time_created, time_updated, ...)`
  - `session(id, project_id, workspace_id, parent_id, slug, directory, title, version,
    cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
    agent, model [JSON: {id, providerID, variant}], time_created, time_updated, time_archived, ...)`
  - `message(id, session_id, time_created, time_updated, data [JSON])` — `data.role`
    (`user`/`assistant`), `data.time.created`, `data.agent`, `data.model`, `data.cost`,
    `data.tokens`.
  - `part(id, message_id, session_id, time_created, time_updated, data [JSON])` — `data.type`
    ∈ `text | reasoning | tool | patch | step-start | step-finish`. Tool parts:
    `{type:'tool', tool: 'read'|'write'|'edit'|'bash'|…, callID, state:{status, input, output}}`.
  - (`workspace`, `todo`, `session_share`, `account*` — not needed for this feature.)
- **File-op tool names confirmed by live data**: `read`, `write`, `edit` map 1:1 to the
  existing `FileOperation` union (`'read' | 'write' | 'edit'`). `bash` is not a file op.
  `patch` is a distinct **part type** (not a tool call) representing applied diffs/snapshots —
  not needed for `fileChanges` since `write`/`edit` tool parts already carry that info.
- No per-session hook or permission-event stream exists in opencode's schema —
  `hookEvents`/`permissionEvents` will always be `[]` for opencode sessions. Existing UI
  empty-states already handle zero-length arrays (true today for some Claude sessions too).
- `session.parent_id` gives subagent parentage directly via FK — simpler than Claude Code's
  positional `Agent`-tool-call heuristic matching in `source-watcher.ts`.
- Config: global `~/.config/opencode/opencode.json` (JSONC, tolerate comments) + optional
  project-level overrides; agent defs as markdown files under the config dir.

## UI requirements

Net-new — not covered by the prior architecture plan (`make-a-plan-to-prancy-parasol.md`),
which addressed backend architecture only.

1. **Sidebar checkboxes.** Rendered in `ProjectList.tsx`'s header area, below the existing
   "N projects" line. Two checkboxes labeled by `SourceKind`: "Claude Code" / "OpenCode".
   State lives in `App.tsx` as `enabledKinds: Set<SourceKind>` (default: every kind present
   across configured sources), passed down to `ProjectList` and used to build the `kinds`
   query param for the data-fetching hooks.
2. **Filtering semantics.** Unchecking a kind hides: (a) sessions of that kind everywhere in
   the session list, (b) projects that would have zero visible sessions once filtered. A
   project with sessions from both kinds stays visible with only the enabled kind's sessions
   counted/shown.
3. **Server-side filtering** via an optional `kinds` query param (comma-separated, e.g.
   `?kinds=claude-code`) on `GET /api/projects` and `GET /api/sessions`, mirroring the existing
   `tag` param pattern already in `routes.ts`. Filtering server-side keeps project session
   counts and the "N projects" header correct without duplicating aggregation logic
   client-side.
4. **Per-session kind badge.** Extend the existing per-session source badge in
   `SessionList.tsx` (today: name-only text, shown when `sources.length > 1`) with a
   kind-keyed icon/style so Claude Code vs OpenCode sessions are visually distinguishable even
   when both checkboxes are checked.
5. **Session detail tabs.** No structural change — all 7 tabs already render correctly on
   empty arrays. Only the Raw Log tab's *data source* branches server-side by kind (below).
6. **Config panel.** Add a fifth, read-only "OpenCode" tab to `ConfigPanel.tsx`'s existing tab
   bar, shown only when an opencode source with `configPath` is configured. Renders
   `opencode.json` and the agent markdown list read-only — no save wiring, unlike the other
   four tabs.

## Data model changes

- `client/src/hooks/useSources.ts`: its local `Source` interface is currently stale (missing
  `kind`/`configPath` that `server/src/sources.ts` already has as of `74ab98e`) — add
  `kind: 'claude-code' | 'opencode'` and `configPath?: string`.
- No changes to `Session`/`Project` in `types.ts` — the opencode parser produces the exact same
  `Session` shape `SessionRegistry` already consumes.

## API changes

- `GET /api/projects?kinds=claude-code,opencode` — optional filter (default: all kinds).
- `GET /api/sessions?projectId=&kinds=` — optional filter, same pattern as the existing `tag`.
- `GET /api/sessions/:id/raw` — branches by the session's source kind (looked up via
  `registry.getSources()`): Claude Code keeps tailing the JSONL file via `readRawLines`
  unchanged; opencode synthesizes a pretty-printed JSON transcript from the already-parsed
  session's `messages`/`toolCalls` (no per-session file exists to tail).
- New read-only endpoints: `GET /api/config/opencode` (parsed `opencode.json`),
  `GET /api/config/opencode/agents` (agent markdown list) — 503 when no opencode source with
  `configPath` is configured, mirroring the existing `primarySource` 503 gate at
  `routes.ts:212-220`.

## Backend architecture

From the prior plan (`make-a-plan-to-prancy-parasol.md`), re-verified against the live schema,
still unimplemented beyond `Source.kind` itself:

- `createWatcher(source, db)` factory in `registry.ts`, replacing the unconditional
  `new SourceWatcher(...)` at `registry.ts:22-24`. Dispatches on `source.kind`:
  `'claude-code'` → existing `SourceWatcher` (unchanged), `'opencode'` → new
  `OpenCodeWatcher`. Both implement the same structural contract
  (`start()/stop()/getAllSessions()` + `EventEmitter` emitting `'session-created'` /
  `'session-updated'`) — `SessionRegistry` needs zero other changes, since `ingest`/
  `getProjects`/`getSessions` already operate purely on the common `Session`/`Source` shape.
- `server/src/opencode-parser.ts` (new): opens the DB read-only
  (`new Database(dbPath, { readonly: true, fileMustExist: true })`), maps `session` +
  `message` + `part` rows to a `Session`:
  - `id` = `session.id`, `sourceId` = passed in, `projectId` =
    `deriveProjectKey(session.directory, sourceId, session.project_id)` (reuses
    `project-key.ts` unchanged).
  - `cwd` = `session.directory`, `title` = `session.title`, `model` = `` `${providerID}/${id}` ``
    parsed from `session.model` JSON, `costUsd` = `session.cost` (opencode already computes
    this — no `pricing.ts` changes needed).
  - `messages`: one `SessionMessage` per `message` row; `content` built from that message's
    ordered `part` rows (`text` parts → text blocks; `tool` parts → the same `tool_use`/
    `tool_result`-shaped `ContentBlock` representation Claude sessions already use, so
    downstream `ToolCallEntry`/`FileChangeEntry` extraction doesn't need a kind branch).
  - `toolCalls`: one `ToolCallEntry` per `tool`-type `part`, using `callID` → `toolUseId`,
    `tool` → `toolName`, `state.input`/`state.output`.
  - `fileChanges`: derived from `tool` parts whose `tool` is `read`/`write`/`edit` (confirmed
    names, see above) via a `FILE_TOOLS`-style map, same shape as `parser.ts:175-179`.
  - `hookEvents`/`permissionEvents`: always `[]`.
  - `subagents`/`parentSessionId`/`isSubagent`: derived directly from `session.parent_id`.
  - `costBreakdown`: `conversationCost`/`totalCost` from `session.cost`; `byTool` call counts
    only (no per-tool cost attribution — documented non-goal, not a bug).
  - `filePath`: set to the DB file path; the raw-log route branches on kind rather than tailing
    it as JSONL.
  - Wrap per-session row parsing in try/catch (mirrors `parseAndStore`'s per-file try/catch in
    `source-watcher.ts:80-100`) so one malformed row/session doesn't take down the whole scan.
- `server/src/opencode-watcher.ts` (new): same public contract as `SourceWatcher`. No
  filesystem glob (no per-session file) — instead polls `opencode.db`'s mtime **and** its
  `-wal` file's mtime (WAL-mode writes update that file, not the main one) on the same 1s
  interval as the existing chokidar config (`source-watcher.ts:147`), and on change queries
  `session` rows with `time_updated > lastPolledAt` to find new/changed sessions to re-parse.
  `start()` does an initial full scan (all sessions), same shape as `scanExisting`.

## Error handling

- opencode DB missing/unreadable at startup → same "skip unreachable source" warning path
  already in `loadSources`/`registry.start` (via `Promise.allSettled`), no code change needed
  there.
- Malformed `message`/`part` JSON row → log + skip that session, don't crash the watcher.
- `configPath` missing for an opencode source → new config endpoints 503, same pattern as
  no-primary-source today (`routes.ts:212-220`).

## Testing

- `opencode-parser.test.ts` (new): row→`Session` mapping using a hand-built temp SQLite DB
  seeded via `better-sqlite3` in test setup (exercising `session`/`message`/`part`/`project`
  tables); malformed-row resilience; file-op tool mapping (`read`/`write`/`edit`); subagent
  linking via `parent_id`.
- `opencode-watcher.test.ts` (new): polling detects new/changed sessions via `time_updated`.
- `sources.test.ts`: `kind`/`configPath` validation already covered (done, merged).
- `registry.test.ts`: new case confirming the factory dispatches `OpenCodeWatcher` for
  `kind: 'opencode'` sources, plus new cases for `kinds`-filtered `getProjects`/`getSessions`.
- Route-level tests (extend existing coverage or add `routes.test.ts` if none exists — verify
  during implementation): `kinds` query param filtering on `/api/projects` and
  `/api/sessions`; raw-log kind branch; opencode config 503/200 paths.
- Client: this codebase has no client test suite today (confirmed — `CLAUDE.md`'s Testing
  section lists only `server/test/`); verify the checkbox filtering and config tab manually.

## Manual verification

Point a `sources.json` entry at the real local opencode install already present on this host
(`~/.local/share/opencode`, confirmed non-trivial real data: 3 projects, 28 sessions, actual
tool calls including `read`/`write`/`edit`/`bash`), run `pnpm dev`, confirm:
- Opencode sessions appear in the project/session list with a distinct kind badge.
- Unchecking "OpenCode" hides opencode sessions and any project that only has opencode
  sessions; unchecking "Claude Code" does the inverse; re-checking restores them.
- Session detail tabs render without errors for a real opencode session, including empty
  Hooks/Agents states and the synthesized Raw Log view.
- The read-only OpenCode config tab shows real `opencode.json` content.
- `pnpm --filter @claude-tracker/server test`, `pnpm typecheck`, `pnpm lint` all pass.

## Out of scope for this spec

- Hot-reloading `sources.json` for newly added opencode sources (existing restart-required
  behavior carries over unchanged).
- Write/edit support for opencode config.
- A UI for adding/removing sources.
- Per-tool cost attribution for opencode.
- A plugin/registry architecture for more than two agent kinds.
