# OpenCode session tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track and view opencode CLI agent sessions in the same UI Claude Code sessions use
today — unified project list, session list, 7-tab session detail — with left-sidebar checkboxes
to toggle visibility of each agent kind ("Claude Code" / "OpenCode").

**Architecture:** `SessionRegistry` gains a `createWatcher(source, db)` factory that dispatches
on the already-merged `Source.kind` discriminator: `'claude-code'` → the existing
`SourceWatcher` (unchanged), `'opencode'` → a new `OpenCodeWatcher` that polls opencode's own
SQLite DB (`~/.local/share/opencode/opencode.db`) instead of watching JSONL files. Both
watchers produce the same `Session` shape, so the aggregation layer (`ingest`, `getProjects`,
`getSessions`) needs only a `kinds` filter parameter added, not a rewrite. The client adds a
`enabledKinds` filter, threaded through as a `kinds` query param, plus a kind-aware badge and a
read-only opencode config tab.

**Tech Stack:** Node 22, TypeScript (NodeNext), Hono 4, chokidar, better-sqlite3, Vitest, React
19.

**Spec:** `docs/superpowers/specs/2026-08-20-opencode-session-tracking-design.md`

**Prior art:** `docs/superpowers/plans/make-a-plan-to-prancy-parasol.md` — backend-architecture
research this plan builds on. Its Task 1 (`Source.kind` discriminator) is already merged as
commit `74ab98e`; this plan's Task 1 below documents that as done and picks up from there,
folding in the UI requirements (checkboxes, `kinds` filtering, config tab) that prior plan did
not cover.

---

### Task 1: `Source.kind` discriminator — already done

**Files:** `server/src/sources.ts`, `server/config/sources.example.json`,
`server/test/sources.test.ts` — all merged in commit `74ab98e`.

- [x] `SourceKind = 'claude-code' | 'opencode'` exported from `sources.ts`.
- [x] `Source.kind` (defaults to `'claude-code'` when absent) and `Source.configPath?` added,
      with validation.
- [x] `sources.example.json` has a worked opencode entry.
- [x] Tests cover `kind`/`configPath` validation, including the invalid-kind rejection path.

No action needed. Verify before starting Task 2:

Run: `cd server && npx vitest run test/sources.test.ts`
Expected: all tests PASS (already true on `master`).

---

### Task 2: `server/src/opencode-parser.ts` — SQLite → `Session`

**Files:**
- Create: `server/src/opencode-parser.ts`
- Test: `server/test/opencode-parser.test.ts`
- Test fixture helper: `server/test/fixtures/opencode/schema.sql` (or inline `CREATE TABLE`
  strings in the test file — decide during implementation based on readability)

Confirmed live schema (captured 2026-08-20 from `~/.local/share/opencode/opencode.db`,
opencode 1.18.18) for the four tables this parser reads:

```sql
CREATE TABLE project (
  id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text,
  time_created integer NOT NULL, time_updated integer NOT NULL
  -- (other columns exist; not needed here)
);

CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
  directory text NOT NULL, title text NOT NULL,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  agent text, model text, -- model is a JSON string: {"id","providerID","variant"}
  time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer
);

CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  data text NOT NULL -- JSON: {role, time, agent, model, cost, tokens, ...}
);

CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  data text NOT NULL
  -- JSON: {type: 'text'|'reasoning'|'tool'|'patch'|'step-start'|'step-finish', ...}
  -- tool parts: {type:'tool', tool, callID, state:{status, input, output}}
);
```

Confirmed tool names for `fileChanges` mapping (live data, 37 tool parts sampled):
`read` → `'read'`, `write` → `'write'`, `edit` → `'edit'`. `bash` and `patch` are not file ops
and must be excluded from `fileChanges`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/opencode-parser.test.ts`. Seed a temp SQLite DB (via `better-sqlite3`,
already a server dependency) with the schema above, insert one `project`, two `session` rows
(one parent, one child with `parent_id` set to the parent — to exercise subagent linking), and
`message`/`part` rows covering: a `text` part, a `tool` part with `tool: 'read'`, a `tool` part
with `tool: 'write'`, a `tool` part with `tool: 'edit'`, and a `tool` part with `tool: 'bash'`
(to confirm it's excluded from `fileChanges`). Also seed one `message`/`part` pair with
malformed JSON in `part.data` to test row-level resilience.

Assertions:
- `listOpenCodeSessions(dbPath, sourceId)` returns one `Session` per non-subagent `session` row
  (plus the child, tagged `isSubagent: true`).
- `fileChanges` contains exactly the `read`/`write`/`edit` ops, correctly typed, `bash` absent.
- `toolCalls` contains all 4 tool parts (including `bash`) with `toolUseId`/`toolName`/`input`/
  `output` populated from `callID`/`tool`/`state.input`/`state.output`.
- `costUsd` equals the session row's `cost` column.
- `hookEvents` and `permissionEvents` are both `[]`.
- The child session's `parentSessionId` equals the parent's `id` and `isSubagent` is `true`.
- The malformed row doesn't throw — that session is skipped with a logged warning, other
  sessions still parse.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/opencode-parser.test.ts`
