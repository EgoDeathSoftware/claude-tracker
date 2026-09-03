# Durable Session Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every parsed Claude Code and OpenCode session transcript in SQLite so sessions stay fully browsable after their source container, host, or JSONL file disappears.

**Architecture:** A new `ArchiveStore` sits beneath `SessionRegistry` as a write-through store sharing `TrackerDB`'s SQLite connection. Watchers parse as they do today and write through to the archive; the registry keeps only a lightweight `SessionMeta` per session in memory (hydrated from SQLite at startup, before any file is read) and loads message/tool-call bodies on demand. A session no live watcher has claimed is marked `archived` and served entirely from the database.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, NodeNext), better-sqlite3 12.9, Hono 4, vitest 3, React 19 + Vite 6 + Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-03-session-archive-database-design.md`

## Global Constraints

- **Never run `pnpm` on the host.** The dev container is the only place commands run. Test: `docker compose exec -w /app/server app npx vitest run test/<file>`. Full suite: `docker compose exec app pnpm test`. Typecheck: `docker compose exec app pnpm typecheck`. Lint: `docker compose exec app pnpm lint`.
- **Test files must be written with `Bash` + `cat > <<'EOF'`, never `Write`/`Edit`.** The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in `Write`/`Edit` for `.ts`/`.tsx`, and every test file imports `../src/...`.
- **Server imports use `.js` extensions** (NodeNext). Type-only imports use `import type`.
- **`exactOptionalPropertyTypes`:** optional properties are `foo?: T | undefined`, and you may not assign `undefined` to them in an object literal typed as the interface — assign conditionally instead (`if (x !== null) obj.foo = x;`).
- **`noUncheckedIndexedAccess`:** indexed access returns `T | undefined`; use `!` only where the index is provably in range, matching existing code.
- **`server/src/types.ts` is mirrored to `client/src/types.ts`** — keep them in sync.
- **SCHEMA_VERSION goes from 2 to 3** exactly once, in Task 2. Do not bump it again.
- **`maybeRebuildFts()` must keep dropping only `session_fts`.** It must never drop `archive_sessions` or `archive_raw_lines` — the archive is the record; FTS is derived from it.
- Commit after every task. Conventional-commit prefixes (`feat:`, `refactor:`, `test:`, `docs:`), matching repo history.

## Deviations from the spec

Two naming changes, both deliberate, already reflected in the spec:

1. The spec's `SessionSummary` type is named **`SessionMeta`**. `client/src/components/SessionSummary.tsx` already exists and `SessionDetail.tsx` imports it, so the type name would collide on the client.
2. `ArchivePutOptions` carries no `source` field. The session passed to `put()` is already decorated with its source snapshot, so passing the `Source` again would be redundant and could disagree with the session.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `server/src/archive-store.ts` | All archive SQL. Row↔`SessionMeta`/`SessionBody` mapping, raw-line storage, live-write coalescing. No filesystem, no watcher, no parser imports. |
| `server/src/session-shape.ts` | Pure conversions between `ParsedSession`, `Session`, `SessionMeta`, `SessionBody`, and a `Source` snapshot. No I/O. |
| `server/test/archive-store.test.ts` | Unit tests for `ArchiveStore` against `:memory:`. |
| `server/test/session-shape.test.ts` | Unit tests for the pure shape conversions. |

**Modified:**

| File | Change |
|---|---|
| `server/src/types.ts` | Split `Session` into `SessionMeta` + `SessionBody`; add `SourceSnapshot`, `ParsedSession`. |
| `server/src/db.ts` | Two new tables in `migrate()`; construct and expose `archive`; bump `SCHEMA_VERSION`. |
| `server/src/parser.ts` | Export `PARSER_VERSION`, `parseSessionDetailed`, `parseLines`; `parseSession` becomes a wrapper; return type `ParsedSession`. |
| `server/src/store-origin.ts` | `applyOrigin` operates on `ParsedSession`. |
| `server/src/source-watcher.ts` | Constructor takes a `Source`; decorate + write through; fingerprint skip. |
| `server/src/opencode-watcher.ts` | Constructor takes a `Source`; decorate + write through. |
| `server/src/registry.ts` | `Map<string, SessionMeta>`; startup hydration; `getSessionDetail`; `matches()` from snapshot; non-destructive `removeSource`. |
| `server/src/routes.ts` | Async detail read; archive-backed raw; three `/api/archive/*` routes. |
| `server/src/index.ts` | Read `ARCHIVE_FLUSH_MS`; pass to `TrackerDB`. |
| `client/src/types.ts` | Mirror the split; own `SourceKind`/`SourceLocation`/`StoreOrigin`. |
| `client/src/hooks/useSources.ts` | Re-export those three types from `types.ts`. |
| `client/src/hooks/useSSE.ts` | Handlers take `SessionMeta`. |
| `client/src/components/SessionList.tsx` | Badge from the session snapshot; archived badge. |
| `client/src/components/SessionDetail.tsx` | Provenance from the snapshot; archived indicator. |
| `docker-compose.yml`, `.env.example` | Forward `ARCHIVE_FLUSH_MS` and `ARCHIVE_RESCAN`. |
| `CLAUDE.md` | Document the archive in Architecture, File Layout, and Testing. |

---

### Task 1: Split the session types

Introduces the type vocabulary every later task uses. Behaviour is unchanged: watchers decorate parsed sessions with their source snapshot, and the registry still holds full `Session` objects.

**Files:**
- Modify: `server/src/types.ts`
- Modify: `server/src/parser.ts` (return type only)
- Modify: `server/src/store-origin.ts` (`applyOrigin` signature)
- Modify: `server/src/source-watcher.ts`, `server/src/opencode-watcher.ts`, `server/src/registry.ts` (constructor takes `Source`, decorate before storing)
- Create: `server/src/session-shape.ts`
- Test: `server/test/session-shape.test.ts`
- Update: `server/test/source-watcher.test.ts`, `server/test/opencode-watcher.test.ts`, `server/test/registry.test.ts`, `server/test/store-origin.test.ts` (constructor / type annotations)

**Interfaces:**
- Consumes: `Source`, `SourceKind`, `SourceLocation` from `sources.ts`; `StoreOrigin` from `store-origin.ts`.
- Produces: `SessionMeta`, `SessionBody`, `SourceSnapshot`, `ParsedSession`, `Session` (types); `sourceSnapshot(source)`, `decorateSession(parsed, source)`, `toMeta(session)`, `toBody(session)` (functions).

- [ ] **Step 1: Write the failing test**

`server/test/session-shape.test.ts` — write with `Bash`, not `Write`:

```bash
cat > server/test/session-shape.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { decorateSession, toMeta, toBody, sourceSnapshot } from '../src/session-shape.js';
import type { ParsedSession } from '../src/types.js';
import type { Source } from '../src/sources.js';

function makeParsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 's1',
    sourceId: 'wsl',
    projectId: 'workspace',
    filePath: '/claude/projects/-workspace/s1.jsonl',
    slug: 's1',
    title: 'Session s1',
    status: 'done',
    turnCount: 2,
    costUsd: 0.5,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [{
      uuid: 'u1', type: 'user', content: 'hello',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [{ lineNumber: 1, type: 'user', summary: 'hello' }],
    toolCalls: [],
    fileChanges: [],
    costBreakdown: { byTool: {}, conversationCost: 0.5, toolCost: 0, totalCost: 0.5 },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
    ...overrides,
  };
}

const hostSource: Source = {
  id: 'wsl', name: 'WSL', path: '/claude/wsl',
  kind: 'claude-code', layout: 'single', location: 'host',
};

const containerSource: Source = {
  id: 'agents:vercel.ai', name: 'vercel.ai', path: '/claude/agents/vercel.ai',
  kind: 'claude-code', layout: 'single', location: 'container',
  parentId: 'agents',
  origin: { container: 'vercel.ai', hostWorkspace: '/home/david/code/vercel.ai' },
};

describe('sourceSnapshot', () => {
  it('copies name, kind and location', () => {
    expect(sourceSnapshot(hostSource)).toEqual({
      sourceName: 'WSL', sourceKind: 'claude-code', sourceLocation: 'host',
    });
  });

  it('includes origin only when the source has one', () => {
    expect(sourceSnapshot(hostSource)).not.toHaveProperty('origin');
    expect(sourceSnapshot(containerSource).origin).toEqual(containerSource.origin);
  });
});

describe('decorateSession', () => {
  it('adds the snapshot and marks the session live-backed', () => {
    const session = decorateSession(makeParsed(), hostSource);
    expect(session.sourceName).toBe('WSL');
    expect(session.sourceKind).toBe('claude-code');
    expect(session.sourceLocation).toBe('host');
    expect(session.archived).toBe(false);
  });

  it('preserves every parsed field', () => {
    const parsed = makeParsed();
    const session = decorateSession(parsed, hostSource);
    expect(session.messages).toEqual(parsed.messages);
    expect(session.costBreakdown).toEqual(parsed.costBreakdown);
    expect(session.title).toBe(parsed.title);
  });

  it('does not mutate the parsed session', () => {
    const parsed = makeParsed();
    decorateSession(parsed, containerSource);
    expect(parsed).not.toHaveProperty('archived');
  });
});

describe('toMeta / toBody', () => {
  it('toMeta drops every body field', () => {
    const meta = toMeta(decorateSession(makeParsed(), hostSource));
    for (const key of [
      'messages', 'logEntries', 'toolCalls', 'fileChanges',
      'hookEvents', 'permissionEvents', 'recaps',
    ]) {
      expect(meta).not.toHaveProperty(key);
    }
    expect(meta.id).toBe('s1');
    expect(meta.subagents).toEqual([]);
    expect(meta.costBreakdown.totalCost).toBe(0.5);
  });

  it('toBody keeps exactly the body fields', () => {
    const body = toBody(decorateSession(makeParsed(), hostSource));
    expect(Object.keys(body).sort()).toEqual([
      'fileChanges', 'hookEvents', 'logEntries', 'messages',
      'permissionEvents', 'recaps', 'toolCalls',
    ]);
    expect(body.messages).toHaveLength(1);
  });

  it('toMeta omits parentSessionId when absent rather than setting undefined', () => {
    const meta = toMeta(decorateSession(makeParsed(), hostSource));
    expect('parentSessionId' in meta).toBe(false);
  });

  it('toMeta carries parentSessionId when present', () => {
    const meta = toMeta(decorateSession(
      makeParsed({ isSubagent: true, parentSessionId: 'parent-1' }), hostSource,
    ));
    expect(meta.parentSessionId).toBe('parent-1');
  });
});
EOF
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/session-shape.test.ts`
Expected: FAIL — cannot resolve `../src/session-shape.js`.

- [ ] **Step 3: Rewrite the session types**

In `server/src/types.ts`, delete the existing `export interface Session { ... }` block and replace it with the following. Add the two `import type` lines at the top of the file, below the existing imports (there are none today — put them at line 1). A type-only import cycle with `sources.ts`/`store-origin.ts` is fine: `verbatimModuleSyntax` erases them entirely.

```ts
import type { SourceKind, SourceLocation } from './sources.ts';
import type { StoreOrigin } from './store-origin.ts';

/** Provenance snapshotted onto a session so it survives its source's removal. */
export interface SourceSnapshot {
  sourceName: string;
  sourceKind: SourceKind;
  sourceLocation: SourceLocation;
  origin?: StoreOrigin | undefined;
}

/** Everything list views and filters need. Small and bounded; held in memory. */
export interface SessionMeta extends SourceSnapshot {
  id: string;
  sourceId: string;
  projectId: string;
  filePath: string;
  slug: string;
  title: string;
  status: SessionStatus;
  turnCount: number;
  costUsd: number;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  cwd: string;
  isSubagent: boolean;
  parentSessionId?: string | undefined;
  costBreakdown: CostBreakdown;
  subagents: SubagentInfo[];
  /** True when no live watcher currently backs this session. Derived, never stored. */
  archived: boolean;
  aiSummary?: AiSummary | undefined;
}

/** The heavy arrays. Stored in SQLite, loaded only when a session is opened. */
export interface SessionBody {
  messages: SessionMessage[];
  logEntries: RawLogEntry[];
  toolCalls: ToolCallEntry[];
  fileChanges: FileChangeEntry[];
  hookEvents: HookEvent[];
  permissionEvents: PermissionEvent[];
  recaps: RecapEntry[];
}

export type Session = SessionMeta & SessionBody;

/**
 * What `parseSession` returns: a session before its source snapshot is
 * attached. The parser is handed a sourceId, not a Source, so it cannot
 * know the source's name, kind, or location.
 */
export type ParsedSession =
  Omit<SessionMeta, keyof SourceSnapshot | 'archived' | 'aiSummary'> & SessionBody;
```

- [ ] **Step 4: Add the shape conversions**

Create `server/src/session-shape.ts`:

