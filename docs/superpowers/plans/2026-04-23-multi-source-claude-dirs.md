# Multi-source Claude directories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate Claude sessions from multiple `.claude` directories (WSL + Windows + future mounts) into a single view, grouping sessions for the same project folder regardless of which side recorded them.

**Architecture:** A new `SessionRegistry` fans out one `SourceWatcher` per configured source (read from `server/config/sources.json`). Each source watcher scans + watches its own `projects/` tree and tags parsed sessions with a `sourceId`. The registry merges their outputs, groups projects by `basename(cwd).toLowerCase()`, and keeps the existing REST + SSE surface stable. A one-shot FTS rebuild on version bump handles the `projectId` semantic change.

**Tech Stack:** Node 22, TypeScript (NodeNext), Hono 4, chokidar, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-23-multi-source-claude-dirs-design.md`

---

### Task 1: Project-key utility

**Files:**
- Create: `server/src/project-key.ts`
- Test: `server/test/project-key.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/test/project-key.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  basenameOf,
  deriveProjectKey,
  displayNameFromCwd,
} from '../src/project-key.ts';

describe('basenameOf', () => {
  it('extracts folder name from a WSL path', () => {
    expect(
      basenameOf('/mnt/c/Users/david/Projects/claude-project-tracker'),
    ).toBe('claude-project-tracker');
  });

  it('extracts folder name from a Windows path', () => {
    expect(
      basenameOf('C:\\Users\\david\\Projects\\claude-project-tracker'),
    ).toBe('claude-project-tracker');
  });

  it('handles trailing forward slash', () => {
    expect(basenameOf('/home/david/foo/')).toBe('foo');
  });

  it('handles trailing backslash', () => {
    expect(basenameOf('C:\\Users\\david\\foo\\')).toBe('foo');
  });

  it('skips drive-letter-only segments', () => {
    expect(basenameOf('C:')).toBe('');
    expect(basenameOf('C:\\')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(basenameOf('')).toBe('');
  });

  it('handles mixed separators', () => {
    expect(basenameOf('C:/Users/david\\foo')).toBe('foo');
  });
});

describe('deriveProjectKey', () => {
  it('uses lowercased basename when cwd is present', () => {
    expect(
      deriveProjectKey(
        '/mnt/c/Users/david/Projects/Foo',
        'wsl',
        '-mnt-c-Foo',
      ),
    ).toBe('foo');
  });

  it('merges WSL and Windows cwds for the same folder', () => {
    const a = deriveProjectKey(
      '/mnt/c/Users/david/Projects/X',
      'wsl',
      '-mnt-c-X',
    );
    const b = deriveProjectKey(
      'C:\\Users\\david\\Projects\\X',
      'windows',
      'C--X',
    );
    expect(a).toBe(b);
    expect(a).toBe('x');
  });

  it('falls back to source-scoped dir name when cwd is empty', () => {
    expect(deriveProjectKey('', 'wsl', '-some-dir'))
      .toBe('wsl:-some-dir');
  });

  it('falls back when cwd yields no basename (root only)', () => {
    expect(deriveProjectKey('C:\\', 'windows', 'C--'))
      .toBe('windows:C--');
  });
});

describe('displayNameFromCwd', () => {
  it('preserves original casing for display', () => {
    expect(displayNameFromCwd('C:\\Users\\david\\Projects\\MyApp'))
      .toBe('MyApp');
  });

  it('returns empty string when cwd has no basename', () => {
    expect(displayNameFromCwd('')).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/project-key.test.ts`
Expected: FAIL — module `../src/project-key.ts` not found.

- [ ] **Step 3: Implement `project-key.ts`**

Create `server/src/project-key.ts`:

```ts
/**
 * Returns the last non-empty path segment, splitting on both / and \.
 * Works for WSL paths ("/mnt/c/foo") and Windows paths ("C:\\foo\\bar").
 * Drive-letter-only segments like "C:" are skipped.
 */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (!s) continue;
    if (s.endsWith(':')) continue;
    return s;
  }
  return '';
}

/**
 * Project identity key. Same folder name → same project, regardless of source
 * or absolute path. Falls back to a source-scoped dir name so sessions without
 * a cwd never merge across sources.
 */
export function deriveProjectKey(
  cwd: string,
  sourceId: string,
  dirName: string,
): string {
  const base = basenameOf(cwd);
  if (base.length > 0) return base.toLowerCase();
  return `${sourceId}:${dirName}`;
}

/**
 * Display name for a project, preserving the casing of the most recent cwd.
 */
export function displayNameFromCwd(cwd: string): string {
  return basenameOf(cwd);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/project-key.test.ts`
Expected: all 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/project-key.ts server/test/project-key.test.ts
git commit -m "feat(server): add project-key utility for cross-source grouping"
```

---

### Task 2: Sources config loader

**Files:**
- Create: `server/src/sources.ts`
- Test: `server/test/sources.test.ts`
- Modify: `.gitignore` (add `server/config/sources.json`)

- [ ] **Step 1: Write the failing tests**

Create `server/test/sources.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSources } from '../src/sources.ts';

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sources-test-'));
}

describe('loadSources', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('loads a valid config with multiple sources', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const src1 = join(dir, 'one');
    const src2 = join(dir, 'two');
    await mkdir(src1);
    await mkdir(src2);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'wsl', name: 'WSL', path: src1 },
          { id: 'windows', name: 'Windows', path: src2 },
        ],
      }),
    );
    const out = await loadSources(cfg, undefined);
    expect(out).toEqual([
      { id: 'wsl', name: 'WSL', path: src1 },
      { id: 'windows', name: 'Windows', path: src2 },
    ]);
  });

  it('falls back to env CLAUDE_DIR when config is missing', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const missing = join(dir, 'nope.json');
    const out = await loadSources(missing, '/tmp/fake-claude');
    expect(out).toEqual([
      { id: 'default', name: 'Default', path: '/tmp/fake-claude' },
    ]);
  });

  it('skips unreachable source paths with a warning', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const ok = join(dir, 'ok');
    await mkdir(ok);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'ok', name: 'OK', path: ok },
          { id: 'gone', name: 'Gone', path: '/definitely/not/here' },
        ],
      }),
    );
    const out = await loadSources(cfg, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ok');
  });

  it('throws on duplicate ids', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const a = join(dir, 'a');
    await mkdir(a);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'x', name: 'A', path: a },
          { id: 'x', name: 'B', path: a },
        ],
      }),
    );
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/duplicate source id: x/);
  });

  it('throws on invalid id characters', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const a = join(dir, 'a');
    await mkdir(a);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [{ id: 'Bad Id!', name: 'A', path: a }],
      }),
    );
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/invalid id/);
  });

  it('throws on malformed JSON', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, '{ not json');
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/malformed JSON/);
  });

  it('throws when sources is not an array', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, JSON.stringify({ sources: 'nope' }));
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/expected "sources" array/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/sources.test.ts`
Expected: FAIL — module `../src/sources.ts` not found.

- [ ] **Step 3: Implement `sources.ts`**

Create `server/src/sources.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';

export interface Source {
  id: string;
  name: string;
  path: string;
}

const ID_PATTERN = /^[a-z0-9_-]+$/;

export async function loadSources(
  configPath: string,
  envClaudeDir: string | undefined,
): Promise<Source[]> {
  const raw = await readFile(configPath, 'utf-8').catch(() => null);

  if (raw === null) {
    const fallback = envClaudeDir
      ?? `${process.env['HOME'] ?? ''}/.claude`;
    console.log(
      `[sources] ${configPath} not found; `
      + `using single source: ${fallback}`,
    );
    return [{ id: 'default', name: 'Default', path: fallback }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[sources] malformed JSON in ${configPath}: ${msg}`);
  }

  const list = (parsed as { sources?: unknown }).sources;
  if (!Array.isArray(list)) {
    throw new Error(
      `[sources] expected "sources" array in ${configPath}`,
    );
  }

  const seen = new Set<string>();
  const valid: Source[] = [];

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `[sources] source entry is not an object: ${JSON.stringify(entry)}`,
      );
    }
    const s = entry as { id?: unknown; name?: unknown; path?: unknown };
    if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) {
      throw new Error(
        `[sources] invalid id (must match [a-z0-9_-]+): ${String(s.id)}`,
      );
    }
    if (typeof s.name !== 'string' || s.name.length === 0) {
      throw new Error(`[sources] source ${s.id} missing non-empty name`);
    }
    if (typeof s.path !== 'string' || s.path.length === 0) {
      throw new Error(`[sources] source ${s.id} missing non-empty path`);
    }
    if (seen.has(s.id)) {
      throw new Error(`[sources] duplicate source id: ${s.id}`);
    }
    seen.add(s.id);
    valid.push({ id: s.id, name: s.name, path: s.path });
  }

  const reachable: Source[] = [];
  for (const src of valid) {
    try {
      await stat(src.path);
      reachable.push(src);
    } catch {
      console.warn(
        `[sources] skipping unreachable source "${src.id}" at ${src.path}`,
      );
    }
  }

  return reachable;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/sources.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Add to .gitignore**