Expected: FAIL — module `../src/opencode-parser.ts` not found.

- [ ] **Step 3: Implement `opencode-parser.ts`**

Entry point mirroring `parser.ts`'s `parseSession`:

```ts
export async function listOpenCodeSessions(
  dbPath: string,
  sourceId: string,
): Promise<Session[]>
```

Opens `new Database(dbPath, { readonly: true, fileMustExist: true })`, queries all `session`
rows, and for each row (wrapped in try/catch per session):
- Resolves `projectId` via `deriveProjectKey(session.directory, sourceId, session.project_id)`
  (import from `./project-key.js`, unchanged).
- Loads that session's `message` rows ordered by `time_created`, and for each message its
  `part` rows ordered by `time_created`, building `SessionMessage[]` (`content` from `text`
  parts; `tool` parts represented as `ContentBlock`s of `type: 'tool_use'`/`'tool_result'` to
  match the shape `ConversationThread.tsx` already renders for Claude sessions).
- Builds `toolCalls: ToolCallEntry[]` from every `tool`-type part across all messages.
- Builds `fileChanges: FileChangeEntry[]` via a local `FILE_TOOLS` map
  (`{ read: 'read', write: 'write', edit: 'edit' }`, same shape as `parser.ts:175-179`),
  skipping tool parts whose `tool` isn't a key of that map.
- Sets `hookEvents: []`, `permissionEvents: []`, `recaps: []`.
- Sets `parentSessionId = session.parent_id ?? undefined`, `isSubagent = session.parent_id !=
  null`. (`subagents: []` here — populated later by `OpenCodeWatcher`, mirroring how
  `SourceWatcher.linkSubagents()` populates it for Claude sessions, so the linking logic stays
  in one place per kind rather than duplicated inside the parser.)
- `costBreakdown`: `{ byTool: <call counts per toolName, cost: 0>, conversationCost:
  session.cost, toolCost: 0, totalCost: session.cost }`.