```ts
import type { Source } from './sources.js';
import type {
  ParsedSession, Session, SessionBody, SessionMeta, SourceSnapshot,
} from './types.js';

const BODY_KEYS = [
  'messages', 'logEntries', 'toolCalls', 'fileChanges',
  'hookEvents', 'permissionEvents', 'recaps',
] as const;

/** Copy a source's identity so a session keeps it after the source is gone. */
export function sourceSnapshot(source: Source): SourceSnapshot {
  const snapshot: SourceSnapshot = {
    sourceName: source.name,
    sourceKind: source.kind,
    sourceLocation: source.location,
  };
  if (source.origin !== undefined) snapshot.origin = source.origin;
  return snapshot;
}

/** Attach the source snapshot to a freshly parsed session. */
export function decorateSession(parsed: ParsedSession, source: Source): Session {
  return { ...parsed, ...sourceSnapshot(source), archived: false };
}

export function toBody(session: Session): SessionBody {
  return {
    messages: session.messages,
    logEntries: session.logEntries,
    toolCalls: session.toolCalls,
    fileChanges: session.fileChanges,
    hookEvents: session.hookEvents,
    permissionEvents: session.permissionEvents,
    recaps: session.recaps,
  };
}

export function toMeta(session: Session): SessionMeta {
  const meta = { ...session } as Session & Partial<SessionBody>;
  for (const key of BODY_KEYS) delete meta[key];
  return meta as SessionMeta;
}
```

- [ ] **Step 5: Update `parser.ts`'s return type**

In `server/src/parser.ts`, change the `Session` entry in the `import type { ... } from './types.ts'` list to `ParsedSession`, and change `parseSession`'s return type from `Promise<Session>` to `Promise<ParsedSession>`. No other change — the returned object literal is already exactly a `ParsedSession`.

- [ ] **Step 6: Update `applyOrigin`**

In `server/src/store-origin.ts`, change `import type { Session } from './types.js';` to `import type { ParsedSession } from './types.js';` and change `applyOrigin`'s signature to `applyOrigin(session: ParsedSession, origin: StoreOrigin): ParsedSession`. The body is unchanged.

- [ ] **Step 7: Make the watchers take a `Source` and decorate**

In `server/src/source-watcher.ts`:

```ts
import type { Source } from './sources.js';
import { decorateSession } from './session-shape.js';
import type { ParsedSession, Session } from './types.js';

export interface SourceWatcherOptions {
  /** Start a filesystem watcher for live updates. Defaults to true. */
  watch?: boolean | undefined;
  /** Applied to every parsed session before it is decorated or stored. */
  transformSession?: ((session: ParsedSession) => ParsedSession) | undefined;
}
```

Replace the constructor with:

```ts
  public readonly sourceId: string;

  constructor(
    private readonly source: Source,
    db?: TrackerDB,
    options?: SourceWatcherOptions,
  ) {
    super();
    this.sourceId = source.id;
    this.projectsDir = join(source.path, 'projects');
    this.db = db ?? null;
    this.watchEnabled = options?.watch ?? true;
    this.transformSession = options?.transformSession ?? (s => s);
  }
```

Delete the now-unused `private readonly claudeDir: string` parameter property, and change `this.transformSession`'s field type to `(session: ParsedSession) => ParsedSession`.

In `parseAndStore`, decorate before storing:

```ts
      const parsed = await parseSession(filePath, this.sourceId, dirName);
      const session = decorateSession(this.transformSession(parsed), this.source);
```

Apply the same two-line change in `handleFileEvent`.

In `server/src/opencode-watcher.ts`, replace the constructor with:

```ts
  public readonly sourceId: string;

  constructor(
    private readonly source: Source,
    db?: TrackerDB,
  ) {
    super();
    this.sourceId = source.id;
    this.dbPath = join(source.path, 'opencode.db');
    this.walPath = `${this.dbPath}-wal`;
    this.db = db ?? null;
  }
```

and in `scan()`, decorate every returned session:

```ts
  private async scan(): Promise<Session[] | null> {
    try {
      const parsed = await listOpenCodeSessions(this.dbPath, this.sourceId);
      return parsed.map(p => decorateSession(p, this.source));
    } catch (err) {
      console.error(
        `[opencode-watcher:${this.sourceId}] Failed to scan ${this.dbPath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
```

`listOpenCodeSessions`' return type in `server/src/opencode-parser.ts` changes from `Promise<Session[]>` to `Promise<ParsedSession[]>` (import swap only).

- [ ] **Step 8: Update `registry.ts`'s watcher construction**

```ts
function createWatcher(
  source: Source,
  db?: TrackerDB,
  options?: SourceWatcherOptions,
): AgentWatcher {
  switch (source.kind) {
    case 'claude-code':
      return new SourceWatcher(source, db, options);
    case 'opencode':
      return new OpenCodeWatcher(source, db);
  }
}
```

and change `watcherOptions`' transform to the `ParsedSession` signature:

```ts
      transformSession: origin
        ? (s: ParsedSession) => applyOrigin(s, origin)
        : undefined,
```

- [ ] **Step 9: Fix the existing tests**

Run `docker compose exec app pnpm typecheck` and fix every reported error. The expected set:

- `server/test/source-watcher.test.ts` — `new SourceWatcher('id', dir, ...)` becomes `new SourceWatcher({ id: 'id', name: 'id', path: dir, kind: 'claude-code', layout: 'single', location: 'host' }, ...)`. Add a `function src(id: string, path: string): Source` helper at the top of the file and use it at each construction site.
- `server/test/opencode-watcher.test.ts` — same change, with `kind: 'opencode'`.
- `server/test/registry.test.ts` — any fake session fixtures need `sourceName`, `sourceKind`, `sourceLocation`, `archived`.
- `server/test/db.test.ts` — `makeSession`'s literal needs `sourceName: 'WSL'`, `sourceKind: 'claude-code'`, `sourceLocation: 'host'`, `archived: false`.
- `server/test/store-origin.test.ts` — annotate its session fixtures as `ParsedSession`.
- `server/test/multi-source.integration.test.ts`, `multi-agent.integration.test.ts`, `container-ingestion.integration.test.ts` — construction sites only.

- [ ] **Step 10: Run the new test and the full suite**

Run: `docker compose exec -w /app/server app npx vitest run test/session-shape.test.ts`
Expected: PASS, 8 tests.

Run: `docker compose exec app pnpm test`
Expected: PASS, 224 tests (216 existing + 8 new).

Run: `docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: both clean.

- [ ] **Step 11: Commit**

```bash
git add server/src/types.ts server/src/session-shape.ts server/src/parser.ts \
  server/src/store-origin.ts server/src/source-watcher.ts \
  server/src/opencode-watcher.ts server/src/opencode-parser.ts \
  server/src/registry.ts server/test
git commit -m "refactor: split Session into SessionMeta and SessionBody"
```

---

### Task 2: Archive schema and summary/body storage

**Files:**
- Create: `server/src/archive-store.ts`
- Modify: `server/src/db.ts`
- Test: `server/test/archive-store.test.ts`

**Interfaces:**
- Consumes: `SessionMeta`, `SessionBody`, `Session` (Task 1); `toMeta`/`toBody` (Task 1).
- Produces: `ArchiveStore` with `loadSummaries()`, `getBody(id)`, `put(session, opts?)`, `hasSession(id)`, `deleteSession(id)`, `stats()`; `ArchivePutOptions`; `ArchiveStats`; `TrackerDB.archive`.

- [ ] **Step 1: Write the failing test**

```bash
cat > server/test/archive-store.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { TrackerDB } from '../src/db.js';
import { decorateSession } from '../src/session-shape.js';
import type { ParsedSession, Session } from '../src/types.js';
import type { Source } from '../src/sources.js';

const hostSource: Source = {
  id: 'wsl', name: 'WSL', path: '/claude/wsl',
  kind: 'claude-code', layout: 'single', location: 'host',
};

const containerSource: Source = {
  id: 'agents:vercel.ai', name: 'vercel.ai', path: '/claude/agents/vercel.ai',
  kind: 'claude-code', layout: 'single', location: 'container',
  parentId: 'agents',
  origin: { container: 'vercel.ai', image: 'agent:latest',
    hostWorkspace: '/home/david/code/vercel.ai', workspaceMount: '/workspace' },
};

function makeParsed(id: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id,
    sourceId: 'wsl',
    projectId: 'workspace',
    filePath: `/claude/wsl/projects/-workspace/${id}.jsonl`,
    slug: id,
    title: `Session ${id}`,
    status: 'done',
    turnCount: 3,
    costUsd: 1.25,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [{
      uuid: `${id}-u1`, type: 'user', content: 'hello archive',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [{ lineNumber: 1, type: 'user', summary: 'hello archive' }],
    toolCalls: [{
      toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' },
      timestamp: '2026-09-01T10:01:00Z',
    }],
    fileChanges: [{
      filePath: '/workspace/a.ts', operation: 'edit',
      timestamp: '2026-09-01T10:02:00Z', toolUseId: 't2',
    }],
    costBreakdown: {
      byTool: { Bash: { calls: 1, cost: 0.25 } },
      conversationCost: 1, toolCost: 0.25, totalCost: 1.25,
    },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
    ...overrides,
  };
}

function make(id: string, source = hostSource, overrides: Partial<ParsedSession> = {}): Session {
  return decorateSession(makeParsed(id, overrides), source);
}

describe('ArchiveStore summary and body storage', () => {
  it('roundtrips a session through put and loadSummaries', () => {
    const db = new TrackerDB(':memory:');
    const session = make('s1');
    db.archive.put(session);

    const summaries = db.archive.loadSummaries();
    expect(summaries).toHaveLength(1);
    const meta = summaries[0]!;
    expect(meta.id).toBe('s1');
    expect(meta.title).toBe('Session s1');
    expect(meta.turnCount).toBe(3);
    expect(meta.costUsd).toBe(1.25);
    expect(meta.cwd).toBe('/workspace');
    expect(meta.costBreakdown.byTool['Bash']).toEqual({ calls: 1, cost: 0.25 });
    expect(meta.subagents).toEqual([]);
  });

  it('marks every loaded summary archived', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    expect(db.archive.loadSummaries()[0]!.archived).toBe(true);
  });

  it('coerces a live status to done on load, since there may be no file', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1', hostSource, { status: 'live' }));
    expect(db.archive.loadSummaries()[0]!.status).toBe('done');
  });

  it('preserves the source snapshot including a container origin', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1', containerSource));
    const meta = db.archive.loadSummaries()[0]!;
    expect(meta.sourceName).toBe('vercel.ai');
    expect(meta.sourceLocation).toBe('container');
    expect(meta.origin?.container).toBe('vercel.ai');
    expect(meta.origin?.hostWorkspace).toBe('/home/david/code/vercel.ai');
  });

  it('omits origin rather than storing undefined for a host session', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    expect('origin' in db.archive.loadSummaries()[0]!).toBe(false);
  });

  it('omits parentSessionId for a non-subagent and keeps it for a subagent', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s2', hostSource, {
      isSubagent: true, parentSessionId: 's1',
    }));
    const byId = new Map(db.archive.loadSummaries().map(m => [m.id, m]));
    expect('parentSessionId' in byId.get('s1')!).toBe(false);
    expect(byId.get('s2')!.parentSessionId).toBe('s1');
    expect(byId.get('s2')!.isSubagent).toBe(true);
  });

  it('includes subagent sessions in loadSummaries', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('sub', hostSource, { isSubagent: true, parentSessionId: 's1' }));
    expect(db.archive.loadSummaries()).toHaveLength(2);
  });

  it('returns the body separately from the summary', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    const body = db.archive.getBody('s1')!;
    expect(body.messages).toHaveLength(1);
    expect(body.toolCalls[0]!.toolName).toBe('Bash');
    expect(body.fileChanges[0]!.filePath).toBe('/workspace/a.ts');
    expect(body.logEntries).toHaveLength(1);
  });

  it('returns null for an unknown body', () => {
    const db = new TrackerDB(':memory:');
    expect(db.archive.getBody('nope')).toBeNull();
  });

  it('replaces an existing session on re-put rather than duplicating it', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s1', hostSource, { title: 'Renamed', turnCount: 9 }));
    const summaries = db.archive.loadSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.title).toBe('Renamed');
    expect(summaries[0]!.turnCount).toBe(9);
  });

  it('keeps first_seen_at from the original put', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    const first = db.archive.firstSeenAt('s1');
    db.archive.put(make('s1', hostSource, { title: 'Renamed' }));
    expect(db.archive.firstSeenAt('s1')).toBe(first);
  });

  it('hasSession reflects presence', () => {
    const db = new TrackerDB(':memory:');
    expect(db.archive.hasSession('s1')).toBe(false);
    db.archive.put(make('s1'));
    expect(db.archive.hasSession('s1')).toBe(true);
  });

  it('deleteSession removes the row and its body', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.deleteSession('s1');
    expect(db.archive.loadSummaries()).toHaveLength(0);
    expect(db.archive.getBody('s1')).toBeNull();
  });

  it('deleting an unknown session does not throw', () => {
    const db = new TrackerDB(':memory:');
    expect(() => db.archive.deleteSession('nope')).not.toThrow();
  });

  it('reports stats', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s2'));
    const stats = db.archive.stats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.rawLineCount).toBe(0);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('orders summaries newest first', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('old', hostSource, { lastActivityAt: '2026-08-01T00:00:00Z' }));
    db.archive.put(make('new', hostSource, { lastActivityAt: '2026-09-01T00:00:00Z' }));
    expect(db.archive.loadSummaries().map(m => m.id)).toEqual(['new', 'old']);
  });
});

describe('archive survives an FTS rebuild', () => {
  it('keeps archive rows when maybeRebuildFts drops the FTS table', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.markSchemaVersion(0);
    expect(db.maybeRebuildFts()).toBe(true);
    expect(db.archive.loadSummaries()).toHaveLength(1);
    expect(db.archive.getBody('s1')).not.toBeNull();
  });
});
EOF
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: FAIL — cannot resolve `../src/archive-store.js` / `db.archive` does not exist.

- [ ] **Step 3: Create `ArchiveStore`**

Create `server/src/archive-store.ts`:

```ts
import type Database from 'better-sqlite3';
import { toMeta, toBody } from './session-shape.js';
import type {
  CostBreakdown, Session, SessionBody, SessionMeta, SessionStatus, SubagentInfo,
} from './types.js';
import type { SourceKind, SourceLocation } from './sources.js';
import type { StoreOrigin } from './store-origin.js';

export interface ArchivePutOptions {
  /** Verbatim JSONL lines, when the session came from a file. */
  lines?: string[] | undefined;
  fileSize?: number | undefined;
  fileMtimeMs?: number | undefined;
  parserVersion?: number | undefined;
}

export interface ArchiveStats {
  sessionCount: number;
  rawLineCount: number;
  bytes: number;
}

interface ArchiveRow {
  session_id: string;
  source_id: string;
  source_name: string;
  source_kind: string;
  source_location: string;
  origin_json: string | null;
  project_id: string;
  cwd: string;
  file_path: string;
  slug: string;
  title: string;
  model: string;
  status: string;
  is_subagent: number;
  parent_session_id: string | null;
  turn_count: number;
  cost_usd: number;
  started_at: string;
  last_activity_at: string;
  duration_ms: number;
  summary_json: string;
}

interface SummaryJson {
  costBreakdown: CostBreakdown;
  subagents: SubagentInfo[];
}

const SUMMARY_COLUMNS = `
  session_id, source_id, source_name, source_kind, source_location,
  origin_json, project_id, cwd, file_path, slug, title, model, status,
  is_subagent, parent_session_id, turn_count, cost_usd, started_at,
  last_activity_at, duration_ms, summary_json
`;

function rowToMeta(row: ArchiveRow): SessionMeta {
  const summary = JSON.parse(row.summary_json) as SummaryJson;
  const meta: SessionMeta = {
    id: row.session_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceKind: row.source_kind as SourceKind,
    sourceLocation: row.source_location as SourceLocation,
    projectId: row.project_id,
    filePath: row.file_path,
    slug: row.slug,
    title: row.title,
    // Status is derived from file mtime at parse time. An archived session
    // may have no file at all, so "live" can never be trusted on load.
    status: row.status === 'live' ? 'done' : (row.status as SessionStatus),
    turnCount: row.turn_count,
    costUsd: row.cost_usd,
    model: row.model,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    durationMs: row.duration_ms,
    cwd: row.cwd,
    isSubagent: row.is_subagent === 1,
    costBreakdown: summary.costBreakdown,
    subagents: summary.subagents,
    archived: true,
  };
  if (row.origin_json !== null) {
    meta.origin = JSON.parse(row.origin_json) as StoreOrigin;
  }
  if (row.parent_session_id !== null) {
    meta.parentSessionId = row.parent_session_id;
  }
  return meta;
}

export class ArchiveStore {
  constructor(private readonly db: Database.Database) {}

  loadSummaries(): SessionMeta[] {
    const rows = this.db
      .prepare(`
        SELECT ${SUMMARY_COLUMNS} FROM archive_sessions
        ORDER BY last_activity_at DESC
      `)
      .all() as ArchiveRow[];
    return rows.map(rowToMeta);
  }

  getBody(sessionId: string): SessionBody | null {
    const row = this.db
      .prepare('SELECT body_json FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) as { body_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.body_json) as SessionBody;
  }

  hasSession(sessionId: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) !== undefined;
  }

  firstSeenAt(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT first_seen_at FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) as { first_seen_at: string } | undefined;
    return row?.first_seen_at ?? null;
  }

  put(session: Session, opts?: ArchivePutOptions): void {
    const meta = toMeta(session);
    const summaryJson = JSON.stringify({
      costBreakdown: meta.costBreakdown,
      subagents: meta.subagents,
    } satisfies SummaryJson);
    const bodyJson = JSON.stringify(toBody(session));

    this.db
      .prepare(`
        INSERT INTO archive_sessions (
          session_id, source_id, source_name, source_kind, source_location,
          origin_json, project_id, cwd, file_path, slug, title, model, status,
          is_subagent, parent_session_id, turn_count, cost_usd, started_at,
          last_activity_at, duration_ms, summary_json, body_json, body_codec,
          parser_version, first_seen_at, last_ingested_at
        ) VALUES (
          @sessionId, @sourceId, @sourceName, @sourceKind, @sourceLocation,
          @originJson, @projectId, @cwd, @filePath, @slug, @title, @model, @status,
          @isSubagent, @parentSessionId, @turnCount, @costUsd, @startedAt,
          @lastActivityAt, @durationMs, @summaryJson, @bodyJson, 'json',
          @parserVersion, datetime('now'), datetime('now')
        )
        ON CONFLICT (session_id) DO UPDATE SET
          source_id = excluded.source_id,
          source_name = excluded.source_name,
          source_kind = excluded.source_kind,
          source_location = excluded.source_location,
          origin_json = excluded.origin_json,
          project_id = excluded.project_id,
          cwd = excluded.cwd,
          file_path = excluded.file_path,
          slug = excluded.slug,
          title = excluded.title,
          model = excluded.model,
          status = excluded.status,
          is_subagent = excluded.is_subagent,
          parent_session_id = excluded.parent_session_id,
          turn_count = excluded.turn_count,
          cost_usd = excluded.cost_usd,
          started_at = excluded.started_at,
          last_activity_at = excluded.last_activity_at,
          duration_ms = excluded.duration_ms,
          summary_json = excluded.summary_json,
          body_json = excluded.body_json,
          parser_version = excluded.parser_version,
          last_ingested_at = datetime('now')
      `)
      .run({
        sessionId: meta.id,
        sourceId: meta.sourceId,
        sourceName: meta.sourceName,
        sourceKind: meta.sourceKind,
        sourceLocation: meta.sourceLocation,
        originJson: meta.origin ? JSON.stringify(meta.origin) : null,
        projectId: meta.projectId,
        cwd: meta.cwd,
        filePath: meta.filePath,
        slug: meta.slug,
        title: meta.title,
        model: meta.model,
        status: meta.status,
        isSubagent: meta.isSubagent ? 1 : 0,
        parentSessionId: meta.parentSessionId ?? null,
        turnCount: meta.turnCount,
        costUsd: meta.costUsd,
        startedAt: meta.startedAt,
        lastActivityAt: meta.lastActivityAt,
        durationMs: meta.durationMs,
        summaryJson,
        bodyJson,
        parserVersion: opts?.parserVersion ?? 0,
      });
  }

  deleteSession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM archive_sessions WHERE session_id = ?')
      .run(sessionId);
  }

  stats(): ArchiveStats {
    return this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM archive_sessions) AS sessionCount,
          (SELECT COUNT(*) FROM archive_raw_lines) AS rawLineCount,
          (SELECT COALESCE(SUM(LENGTH(body_json) + LENGTH(summary_json)), 0)
             FROM archive_sessions)
          + (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM archive_raw_lines)
            AS bytes
      `)
      .get() as ArchiveStats;
  }
}
```

