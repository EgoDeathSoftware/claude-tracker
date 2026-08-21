# Task: `server/src/opencode-watcher.ts` — polling watcher for opencode sessions

## Spec

This repo tracks Claude Code sessions parsed from JSONL files. We are adding support for
tracking **opencode** CLI sessions, which live in a SQLite database instead.

Task 2 (already complete, do NOT modify) added `server/src/opencode-parser.ts`, which exports:

```ts
export async function listOpenCodeSessions(dbPath: string, sourceId: string): Promise<Session[]>
```

Your job is Task 3: a polling watcher that mirrors the existing `SourceWatcher` contract, but
polls a SQLite file instead of using chokidar on JSONL files.

Create `server/src/opencode-watcher.ts` exporting:

```ts
export class OpenCodeWatcher extends EventEmitter {
  constructor(
    public readonly sourceId: string,
    private readonly dataDir: string, // e.g. ~/.local/share/opencode
    db?: TrackerDB,
  )
  async start(): Promise<void>   // initial full scan, then begin polling
  async stop(): Promise<void>    // clear the poll interval
  getAllSessions(): Session[]
  async pollOnce(): Promise<void> // one poll cycle; used by the timer AND by tests
}
```

Behaviour:

- `dbPath = join(dataDir, 'opencode.db')`.
- `start()` does an initial full scan via `listOpenCodeSessions(dbPath, this.sourceId)`,
  populates an in-memory `Map<string, Session>` keyed by session `id`, indexes each
  non-subagent session into the DB (`this.db?.indexSession(session)` — only when `db` was
  provided and `!session.isSubagent`), then runs the subagent-linking pass, then starts a
  `setInterval` calling `pollOnce()` every **1000ms**.
- `pollOnce()` checks the mtimes of BOTH `dbPath` and `${dbPath}-wal` via `fs/promises` `stat`.
  Checking both matters: opencode runs SQLite in WAL mode, so writes touch the `-wal` file and
  may not touch the main DB file until a checkpoint. Either file missing is not an error — a
  missing `-wal` file just means no WAL exists yet; treat it as "no mtime". If neither file's
  mtime has advanced since the last observed value, return without re-reading the DB.
- On a detected mtime change, re-run `listOpenCodeSessions(dbPath, this.sourceId)` and diff
  against the in-memory map:
  - id not present in the map -> store it, index it (non-subagent only), emit
    `'session-created'` with the session as the sole argument.
  - id present but `lastActivityAt` differs from the stored session's -> store it, index it,
    emit `'session-updated'` with the session as the sole argument.
  - Otherwise no event.
  After processing, if any newly-seen/changed session is a subagent, re-run the linking pass.
- Subagent linking mirrors `SourceWatcher.linkSubagents()` (see `server/src/source-watcher.ts`,
  around line 102): group sessions that have `isSubagent && parentSessionId` by their
  `parentSessionId`, then attach them to the matching parent session's `subagents` array.
  `opencode-parser.ts` intentionally leaves `subagents: []` on parents, so this pass is what
  populates it.
- `stop()` clears the interval (and is safe to call when never started).
- Errors from `listOpenCodeSessions` (e.g. DB temporarily locked or missing) must be caught and
  logged via `console.error` with a `[opencode-watcher:${this.sourceId}]` prefix, matching the
  logging style in `source-watcher.ts` — the watcher must not crash the process or leave a
  rejected promise from the interval callback.

**Read `server/src/source-watcher.ts` first** and mirror its structure closely: constructor
shape, the private `parseAndStore`-style indexing, `linkSubagents()`, event emission, and
`getAllSessions()`. This new class is deliberately a parallel implementation of the same
contract.

## Tests (write these FIRST — TDD)

Create `server/test/opencode-watcher.test.ts`. Use `better-sqlite3` directly to seed a temp
SQLite DB (write it under a temp dir created with `fs.mkdtemp`, named `opencode.db`, and clean
it up in an `afterEach`/`afterAll`). Look at `server/test/opencode-parser.test.ts` for the exact
schema shape the parser expects and reuse that seeding approach rather than inventing a new one.

Required cases:

1. **Initial scan** — seed one session row, `await watcher.start()`, assert `getAllSessions()`
   returns that one session with the expected `id`.
2. **New session detected** — insert a second session row directly into the DB, then
   `await watcher.pollOnce()`, and assert a `'session-created'` event fired carrying the new
   session. (Use `pollOnce()` explicitly — do NOT write a test that sleeps waiting on the real
   1000ms timer; that is slow and flaky.)
3. **Updated session detected** — update an existing row's `time_updated` and `title`, then
   `await watcher.pollOnce()`, and assert a `'session-updated'` event fired for that session.

Note: because `pollOnce()` gates on mtime, the test must ensure the mtime actually advances
between polls. Filesystem mtime granularity can make two writes within the same millisecond
look identical — if that causes flakiness, explicitly bump the file mtime (e.g. `fs.utimes`)
after seeding rather than adding a sleep.

Always `await watcher.stop()` in teardown so vitest does not hang on an open interval.

## Acceptance criteria

- `server/test/opencode-watcher.test.ts` exists and covers all three cases above.
- `cd server && npx vitest run test/opencode-watcher.test.ts` passes.
- `pnpm --filter @claude-tracker/server test` passes — the WHOLE suite, no regressions.
- `cd server && npx tsc --noEmit` passes with zero errors.
- `pnpm lint` passes with **zero** warnings. This repo has a strict zero-warnings policy:
  unused variables, unused imports, dead code, and unreachable branches are all failures even
  if the tests pass. Delete anything you wrote and then stopped using.

## Files in scope

- Create: `server/src/opencode-watcher.ts`
- Create: `server/test/opencode-watcher.test.ts`

## Files out of scope (read for reference only — do NOT modify)

- `server/src/source-watcher.ts` — the pattern to mirror
- `server/src/opencode-parser.ts` — Task 2's output, a finished, verified dependency
- `server/src/types.ts` — `Session` type
- `server/src/db.ts` — `TrackerDB` / `indexSession`
- `server/test/opencode-parser.test.ts` — reference for DB seeding
- `server/src/registry.ts`, `server/src/routes.ts`, `server/src/sources.ts` — later tasks own these
- Anything under `client/`

## Conventions

Follow `/workspace/CLAUDE.md` (repo root) for all project conventions. The ones most likely to
bite you here:

- TypeScript strict mode with `exactOptionalPropertyTypes` — optional props must be declared
  `foo?: T | undefined`.
- `verbatimModuleSyntax` — type-only imports MUST use `import type { ... }`.
- `noUncheckedIndexedAccess` — indexing an array/record yields `T | undefined`; handle it, do
  not cast it away.
- Server imports use `.js` extensions (NodeNext resolution): `import { listOpenCodeSessions }
  from './opencode-parser.js'`.
- Test files use relative imports (`../src/opencode-watcher.js`) — that is correct and expected
  for tests.
- Do not use `any` or unchecked `as` casts to silence the type checker.