- `filePath` = `dbPath` (not a per-session file; documents where this session's data actually
  lives, consumed by the raw-log route's kind branch in Task 7).
- `model` = `` `${parsed.providerID}/${parsed.id}` `` from the `session.model` JSON column.
- `status` = same `live`/`waiting`/`done` derivation as `parser.ts`, but based on
  `session.time_updated` instead of file mtime (no file to stat).

A malformed row (JSON.parse throws on `message.data`/`part.data`, or the session row is
otherwise unusable) is caught per-session: log via `console.error` and `continue` to the next
session, matching `parseAndStore`'s existing per-file try/catch pattern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/opencode-parser.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/opencode-parser.ts server/test/opencode-parser.test.ts
git commit -m "feat(server): add opencode SQLite session parser"
```

---

### Task 3: `server/src/opencode-watcher.ts` — polling watcher

**Files:**
- Create: `server/src/opencode-watcher.ts`
- Test: `server/test/opencode-watcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/test/opencode-watcher.test.ts`. Seed a temp SQLite DB with one session, start an
`OpenCodeWatcher`, assert `getAllSessions()` returns it. Then insert a new session row directly
into the DB (simulating opencode writing to it), tick the watcher's poll (either wait past its
interval or expose a `pollOnce()` method for deterministic testing — prefer the latter to avoid
a slow/flaky timer-based test), and assert a `'session-created'` event fires with the new
session. Update an existing session's `time_updated` + `title`, poll again, assert
`'session-updated'` fires.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/opencode-watcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `opencode-watcher.ts`**

Same public contract as `SourceWatcher`:

```ts
export class OpenCodeWatcher extends EventEmitter {
  constructor(
    public readonly sourceId: string,
    private readonly dataDir: string, // Source.path, e.g. ~/.local/share/opencode
    db?: TrackerDB,
  )
  async start(): Promise<void>   // initial full scan via listOpenCodeSessions, then begin polling
  async stop(): Promise<void>    // clear the poll interval
  getAllSessions(): Session[]
}
```

- `dbPath = join(dataDir, 'opencode.db')`.
- Poll every 1000ms (matches `source-watcher.ts:147`'s chokidar interval) checking both
  `dbPath` and `${dbPath}-wal` mtimes via `stat` — WAL-mode writes touch the `-wal` file, not
  the main DB file, so both must be checked or updates are missed between checkpoints.
- On a detected change, re-run `listOpenCodeSessions(dbPath, sourceId)`, diff against the
  in-memory `Map<string, Session>` by `id` + `lastActivityAt`, emit `'session-created'` for new
  ids and `'session-updated'` for changed ones (same emit contract as
  `source-watcher.ts:152-158`).
- Index into `db.indexSession(session)` for non-subagent sessions on both initial scan and
  updates, same as `SourceWatcher.parseAndStore`.
- After the initial scan, run the same subagent-linking pass `SourceWatcher.linkSubagents()`
  does (matching children by `parentSessionId`), since `opencode-parser.ts` intentionally
  leaves `subagents: []` on the parent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/opencode-watcher.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/opencode-watcher.ts server/test/opencode-watcher.test.ts
git commit -m "feat(server): add polling watcher for opencode SQLite sessions"
```

---

### Task 4: `registry.ts` — factory dispatch by kind

**Files:**
- Modify: `server/src/registry.ts`
- Modify: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `registry.test.ts`: a case building a temp opencode-schema DB (reuse the seeding helper
from `opencode-parser.test.ts` if practical — consider extracting a shared test helper into
`server/test/fixtures/opencode/seed.ts` if both tests need it, per YAGNI only if duplication is
actually painful), constructing a `Source` with `kind: 'opencode', path: <tempDir>`, starting a
`SessionRegistry` with both a claude-code source and this opencode source, and asserting:
- Sessions from both watchers appear in `registry.getSessions()`.
- When both sources' sessions share a project basename, they merge into one `Project` with
  `sources: [<both ids>]` (proves the aggregation layer really is kind-agnostic).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: FAIL — registry still only constructs `SourceWatcher`, opencode source produces no
sessions.

- [ ] **Step 3: Implement the factory**

In `registry.ts`, add a structural interface capturing the shared contract (both `SourceWatcher`
and `OpenCodeWatcher` already satisfy this without modification):

```ts
interface AgentWatcher extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAllSessions(): Session[];
}

function createWatcher(source: Source, db?: TrackerDB): AgentWatcher {
  switch (source.kind) {
    case 'claude-code':
      return new SourceWatcher(source.id, source.path, db);
    case 'opencode':
      return new OpenCodeWatcher(source.id, source.path, db);
  }
}
```

Replace `registry.ts:22-24`'s unconditional `new SourceWatcher(...)` with:

```ts
this.watchers = this.sources.map(s => createWatcher(s, this.db ?? undefined));
```

Change `private watchers: SourceWatcher[]` to `private watchers: AgentWatcher[]`. Add the
`OpenCodeWatcher` import. No other change needed — `ingest`, `getProjects`, `getSessions`
already operate purely on `Session`/`Source`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: all tests PASS, including the new one.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.ts
git commit -m "feat(server): dispatch watcher construction by source kind"
```

---

### Task 5: `kinds` filtering — registry + routes

**Files:**
- Modify: `server/src/registry.ts` (`getProjects`, `getSessions`)
- Modify: `server/src/routes.ts` (`GET /api/projects`, `GET /api/sessions`)
- Modify: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add cases to `registry.test.ts`: with a registry containing both a claude-code and an opencode
source (reuse Task 4's setup), assert `getProjects(['claude-code'])` excludes opencode-only
projects and reduces `sessionCount` on mixed projects; assert `getSessions(undefined,
['opencode'])` returns only opencode sessions; assert omitting the `kinds` argument (or passing
`undefined`) returns everything, unchanged from today's behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: FAIL — `getProjects`/`getSessions` don't accept a second/first-optional `kinds` arg
yet (TS compile error or silently ignored depending on how the test is written — write it so it
fails on behavior, not just types).

- [ ] **Step 3: Implement filtering**

In `registry.ts`, build a `sourceId → kind` lookup once (either as a private field set in the
constructor, or computed inline — prefer a private `Map<string, SourceKind>` built in the
constructor since `this.sources` doesn't change after construction):

```ts
private kindBySourceId = new Map(this.sources.map(s => [s.id, s.kind]));
```

Change signatures:

```ts
getProjects(kinds?: SourceKind[]): Project[]
getSessions(projectId?: string, kinds?: SourceKind[]): Session[]
```

In both, filter the working session set before aggregation:

```ts
const allowedKinds = kinds ? new Set(kinds) : null;
// ...
.filter(s => !allowedKinds || allowedKinds.has(this.kindBySourceId.get(s.sourceId)!))
```

Add this filter alongside the existing `!session.isSubagent` filter in `getProjects`, and
alongside the existing `!s.isSubagent` filter in `getSessions`, before the `projectId` filter.

In `routes.ts`, both `/api/projects` and `/api/sessions` handlers parse an optional `kinds`
query param the same way the existing `tag` param is parsed:

```ts
const kindsParam = c.req.query('kinds');
const kinds = kindsParam
  ? kindsParam.split(',').filter(
      (k): k is SourceKind => k === 'claude-code' || k === 'opencode',
    )
  : undefined;
```

Pass `kinds` through to `registry.getProjects(kinds)` / `registry.getSessions(projectId,
kinds)`. Import `SourceKind` from `./sources.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `cd server && npx tsc --noEmit && cd .. && pnpm lint`
Expected: no errors/warnings.

- [ ] **Step 6: Commit**

```bash
git add server/src/registry.ts server/src/routes.ts server/test/registry.test.ts
git commit -m "feat(server): filter projects/sessions by agent kind"
```

---

### Task 6: Client — sidebar checkboxes + kind badge

**Files:**
- Modify: `client/src/hooks/useSources.ts` (add `kind`/`configPath`)
- Modify: `client/src/hooks/useProjects.ts`, `client/src/hooks/useSessions.ts` (accept `kinds`)
- Modify: `client/src/App.tsx` (`enabledKinds` state)
- Modify: `client/src/components/ProjectList.tsx` (checkboxes)
- Modify: `client/src/components/SessionList.tsx` (kind-aware badge)

- [ ] **Step 1: Mirror the `Source` type**

In `client/src/hooks/useSources.ts`, update the local `Source` interface to match
`server/src/sources.ts`:

```ts
export type SourceKind = 'claude-code' | 'opencode';

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  configPath?: string;
}
```

- [ ] **Step 2: Thread `kinds` through the data hooks**

`useProjects.ts` and `useSessions.ts` currently build fetch URLs with no filter params (beyond
`useSessions`'s existing `projectId`). Add an optional `kinds: SourceKind[]` argument to each
hook; when present and non-empty (and not equal to "all known kinds", to avoid a needless query
param when nothing is filtered), append `&kinds=<comma-joined>` to the fetch URL. Both hooks'
`useEffect`/`refresh` dependency arrays need `kinds` added so toggling a checkbox refetches.

- [ ] **Step 3: Add `enabledKinds` state to `App.tsx`**

```ts
const sources = useSources();
const allKinds = useMemo(
  () => [...new Set(sources.map(s => s.kind))],
  [sources],
);
const [enabledKinds, setEnabledKinds] = useState<SourceKind[] | null>(null);
// null = "not yet initialized from sources" ⇒ treat as "all enabled" until sources load
const effectiveKinds = enabledKinds ?? allKinds;
```

Pass `effectiveKinds` into `useProjects`/`useSessions`. Pass `allKinds`, `effectiveKinds`, and a
`toggleKind` callback down to `ProjectList`.

- [ ] **Step 4: Render checkboxes in `ProjectList.tsx`**

Below the existing "N projects" line in the header (`ProjectList.tsx:16-51`), add:

```tsx
{allKinds.length > 1 && (
  <div className="flex gap-3 px-4 py-1.5 border-b border-gray-100 text-[11px]">
    {allKinds.map(kind => (
      <label key={kind} className="flex items-center gap-1 text-gray-600">
        <input
          type="checkbox"
          checked={effectiveKinds.includes(kind)}
          onChange={() => onToggleKind(kind)}
        />
        {kind === 'claude-code' ? 'Claude Code' : 'OpenCode'}
      </label>
    ))}
  </div>
)}
```

Only rendered when `allKinds.length > 1` — matches the spec's "only when >1 kind configured"
requirement and the existing convention in `SessionList.tsx` for the source badge.

- [ ] **Step 5: Kind-aware badge in `SessionList.tsx`**

Extend the existing badge block (`SessionList.tsx`, gated on `sources.length > 1` today — keep
that gate, it's a separate concern from the kind checkboxes) to also render a small kind glyph:

```tsx
const kindById = new Map(sources.map(s => [s.id, s.kind]));
// ...
{sources.length > 1 && sourceNameById.has(s.sourceId) && (
  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium
    bg-gray-100 text-gray-600 uppercase tracking-wide flex items-center gap-1">
    <span className={kindById.get(s.sourceId) === 'opencode' ? 'text-emerald-600' : 'text-indigo-600'}>
      ●
    </span>
    {sourceNameById.get(s.sourceId)}
  </span>
)}
```

(Exact glyph/color is a placeholder — match whatever visual language the rest of the app uses;
not load-bearing for functionality.)

- [ ] **Step 6: Typecheck**

Run: `cd client && npx tsc --noEmit --allowImportingTsExtensions`
Expected: no errors.

- [ ] **Step 7: Manual check**

Run `pnpm dev`. With only Claude Code sources configured, confirm no checkbox row renders
(single kind). Add an opencode source to `sources.json` (see Task 9 for the example), restart,
confirm the checkbox row appears and toggling each checkbox filters the project/session lists
and updates counts.

- [ ] **Step 8: Commit**

```bash
git add client/src/hooks/useSources.ts client/src/hooks/useProjects.ts \
  client/src/hooks/useSessions.ts client/src/App.tsx \
  client/src/components/ProjectList.tsx client/src/components/SessionList.tsx
git commit -m "feat(client): add agent-kind filter checkboxes and badge"
```

---

### Task 7: Read-only opencode config + raw-log branch

**Files:**
- Create: `server/src/opencode-config.ts`
- Modify: `server/src/routes.ts` (new endpoints, raw-log branch)
- Modify: `client/src/components/config/ConfigPanel.tsx` (new tab)
- Test: `server/test/opencode-config.test.ts`

- [ ] **Step 1: Write failing tests for `opencode-config.ts`**

Create `server/test/opencode-config.test.ts` covering: `readOpenCodeConfig(configPath)` parses
a valid `opencode.json` (including one with `//` line comments, since opencode's config is
JSONC); returns `{}` when the file is missing or malformed (matching `config.ts`'s existing
tolerance for malformed reads, not a thrown error); `listOpenCodeAgents(configPath)` lists
`<configPath>/agents/*.md` files with their content, empty array when the dir doesn't exist.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/opencode-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `opencode-config.ts`**

```ts
export async function readOpenCodeConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(configPath, 'opencode.json'), 'utf-8').catch(() => null);
  if (raw === null) return {};
  const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try {
    return JSON.parse(stripped);
  } catch {
    return {};
  }
}

export async function listOpenCodeAgents(
  configPath: string,
): Promise<Array<{ name: string; content: string }>> {
  const dir = join(configPath, 'agents');
  const files = await readdir(dir).catch(() => [] as string[]);
  const agents = await Promise.all(
    files.filter(f => f.endsWith('.md')).map(async name => ({
      name,
      content: await readFile(join(dir, name), 'utf-8'),
    })),
  );
  return agents;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/opencode-config.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Add routes**

In `routes.ts`, after the existing config gate block (`routes.ts:210-220`), add:

```ts
const primaryOpenCodeSource = sources.find(
  s => s.kind === 'opencode' && s.configPath,
);

app.get('/api/config/opencode', async c => {
  if (!primaryOpenCodeSource?.configPath) {
    return c.json({ error: 'no opencode source configured' }, 503);
  }
  return c.json(await readOpenCodeConfig(primaryOpenCodeSource.configPath));
});

app.get('/api/config/opencode/agents', async c => {
  if (!primaryOpenCodeSource?.configPath) {
    return c.json({ error: 'no opencode source configured' }, 503);
  }
  return c.json(await listOpenCodeAgents(primaryOpenCodeSource.configPath));
});
```

Placed outside the `/api/config/*` `primarySource` gate middleware (`routes.ts:212-220`) since
that gate gets its own `primaryOpenCodeSource` check instead — the two config surfaces
(Claude Code vs opencode) are independent and one being absent shouldn't 503 the other.

- [ ] **Step 6: Raw-log kind branch**

In the existing `/api/sessions/:id/raw` handler (`routes.ts:65-72`), branch on kind:

```ts
app.get('/api/sessions/:id/raw', async c => {
  const session = registry.getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'not found' }, 404);
  const source = registry.getSources().find(s => s.id === session.sourceId);
  if (source?.kind === 'opencode') {
    return c.json({
      lines: [JSON.stringify(
        { messages: session.messages, toolCalls: session.toolCalls },
        null,
        2,
      )],
      totalLines: 1,
    }); // shape TBD — match whatever readRawLines's return type actually is; see Step 6a
  }
  const offset = Number(c.req.query('offset') ?? '0');
  const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
  const result = await readRawLines(session.filePath, offset, limit);
  return c.json(result);
});
```

- [ ] **Step 6a: Match `readRawLines`'s actual return shape**

Before finalizing Step 6, read `readRawLines`'s return type in `parser.ts` and make the
opencode branch return the same shape (likely `{ lines: string[], totalLines: number }` or
similar with pagination fields) so `RawLogViewer.tsx` needs no client-side branching. Since the
opencode transcript is synthesized in one shot (not paginated from a growing file), `offset`/
`limit` can be ignored for this branch, or a simple client-side slice applied if the type
requires it.

- [ ] **Step 7: Add the OpenCode config tab**

In `client/src/components/config/ConfigPanel.tsx`:
- Add `{ id: 'opencode', label: 'OpenCode' }` to `CONFIG_TABS`, conditionally included only when
  `useSources()` contains a `kind: 'opencode'` source with `configPath` set.
- Add a simple read-only render branch (`activeTab === 'opencode'`) that fetches
  `GET /api/config/opencode` and `GET /api/config/opencode/agents` and renders them as
  formatted JSON / a list of markdown files — no `SettingsEditor`/`HooksManager`-style save
  wiring, consistent with this tab being view-only per the spec.

- [ ] **Step 8: Typecheck + lint + full test suite**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit --allowImportingTsExtensions`
Run: `pnpm lint`
Run: `pnpm --filter @claude-tracker/server test`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add server/src/opencode-config.ts server/src/routes.ts server/test/opencode-config.test.ts \
  client/src/components/config/ConfigPanel.tsx
git commit -m "feat: add read-only opencode config tab and raw-log branch"
```

---

### Task 8: Cross-agent integration test with fixtures

**Files:**
- Create: `server/test/fixtures/opencode/` (seed script or committed tiny `.db`)
- Create: `server/test/multi-agent.integration.test.ts`

- [ ] **Step 1: Build the fixture**

Decide, based on how Task 2/3's test seeding turned out: either commit a tiny pre-built
`opencode.db` (simplest, but schema drift risk if opencode changes its schema) or a
`server/test/fixtures/opencode/seed.ts` helper that creates the schema + rows at test-run time
(more robust, matches the spirit of the existing `server/test/fixtures/sources/{wsl,windows}`
JSONL fixtures being plain committed files, but SQLite doesn't lend itself to hand-editing like
JSONL does). Prefer the seed-script approach for maintainability; extract it from
`opencode-parser.test.ts`'s Task 2 seeding if that logic is already written and reusable.

- [ ] **Step 2: Write the integration test**

`server/test/multi-agent.integration.test.ts`, mirroring
`server/test/multi-source.integration.test.ts`'s structure: build a `SessionRegistry` with one
claude-code `Source` (pointed at a small JSONL fixture, same pattern as the existing
`wsl`/`windows` fixtures) and one opencode `Source` (pointed at the new fixture DB), sharing a
project basename. Assert they merge into one `Project` with both source ids, and that
`getSessions('<basename>', ['opencode'])` returns only the opencode session.

- [ ] **Step 3: Run the test**

Run: `cd server && npx vitest run test/multi-agent.integration.test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @claude-tracker/server test`
Expected: all tests across all files PASS.

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/opencode server/test/multi-agent.integration.test.ts
git commit -m "test(server): add claude-code/opencode cross-agent merge integration test"
```

---

### Task 9: Docs

**Files:**
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Update the "Multi-source setup" section**

Extend the existing section in `CLAUDE.md` with a short note on `kind`, pointing at the
opencode entry already present in `server/config/sources.example.json`:

```markdown
Sources also carry a `kind` (`claude-code` | `opencode`, defaults to `claude-code`). An
opencode source reads sessions directly from opencode's own SQLite DB
(`~/.local/share/opencode/opencode.db`) instead of watching JSONL files, and needs an
additional `configPath` pointing at `~/.config/opencode` to enable the read-only OpenCode
config tab. See the `opencode` entry in `sources.example.json`.
```

- [ ] **Step 2: Update "File Layout" and "Testing" sections**

Add one line each (matching the existing terse style) for: `opencode-parser.ts`,
`opencode-watcher.ts`, `opencode-config.ts`, and the new test files from Tasks 2, 3, 7, 8.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document opencode source kind and new files"
```

---

### Task 10: Full verification

- [ ] Run `pnpm --filter @claude-tracker/server test` — all tests pass.
- [ ] Run `pnpm typecheck` — both packages clean.
- [ ] Run `pnpm lint` — clean.
- [ ] Add a real opencode source to `server/config/sources.json`, pointed at
  `~/.local/share/opencode` (`configPath: ~/.config/opencode`) — the real install already
  present on this host (3 projects, 28 sessions, real tool calls).
- [ ] Run `pnpm dev`. Confirm:
  - Opencode sessions appear in the project/session list with a distinct kind badge.
  - Unchecking "OpenCode" hides opencode sessions and opencode-only projects; unchecking
    "Claude Code" does the inverse; re-checking restores them.
  - Session detail tabs render without errors for a real opencode session, including empty
    Hooks/Agents states and the synthesized Raw Log view.
  - The read-only OpenCode config tab shows real `opencode.json` content.
- [ ] Stop the dev server.

---

## Self-Review

**Spec coverage:**
- Opencode SQLite storage confirmed live (spec §Confirmed facts) → Task 2.
- File-op tool mapping confirmed live (spec) → Task 2.
- `createWatcher` factory dispatch (spec §Backend architecture) → Task 4.
- `OpenCodeWatcher` polling contract (spec) → Task 3.
- Sidebar checkboxes (spec §UI requirements 1-2) → Task 6.
- `kinds` server-side filtering (spec §UI requirements 3) → Task 5.
- Per-session kind badge (spec §UI requirements 4) → Task 6.
- Session detail tabs need no structural change (spec §UI requirements 5) → confirmed, no task.
- Read-only OpenCode config tab (spec §UI requirements 6) → Task 7.
- Raw-log kind branch (spec §API changes) → Task 7.
- `useSources.ts` stale type mirror (spec §Data model changes) → Task 6, Step 1.
- Error handling (malformed rows, missing configPath) (spec §Error handling) → Tasks 2, 7.
- Testing enumerated in spec §Testing → Tasks 2, 3, 4, 5, 7, 8.
- Manual verification plan (spec) → Task 10.

**Type consistency:**
- `listOpenCodeSessions(dbPath, sourceId)` — defined Task 2, used by Task 3's
  `OpenCodeWatcher`.
- `OpenCodeWatcher` ctor `(sourceId, dataDir, db?)` — matches `SourceWatcher`'s `(sourceId,
  claudeDir, db?)` shape, both satisfy the `AgentWatcher` structural interface from Task 4.
- `registry.getProjects(kinds?)` / `getSessions(projectId?, kinds?)` — Task 5, consumed by
  Task 6's client hooks via the `kinds` query param, Task 8's integration test.
- `SourceKind` imported from `server/src/sources.ts` everywhere server-side; mirrored (not
  re-declared incompatibly) in `client/src/hooks/useSources.ts` for Task 6.

**Placeholder scan:** Task 7 Step 6 intentionally leaves the raw-log response shape as
"match `readRawLines`'s actual type" rather than guessing — flagged explicitly as a
step-6a lookup against real code, not a TODO to skip. Everything else is concrete.

No inconsistencies found. Plan is ready for implementation.