- [ ] **Step 4: Wire it into `TrackerDB`**

In `server/src/db.ts`: bump `const SCHEMA_VERSION = 2;` to `3`, add `import { ArchiveStore } from './archive-store.js';`, and append this to the `migrate()` template literal:

```sql
      CREATE TABLE IF NOT EXISTS archive_sessions (
        session_id        TEXT PRIMARY KEY,
        source_id         TEXT NOT NULL,
        source_name       TEXT NOT NULL,
        source_kind       TEXT NOT NULL,
        source_location   TEXT NOT NULL,
        origin_json       TEXT,
        project_id        TEXT NOT NULL,
        cwd               TEXT NOT NULL,
        file_path         TEXT NOT NULL,
        slug              TEXT NOT NULL,
        title             TEXT NOT NULL,
        model             TEXT NOT NULL,
        status            TEXT NOT NULL,
        is_subagent       INTEGER NOT NULL,
        parent_session_id TEXT,
        turn_count        INTEGER NOT NULL,
        cost_usd          REAL NOT NULL,
        started_at        TEXT NOT NULL,
        last_activity_at  TEXT NOT NULL,
        duration_ms       INTEGER NOT NULL,
        summary_json      TEXT NOT NULL,
        body_json         TEXT NOT NULL,
        body_codec        TEXT NOT NULL DEFAULT 'json',
        parser_version    INTEGER NOT NULL,
        file_size         INTEGER,
        file_mtime_ms     INTEGER,
        head_hash         TEXT,
        raw_line_count    INTEGER NOT NULL DEFAULT 0,
        first_seen_at     TEXT NOT NULL,
        last_ingested_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_archive_project
        ON archive_sessions(project_id, last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archive_parent
        ON archive_sessions(parent_session_id);

      CREATE TABLE IF NOT EXISTS archive_raw_lines (
        session_id  TEXT NOT NULL
          REFERENCES archive_sessions(session_id) ON DELETE CASCADE,
        line_number INTEGER NOT NULL,
        content     TEXT NOT NULL,
        PRIMARY KEY (session_id, line_number)
      ) WITHOUT ROWID;
```

Then construct the store after `migrate()`:

```ts
export class TrackerDB {
  private db: Database.Database;
  /** Durable transcript archive. Shares this connection; see archive-store.ts. */
  readonly archive: ArchiveStore;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    // Rebuild FTS if the schema version changed. Done eagerly here so any
    // subsequent indexSession() calls write into the up-to-date table.
    this.maybeRebuildFts();
    this.archive = new ArchiveStore(this.db);
  }
```

`mkdirSync(dirname(':memory:'))` already works today (it creates `.`), so `:memory:` in tests needs no special handling.

- [ ] **Step 5: Run the test to verify it passes**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: PASS, 241 tests, clean typecheck and lint.

- [ ] **Step 7: Commit**

```bash
git add server/src/archive-store.ts server/src/db.ts server/test/archive-store.test.ts
git commit -m "feat: add archive schema and session summary/body storage"
```

---

### Task 3: Raw line storage with incremental append

**Files:**
- Modify: `server/src/archive-store.ts`
- Test: `server/test/archive-store.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `ArchiveStore.put` (Task 2).
- Produces: `put(session, { lines })` persists raw lines; `getRawLines(id, offset, limit): { lines: { lineNumber: number; content: unknown }[]; total: number }`; `rawLineStrings(id): string[]`; `fileFingerprint(id): ArchiveFingerprint | null`; `ArchiveFingerprint`.

- [ ] **Step 1: Write the failing test**

Append to `server/test/archive-store.test.ts`:

```bash
cat >> server/test/archive-store.test.ts <<'EOF'

describe('ArchiveStore raw lines', () => {
  const line = (n: number): string => JSON.stringify({ type: 'user', n });

  it('stores lines and paginates them like readRawLines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2), line(3)] });

    const page = db.archive.getRawLines('s1', 0, 2);
    expect(page.total).toBe(3);
    expect(page.lines).toEqual([
      { lineNumber: 1, content: { type: 'user', n: 1 } },
      { lineNumber: 2, content: { type: 'user', n: 2 } },
    ]);
  });

  it('returns the raw string when a line is not valid JSON', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: ['{not json'] });
    expect(db.archive.getRawLines('s1', 0, 10).lines[0]!.content).toBe('{not json');
  });

  it('clamps the page to the available lines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    const page = db.archive.getRawLines('s1', 1, 500);
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.lineNumber).toBe(2);
  });

  it('returns an empty page for a session with no lines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    expect(db.archive.getRawLines('s1', 0, 10)).toEqual({ lines: [], total: 0 });
  });

  it('appends only the new lines when the file grows', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    db.archive.put(make('s1'), { lines: [line(1), line(2), line(3)] });

    const page = db.archive.getRawLines('s1', 0, 10);
    expect(page.total).toBe(3);
    expect(page.lines.map(l => l.lineNumber)).toEqual([1, 2, 3]);
    expect(db.archive.fileFingerprint('s1')!.lineCount).toBe(3);
  });

  it('replaces every line when the head changes (file rewritten)', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2), line(3)] });
    db.archive.put(make('s1'), { lines: [line(9)] });

    const page = db.archive.getRawLines('s1', 0, 10);
    expect(page.total).toBe(1);
    expect(page.lines[0]!.content).toEqual({ type: 'user', n: 9 });
  });

  it('replaces every line when the file is truncated to fewer lines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2), line(3)] });
    db.archive.put(make('s1'), { lines: [line(1)] });
    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(1);
  });

  it('leaves stored lines untouched when a put carries no lines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    db.archive.put(make('s1'));
    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(2);
  });

  it('records the file fingerprint', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), {
      lines: [line(1)], fileSize: 4096, fileMtimeMs: 1_756_000_000_000,
    });
    const fp = db.archive.fileFingerprint('s1')!;
    expect(fp.size).toBe(4096);
    expect(fp.mtimeMs).toBe(1_756_000_000_000);
    expect(fp.lineCount).toBe(1);
    expect(fp.headHash).toHaveLength(64);
  });

  it('returns null fingerprint for an unknown session', () => {
    const db = new TrackerDB(':memory:');
    expect(db.archive.fileFingerprint('nope')).toBeNull();
  });

  it('rawLineStrings returns the verbatim lines in order', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    expect(db.archive.rawLineStrings('s1')).toEqual([line(1), line(2)]);
  });

  it('deleteSession cascades to the raw lines', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    db.archive.deleteSession('s1');
    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(0);
    expect(db.archive.stats().rawLineCount).toBe(0);
  });

  it('counts raw lines in stats', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'), { lines: [line(1), line(2)] });
    expect(db.archive.stats().rawLineCount).toBe(2);
  });
});
EOF
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: FAIL — `getRawLines is not a function`.