Modify root `.gitignore`, appending:

```
# Multi-source tracker config
server/config/sources.json
```

- [ ] **Step 6: Commit**

```bash
git add server/src/sources.ts server/test/sources.test.ts .gitignore
git commit -m "feat(server): add sources config loader with env fallback"
```

---

### Task 3: Session/Project types + parser signature change

**Files:**
- Modify: `server/src/types.ts` (add `sourceId` to Session, `sources` to Project)
- Modify: `client/src/types.ts` (mirror)
- Modify: `server/src/parser.ts:239,437` (new signature)
- Modify: `server/test/parser.test.ts` (adapt test calls)

- [ ] **Step 1: Update server types**

Edit `server/src/types.ts`:

In the `Session` interface (around line 91), add `sourceId: string;` immediately after `id: string;`:

```ts
export interface Session {
  id: string;
  sourceId: string;
  projectId: string;
  // ... rest unchanged
```

In the `Project` interface (around line 117), add `sources: string[];` as the last field:

```ts
export interface Project {
  id: string;
  name: string;
  dirPath: string;
  sessionCount: number;
  liveCount: number;
  lastActivityAt: string;
  sources: string[];
}
```

- [ ] **Step 2: Mirror changes in client types**

Apply the identical additions to `client/src/types.ts` at the same positions.

- [ ] **Step 3: Update parser signature**

Edit `server/src/parser.ts`.

At the top, add the import after the existing imports:

```ts
import { deriveProjectKey } from './project-key.js';
```

Change the `parseSession` signature at line 239 from:

```ts
export async function parseSession(filePath: string, projectId: string): Promise<Session> {
```

to:

```ts
export async function parseSession(
  filePath: string,
  sourceId: string,
  dirName: string,
): Promise<Session> {
```

Inside `parseSession`, just before the `return { ... }` block at line 435 (after `const parentSessionId = detectParentSessionId(filePath);`), add:

```ts
const projectId = deriveProjectKey(cwd, sourceId, dirName);
```

Then in the returned object, add `sourceId,` after the `id` field:

```ts
return {
  id: sessionId,
  sourceId,
  projectId,
  filePath,
  // ... rest unchanged
```

- [ ] **Step 4: Update parser tests**

Edit `server/test/parser.test.ts`. Every call site of `parseSession(path, projectId)` becomes `parseSession(path, 'test-source', projectId)` — the second argument now represents sourceId, third represents the legacy dirName.

Use project-wide search to find all occurrences:

Run: `cd server && rg -n "parseSession\(" test/parser.test.ts`

For each occurrence, change `parseSession(X, Y)` to `parseSession(X, 'test-source', Y)`.

Also update any assertions that check session properties to account for the new `sourceId` field if needed (most won't care).

- [ ] **Step 5: Run parser tests to verify they pass**

Run: `cd server && npx vitest run test/parser.test.ts`
Expected: all existing parser tests PASS with the new signature.

- [ ] **Step 6: Commit**

```bash
git add server/src/types.ts client/src/types.ts server/src/parser.ts server/test/parser.test.ts
git commit -m "feat: add sourceId to Session, derive projectId from cwd basename"
```

---

### Task 4: Extract SourceWatcher from watcher.ts

**Files:**
- Create: `server/src/source-watcher.ts`
- Delete: `server/src/watcher.ts` (after Task 6 wiring — for now, it stays)
- Rename + modify: `server/test/watcher.test.ts` → `server/test/source-watcher.test.ts`

This task creates the per-source watcher as a standalone module without removing the old one yet. Full removal happens in Task 6 after the Registry is in place.

- [ ] **Step 1: Create `source-watcher.ts`**

Create `server/src/source-watcher.ts`:

```ts
import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import type { TrackerDB } from './db.js';
import type { Session } from './types.js';

export class SourceWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private projectsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private db: TrackerDB | null;

  constructor(
    public readonly sourceId: string,
    private claudeDir: string,
    db?: TrackerDB,
  ) {
    super();
    this.projectsDir = join(claudeDir, 'projects');
    this.db = db ?? null;
  }

  async start(): Promise<void> {
    await this.scanExisting();
    this.linkSubagents();
    this.watchDir();
  }

  private dirNameFromPath(filePath: string): string {
    const rel = relative(this.projectsDir, filePath);
    const firstSegment = rel.split(sep)[0];
    return firstSegment ?? basename(dirname(filePath));
  }

  private async scanExisting(): Promise<void> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return;
    }

    const parses: Promise<void>[] = [];

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const entries = await readdir(projectPath).catch(
        () => [] as string[],
      );

      for (const entry of entries) {
        const entryPath = join(projectPath, entry);

        if (entry.endsWith('.jsonl')) {
          parses.push(this.parseAndStore(entryPath, projectDir));
          continue;
        }

        const subagentsDir = join(entryPath, 'subagents');
        const subFiles = await readdir(subagentsDir).catch(
          () => [] as string[],
        );
        for (const subFile of subFiles) {
          if (!subFile.endsWith('.jsonl')) continue;
          parses.push(
            this.parseAndStore(
              join(subagentsDir, subFile),
              projectDir,
            ),
          );
        }
      }
    }

    await Promise.all(parses);
  }

  private async parseAndStore(
    filePath: string,
    dirName: string,
  ): Promise<void> {
    try {
      const session = await parseSession(
        filePath,
        this.sourceId,
        dirName,
      );
      this.sessions.set(session.id, session);
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

  private linkSubagents(): void {
    const childMap = new Map<string, Session[]>();
    for (const session of this.sessions.values()) {
      if (!session.isSubagent || !session.parentSessionId) continue;
      let children = childMap.get(session.parentSessionId);
      if (!children) {
        children = [];
        childMap.set(session.parentSessionId, children);
      }
      children.push(session);
    }

    for (const [parentId, children] of childMap) {
      const parent = this.sessions.get(parentId);
      if (!parent) continue;

      const agentToolCalls = parent.toolCalls.filter(
        tc => tc.toolName === 'Agent',
      );

      parent.subagents = children.map((child, i) => {
        const agentCall = agentToolCalls[i];
        const input = agentCall?.input as
          | { description?: string; subagent_type?: string }
          | undefined;

        return {
          sessionId: child.id,
          parentSessionId: parentId,
          description: input?.description,
          subagentType: input?.subagent_type,
          turnCount: child.turnCount,
          costUsd: child.costUsd,
          model: child.model,
          startedAt: child.startedAt,
          durationMs: child.durationMs,
        };
      });
    }
  }

  private watchDir(): void {
    this.watcher = watch(`${this.projectsDir}/**/*.jsonl`, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('add', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-created');
    });

    this.watcher.on('change', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-updated');
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleFileEvent(
    filePath: string,
    eventName: 'session-created' | 'session-updated',
  ): Promise<void> {
    const dirName = this.dirNameFromPath(filePath);
    const session = await parseSession(
      filePath,
      this.sourceId,
      dirName,
    ).catch(err => {
      console.error(
        `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (!session) return;
    this.sessions.set(session.id, session);

    if (session.isSubagent) {
      this.linkSubagents();
    }

    this.emit(eventName, session);
  }

  getAllSessions(): Session[] {
    return [...this.sessions.values()];
  }
}
```

- [ ] **Step 2: Rename and update the watcher test**

Run:
```bash
git mv server/test/watcher.test.ts server/test/source-watcher.test.ts
```

Edit `server/test/source-watcher.test.ts`:

Replace the import line:
```ts
import { SessionWatcher } from '../src/watcher.ts';
```
with:
```ts
import { SourceWatcher } from '../src/source-watcher.ts';
```

Replace the `describe` label:
```ts
describe('SessionWatcher subagent support', () => {
```
with:
```ts
describe('SourceWatcher subagent support', () => {
```

Every construction `new SessionWatcher(claudeDir)` becomes `new SourceWatcher('test-source', claudeDir)`.

The existing assertions check projectId values like `'-my-project'`. With the new parser semantics, when cwd is missing (as in these tests), the projectId falls back to `test-source:-my-project`. Update the assertions:

Change:
```ts
expect(all[0]!.projectId).toBe('-my-project');
```
to:
```ts
expect(all[0]!.projectId).toBe('test-source:-my-project');
```

Change:
```ts
expect(sub?.projectId).toBe('-my-project');
```
to:
```ts
expect(sub?.projectId).toBe('test-source:-my-project');
```

Also replace the call to `watcher.getSessions()` and `watcher.getProjects()` — **those methods no longer exist on SourceWatcher**. Replace with `watcher.getAllSessions()` and filter manually:

Change:
```ts
const sessions = watcher.getSessions();
expect(sessions).toHaveLength(1);
```
to:
```ts
const sessions = watcher.getAllSessions().filter(s => !s.isSubagent);
expect(sessions).toHaveLength(1);
```

Change:
```ts
const projects = watcher.getProjects();
expect(projects).toHaveLength(1);
expect(projects[0]!.sessionCount).toBe(1);
```
to:
```ts
// Project aggregation is tested at the registry level in registry.test.ts;
// here we just verify subagents are in the raw session map.
const all = watcher.getAllSessions();
expect(all.filter(s => !s.isSubagent)).toHaveLength(1);
expect(all.filter(s => s.isSubagent)).toHaveLength(1);
```

Also change:
```ts
const sub = watcher.getSession(parent.subagents[0]!.sessionId);
```
to:
```ts
const sub = watcher.getAllSessions().find(
  s => s.id === parent.subagents[0]!.sessionId,
);
```

- [ ] **Step 3: Run the renamed test to verify it passes**

Run: `cd server && npx vitest run test/source-watcher.test.ts`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/source-watcher.ts server/test/source-watcher.test.ts
git commit -m "feat(server): extract per-source watcher with sourceId tagging"
```

---

### Task 5: SessionRegistry

**Files:**
- Create: `server/src/registry.ts`
- Test: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/test/registry.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry } from '../src/registry.ts';
import type { Source } from '../src/sources.ts';

function makeUserLine(
  uuid: string,
  content: string,
  ts: string,
  cwd?: string,
): string {
  const rec: Record<string, unknown> = {
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    timestamp: ts,
    message: { role: 'user', content },
  };
  if (cwd) rec['cwd'] = cwd;
  return JSON.stringify(rec);
}

async function seedSession(
  claudeDir: string,
  dirName: string,
  sessionId: string,
  cwd: string,
  ts: string,
): Promise<void> {
  const projectDir = join(claudeDir, 'projects', dirName);
  await mkdir(projectDir, { recursive: true });
  const line = makeUserLine('u1', 'hello', ts, cwd);
  await writeFile(join(projectDir, `${sessionId}.jsonl`), line);
}

describe('SessionRegistry', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('merges sessions from two sources by basename cwd', async () => {
    const wslDir = await mkdtemp(join(tmpdir(), 'reg-wsl-'));
    const winDir = await mkdtemp(join(tmpdir(), 'reg-win-'));
    cleanup.push(wslDir, winDir);

    await seedSession(
      wslDir,
      '-mnt-c-Users-david-Projects-X',
      'sess-a',
      '/mnt/c/Users/david/Projects/X',
      '2026-04-01T10:00:00.000Z',
    );
    await seedSession(
      winDir,
      'C--Users-david-Projects-X',
      'sess-b',
      'C:\\Users\\david\\Projects\\X',
      '2026-04-02T10:00:00.000Z',
    );

    const sources: Source[] = [
      { id: 'wsl', name: 'WSL', path: wslDir },
      { id: 'windows', name: 'Windows', path: winDir },
    ];
    const reg = new SessionRegistry(sources);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('x');
      expect(projects[0]!.sessionCount).toBe(2);
      expect(projects[0]!.sources.sort()).toEqual(['wsl', 'windows'].sort());

      const sessions = reg.getSessions('x');
      expect(sessions).toHaveLength(2);
      // Most-recent first
      expect(sessions[0]!.id).toBe('sess-b');
      expect(sessions[0]!.sourceId).toBe('windows');
    } finally {
      await reg.stop();
    }
  });

  it('keeps sessions from same source grouped under one project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-single-'));
    cleanup.push(dir);
    await seedSession(
      dir,
      '-home-david-foo',
      's1',
      '/home/david/foo',
      '2026-04-01T10:00:00.000Z',
    );
    await seedSession(
      dir,
      '-home-david-foo',
      's2',
      '/home/david/foo',
      '2026-04-02T10:00:00.000Z',
    );

    const reg = new SessionRegistry([
      { id: 'wsl', name: 'WSL', path: dir },
    ]);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('foo');
      expect(projects[0]!.sources).toEqual(['wsl']);
      expect(reg.getSessions('foo')).toHaveLength(2);
    } finally {
      await reg.stop();
    }
  });

  it('falls back to source-scoped key when cwd is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-nocwd-'));
    cleanup.push(dir);
    await seedSession(
      dir,
      '-some-dir',
      's1',
      '',
      '2026-04-01T10:00:00.000Z',
    );

    const reg = new SessionRegistry([
      { id: 'wsl', name: 'WSL', path: dir },
    ]);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('wsl:-some-dir');
    } finally {
      await reg.stop();
    }
  });

  it('merges case-different basenames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reg-case-'));
    cleanup.push(dir);
    await seedSession(
      dir,
      '-foo',
      's1',
      '/home/user/Foo',
      '2026-04-01T10:00:00.000Z',
    );
    await seedSession(
      dir,
      '-FOO',
      's2',
      '/home/user/FOO',
      '2026-04-02T10:00:00.000Z',
    );

    const reg = new SessionRegistry([
      { id: 'wsl', name: 'WSL', path: dir },
    ]);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('foo');
      // Display name preserves the most-recent casing
      expect(projects[0]!.name).toBe('FOO');
    } finally {
      await reg.stop();
    }
  });

  it('continues starting other sources when one is unreachable', async () => {
    const ok = await mkdtemp(join(tmpdir(), 'reg-ok-'));
    cleanup.push(ok);
    await seedSession(
      ok,
      '-home-david-foo',
      's1',
      '/home/david/foo',
      '2026-04-01T10:00:00.000Z',
    );

    const reg = new SessionRegistry([
      { id: 'gone', name: 'Gone', path: '/definitely/not/here' },
      { id: 'ok', name: 'OK', path: ok },
    ]);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('foo');
    } finally {
      await reg.stop();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: FAIL — module `../src/registry.ts` not found.

- [ ] **Step 3: Implement `registry.ts`**

Create `server/src/registry.ts`:

```ts
import { EventEmitter } from 'node:events';
import { SourceWatcher } from './source-watcher.js';
import type { TrackerDB } from './db.js';
import type { Session, Project } from './types.js';
import type { Source } from './sources.js';
import { displayNameFromCwd } from './project-key.js';

export class SessionRegistry extends EventEmitter {
  private watchers: SourceWatcher[] = [];
  private sessions = new Map<string, Session>();
  private db: TrackerDB | null;

  constructor(
    private sources: Source[],
    db?: TrackerDB,
  ) {
    super();
    this.db = db ?? null;
  }

  async start(): Promise<void> {
    this.watchers = this.sources.map(
      s => new SourceWatcher(s.id, s.path, this.db ?? undefined),
    );

    const results = await Promise.allSettled(
      this.watchers.map(w => w.start()),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[registry] source "${this.sources[i]!.id}" failed to start:`,
          r.reason,
        );
      }
    });

    // Pull initially-scanned sessions into the unified map.
    for (const w of this.watchers) {
      for (const session of w.getAllSessions()) {
        this.ingest(session);
      }
    }

    // Subscribe to ongoing events after initial ingest so we don't double-count.
    for (const w of this.watchers) {
      w.on('session-created', (s: Session) => {
        this.ingest(s);
        this.emit('session-created', s);
      });
      w.on('session-updated', (s: Session) => {
        this.ingest(s);
        this.emit('session-updated', s);
      });
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.watchers.map(w => w.stop()));
  }

  private ingest(session: Session): void {
    const existing = this.sessions.get(session.id);
    if (existing && existing.sourceId !== session.sourceId) {
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
    this.sessions.set(session.id, session);
  }

  getProjects(): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      const existing = map.get(session.projectId);
      if (!existing) {
        map.set(session.projectId, {
          id: session.projectId,
          name: displayNameFromCwd(session.cwd) || session.projectId,
          dirPath: session.cwd,
          sessionCount: 1,
          liveCount: session.status === 'live' ? 1 : 0,
          lastActivityAt: session.lastActivityAt,
          sources: [session.sourceId],
        });
      } else {
        existing.sessionCount++;
        if (session.status === 'live') existing.liveCount++;
        if (session.lastActivityAt > existing.lastActivityAt) {
          existing.lastActivityAt = session.lastActivityAt;
          existing.dirPath = session.cwd;
          existing.name
            = displayNameFromCwd(session.cwd) || session.projectId;
        }
        if (!existing.sources.includes(session.sourceId)) {
          existing.sources.push(session.sourceId);
        }
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime()
        - new Date(a.lastActivityAt).getTime(),
    );
  }

  getSessions(projectId?: string): Session[] {
    const all = [...this.sessions.values()].filter(s => !s.isSubagent);
    const filtered = projectId
      ? all.filter(s => s.projectId === projectId)
      : all;
    return filtered.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime()
        - new Date(a.lastActivityAt).getTime(),
    );
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSources(): Source[] {
    return this.sources;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/registry.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.ts
git commit -m "feat(server): add SessionRegistry to merge sessions across sources"
```

---

### Task 6: Wire up index.ts and routes.ts; remove watcher.ts

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/routes.ts` (update type imports and watcher references)
- Delete: `server/src/watcher.ts`

- [ ] **Step 1: Update `index.ts`**

Replace the content of `server/src/index.ts`:

```ts
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { SessionRegistry } from './registry.js';
import { loadSources } from './sources.js';
import { TrackerDB } from './db.js';
import { buildApp } from './routes.js';

const sourcesConfigPath = process.env['SOURCES_CONFIG']
  ?? join(process.cwd(), 'config', 'sources.json');
const dataDir = process.env['DATA_DIR']
  ?? join(process.env['HOME'] ?? '.', '.claude', 'tracker');
const port = Number(process.env['PORT'] ?? 3001);

const sources = await loadSources(
  sourcesConfigPath,
  process.env['CLAUDE_DIR'],
);

if (sources.length === 0) {
  console.warn(
    '[server] starting with zero sources — projects and sessions will be empty',
  );
}

const db = new TrackerDB(join(dataDir, 'tracker.db'));
const registry = new SessionRegistry(sources, db);
await registry.start();

const app = buildApp(registry, db);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Sources:`);
  for (const s of sources) {
    console.log(`  - ${s.id} (${s.name}): ${s.path}`);
  }
  console.log(`Database: ${join(dataDir, 'tracker.db')}`);
});
```

- [ ] **Step 2: Update `routes.ts` — type imports and watcher references**

In `server/src/routes.ts`:

Replace the import of `SessionWatcher`:
```ts
import type { SessionWatcher } from './watcher.ts';
```
with:
```ts
import type { SessionRegistry } from './registry.ts';
```

Change the function signature of `buildApp`:
```ts
export function buildApp(
  watcher: SessionWatcher,
  db: TrackerDB,
  claudeDir: string,
): Hono {
```
to:
```ts
export function buildApp(
  registry: SessionRegistry,
  db: TrackerDB,
): Hono {
```

Remove the line:
```ts
const homeDir = claudeDir.replace(/\/\.claude$/, '');
```

Since `claudeDir` is no longer a parameter, config routes that referenced it need to target the first source. Right after `const app = new Hono();`, add:

```ts
const sources = registry.getSources();
const primarySource = sources[0];
if (!primarySource) {
  console.warn(
    '[routes] no sources configured — config management endpoints will 503',
  );
}
const primaryClaudeDir = primarySource?.path ?? '';
const primaryHomeDir = primaryClaudeDir.replace(/\/\.claude$/, '');
```

Then, replace every reference to `claudeDir` in config routes with `primaryClaudeDir`, and every reference to `homeDir` with `primaryHomeDir`.

Use search-and-replace:

Run: `cd server && rg -n "claudeDir|homeDir" src/routes.ts` — verify both identifiers only appear in the config/MCP routes. For each occurrence:
- `claudeDir` → `primaryClaudeDir`
- `homeDir` → `primaryHomeDir`

Replace every reference to the `watcher` variable with `registry`:
- `watcher.getProjects()` → `registry.getProjects()`
- `watcher.getSessions(...)` → `registry.getSessions(...)`
- `watcher.getSession(...)` → `registry.getSession(...)`
- `watcher.on(...)` / `watcher.off(...)` → `registry.on(...)` / `registry.off(...)`

Add a new endpoint right after the `/api/projects` route:

```ts
app.get('/api/sources', c => c.json(registry.getSources()));
```

- [ ] **Step 3: Delete `watcher.ts`**

```bash
rm server/src/watcher.ts
```

- [ ] **Step 4: Typecheck the server**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

If there are errors about `claudeDir` being unused or `sources` types, fix them inline.

- [ ] **Step 5: Run all server tests**

Run: `cd server && npx vitest run`
Expected: all tests PASS (parser, project-key, sources, source-watcher, registry).

- [ ] **Step 6: Smoke-test the server**

Start the server:
```bash
cd server && npx tsx src/index.ts &
```

In another shell, hit the endpoints:
```bash
curl -s http://localhost:3001/api/sources | head
curl -s http://localhost:3001/api/projects | head
```

Expected: `/api/sources` returns the single `default` source (since no `sources.json` exists); `/api/projects` returns a non-empty list from `~/.claude/projects`.

Stop the server:
```bash
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts server/src/routes.ts
git rm server/src/watcher.ts
git commit -m "refactor(server): wire registry + sources, remove legacy watcher"
```

---

### Task 7: DB schema version + FTS rebuild

**Files:**
- Modify: `server/src/db.ts`
- Modify: `server/src/registry.ts` (call `db.maybeRebuildFts()` during start)

The `projectId` semantic changed from encoded-dir-name to basename-slug. Existing FTS rows reference stale project ids. On version mismatch, wipe and re-index.

- [ ] **Step 1: Add schema version tracking and rebuild method to `db.ts`**

In `server/src/db.ts`:

Add a constant at the top of the file after imports:

```ts
const SCHEMA_VERSION = 2;
```

The existing `migrate` method stays as-is (it creates the tables on first run).

Add three new methods right after `migrate`:

```ts
currentSchemaVersion(): number {
  const row = this.db
    .prepare('SELECT version FROM schema_version LIMIT 1')
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

markSchemaVersion(version: number): void {
  this.db.exec('DELETE FROM schema_version');
  this.db
    .prepare('INSERT INTO schema_version (version) VALUES (?)')
    .run(version);
}

/**
 * If the stored schema version doesn't match the current one, drop and
 * recreate the FTS table. Caller is responsible for re-indexing sessions
 * after this returns.
 * Returns true if the FTS was rebuilt.
 */
maybeRebuildFts(): boolean {
  const stored = this.currentSchemaVersion();
  if (stored === SCHEMA_VERSION) return false;

  console.log(
    `[db] schema version ${stored} -> ${SCHEMA_VERSION}; `
    + 'rebuilding FTS index',
  );
  this.db.exec('DROP TABLE IF EXISTS session_fts');
  this.db.exec(`
    CREATE VIRTUAL TABLE session_fts USING fts5(
      session_id,
      project_id,
      title,
      content,
      tokenize='porter unicode61'
    );
  `);
  this.markSchemaVersion(SCHEMA_VERSION);
  return true;
}
```

- [ ] **Step 2: Call rebuild + re-index from `SessionRegistry.start`**

Edit `server/src/registry.ts`.

In the `start()` method, immediately after the initial-ingest loop and before the subscribe-to-ongoing-events section, add:

```ts
if (this.db && this.db.maybeRebuildFts()) {
  for (const session of this.sessions.values()) {
    if (session.isSubagent) continue;
    this.db.indexSession(session);
  }
}
```

This runs once on version bump, re-indexing every non-subagent session in memory.

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run all server tests**

Run: `cd server && npx vitest run`
Expected: all tests PASS.

- [ ] **Step 5: Smoke-test the rebuild**

Move any existing tracker DB aside, start the server, let it scan, then search:

```bash
mv ~/.claude/tracker/tracker.db{,.bak} 2>/dev/null || true
cd server && npx tsx src/index.ts &
sleep 3
curl -s 'http://localhost:3001/api/search?q=hello' | head
kill %1
```

Expected: a non-empty JSON array. The server log shows `[db] schema version 0 -> 2; rebuilding FTS index`.

- [ ] **Step 6: Commit**

```bash
git add server/src/db.ts server/src/registry.ts
git commit -m "feat(server): rebuild FTS on schema version bump"
```

---

### Task 8: Client — useSources hook and source badges

**Files:**
- Create: `client/src/hooks/useSources.ts`
- Modify: `client/src/components/SessionList.tsx` (show source badge)
- Modify: `client/src/components/config/ConfigPanel.tsx` (show active source label)

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/useSources.ts`:

```ts
import { useEffect, useState } from 'react';

export interface Source {
  id: string;
  name: string;
  path: string;
}

export function useSources(): Source[] {
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/sources')
      .then(r => r.json() as Promise<Source[]>)
      .then(data => {
        if (!cancelled) setSources(data);
      })
      .catch(err => {
        console.error('[useSources] failed to load:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return sources;
}
```

- [ ] **Step 2: Add source badge to SessionList**

Edit `client/src/components/SessionList.tsx`.

Add the import near the top with other hook imports:

```ts
import { useSources } from '@/hooks/useSources.ts';
```

Inside the `SessionList` component, near the top of the function body, add:

```ts
const sources = useSources();
const sourceNameById = new Map(sources.map(s => [s.id, s.name]));
```

(Only show the badge when there's more than one source — no point adding visual noise for single-source users.)

In the session row JSX (around line 108-122), find the top row that shows status + relative time:

```tsx
<div className="flex items-center justify-between mb-1">
  <StatusBadge status={s.status} />
  <span className="text-[10px] text-gray-400">
    {formatRelative(s.lastActivityAt)}
  </span>
</div>
```

Replace with:

```tsx
<div className="flex items-center justify-between mb-1">
  <div className="flex items-center gap-1.5">
    <StatusBadge status={s.status} />
    {sources.length > 1 && sourceNameById.has(s.sourceId) && (
      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium
        bg-gray-100 text-gray-600 uppercase tracking-wide">
        {sourceNameById.get(s.sourceId)}
      </span>
    )}
  </div>
  <span className="text-[10px] text-gray-400">
    {formatRelative(s.lastActivityAt)}
  </span>
</div>
```

- [ ] **Step 3: Add source label to ConfigPanel header**

Read the current ConfigPanel to find the title area:

```bash
head -60 client/src/components/config/ConfigPanel.tsx
```

Locate the header element containing the panel title (it will have text like "Configuration" or "Settings"). Immediately after the title, inject a small label. Add the import at the top:

```ts
import { useSources } from '@/hooks/useSources.ts';
```

In the component body, add:

```ts
const sources = useSources();
const primary = sources[0];
```

Next to the panel title, render:

```tsx
{primary && (
  <span className="ml-2 text-[10px] font-normal text-gray-500">
    Editing: {primary.name}
  </span>
)}
```

If the existing layout doesn't have a clear place to inject this, add it just below the main title line within the same header container so it reads as secondary text.

- [ ] **Step 4: Typecheck the client**

Run: `cd client && npx tsc --noEmit --allowImportingTsExtensions`
Expected: no errors.

- [ ] **Step 5: Manual UI check**

Start the full dev stack:
```bash
pnpm dev
```

With a default single-source setup, confirm:
- The session list renders without a source badge (single source means no badge).
- The config panel shows "Editing: Default" next to its title.

Then create `server/config/sources.json` with two entries pointing at two `.claude` directories, restart the server, and confirm:
- Session rows now show a small badge (WSL / Windows / etc.).
- A project folder that has sessions from both sides shows them merged in the session list.

Stop the dev server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useSources.ts client/src/components/SessionList.tsx client/src/components/config/ConfigPanel.tsx
git commit -m "feat(client): show per-session source badge and config panel label"
```

---

### Task 9: Cross-source integration test with fixtures

**Files:**
- Create: `server/test/fixtures/sources/wsl/projects/-mnt-c-Users-david-Projects-Demo/sess-w.jsonl`
- Create: `server/test/fixtures/sources/windows/projects/C--Users-david-Projects-Demo/sess-n.jsonl`
- Create: `server/test/multi-source.integration.test.ts`

- [ ] **Step 1: Build the fixtures**

Run:
```bash
mkdir -p server/test/fixtures/sources/wsl/projects/-mnt-c-Users-david-Projects-Demo
mkdir -p server/test/fixtures/sources/windows/projects/C--Users-david-Projects-Demo
```

Write `server/test/fixtures/sources/wsl/projects/-mnt-c-Users-david-Projects-Demo/sess-w.jsonl`:

```json
{"type":"user","uuid":"w1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-10T10:00:00.000Z","cwd":"/mnt/c/Users/david/Projects/Demo","message":{"role":"user","content":"run from wsl"}}
```

Write `server/test/fixtures/sources/windows/projects/C--Users-david-Projects-Demo/sess-n.jsonl`:

```json
{"type":"user","uuid":"n1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-11T10:00:00.000Z","cwd":"C:\\Users\\david\\Projects\\Demo","message":{"role":"user","content":"run from windows"}}
```

(Each file is a single-line JSONL record with a `cwd` for the same basename `Demo`.)

- [ ] **Step 2: Write the integration test**

Create `server/test/multi-source.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/registry.ts';
import type { Source } from '../src/sources.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, 'fixtures', 'sources');

describe('multi-source integration', () => {
  let registry: SessionRegistry;

  beforeAll(async () => {
    const sources: Source[] = [
      { id: 'wsl', name: 'WSL', path: join(FIXTURES, 'wsl') },
      { id: 'windows', name: 'Windows', path: join(FIXTURES, 'windows') },
    ];
    registry = new SessionRegistry(sources);
    await registry.start();
  });

  afterAll(async () => {
    await registry.stop();
  });

  it('merges Demo into a single project', () => {
    const projects = registry.getProjects();
    const demo = projects.find(p => p.id === 'demo');
    expect(demo).toBeDefined();
    expect(demo!.sessionCount).toBe(2);
    expect(demo!.sources.sort()).toEqual(['windows', 'wsl']);
  });

  it('exposes sessions with correct sourceId tags', () => {
    const sessions = registry.getSessions('demo');
    expect(sessions).toHaveLength(2);
    const bySource = Object.fromEntries(
      sessions.map(s => [s.sourceId, s.id]),
    );
    expect(bySource['wsl']).toBe('sess-w');
    expect(bySource['windows']).toBe('sess-n');
  });

  it('uses the most-recently-active cwd casing for the display name', () => {
    const projects = registry.getProjects();
    const demo = projects.find(p => p.id === 'demo');
    // sess-n (Windows) is newer; its cwd basename is "Demo".
    expect(demo!.name).toBe('Demo');
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd server && npx vitest run test/multi-source.integration.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 4: Run the full suite once more**

Run: `pnpm test`
Expected: all tests across all files PASS.

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/sources server/test/multi-source.integration.test.ts
git commit -m "test(server): add cross-source merging integration test"
```

---

### Task 10: Example sources.json and README snippet

**Files:**
- Create: `server/config/sources.example.json` (committed; real one is gitignored)
- Modify: `CLAUDE.md` (short note on multi-source config)

- [ ] **Step 1: Add the example config**

Create `server/config/sources.example.json`:

```json
{
  "sources": [
    {
      "id": "wsl",
      "name": "WSL",
      "path": "/home/YOURUSER/.claude"
    },
    {
      "id": "windows",
      "name": "Windows",
      "path": "/mnt/c/Users/YOURUSER/.claude"
    }
  ]
}
```

- [ ] **Step 2: Document in CLAUDE.md**

Add a new section to `CLAUDE.md` (project root) under the existing "Architecture" section, immediately before "Key Conventions":

```markdown
## Multi-source setup

The tracker can watch multiple `.claude` directories (e.g. WSL and Windows on the same host). Copy `server/config/sources.example.json` to `server/config/sources.json` and edit paths to match your setup. Sessions for the same folder basename (case-insensitive) merge into one project regardless of source.

Without a `sources.json`, the tracker falls back to the `CLAUDE_DIR` env var (or `~/.claude`) as a single source.
```

- [ ] **Step 3: Commit**

```bash
git add server/config/sources.example.json CLAUDE.md
git commit -m "docs: document multi-source config and add example file"
```

---

## Self-Review

**Spec coverage:**
- Sources config file (spec §Sources config) → Task 2
- env-var fallback (spec) → Task 2
- Malformed/duplicate handling (spec) → Task 2
- Unreachable-path skip (spec) → Tasks 2 + 5 (one in loader, one at registry start)
- Project identity by basename (spec §Project identity) → Task 1
- Basename extraction handles `/` and `\`, drive letters (spec) → Task 1
- Cwd-missing fallback (spec) → Tasks 1 + 3 (parser now calls deriveProjectKey) + test in Task 4
- Display name preserves casing (spec) → Task 1 + Task 5 registry
- `Session.sourceId` added (spec §Data model) → Task 3
- `Project.sources[]` added (spec §Data model) → Task 3
- Per-source watcher module (spec §Watcher architecture) → Task 4
- SessionRegistry merge (spec §Watcher architecture) → Task 5
- Session ID collision handling (spec) → Task 5 `ingest`
- Startup resilience via Promise.allSettled (spec) → Task 5
- `GET /api/sources` (spec §API surface) → Task 6
- Config routes target first source (spec §API surface) → Task 6
- `schema_version` + FTS rebuild (spec §Database) → Task 7
- Source badges in UI (spec §UI) → Task 8
- Config panel source label (spec §UI) → Task 8
- Test coverage enumerated in spec §Testing → Tasks 1, 2, 5, 9 + renamed watcher test in Task 4

**Placeholder scan:** no "TBD", "TODO", "implement later", or skipped details. Every code step contains the full code.

**Type consistency:**
- `Source` interface defined once in `sources.ts`, imported everywhere.
- `SourceWatcher` ctor: `(sourceId, claudeDir, db?)` — consistent across Task 4, Task 5, Task 9.
- `SessionRegistry` ctor: `(sources, db?)` — consistent across Task 5, Task 6, Task 9.
- `parseSession(filePath, sourceId, dirName)` — consistent across Tasks 3, 4.
- `Session.sourceId` string, added in Task 3, referenced in Tasks 4, 5, 8.
- `Project.sources: string[]`, set in Task 5, consumed in Task 8 indirectly (not rendered, but safe).
- DB methods: `maybeRebuildFts`, `currentSchemaVersion`, `markSchemaVersion` — defined in Task 7, only called from registry.

No inconsistencies found. Plan is ready for implementation.
