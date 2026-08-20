# Task: `server/src/opencode-parser.ts` — opencode SQLite → `Session`

## Context

This repo is a Claude Code session tracker (Hono server + React client). It is gaining
support for tracking **opencode CLI** agent sessions alongside Claude Code sessions.
opencode stores its sessions in its own SQLite database rather than JSONL files, so this
task adds a parser that reads that SQLite DB and produces the same `Session` objects the
rest of the app already consumes.

**Read these first — they contain the authoritative spec:**

1. `docs/superpowers/plans/2026-08-20-opencode-session-tracking.md`, section
   **"### Task 2: `server/src/opencode-parser.ts` — SQLite → `Session`"**. This is your
   spec. It contains the exact confirmed SQLite schema for the four tables you read
   (`project`, `session`, `message`, `part`), the confirmed tool-name → file-op mapping,
   the exact test scenarios to write, and the field-by-field mapping from SQLite rows to
   the `Session` type. Follow it precisely.
2. `/workspace/CLAUDE.md` — full repo conventions (TypeScript strict settings, file
   layout, testing patterns). Do not restate it; follow it.

A prerequisite task (`Source.kind` discriminator in `server/src/sources.ts`) is already
merged. Do not redo it.

## Spec

Create `server/src/opencode-parser.ts` exporting:

```ts
export async function listOpenCodeSessions(
  dbPath: string,
  sourceId: string,
): Promise<Session[]>
```

Behaviour, per the plan section named above:

- Open the DB **read-only** with `better-sqlite3` (already a server dependency):
  `new Database(dbPath, { readonly: true, fileMustExist: true })`.
- Query all `session` rows. For each row, build one `Session`.
- `projectId` = `deriveProjectKey(session.directory, sourceId, session.project_id)`,
  imported unchanged from `./project-key.js`.
- Load that session's `message` rows ordered by `time_created`; for each, its `part` rows
  ordered by `time_created`. Build `SessionMessage[]`: `content` from `text` parts;
  `tool` parts represented as `ContentBlock`s of `type: 'tool_use'` / `'tool_result'`,
  matching the shape the client already renders for Claude sessions.
- `toolCalls: ToolCallEntry[]` from every `tool`-type part across all messages, with
  `toolUseId` / `toolName` / `input` / `output` populated from `callID` / `tool` /
  `state.input` / `state.output`.
- `fileChanges: FileChangeEntry[]` via a local `FILE_TOOLS` map
  `{ read: 'read', write: 'write', edit: 'edit' }` — same shape as the `FILE_TOOLS` map in
  `server/src/parser.ts`. Tool parts whose `tool` is not a key of that map (notably `bash`
  and `patch`) are **excluded** from `fileChanges`.
- `hookEvents: []`, `permissionEvents: []`, `recaps: []`, `subagents: []`.
  **Do not implement subagent linking here** — a later task's watcher handles it.
- `parentSessionId = session.parent_id ?? undefined`;
  `isSubagent = session.parent_id != null`.
- `costUsd` = the session row's `cost` column.
- `costBreakdown` = `{ byTool: <call counts per toolName, cost: 0>, conversationCost:
  session.cost, toolCost: 0, totalCost: session.cost }`.
- `filePath` = `dbPath`.
- `model` = `` `${parsed.providerID}/${parsed.id}` `` parsed from the `session.model` JSON
  column.
- `status` = the same `live` / `waiting` / `done` derivation `server/src/parser.ts` uses,
  but based on `session.time_updated` instead of file mtime (there is no per-session file
  to stat).

**Resilience:** wrap per-session parsing in try/catch. A malformed row (e.g. `JSON.parse`
throws on `message.data` or `part.data`, or the session row is otherwise unusable) must
log via `console.error` and skip **only that session** — it must not crash the scan or
throw out of `listOpenCodeSessions`. This mirrors the existing per-file try/catch pattern
in `server/src/parser.ts`.

## Approach: TDD (required)

1. Write `server/test/opencode-parser.test.ts` **first**, per the plan's Step 1.
2. Run `cd server && npx vitest run test/opencode-parser.test.ts` and confirm it FAILS
   (module not found).
3. Implement `server/src/opencode-parser.ts`.
4. Re-run and confirm it PASSES.

The test seeds a temp SQLite DB (via `better-sqlite3`) using the schema from the plan, with
one `project` row, two `session` rows (a parent and a child whose `parent_id` points at the
parent), and `message`/`part` rows covering: a `text` part, `tool` parts for `read`,
`write`, `edit`, and `bash`, plus one `message`/`part` pair with malformed JSON in
`part.data`.

You may either inline the `CREATE TABLE` strings in the test file or put them in
`server/test/fixtures/opencode/schema.sql` — pick whichever reads better.

## Acceptance criteria

- `server/test/opencode-parser.test.ts` exists and asserts:
  - `listOpenCodeSessions(dbPath, sourceId)` returns the expected `Session[]` shape — one
    per `session` row, including the child tagged `isSubagent: true`.
  - `fileChanges` contains exactly the `read` / `write` / `edit` ops, correctly typed,
    with `bash` absent.
  - `toolCalls` contains all 4 tool parts (including `bash`), with `toolUseId`,
    `toolName`, `input`, `output` populated.
  - `costUsd` equals the session row's `cost` column.
  - `hookEvents` and `permissionEvents` are both `[]`.
  - The child session's `parentSessionId` equals the parent's `id` and `isSubagent` is
    `true`.
  - The malformed row does not throw: that session is skipped, other sessions still parse.
- `cd server && npx vitest run test/opencode-parser.test.ts` passes.
- `cd server && npx tsc --noEmit` passes with zero errors.
- `pnpm lint` passes with zero warnings.
- The full server suite (`pnpm --filter @claude-tracker/server test`) still passes — no
  regressions in existing tests.

## Files in scope

Create only these two files:

- `server/src/opencode-parser.ts`
- `server/test/opencode-parser.test.ts`
- (optional) `server/test/fixtures/opencode/schema.sql`

Read for reference, **do not modify**:

- `server/src/parser.ts` — the equivalent parser for Claude Code sessions. Mirror its
  `FILE_TOOLS` map, status derivation, and per-item try/catch patterns.
- `server/src/project-key.ts` — `deriveProjectKey`.
- `server/src/types.ts` — the `Session` / `SessionMessage` / `ToolCallEntry` /
  `FileChangeEntry` / `ContentBlock` types this parser must produce.

## Files out of scope — do not touch

- `server/src/sources.ts` (already complete)
- `server/src/registry.ts`, `server/src/source-watcher.ts`, `server/src/routes.ts` —
  later tasks depend on these staying unchanged for now
- `server/src/opencode-watcher.ts` — that is a later task; **do not create it**
- Anything under `client/`

## Conventions

Follow `/workspace/CLAUDE.md`. Points that most often trip up this repo:

- TypeScript strict mode with `exactOptionalPropertyTypes` — optional props must include
  `| undefined` (e.g. `foo?: string | undefined`).
- `verbatimModuleSyntax` — use `import type` for type-only imports.
- `noUncheckedIndexedAccess` — index access returns `T | undefined`.
- Server source imports use `.js` extensions (NodeNext resolution).
- Test files use **relative** imports (`../src/opencode-parser.ts`) — required for
  NodeNext, and consistent with every existing file in `server/test/`.