- [ ] **Step 3: Implement raw line storage**

In `server/src/archive-store.ts`, add `import { createHash } from 'node:crypto';` at the top and these members. Note the ordering inside `put`: the fingerprint must be read *before* the row upsert overwrites `head_hash`.

```ts
export interface ArchiveFingerprint {
  size: number | null;
  mtimeMs: number | null;
  headHash: string | null;
  lineCount: number;
}

const HEAD_HASH_BYTES = 4096;

/**
 * Cheap identity for the head of a transcript. Two files that agree here and
 * differ only in length are treated as the same file having grown, which is
 * what a live Claude Code session does on every turn.
 */
function headHashOf(lines: string[]): string {
  return createHash('sha256')
    .update(lines.join('\n').slice(0, HEAD_HASH_BYTES))
    .digest('hex');
}
```

Add to the class:

```ts
  fileFingerprint(sessionId: string): ArchiveFingerprint | null {
    const row = this.db
      .prepare(`
        SELECT file_size, file_mtime_ms, head_hash, raw_line_count
        FROM archive_sessions WHERE session_id = ?
      `)
      .get(sessionId) as {
        file_size: number | null;
        file_mtime_ms: number | null;
        head_hash: string | null;
        raw_line_count: number;
      } | undefined;
    if (!row) return null;
    return {
      size: row.file_size,
      mtimeMs: row.file_mtime_ms,
      headHash: row.head_hash,
      lineCount: row.raw_line_count,
    };
  }

  getRawLines(
    sessionId: string, offset: number, limit: number,
  ): { lines: { lineNumber: number; content: unknown }[]; total: number } {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM archive_raw_lines WHERE session_id = ?')
        .get(sessionId) as { n: number }
    ).n;

    const rows = this.db
      .prepare(`
        SELECT line_number, content FROM archive_raw_lines
        WHERE session_id = ? ORDER BY line_number LIMIT ? OFFSET ?
      `)
      .all(sessionId, limit, offset) as { line_number: number; content: string }[];

    // Mirrors readRawLines: a line that isn't valid JSON comes back verbatim.
    const lines = rows.map(r => {
      let content: unknown;
      try {
        content = JSON.parse(r.content);
      } catch {
        content = r.content;
      }
      return { lineNumber: r.line_number, content };
    });
    return { lines, total };
  }

  rawLineStrings(sessionId: string): string[] {
    return (
      this.db
        .prepare(`
          SELECT content FROM archive_raw_lines
          WHERE session_id = ? ORDER BY line_number
        `)
        .all(sessionId) as { content: string }[]
    ).map(r => r.content);
  }

  /**
   * Insert only the lines past what is already stored when the file has
   * merely grown; otherwise replace the lot. Called inside put's transaction,
   * after the parent row exists (the foreign key requires it).
   */
  private writeLines(
    sessionId: string, lines: string[], previous: ArchiveFingerprint | null,
  ): void {
    const canAppend
      = previous !== null
      && previous.headHash === headHashOf(lines)
      && lines.length >= previous.lineCount;
    const from = canAppend ? previous.lineCount : 0;

    if (!canAppend) {
      this.db
        .prepare('DELETE FROM archive_raw_lines WHERE session_id = ?')
        .run(sessionId);
    }

    const insert = this.db.prepare(`
      INSERT INTO archive_raw_lines (session_id, line_number, content)
      VALUES (?, ?, ?)
      ON CONFLICT (session_id, line_number) DO UPDATE SET content = excluded.content
    `);
    for (let i = from; i < lines.length; i++) {
      insert.run(sessionId, i + 1, lines[i]!);
    }
  }
```

Then change `put` to run in a transaction, capture the fingerprint first, write the raw bookkeeping columns, and call `writeLines`. Replace the body of `put` with:

```ts
  put(session: Session, opts?: ArchivePutOptions): void {
    const meta = toMeta(session);
    const summaryJson = JSON.stringify({
      costBreakdown: meta.costBreakdown,
      subagents: meta.subagents,
    } satisfies SummaryJson);
    const bodyJson = JSON.stringify(toBody(session));
    const lines = opts?.lines;

    const txn = this.db.transaction(() => {
      // Read before the upsert: the upsert overwrites head_hash.
      const previous = this.fileFingerprint(meta.id);
      const lineCount = lines ? lines.length : (previous?.lineCount ?? 0);
      const headHash = lines ? headHashOf(lines) : (previous?.headHash ?? null);

      this.upsertRow.run({
        sessionId: meta.id,
        sourceId: meta.sourceId,
        sourceName: meta.sourceName,
        sourceKind: meta.sourceKind,
        sourceLocation: meta.sourceLocation,
        originJson: meta.origin ? JSON.stringify(meta.origin) : null,
        projectId: meta.projectId,
        cwd: meta.cwd,
        filePath: meta.filePath,
        slug: meta.slug,
        title: meta.title,
        model: meta.model,
        status: meta.status,
        isSubagent: meta.isSubagent ? 1 : 0,
        parentSessionId: meta.parentSessionId ?? null,
        turnCount: meta.turnCount,
        costUsd: meta.costUsd,
        startedAt: meta.startedAt,
        lastActivityAt: meta.lastActivityAt,
        durationMs: meta.durationMs,
        summaryJson,
        bodyJson,
        parserVersion: opts?.parserVersion ?? 0,
        fileSize: opts?.fileSize ?? previous?.size ?? null,
        fileMtimeMs: opts?.fileMtimeMs ?? previous?.mtimeMs ?? null,
        headHash,
        rawLineCount: lineCount,
      });

      if (lines) this.writeLines(meta.id, lines, previous);
    });

    txn();
  }
```

Hoist the statement from Task 2 into a `private readonly upsertRow` field prepared once in the constructor, and extend it with the four raw-bookkeeping columns. Its `VALUES` list gains `@fileSize, @fileMtimeMs, @headHash, @rawLineCount` (after `@parserVersion`, before `datetime('now'), datetime('now')`), its column list gains `file_size, file_mtime_ms, head_hash, raw_line_count` in the same positions, and its `DO UPDATE SET` clause gains:

```sql
          file_size = excluded.file_size,
          file_mtime_ms = excluded.file_mtime_ms,
          head_hash = excluded.head_hash,
          raw_line_count = excluded.raw_line_count,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Run the full suite**

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck`
Expected: PASS, 254 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/archive-store.ts server/test/archive-store.test.ts
git commit -m "feat: store verbatim transcript lines with incremental append"
```

---

### Task 4: Live-session write coalescing

A live transcript changes every second. Without this, every change rewrites the whole `body_json`. Coalescing affects only what reaches SQLite — the registry's in-memory meta is updated on every ingest regardless, so the UI never shows stale data because of it.

**Files:**
- Modify: `server/src/archive-store.ts`, `server/src/db.ts`, `server/src/index.ts`
- Modify: `docker-compose.yml`, `.env.example`
- Test: `server/test/archive-store.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: `put` (Task 3); `parseOptionalNumberEnv` from `env-config.ts`.
- Produces: `ArchiveStoreOptions { flushMs?, now? }`; `ArchiveStore.flush(id)`, `ArchiveStore.flushAll()`; `new TrackerDB(dbPath, archiveOptions?)`.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/archive-store.test.ts <<'EOF'

describe('ArchiveStore live-write coalescing', () => {
  const line = (n: number): string => JSON.stringify({ type: 'user', n });

  function liveDb(clock: { ms: number }) {
    return new TrackerDB(':memory:', {
      flushMs: 15_000, now: () => clock.ms,
    });
  }

  it('defers a body rewrite for a live session inside the flush window', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 2 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(1);
  });

  it('still appends raw lines during a deferred write', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live' }), { lines: [line(1)] });

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live' }),
      { lines: [line(1), line(2)] });

    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(2);
  });

  it('writes through once the flush window has elapsed', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 20_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 7 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(7);
  });

  it('never defers a non-live session', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'done', turnCount: 4 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(4);
  });

  it('never defers the very first write of a session', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));
    expect(db.archive.loadSummaries()).toHaveLength(1);
  });

  it('flushAll writes every deferred body', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));
    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 5 }));

    db.archive.flushAll();
    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(5);
  });

  it('flushAll is a no-op when nothing is pending', () => {
    const db = liveDb({ ms: 1_000 });
    db.archive.put(make('s1'));
    expect(() => db.archive.flushAll()).not.toThrow();
    expect(db.archive.loadSummaries()).toHaveLength(1);
  });

  it('a flush does not clobber the raw line count written while deferred', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live' }), { lines: [line(1)] });
    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live' }),
      { lines: [line(1), line(2), line(3)] });

    db.archive.flushAll();
    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(3);
    expect(db.archive.fileFingerprint('s1')!.lineCount).toBe(3);
  });
});
EOF
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: FAIL — `TrackerDB` takes one argument.

- [ ] **Step 3: Implement coalescing**

In `server/src/archive-store.ts`:

```ts
export interface ArchiveStoreOptions {
  /** Minimum ms between body rewrites for a live session. Default 15000. */
  flushMs?: number | undefined;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

const DEFAULT_FLUSH_MS = 15_000;
```

Add to the class:

```ts
  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly lastBodyWrite = new Map<string, number>();
  private readonly pending = new Map<string, { session: Session; parserVersion: number }>();

  constructor(
    private readonly db: Database.Database,
    options?: ArchiveStoreOptions,
  ) {
    this.flushMs = options?.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options?.now ?? (() => Date.now());
    this.upsertRow = db.prepare(/* the INSERT ... ON CONFLICT from Task 3 */);
    this.touchRaw = db.prepare(/* below */);
    this.updateBody = db.prepare(/* below */);
  }
```

(The three statement bodies are given verbatim in this step and Task 3; assign them directly rather than leaving the comments in place.)

In `put`, decide before the transaction and branch inside it:

```ts
    const now = this.now();
    const existed = this.hasSession(meta.id);
    const withinWindow
      = (now - (this.lastBodyWrite.get(meta.id) ?? 0)) < this.flushMs;
    const defer = existed && meta.status === 'live' && withinWindow;
```

When `defer` is true the transaction runs `writeLines` plus a `touchRaw` statement and records the session as pending:

```ts
      if (defer) {
        this.touchRaw.run({
          sessionId: meta.id,
          lastActivityAt: meta.lastActivityAt,
          fileSize, fileMtimeMs, headHash, rawLineCount: lineCount,
        });
        if (lines) this.writeLines(meta.id, lines, previous);
        this.pending.set(meta.id, {
          session, parserVersion: opts?.parserVersion ?? 0,
        });
        return;
      }
```

with

```ts
    this.touchRaw = db.prepare(`
      UPDATE archive_sessions SET
        last_activity_at = @lastActivityAt,
        file_size = @fileSize,
        file_mtime_ms = @fileMtimeMs,
        head_hash = @headHash,
        raw_line_count = @rawLineCount,
        last_ingested_at = datetime('now')
      WHERE session_id = @sessionId
    `);
```

The non-deferred branch is the existing upsert path, plus `this.lastBodyWrite.set(meta.id, now); this.pending.delete(meta.id);` after it.

`flush` writes only the body and scalar columns, never the raw bookkeeping — those were already advanced by the deferred puts:

```ts
  /** Write a deferred body through. Leaves raw-line bookkeeping alone. */
  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    const meta = toMeta(entry.session);
    this.updateBody.run({
      sessionId: meta.id,
      status: meta.status,
      title: meta.title,
      model: meta.model,
      turnCount: meta.turnCount,
      costUsd: meta.costUsd,
      durationMs: meta.durationMs,
      lastActivityAt: meta.lastActivityAt,
      summaryJson: JSON.stringify({
        costBreakdown: meta.costBreakdown, subagents: meta.subagents,
      } satisfies SummaryJson),
      bodyJson: JSON.stringify(toBody(entry.session)),
      parserVersion: entry.parserVersion,
    });
    this.pending.delete(sessionId);
    this.lastBodyWrite.set(sessionId, this.now());
  }

  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }
```

with `updateBody` prepared as an `UPDATE archive_sessions SET status = @status, title = @title, model = @model, turn_count = @turnCount, cost_usd = @costUsd, duration_ms = @durationMs, last_activity_at = @lastActivityAt, summary_json = @summaryJson, body_json = @bodyJson, parser_version = @parserVersion, last_ingested_at = datetime('now') WHERE session_id = @sessionId`.

- [ ] **Step 4: Plumb the option through `TrackerDB` and `index.ts`**

`db.ts`:

```ts
import { ArchiveStore } from './archive-store.js';
import type { ArchiveStoreOptions } from './archive-store.js';

  constructor(dbPath: string, archiveOptions?: ArchiveStoreOptions) {
    /* ...unchanged... */
    this.archive = new ArchiveStore(this.db, archiveOptions);
  }
```

`index.ts`, after the existing `storePollMs` line:

```ts
const archiveFlushMs = parseOptionalNumberEnv('ARCHIVE_FLUSH_MS');
```

and

```ts
const db = new TrackerDB(join(dataDir, 'tracker.db'), { flushMs: archiveFlushMs });
```

`docker-compose.yml`, in the `app` service's `environment:` list:

```yaml
      - ARCHIVE_FLUSH_MS=${ARCHIVE_FLUSH_MS:-}
```

`.env.example`, alongside the existing `STORE_*` entries:

```bash
# Minimum milliseconds between archive body rewrites for a live session.
# Raw transcript lines are always appended immediately; this only throttles
# rewriting the parsed body. Default 15000.
ARCHIVE_FLUSH_MS=
```

- [ ] **Step 5: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/archive-store.test.ts`
Expected: PASS, 38 tests.

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck`
Expected: PASS, 262 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/archive-store.ts server/src/db.ts server/src/index.ts \
  docker-compose.yml .env.example server/test/archive-store.test.ts
git commit -m "feat: coalesce archive body writes for live sessions"
```

---

### Task 5: `parseSessionDetailed` and `PARSER_VERSION`

**Files:**
- Modify: `server/src/parser.ts`
- Test: `server/test/parser.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `PARSER_VERSION: number`; `parseSessionDetailed(filePath, sourceId, dirName): Promise<ParsedFile>`; `ParsedFile { session: ParsedSession; lines: string[]; size: number; mtimeMs: number }`; `parseLines(lines, fileStat, filePath, sourceId, dirName): ParsedSession`.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/parser.test.ts <<'EOF'

describe('parseSessionDetailed', () => {
  it('returns the same session parseSession does', async () => {
    const file = await writeFixture([
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false,
        timestamp: '2026-09-01T10:00:00Z', cwd: '/workspace',
        message: { role: 'user', content: 'hello' } },
    ]);
    const plain = await parseSession(file, 'wsl', '-workspace');
    const detailed = await parseSessionDetailed(file, 'wsl', '-workspace');
    expect(detailed.session).toEqual(plain);
  });

  it('returns the verbatim lines it parsed', async () => {
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false,
        timestamp: '2026-09-01T10:00:00Z', cwd: '/workspace',
        message: { role: 'user', content: 'hello' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: false,
        timestamp: '2026-09-01T10:01:00Z',
        message: { role: 'user', content: 'again' } },
    ];
    const file = await writeFixture(records);
    const { lines } = await parseSessionDetailed(file, 'wsl', '-workspace');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(records[0]);
  });

  it('reports the file size and mtime', async () => {
    const file = await writeFixture([
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false,
        timestamp: '2026-09-01T10:00:00Z', cwd: '/workspace',
        message: { role: 'user', content: 'hello' } },
    ]);
    const { size, mtimeMs } = await parseSessionDetailed(file, 'wsl', '-workspace');
    expect(size).toBeGreaterThan(0);
    expect(mtimeMs).toBeGreaterThan(0);
  });

  it('line numbers line up with logEntries', async () => {
    const file = await writeFixture([
      { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false,
        timestamp: '2026-09-01T10:00:00Z', cwd: '/workspace',
        message: { role: 'user', content: 'one' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: false,
        timestamp: '2026-09-01T10:01:00Z',
        message: { role: 'user', content: 'two' } },
    ]);
    const { session, lines } = await parseSessionDetailed(file, 'wsl', '-workspace');
    for (const entry of session.logEntries) {
      expect(lines[entry.lineNumber - 1]).toBeDefined();
      expect(JSON.parse(lines[entry.lineNumber - 1]!).uuid).toBe(entry.uuid);
    }
  });

  it('exports a positive PARSER_VERSION', () => {
    expect(PARSER_VERSION).toBeGreaterThan(0);
  });
});
EOF
```

`parser.test.ts` builds its fixtures inline today (`mkdtemp` + `writeFile`) and has no shared helper, so add this one just below its imports and use it in the block above:

```ts
const parserTmp: string[] = [];
afterEach(async () => {
  for (const d of parserTmp.splice(0)) await rm(d, { recursive: true, force: true });
});

async function writeFixture(records: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'parse-detail-'));
  parserTmp.push(dir);
  const file = join(dir, 'sess.jsonl');
  await writeFile(file, records.map(r => JSON.stringify(r)).join('\n'), 'utf-8');
  return file;
}
```

Extend the file's imports: add `afterEach` from `vitest`, `rm` from `node:fs/promises` (the other fs functions are already imported), and `parseSessionDetailed`, `PARSER_VERSION` to the existing `../src/parser.ts` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/parser.test.ts`
Expected: FAIL — `parseSessionDetailed` is not exported.

- [ ] **Step 3: Refactor `parseSession`**

In `server/src/parser.ts`, add near the top:

```ts
/**
 * Bumped by hand whenever parsing semantics change. Archived sessions record
 * the version they were parsed with, so POST /api/archive/reparse can find
 * and re-derive the stale ones from their stored raw lines.
 */
export const PARSER_VERSION = 1;

export interface ParsedFile {
  session: ParsedSession;
  lines: string[];
  size: number;
  mtimeMs: number;
}
```

Rename the existing `parseSession` to `parseLines` with this signature, keeping its body byte-for-byte from `const messages: SessionMessage[] = [];` onward (delete only its first line, the `readLines`/`stat` call):

```ts
export function parseLines(
  lines: string[],
  fileStat: { mtimeMs: number; birthtimeMs: number },
  filePath: string,
  sourceId: string,
  dirName: string,
): ParsedSession {
```

Then add the two wrappers:

```ts
export async function parseSessionDetailed(
  filePath: string,
  sourceId: string,
  dirName: string,
): Promise<ParsedFile> {
  const [lines, fileStat] = await Promise.all([
    readLines(filePath), stat(filePath),
  ]);
  return {
    session: parseLines(lines, fileStat, filePath, sourceId, dirName),
    lines,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  };
}

export async function parseSession(
  filePath: string,
  sourceId: string,
  dirName: string,
): Promise<ParsedSession> {
  return (await parseSessionDetailed(filePath, sourceId, dirName)).session;
}
```

- [ ] **Step 4: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/parser.test.ts`
Expected: PASS, 43 tests (38 existing + 5 new).

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck`
Expected: PASS, 267 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/parser.ts server/test/parser.test.ts
git commit -m "feat: expose parseSessionDetailed and PARSER_VERSION"
```

---

### Task 6: Watchers write through to the archive

**Files:**
- Modify: `server/src/source-watcher.ts`, `server/src/opencode-watcher.ts`
- Test: `server/test/source-watcher.test.ts`, `server/test/opencode-watcher.test.ts`

**Interfaces:**
- Consumes: `parseSessionDetailed`, `PARSER_VERSION` (Task 5); `db.archive.put` (Tasks 2-4); `decorateSession` (Task 1).
- Produces: no new API. Both watchers persist every session they parse.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/source-watcher.test.ts <<'EOF'

describe('SourceWatcher archive write-through', () => {
  it('archives every session found in the initial scan, with its raw lines', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const summaries = db.archive.loadSummaries();
    expect(summaries.map(s => s.id)).toContain('a1');
    expect(db.archive.getRawLines('a1', 0, 10).total).toBeGreaterThan(0);
    expect(db.archive.getBody('a1')!.messages.length).toBeGreaterThan(0);
    await watcher.stop();
  });

  it('archives the source snapshot, not just the source id', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const meta = db.archive.loadSummaries().find(s => s.id === 'a1')!;
    expect(meta.sourceName).toBe('wsl');
    expect(meta.sourceKind).toBe('claude-code');
    expect(meta.sourceLocation).toBe('host');
    await watcher.stop();
  });

  it('archives subagent sessions too', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'parent', cwd: '/workspace' },
      { project: '-workspace', session: 'agent-1', cwd: '/workspace',
        subagentOf: 'parent' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const ids = db.archive.loadSummaries().map(s => s.id);
    expect(ids).toContain('parent');
    expect(ids).toContain('agent-1');
    await watcher.stop();
  });

  it('applies transformSession before archiving', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, {
      watch: false,
      transformSession: s => ({ ...s, cwd: '/host/workspace' }),
    });
    await watcher.start();

    expect(db.archive.loadSummaries().find(s => s.id === 'a1')!.cwd)
      .toBe('/host/workspace');
    await watcher.stop();
  });
});
EOF
```

`source-watcher.test.ts` has only `makeUserLine`/`makeAssistantLine` today and builds directories inline, so add these two helpers below them (`src` was added in Task 1 Step 9):

```ts
const watcherTmp: string[] = [];
afterEach(async () => {
  for (const d of watcherTmp.splice(0)) await rm(d, { recursive: true, force: true });
});

interface SeedSpec {
  project: string;
  session: string;
  cwd: string;
  /** When set, the file is written under <parent>/subagents/ instead. */
  subagentOf?: string | undefined;
}

async function makeClaudeDir(specs: SeedSpec[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archive-watcher-'));
  watcherTmp.push(dir);
  for (const spec of specs) {
    const projectDir = join(dir, 'projects', spec.project);
    const target = spec.subagentOf
      ? join(projectDir, spec.subagentOf, 'subagents')
      : projectDir;
    await mkdir(target, { recursive: true });
    const rec = JSON.parse(makeUserLine('u1', 'hello', '2026-09-01T10:00:00.000Z')) as
      Record<string, unknown>;
    rec['cwd'] = spec.cwd;
    await writeFile(
      join(target, `${spec.session}.jsonl`), JSON.stringify(rec), 'utf-8',
    );
  }
  return dir;
}

async function appendRecord(
  dir: string, project: string, session: string, record: unknown,
): Promise<void> {
  await appendFile(
    join(dir, 'projects', project, `${session}.jsonl`),
    `\n${JSON.stringify(record)}`, 'utf-8',
  );
}
```

Extend the file's imports with `appendFile` and `rm` from `node:fs/promises` and add `import { TrackerDB } from '../src/db.js';`. `appendRecord` is unused until Task 11 — add it now so both tasks share one helper.

```bash
cat >> server/test/opencode-watcher.test.ts <<'EOF'

describe('OpenCodeWatcher archive write-through', () => {
  const ocCleanup: string[] = [];
  afterEach(async () => {
    for (const d of ocCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('archives scanned sessions with a body and no raw lines', async () => {
    const dataDir = makeTmp();
    ocCleanup.push(dataDir);
    const ocDb = createDb(dataDir);
    insertSession(ocDb, {
      id: 'oc-1', projectId: 'p1', directory: '/workspace',
      model: 'gpt-4', cost: 0.1, timeUpdated: 1_756_000_000_000,
      title: 'OpenCode session',
    });
    ocDb.close();

    const db = new TrackerDB(':memory:');
    const watcher = new OpenCodeWatcher(
      { id: 'oc', name: 'OpenCode', path: dataDir,
        kind: 'opencode', layout: 'single', location: 'host' },
      db,
    );
    await watcher.start();

    const summaries = db.archive.loadSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]!.sourceKind).toBe('opencode');
    expect(db.archive.getBody(summaries[0]!.id)).not.toBeNull();
    expect(db.archive.stats().rawLineCount).toBe(0);
    await watcher.stop();
  });
});
EOF
```

`createDb` and `insertSession` are the file's existing helpers, currently nested inside its `describe('OpenCodeWatcher')` block — hoist both to module scope first (a pure move, no body change) so the new block can call them, and match `insertSession`'s exact parameter object to its declaration. Add `import { TrackerDB } from '../src/db.js';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec -w /app/server app npx vitest run test/source-watcher.test.ts test/opencode-watcher.test.ts`
Expected: FAIL — archive is empty.

- [ ] **Step 3: Write through from `SourceWatcher`**

Replace `parseAndStore` in `server/src/source-watcher.ts`:

```ts
  private async parseAndStore(
    filePath: string,
    dirName: string,
  ): Promise<void> {
    try {
      const parsed = await parseSessionDetailed(filePath, this.sourceId, dirName);
      const session = decorateSession(
        this.transformSession(parsed.session), this.source,
      );
      this.sessions.set(session.id, session);
      this.db?.archive.put(session, {
        lines: parsed.lines,
        fileSize: parsed.size,
        fileMtimeMs: parsed.mtimeMs,
        parserVersion: PARSER_VERSION,
      });
      if (this.db && !session.isSubagent) {
        this.db.indexSession(session);
      }
    } catch (err) {
      console.error(
        `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
```

and `handleFileEvent`'s parse block the same way:

```ts
    const parsed = await parseSessionDetailed(filePath, this.sourceId, dirName)
      .catch(err => {
        console.error(
          `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      });
    if (!parsed) return;
    const session = decorateSession(
      this.transformSession(parsed.session), this.source,
    );
    this.sessions.set(session.id, session);
    this.db?.archive.put(session, {
      lines: parsed.lines,
      fileSize: parsed.size,
      fileMtimeMs: parsed.mtimeMs,
      parserVersion: PARSER_VERSION,
    });
```

Update the import to `import { parseSessionDetailed, PARSER_VERSION } from './parser.js';`.

- [ ] **Step 4: Write through from `OpenCodeWatcher`**

In `applyScan`, immediately after `this.sessions.set(session.id, session);`:

```ts
      // No raw lines exist for opencode: its sessions come from opencode's
      // own SQLite tables, not a JSONL file.
      this.db?.archive.put(session);
```

- [ ] **Step 5: Flush pending writes on stop**

In `SourceWatcher.stop()` and `OpenCodeWatcher.stop()`, add `this.db?.archive.flushAll();` before returning, so a shutdown mid-live-session does not lose the last coalesced body.

- [ ] **Step 6: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/source-watcher.test.ts test/opencode-watcher.test.ts`
Expected: PASS, 13 tests (9 existing + 4) and 8 tests (7 existing + 1).

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck`
Expected: PASS, 272 tests.

- [ ] **Step 7: Commit**

```bash
git add server/src/source-watcher.ts server/src/opencode-watcher.ts server/test
git commit -m "feat: write parsed sessions through to the archive"
```

---

### Task 7: Registry hydration and the meta map

**Files:**
- Modify: `server/src/registry.ts`
- Test: `server/test/registry.test.ts`

**Interfaces:**
- Consumes: `db.archive.loadSummaries()`, `db.archive.getBody()` (Task 2); `toMeta` (Task 1).
- Produces: `SessionRegistry.getSessionMeta(id): SessionMeta | undefined`; `getSessionDetail(id): Promise<Session | undefined>`; `getSessions`/`getProjects` return/consume `SessionMeta`. `getSession` is removed.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/registry.test.ts <<'EOF'

describe('SessionRegistry archive hydration', () => {
  it('serves projects and sessions loaded from the archive with no watcher', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));

    const registry = new SessionRegistry([], db);
    await registry.start();

    expect(registry.getProjects().map(p => p.id)).toEqual(['workspace']);
    expect(registry.getSessions().map(s => s.id)).toEqual(['gone-1']);
    await registry.stop();
  });

  it('marks hydrated sessions archived', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));

    const registry = new SessionRegistry([], db);
    await registry.start();

    expect(registry.getSessions()[0]!.archived).toBe(true);
    await registry.stop();
  });

  it('a live watcher claiming a hydrated session clears archived', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-archive-'));
    cleanup.push(dir);
    await seedSession(dir, '-workspace', 'a1', '/workspace', '2026-09-01T10:00:00.000Z');
    const db = new TrackerDB(':memory:');

    const first = new SessionRegistry([src('wsl', dir)], db);
    await first.start();
    await first.stop();

    const second = new SessionRegistry([src('wsl', dir)], db);
    await second.start();
    expect(second.getSessions().find(s => s.id === 'a1')!.archived).toBe(false);
    await second.stop();
  });

  it('getSessionDetail merges the meta with the archived body', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));

    const registry = new SessionRegistry([], db);
    await registry.start();

    const detail = await registry.getSessionDetail('gone-1');
    expect(detail!.title).toBe('Session gone-1');
    expect(detail!.archived).toBe(true);
    expect(detail!.messages).toHaveLength(1);
    await registry.stop();
  });

  it('getSessionDetail returns undefined for an unknown session', async () => {
    const registry = new SessionRegistry([], new TrackerDB(':memory:'));
    await registry.start();
    expect(await registry.getSessionDetail('nope')).toBeUndefined();
    await registry.stop();
  });

  it('getSessionDetail degrades to an empty body when the archive has none', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('orphan', 'ghost-source'));
    const registry = new SessionRegistry([], db);
    await registry.start();

    // The registry has the meta; the body row is gone underneath it.
    db.archive.deleteSession('orphan');

    const detail = await registry.getSessionDetail('orphan');
    expect(detail!.messages).toEqual([]);
    expect(detail!.toolCalls).toEqual([]);
    await registry.stop();
  });

  it('hydration includes subagents without listing them as sessions', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('parent', 'ghost-source'));
    db.archive.put({
      ...archivedSession('sub', 'ghost-source'),
      isSubagent: true, parentSessionId: 'parent',
    });

    const registry = new SessionRegistry([], db);
    await registry.start();
    expect(registry.getSessions().map(s => s.id)).toEqual(['parent']);
    expect(registry.getSessionMeta('sub')).toBeDefined();
    await registry.stop();
  });
});
EOF
```

`registry.test.ts` already has `seedSession`, `makeUserLine`, `seedOpenCodeDb`, and a `cleanup: string[]` array with an `afterEach`. Add a `src` helper next to them:

```ts
function src(id: string, path: string): Source {
  return {
    id, name: id, path,
    kind: 'claude-code', layout: 'single', location: 'host',
  };
}
```

`archivedSession` is needed by three test files, so it goes in a shared fixture module — the same pattern `server/test/fixtures/opencode/seed.ts` already uses. Create `server/test/fixtures/session.ts` (write it with `Bash`; it imports `../../src/`):

```ts
import type { Session } from '../../src/types.js';

/** A fully-formed session as it would look coming out of a dead source. */
export function archivedSession(id: string, sourceId: string): Session {
  return {
    id,
    sourceId,
    sourceName: sourceId,
    sourceKind: 'claude-code',
    sourceLocation: 'host',
    projectId: 'workspace',
    filePath: `/gone/projects/-workspace/${id}.jsonl`,
    slug: id,
    title: `Session ${id}`,
    status: 'done',
    turnCount: 1,
    costUsd: 0.1,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    isSubagent: false,
    costBreakdown: { byTool: {}, conversationCost: 0.1, toolCost: 0, totalCost: 0.1 },
    subagents: [],
    archived: false,
    messages: [{
      uuid: `${id}-u1`, type: 'user', content: 'archived hello',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [],
    toolCalls: [],
    fileChanges: [],
    hookEvents: [],
    permissionEvents: [],
    recaps: [],
  };
}
```

Then add `import { archivedSession } from './fixtures/session.js';` and `import type { Source } from '../src/sources.js';` (already present) to `registry.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/registry.test.ts`
Expected: FAIL — registry has no `getSessionDetail`, hydration does not happen.

- [ ] **Step 3: Narrow the map and hydrate at startup**

In `server/src/registry.ts`:

```ts
import { toMeta } from './session-shape.js';
import type { Session, SessionBody, SessionMeta, Project } from './types.js';

  private sessions = new Map<string, SessionMeta>();
```

At the very top of `start()`, before any watcher is constructed:

```ts
    // Hydrate from the archive first: the UI is browsable before a single
    // JSONL file is opened, and sessions whose source is gone stay listed.
    for (const meta of this.db?.archive.loadSummaries() ?? []) {
      this.sessions.set(meta.id, meta);
    }
```

`ingest` stores the meta and marks it live-backed:

```ts
  private ingest(session: Session): void {
    const existing = this.sessions.get(session.id);
    if (existing && !existing.archived && existing.sourceId !== session.sourceId) {
      const incomingNewer
        = new Date(session.lastActivityAt).getTime()
        >= new Date(existing.lastActivityAt).getTime();
      if (!incomingNewer) {
        console.warn(
          `[registry] session ID collision: ${session.id} `
          + `(keeping ${existing.sourceId}, discarding ${session.sourceId})`,
        );
        return;
      }
      console.warn(
        `[registry] session ID collision: ${session.id} `
        + `(replacing ${existing.sourceId} with ${session.sourceId})`,
      );
    }
    this.sessions.set(session.id, toMeta(session));
  }
```

The collision check now skips archived incumbents: a hydrated row is not a competing live source, it is the same session's own archived copy, and the live watcher must always win.

Replace `getSession` with:

```ts
  getSessionMeta(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  /**
   * Full session for the detail view. The body comes from the archive; a
   * missing body row is corruption rather than a normal state, so it degrades
   * to empty arrays with a warning instead of 404ing a session that is listed.
   */
  async getSessionDetail(id: string): Promise<Session | undefined> {
    const meta = this.sessions.get(id);
    if (!meta) return undefined;
    const body = this.db?.archive.getBody(id) ?? null;
    if (body === null) {
      console.warn(`[registry] no archived body for session ${id}`);
      return { ...meta, ...EMPTY_BODY };
    }
    return { ...meta, ...body };
  }
```

with a module-level constant:

```ts
const EMPTY_BODY: SessionBody = {
  messages: [], logEntries: [], toolCalls: [], fileChanges: [],
  hookEvents: [], permissionEvents: [], recaps: [],
};
```

`getProjects` and `getSessions` need no logic change — their bodies only touch meta fields — but their return type becomes `SessionMeta[]` for `getSessions`.

- [ ] **Step 4: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/registry.test.ts`
Expected: PASS, 28 tests.

Run: `docker compose exec app pnpm typecheck`
Expected: two errors in `routes.ts` (`registry.getSession` no longer exists). Leave them — Task 9 fixes routes. To keep this task's commit green, apply the minimal routes change now: `registry.getSession(...)` → `registry.getSessionMeta(...)` in both call sites, and in `GET /api/sessions/:id` use `await registry.getSessionDetail(...)` with the handler marked `async`.

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck`
Expected: PASS, 278 tests, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/src/routes.ts server/test/registry.test.ts
git commit -m "feat: hydrate the registry from the archive at startup"
```

---

### Task 8: Non-destructive source removal and snapshot-based filtering

**Files:**
- Modify: `server/src/registry.ts`
- Test: `server/test/registry.test.ts`

**Interfaces:**
- Consumes: the meta map (Task 7).
- Produces: `removeSource` marks sessions archived instead of deleting them; `matches()` reads kind/location from the session.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/registry.test.ts <<'EOF'

describe('SessionRegistry non-destructive source removal', () => {
  it('keeps a removed source\'s sessions, marked archived', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-archive-'));
    cleanup.push(dir);
    await seedSession(dir, '-workspace', 'a1', '/workspace', '2026-09-01T10:00:00.000Z');
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([src('wsl', dir)], db);
    await registry.start();
    expect(registry.getSessions().find(s => s.id === 'a1')!.archived).toBe(false);

    await registry.removeSource('wsl');

    const session = registry.getSessions().find(s => s.id === 'a1');
    expect(session).toBeDefined();
    expect(session!.archived).toBe(true);
    await registry.stop();
  });

  it('keeps FTS, tags and summaries for a removed source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-archive-'));
    cleanup.push(dir);
    await seedSession(dir, '-workspace', 'a1', '/workspace', '2026-09-01T10:00:00.000Z');
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([src('wsl', dir)], db);
    await registry.start();
    db.addSessionTag('a1', 'keepme');

    await registry.removeSource('wsl');

    expect(db.getSessionTags('a1').map(t => t.name)).toEqual(['keepme']);
    expect(db.getAllTags().map(t => t.name)).toEqual(['keepme']);
    await registry.stop();
  });

  it('keeps the archived body readable after removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-archive-'));
    cleanup.push(dir);
    await seedSession(dir, '-workspace', 'a1', '/workspace', '2026-09-01T10:00:00.000Z');
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([src('wsl', dir)], db);
    await registry.start();

    await registry.removeSource('wsl');

    const detail = await registry.getSessionDetail('a1');
    expect(detail!.messages.length).toBeGreaterThan(0);
    await registry.stop();
  });

  it('still drops the source from getSources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-archive-'));
    cleanup.push(dir);
    await seedSession(dir, '-workspace', 'a1', '/workspace', '2026-09-01T10:00:00.000Z');
    const registry = new SessionRegistry([src('wsl', dir)], new TrackerDB(':memory:'));
    await registry.start();
    await registry.removeSource('wsl');
    expect(registry.getSources()).toEqual([]);
    await registry.stop();
  });
});

describe('SessionRegistry filters archived sessions by snapshot', () => {
  it('matches a kind filter for a session whose source is gone', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));
    const registry = new SessionRegistry([], db);
    await registry.start();

    expect(registry.getSessions(undefined, { kinds: ['claude-code'] }))
      .toHaveLength(1);
    expect(registry.getSessions(undefined, { kinds: ['opencode'] }))
      .toHaveLength(0);
    await registry.stop();
  });

  it('matches a location filter for a session whose source is gone', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put({
      ...archivedSession('gone-1', 'ghost-source'),
      sourceLocation: 'container',
    });
    const registry = new SessionRegistry([], db);
    await registry.start();

    expect(registry.getSessions(undefined, { locations: ['container'] }))
      .toHaveLength(1);
    expect(registry.getSessions(undefined, { locations: ['host'] }))
      .toHaveLength(0);
    await registry.stop();
  });

  it('an explicitly empty filter still matches nothing', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));
    const registry = new SessionRegistry([], db);
    await registry.start();
    expect(registry.getSessions(undefined, { kinds: [] })).toHaveLength(0);
    await registry.stop();
  });

  it('archived projects appear in getProjects under a matching filter', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));
    const registry = new SessionRegistry([], db);
    await registry.start();
    expect(registry.getProjects({ kinds: ['claude-code'] })).toHaveLength(1);
    await registry.stop();
  });
});
EOF
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/registry.test.ts`
Expected: FAIL — sessions are purged on removal; filters exclude archived sessions.

- [ ] **Step 3: Make `matches` read the snapshot**

Replace `matches` in `server/src/registry.ts` and delete the now-unused `kindBySourceId`/`locationBySourceId` fields together with every line that writes to them (constructor, `addSource`, `removeSource`):

```ts
  /**
   * Single predicate consulted by both getProjects and getSessions. Kind and
   * location come from the session's own snapshot rather than the live source
   * table, so a session whose source has been removed still filters correctly.
   */
  private matches(session: SessionMeta, filter?: SessionFilter): boolean {
    if (filter?.kinds && !filter.kinds.includes(session.sourceKind)) return false;
    if (filter?.locations && !filter.locations.includes(session.sourceLocation)) {
      return false;
    }
    return true;
  }
```

Update both call sites to pass the session: `if (!this.matches(session, filter)) continue;` in `getProjects`, and `s => !s.isSubagent && this.matches(s, filter)` in `getSessions`.

- [ ] **Step 4: Make `removeSource` non-destructive**

Replace the session-purging loop in `removeSource`:

```ts
    // A destroyed container takes this path on every StoreSetWatcher poll.
    // Its sessions stay listed, browsable from the archive, and keep their
    // FTS rows, tags and cached summaries; only the live binding is dropped.
    this.db?.archive.flushAll();
    for (const [sessionId, session] of this.sessions) {
      if (session.sourceId === id) {
        this.sessions.set(sessionId, { ...session, archived: true });
      }
    }
```

Delete the `this.db?.removeSession(sessionId)` call. `db.removeSession` keeps its current behaviour and is invoked from the delete route in Task 9.

- [ ] **Step 5: Flush on stop**

In `SessionRegistry.stop()`, after the watchers have stopped, add `this.db?.archive.flushAll();`.

- [ ] **Step 6: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/registry.test.ts`
Expected: PASS, 36 tests.

Some existing registry tests assert the old purging behaviour (the ones covering "dropping only the removed source's sessions including their SQLite state"). Update them to assert the new contract: the session remains, `archived` is true, and its FTS/tag state survives. Do not delete those tests.

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: PASS, 286 tests, clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.ts
git commit -m "feat: keep sessions archived when their source is removed"
```

---

### Task 9: Routes — archive-backed reads and the /api/archive endpoints

**Files:**
- Modify: `server/src/routes.ts`
- Modify: `server/src/archive-store.ts` (add `listStale`)
- Test: `server/test/routes.test.ts`

**Interfaces:**
- Consumes: `registry.getSessionMeta`, `registry.getSessionDetail` (Task 7); `db.archive.*`.
- Produces: `GET /api/archive/stats`, `DELETE /api/archive/sessions/:id`, `POST /api/archive/reparse`; `ArchiveStore.listStale(parserVersion, limit): string[]`.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/routes.test.ts <<'EOF'

describe('archive routes', () => {
  it('serves an archived session detail from the database', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'));
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');

    const res = await app.request('/api/sessions/gone-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { archived: boolean; messages: unknown[] };
    expect(body.archived).toBe(true);
    expect(body.messages).toHaveLength(1);
    await registry.stop();
  });

  it('serves an archived raw log from the database', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'), {
      lines: ['{"type":"user","n":1}', '{"type":"user","n":2}'],
    });
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');

    const res = await app.request('/api/sessions/gone-1/raw?offset=0&limit=10');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; lines: unknown[] };
    expect(body.total).toBe(2);
    expect(body.lines).toHaveLength(2);
    await registry.stop();
  });

  it('404s the detail of an unknown session', async () => {
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');
    expect((await app.request('/api/sessions/nope')).status).toBe(404);
    await registry.stop();
  });

  it('reports archive stats', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'), { lines: ['{}'] });
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');

    const body = await (await app.request('/api/archive/stats')).json() as {
      sessionCount: number; rawLineCount: number; bytes: number;
    };
    expect(body.sessionCount).toBe(1);
    expect(body.rawLineCount).toBe(1);
    await registry.stop();
  });

  it('deletes a session from the archive and the derived index', async () => {
    const db = new TrackerDB(':memory:');
    const session = archivedSession('gone-1', 'ghost-source');
    db.archive.put(session, { lines: ['{}'] });
    db.indexSession(session);
    db.addSessionTag('gone-1', 'temp');
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');

    const res = await app.request('/api/archive/sessions/gone-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(db.archive.loadSummaries()).toHaveLength(0);
    expect(db.getAllTags()).toEqual([]);
    expect(registry.getSessions()).toHaveLength(0);
    await registry.stop();
  });

  it('404s a delete for an unknown session', async () => {
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');
    const res = await app.request('/api/archive/sessions/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
    await registry.stop();
  });

  it('reparse re-derives a stale body from stored raw lines', async () => {
    const db = new TrackerDB(':memory:');
    const session = archivedSession('gone-1', 'ghost-source');
    db.archive.put(
      { ...session, messages: [] },
      {
        lines: [JSON.stringify({
          type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false,
          timestamp: '2026-09-01T10:00:00Z', cwd: '/workspace',
          message: { role: 'user', content: 'recovered' },
        })],
        parserVersion: 0,
      },
    );
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');

    const res = await app.request('/api/archive/reparse', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reparsed: 1 });
    expect(db.archive.getBody('gone-1')!.messages).toHaveLength(1);
    await registry.stop();
  });

  it('reparse reports zero when nothing is stale', async () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(archivedSession('gone-1', 'ghost-source'), {
      lines: ['{}'], parserVersion: PARSER_VERSION,
    });
    const registry = new SessionRegistry([], db);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/llm.json');
    expect(await (await app.request('/api/archive/reparse', { method: 'POST' })).json())
      .toEqual({ reparsed: 0 });
    await registry.stop();
  });
});
EOF
```

Add `import { archivedSession } from './fixtures/session.js';` and `import { PARSER_VERSION } from '../src/parser.js';` to `routes.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/routes.test.ts`
Expected: FAIL — 404 on the `/api/archive/*` routes.

- [ ] **Step 3: Add `listStale` to `ArchiveStore`**

```ts
  /** Session ids whose stored body predates the given parser version. */
  listStale(parserVersion: number, limit: number): string[] {
    return (
      this.db
        .prepare(`
          SELECT session_id FROM archive_sessions
          WHERE parser_version < ? AND raw_line_count > 0
          ORDER BY last_activity_at DESC LIMIT ?
        `)
        .all(parserVersion, limit) as { session_id: string }[]
    ).map(r => r.session_id);
  }

  /** Overwrite a session's derived body after a reparse. */
  replaceBody(sessionId: string, body: SessionBody, parserVersion: number): void {
    this.db
      .prepare(`
        UPDATE archive_sessions
        SET body_json = ?, parser_version = ?, last_ingested_at = datetime('now')
        WHERE session_id = ?
      `)
      .run(JSON.stringify(body), parserVersion, sessionId);
  }
```

- [ ] **Step 4: Update the routes**

In `server/src/routes.ts`, change the two session routes:

```ts
  app.get('/api/sessions/:id', async c => {
    const session = await registry.getSessionDetail(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const aiSummary = db.getSessionSummary(session.id) ?? undefined;
    return c.json({ ...session, aiSummary });
  });

  app.get('/api/sessions/:id/raw', async c => {
    const session = registry.getSessionMeta(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const offset = Number(c.req.query('offset') ?? '0');
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);

    // opencode never had a JSONL file and archives no raw lines, so its
    // synthesized view (from already-parsed messages) stays first.
    if (session.sourceKind === 'opencode') {
      const detail = await registry.getSessionDetail(session.id);
      const messages = detail?.messages ?? [];
      const total = messages.length;
      const end = Math.min(offset + limit, total);
      const lines: { lineNumber: number; content: unknown }[] = [];
      for (let i = offset; i < end; i++) {
        lines.push({ lineNumber: i + 1, content: messages[i] });
      }
      return c.json({ lines, total });
    }

    // An archived session may have no file left; its verbatim lines are in
    // the archive.
    if (session.archived) {
      return c.json(db.archive.getRawLines(session.id, offset, limit));
    }

    return c.json(await readRawLines(session.filePath, offset, limit));
  });
```

The opencode branch is the existing one, with two changes: it reads `session.sourceKind` from the snapshot instead of looking the source up in `registry.getSources()`, and it pulls messages from `getSessionDetail` because `getSessionMeta` no longer carries them.

Add the three archive routes after the search routes:

```ts
  // --- Archive ---

  app.get('/api/archive/stats', c => c.json(db.archive.stats()));

  app.delete('/api/archive/sessions/:id', async c => {
    const id = c.req.param('id');
    if (!db.archive.hasSession(id) && !registry.getSessionMeta(id)) {
      return c.json({ error: 'not found' }, 404);
    }
    db.archive.deleteSession(id);
    db.removeSession(id);
    registry.forgetSession(id);
    return c.json({ deleted: id });
  });

  app.post('/api/archive/reparse', async c => {
    const limit = Math.min(Number(c.req.query('limit') ?? '500'), 5000);
    const stale = db.archive.listStale(PARSER_VERSION, limit);
    let reparsed = 0;
    for (const id of stale) {
      const meta = registry.getSessionMeta(id);
      if (!meta) continue;
      const lines = db.archive.rawLineStrings(id);
      if (lines.length === 0) continue;
      const fileStat = {
        mtimeMs: new Date(meta.lastActivityAt).getTime(),
        birthtimeMs: new Date(meta.startedAt).getTime(),
      };
      const parsed = parseLines(
        lines, fileStat, meta.filePath, meta.sourceId, meta.projectId,
      );
      db.archive.replaceBody(id, toBody({ ...meta, ...parsed }), PARSER_VERSION);
      reparsed++;
    }
    return c.json({ reparsed });
  });
```

Add `import { readRawLines, parseLines, PARSER_VERSION } from './parser.js';` and `import { toBody } from './session-shape.js';`.

- [ ] **Step 5: Add `forgetSession` to the registry**

```ts
  /** Drop a session from the in-memory map. Called by the delete route only. */
  forgetSession(id: string): void {
    this.sessions.delete(id);
  }
```

- [ ] **Step 6: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/routes.test.ts`
Expected: PASS, 20 tests (12 existing + 8 new).

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: PASS, 294 tests, clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes.ts server/src/registry.ts server/src/archive-store.ts \
  server/test/routes.test.ts
git commit -m "feat: serve archived sessions and add /api/archive routes"
```

---

### Task 10: Client type mirror and archived UI

**Files:**
- Modify: `client/src/types.ts`, `client/src/hooks/useSources.ts`, `client/src/hooks/useSSE.ts`
- Modify: `client/src/components/SessionList.tsx`, `client/src/components/SessionDetail.tsx`

**Interfaces:**
- Consumes: `SessionMeta`/`SessionBody`/`Session` shapes from the server (Task 1); `archived`, `sourceName`, `sourceKind`, `sourceLocation`, `origin` on every session the API returns.
- Produces: no new API. Visual: an "archived" badge in the list, an archived note in the detail header.

- [ ] **Step 1: Mirror the types**

In `client/src/types.ts`, move the `SourceKind`, `SourceLocation`, and `StoreOrigin` declarations here from `hooks/useSources.ts` (verbatim), then apply the same `SessionMeta`/`SessionBody`/`Session` split as `server/src/types.ts`. Omit `ParsedSession` — the client never sees an undecorated session.

In `client/src/hooks/useSources.ts`, replace those three declarations with a re-export so existing importers keep working:

```ts
export type { SourceKind, SourceLocation, StoreOrigin } from '@/types.ts';
```

- [ ] **Step 2: Narrow the list-side types**

`client/src/hooks/useSSE.ts`:

```ts
import type { SessionMeta } from '@/types.ts';

type SSEHandler = (session: SessionMeta) => void;
```

and cast both `JSON.parse` results to `SessionMeta`.

`client/src/components/SessionList.tsx`: change `import type { Session }` to `import type { SessionMeta }` and `sessions: Session[]` to `sessions: SessionMeta[]`.

`client/src/components/SessionDetail.tsx`: the `session` prop becomes `SessionMeta | null`; `fullSession` stays `Session | null`.

Run `docker compose exec -w /app/client app npx tsc --noEmit --allowImportingTsExtensions` and fix any remaining call sites (`App.tsx`, `useSessions.ts`, `useSearch.ts`, the compare view) by narrowing them to `SessionMeta` where they only touch meta fields.

- [ ] **Step 3: Read provenance from the session, not the source table**

In `SessionList.tsx`, replace the badge computation:

```ts
          // Provenance comes from the session's own snapshot: an archived
          // session's source is gone from /api/sources entirely.
          const source = sourceById.get(s.sourceId);
          const badgeLabel = s.sourceLocation === 'container'
            ? (s.origin?.container ?? s.sourceName)
            : (source?.name ?? s.sourceName);
```

and change the render condition from `(sources.length > 1 || source?.location === 'container') && source && (` to:

```tsx
                  {(sources.length > 1 || s.sourceLocation === 'container'
                    || s.archived) && (
                    <>
                      <SourceKindDots kinds={[s.sourceKind]} />
                      <span
                        title={s.sourceLocation === 'container'
                          ? `container: ${badgeLabel}`
                          : badgeLabel}
                        className="px-1.5 py-0.5 rounded text-[9px] font-medium
                          bg-gray-100 text-gray-600 uppercase tracking-wide
                          max-w-[7rem] truncate"
                      >
                        {badgeLabel}
                      </span>
                      {s.archived && (
                        <span
                          title="Source no longer present; served from the archive"
                          className="px-1.5 py-0.5 rounded text-[9px] font-medium
                            bg-amber-100 text-amber-700 uppercase tracking-wide"
                        >
                          archived
                        </span>
                      )}
                    </>
                  )}
```

In `SessionDetail.tsx`, replace the provenance block:

```tsx
        {fullSession.sourceLocation === 'container' && (
          <div className="text-[11px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>container: {fullSession.origin?.container ?? fullSession.sourceName}</span>
            {fullSession.origin?.image && <span>· {fullSession.origin.image}</span>}
            {fullSession.origin?.hostWorkspace && (
              <span className="truncate">· {fullSession.origin.hostWorkspace}</span>
            )}
          </div>
        )}
        {fullSession.archived && (
          <div className="text-[11px] text-amber-700 mt-0.5">
            Archived — {fullSession.sourceName} is no longer connected.
            Served from the tracker database.
          </div>
        )}
```

and delete the now-unused `const source = sources.find(...)` line if nothing else uses it.

- [ ] **Step 4: Verify in the running container**

Run: `docker compose exec -w /app/client app npx tsc --noEmit --allowImportingTsExtensions`
Expected: clean.

Run: `docker compose exec app pnpm lint`
Expected: clean.

Open `http://localhost:5173`, confirm the session list still renders with source badges, open a session and confirm all seven tabs populate. Then confirm the archived path end to end: `docker compose exec app sqlite3 /app/data/tracker.db "select count(*) from archive_sessions;"` returns a non-zero count.

- [ ] **Step 5: Commit**

```bash
git add client/src
git commit -m "feat: show archived sessions and read provenance from the session"
```

---

### Task 11: Skip re-parsing unchanged files at startup

The optimization that makes the archive pay for itself: with it, a boot re-reads only transcripts that actually changed.

**Files:**
- Modify: `server/src/source-watcher.ts`, `server/src/index.ts`, `docker-compose.yml`, `.env.example`
- Test: `server/test/source-watcher.test.ts`

**Interfaces:**
- Consumes: `ArchiveStore.fileFingerprint` (Task 3).
- Produces: `SourceWatcherOptions.rescan?: boolean | undefined`.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/source-watcher.test.ts <<'EOF'

describe('SourceWatcher startup fingerprint skip', () => {
  it('does not re-parse a file whose size and mtime are unchanged', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');

    const first = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await first.start();
    await first.stop();
    const before = db.archive.fileFingerprint('a1')!;

    const second = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await second.start();

    expect(second.getAllSessions().map(s => s.id)).toContain('a1');
    expect(db.archive.fileFingerprint('a1')).toEqual(before);
    await second.stop();
  });

  it('re-parses when the file has grown', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const first = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await first.start();
    await first.stop();
    const beforeLines = db.archive.getRawLines('a1', 0, 100).total;

    await appendRecord(dir, '-workspace', 'a1', {
      type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: false,
      timestamp: '2026-09-01T11:00:00Z',
      message: { role: 'user', content: 'more' },
    });

    const second = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await second.start();
    expect(db.archive.getRawLines('a1', 0, 100).total).toBe(beforeLines + 1);
    await second.stop();
  });

  it('rescan: true re-parses even an unchanged file', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const first = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await first.start();
    await first.stop();

    const second = new SourceWatcher(src('wsl', dir), db, {
      watch: false, rescan: true,
    });
    await second.start();
    expect(second.getAllSessions().map(s => s.id)).toContain('a1');
    await second.stop();
  });

  it('a skipped session is still served in memory from the archive', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const first = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await first.start();
    await first.stop();

    const second = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await second.start();
    const session = second.getAllSessions().find(s => s.id === 'a1')!;
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.archived).toBe(false);
    await second.stop();
  });
});
EOF
```

`makeClaudeDir`, `appendRecord`, and `src` were all added to this file in Tasks 1 and 6 — no new helpers are needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose exec -w /app/server app npx vitest run test/source-watcher.test.ts`
Expected: FAIL — `rescan` is not an option; the fingerprint changes on every start.

- [ ] **Step 3: Implement the skip**

Add to `SourceWatcherOptions`:

```ts
  /** Re-parse every file even when its fingerprint is unchanged. Default false. */
  rescan?: boolean | undefined;
```

and to the constructor: `this.rescan = options?.rescan ?? false;`.

In `parseAndStore`, before parsing:

```ts
    const sessionId = basename(filePath, '.jsonl');
    if (!this.rescan && this.db) {
      const fp = this.db.archive.fileFingerprint(sessionId);
      const st = await stat(filePath).catch(() => null);
      // Both must match exactly. A file that grew, shrank, or was rewritten
      // has a different size or mtime and falls through to a full parse.
      if (fp && st && fp.size === st.size && fp.mtimeMs === st.mtimeMs) {
        const body = this.db.archive.getBody(sessionId);
        const meta = this.db.archive.loadSummary(sessionId);
        if (body && meta) {
          this.sessions.set(sessionId, { ...meta, ...body, archived: false });
          return;
        }
      }
    }
```

Add `import { stat } from 'node:fs/promises';` (merge with the existing `readdir` import) and a `loadSummary(sessionId): SessionMeta | null` single-row method to `ArchiveStore`, reusing `SUMMARY_COLUMNS` and `rowToMeta`.

The skip path deliberately bypasses `db.indexSession`: the FTS row was written when the file was first parsed and the file has not changed since.

`parseAndStore` is only reachable from `scanExisting`; `handleFileEvent` never consults the fingerprint, because a file event means the file changed.

- [ ] **Step 4: Plumb `ARCHIVE_RESCAN`**

`index.ts`:

```ts
const archiveRescan = process.env['ARCHIVE_RESCAN'] === '1';
```

and pass it through the registry's existing third constructor argument, which gains a field:

```ts
// registry.ts
export interface RegistryOptions extends StoreSetWatcherOptions {
  /** Re-parse every transcript at startup, ignoring archive fingerprints. */
  rescan?: boolean | undefined;
}
```

Change the constructor's third parameter type from `StoreSetWatcherOptions` to `RegistryOptions` (it is structurally compatible, so the `StoreSetWatcher` construction sites need no change), and add `rescan: this.storeSetOptions?.rescan` to the object `watcherOptions` returns (`storeSetOptions` is the existing name of that constructor parameter property). In `index.ts`:

```ts
const registry = new SessionRegistry(sources, db, {
  activeDays: storeActiveDays, pollMs: storePollMs, rescan: archiveRescan,
});
```

`docker-compose.yml`:

```yaml
      - ARCHIVE_RESCAN=${ARCHIVE_RESCAN:-}
```

`.env.example`:

```bash
# Set to 1 to force a full re-parse of every transcript at startup, ignoring
# the archive's size+mtime fingerprints. Normally unnecessary.
ARCHIVE_RESCAN=
```

- [ ] **Step 5: Run the tests**

Run: `docker compose exec -w /app/server app npx vitest run test/source-watcher.test.ts`
Expected: PASS, 17 tests.

Run: `docker compose exec app pnpm test && docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: PASS, 298 tests, clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/source-watcher.ts server/src/registry.ts server/src/index.ts \
  server/src/archive-store.ts docker-compose.yml .env.example \
  server/test/source-watcher.test.ts
git commit -m "perf: skip re-parsing transcripts unchanged since the last boot"
```

---

### Task 12: End-to-end container-destruction test and documentation

The case the whole feature exists for, plus the docs that keep it discoverable.

**Files:**
- Modify: `server/test/container-ingestion.integration.test.ts`
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/container-ingestion.integration.test.ts <<'EOF'

describe('a destroyed container keeps its sessions', () => {
  it('serves the session, its project, its body and its raw log after removal', async () => {
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([storeSet], db);
    await registry.start();

    const before = registry.getSessions().find(s => s.sourceLocation === 'container');
    expect(before).toBeDefined();
    const sessionId = before!.id;
    const projectId = before!.projectId;
    const rawTotal = (await (
      await buildApp(registry, db, '/tmp/llm.json')
        .request(`/api/sessions/${sessionId}/raw`)
    ).json() as { total: number }).total;
    expect(rawTotal).toBeGreaterThan(0);

    await registry.removeSource(before!.sourceId);

    const after = registry.getSessions().find(s => s.id === sessionId);
    expect(after).toBeDefined();
    expect(after!.archived).toBe(true);
    expect(after!.projectId).toBe(projectId);
    expect(registry.getProjects().map(p => p.id)).toContain(projectId);

    const detail = await registry.getSessionDetail(sessionId);
    expect(detail!.messages.length).toBeGreaterThan(0);

    const app = buildApp(registry, db, '/tmp/llm.json');
    const raw = await (
      await app.request(`/api/sessions/${sessionId}/raw`)
    ).json() as { total: number };
    expect(raw.total).toBe(rawTotal);

    await registry.stop();
  });

  it('an archived container session still merges into its host project', async () => {
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([await makeHostSource(), storeSet], db);
    await registry.start();

    const containerSession = registry.getSessions()
      .find(s => s.sourceLocation === 'container')!;
    await registry.removeSource(containerSession.sourceId);

    const project = registry.getProjects()
      .find(p => p.id === containerSession.projectId)!;
    expect(project.sessionCount).toBeGreaterThan(1);
    await registry.stop();
  });

  it('a container session survives a full restart with its source gone', async () => {
    const dbPath = join(await mkdtemp(join(tmpdir(), 'archive-')), 'tracker.db');
    const db = new TrackerDB(dbPath);
    const registry = new SessionRegistry([storeSet], db);
    await registry.start();
    const sessionId = registry.getSessions()
      .find(s => s.sourceLocation === 'container')!.id;
    await registry.stop();
    db.close();

    // Second boot with no sources at all, standing in for a host whose
    // agent store directory has been deleted.
    const db2 = new TrackerDB(dbPath);
    const registry2 = new SessionRegistry([], db2);
    await registry2.start();

    const session = registry2.getSessions().find(s => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session!.archived).toBe(true);
    expect((await registry2.getSessionDetail(sessionId))!.messages.length)
      .toBeGreaterThan(0);
    await registry2.stop();
  });
});
EOF
```

`makeHostSource()` and the module-level `storeSet` const are the file's existing fixtures — use them as-is, no extraction needed. Add to its imports: `TrackerDB` from `../src/db.js`, `buildApp` from `../src/routes.js`, and `mkdtemp` from `node:fs/promises` (`tmpdir` and `join` are already imported).

Note that the existing tests construct `new SessionRegistry([...])` with no database. The new tests pass one, because without it there is no archive to survive into.

- [ ] **Step 2: Run the test**

Run: `docker compose exec -w /app/server app npx vitest run test/container-ingestion.integration.test.ts`
Expected: PASS, 8 tests (5 existing + 3 new). If the third test fails on the second boot, the cause is almost certainly `registry.stop()` not flushing pending archive writes — verify Task 8 Step 5 landed.

- [ ] **Step 3: Update `CLAUDE.md`**

Add a section after "Multi-source setup":

```markdown
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
```

Add to **File Layout**:

```markdown
- `server/src/archive-store.ts` — `ArchiveStore`: all archive SQL. Shares `TrackerDB`'s connection (exposed as `db.archive`). `loadSummaries`/`loadSummary` hydrate `SessionMeta`, `getBody` loads a `SessionBody` on demand, `put` write-throughs a session and its verbatim lines (appending only new lines when the head hash matches and the file grew; replacing all on a rewrite), `fileFingerprint` drives the startup skip, and body writes for `live` sessions coalesce to at most one per `ARCHIVE_FLUSH_MS` (`flush`/`flushAll` force them out).
- `server/src/session-shape.ts` — Pure conversions: `sourceSnapshot`, `decorateSession` (parser output + `Source` → `Session`), `toMeta`, `toBody`.
```

Update the `types.ts` convention bullet to mention the `SessionMeta`/`SessionBody`/`Session`/`ParsedSession` split, and update the `registry.ts`, `db.ts`, `parser.ts`, `source-watcher.ts`, and `routes.ts` entries to reflect their new responsibilities.

Update **Testing**'s total and add:

```markdown
- `archive-store.test.ts` — 38 tests for `ArchiveStore`: summary/body roundtrip, status coercion on load, source-snapshot and origin persistence, `exactOptionalPropertyTypes`-correct omission of absent optionals, incremental line append vs. full replace on a rewrite or truncation, raw-line pagination matching `readRawLines`' shape, fingerprints, cascade delete, stats, live-write coalescing, and archive rows surviving an FTS rebuild.
- `session-shape.test.ts` — 8 tests for the pure shape conversions.
```

- [ ] **Step 4: Update `README.md`**

Add a short "Durable archive" paragraph to the feature list, pointing at the `CLAUDE.md` section for detail, and document `ARCHIVE_FLUSH_MS`/`ARCHIVE_RESCAN` alongside the existing `STORE_*` env vars.

- [ ] **Step 5: Full verification**

Run: `docker compose exec app pnpm test`
Expected: PASS, 301 tests.

Run: `docker compose exec app pnpm typecheck && docker compose exec app pnpm lint`
Expected: clean.

Run: `docker compose exec -w /app/client app npx tsc --noEmit --allowImportingTsExtensions`
Expected: clean.

Restart the stack and confirm the archive is populating against real data:

```bash
docker compose restart app
sleep 30
docker compose exec app sqlite3 /app/data/tracker.db \
  "select count(*) from archive_sessions; select count(*) from archive_raw_lines;"
curl -s localhost:3001/api/archive/stats
```

Expected: non-zero counts, and `/api/archive/stats` agreeing with them.

- [ ] **Step 6: Commit**

```bash
git add server/test/container-ingestion.integration.test.ts CLAUDE.md README.md
git commit -m "test: cover container destruction end to end; document the archive"
```

---

## Verification Checklist

Run before declaring the feature done:

- [ ] `docker compose exec app pnpm test` — 301 tests pass
- [ ] `docker compose exec app pnpm typecheck` — clean
- [ ] `docker compose exec app pnpm lint` — clean
- [ ] `docker compose exec -w /app/client app npx tsc --noEmit --allowImportingTsExtensions` — clean
- [ ] `curl -s localhost:3001/api/archive/stats` reports non-zero counts against real data
- [ ] A session opened in the UI populates all seven detail tabs
- [ ] Stopping a tracked agent container and waiting one `STORE_POLL_MS` leaves its sessions listed with the archived badge, still openable, raw log intact
