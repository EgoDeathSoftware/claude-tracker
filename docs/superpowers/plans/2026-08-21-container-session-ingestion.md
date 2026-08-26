# Container Session Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Claude Code sessions from agent containers in the dashboard, merged into the correct project, with a visible source indicator and a filter to isolate them.

**Architecture:** agent-shell now writes each container's `.claude` to a host directory carrying a `.tracker-origin.json` marker. A new `store-set` source layout expands one such directory into a child `Source` per store, each driven by an ordinary `SourceWatcher`. Transcripts record cwd `/workspace`, so the marker's `hostWorkspace` is used to rewrite cwd as a post-parse transform — leaving `parser.ts` and its 38 tests untouched — which lets container sessions merge into the same project as host sessions for the same folder.

**Tech Stack:** Node 22, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Hono 4, vitest, React 19, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-21-container-session-ingestion-design.md`

**Prerequisite:** The agent-shell plan (`agent-shell/docs/superpowers/plans/2026-08-21-claude-store-bind-mount.md`) must be complete through its Task 10.

---

## Conventions for every task

**All `pnpm`/`vitest` commands run inside the dev container.** `pnpm` is not set up on the host. The container mounts `server/src`, `server/test`, `client/src`, and `server/config` read-write, so host edits are picked up live.

```bash
docker compose exec app sh -c 'cd server && npx vitest run test/<file>'
```

**Test files must be written with `Bash` and `cat >`, never `Write`/`Edit`.** The `~/.claude/hooks/check-imports.sh` hook blocks `../` imports in `Write`/`Edit` for `.ts`/`.tsx`, and test files require relative imports (`../src/foo.ts`) under NodeNext resolution. Source files under `server/src` use `./foo.js` and are fine with `Write`.

**Type style:** optional properties must be declared `foo?: T | undefined` under `exactOptionalPropertyTypes`, and type-only imports must use `import type`.

---

## File Structure

| file | responsibility |
|---|---|
| `server/src/store-origin.ts` (new) | Pure: parse/synthesise a `StoreOrigin`, rewrite a container cwd to its host path, apply both to a `Session`. |
| `server/src/store-set-watcher.ts` (new) | Expand a `store-set` source into child sources, track store churn, and promote/demote live watching by store activity. |
| `server/src/sources.ts` | `layout`, `location`, `origin`, `parentId` on `Source`, with validation and defaults. |
| `server/src/source-watcher.ts` | Optional options argument: session transform and watch toggle. |
| `server/src/registry.ts` | Watcher map, `addSource`/`removeSource`, `SessionFilter`, `sources-changed`. |
| `server/src/routes.ts` | `?locations=` parsing, `sources-changed` over SSE. |
| `client/src/hooks/useSources.ts` | Mirror the new source fields. |
| `client/src/App.tsx`, `client/src/components/ProjectList.tsx` | Location filter state and checkboxes. |
| `client/src/components/SessionList.tsx`, `SessionDetail.tsx` | Container badge and provenance header. |

---

### Task 1: `rewriteCwd` and `synthesizeOrigin`

Every container transcript records cwd `/workspace` (`ai-agent.sh` mounts the workspace there with `-w /workspace`). `deriveProjectKey` keys projects on `basenameOf(cwd).toLowerCase()` (`server/src/project-key.ts:28-30`), so without a rewrite every container session in every project collapses into one project named `workspace`.

**Files:**
- Create: `server/src/store-origin.ts`
- Test: `server/test/store-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat > server/test/store-origin.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { rewriteCwd, synthesizeOrigin } from '../src/store-origin.ts';
import type { StoreOrigin } from '../src/store-origin.ts';

const origin: StoreOrigin = {
  container: 'vercel.ai',
  hostWorkspace: '/home/dave/Projects/agent-shell',
  workspaceMount: '/workspace',
};

describe('rewriteCwd', () => {
  it('maps the mount root to the host workspace', () => {
    expect(rewriteCwd('/workspace', origin)).toBe('/home/dave/Projects/agent-shell');
  });

  it('maps a path under the mount', () => {
    expect(rewriteCwd('/workspace/server/src', origin))
      .toBe('/home/dave/Projects/agent-shell/server/src');
  });

  it('leaves an unrelated path untouched', () => {
    expect(rewriteCwd('/etc/hosts', origin)).toBe('/etc/hosts');
  });

  it('does not match a prefix that is not a path boundary', () => {
    expect(rewriteCwd('/workspace-other/x', origin)).toBe('/workspace-other/x');
  });

  it('honours a custom workspaceMount', () => {
    const custom: StoreOrigin = { ...origin, workspaceMount: '/srv/work' };
    expect(rewriteCwd('/srv/work/a', custom)).toBe('/home/dave/Projects/agent-shell/a');
    expect(rewriteCwd('/workspace', custom)).toBe('/workspace');
  });

  it('defaults workspaceMount to /workspace when absent', () => {
    const noMount: StoreOrigin = { container: 'c', hostWorkspace: '/host/proj' };
    expect(rewriteCwd('/workspace', noMount)).toBe('/host/proj');
  });

  it('returns cwd unchanged when hostWorkspace is absent', () => {
    expect(rewriteCwd('/workspace', { container: 'c' })).toBe('/workspace');
  });

  it('handles a Windows hostWorkspace', () => {
    const win: StoreOrigin = { container: 'c', hostWorkspace: 'C:\\Users\\dave\\proj' };
    expect(rewriteCwd('/workspace', win)).toBe('C:\\Users\\dave\\proj');
  });
});

describe('synthesizeOrigin', () => {
  it('builds a fallback rooted at the store name', () => {
    expect(synthesizeOrigin('legacy-shared')).toEqual({
      container: 'legacy-shared',
      hostWorkspace: '/legacy-shared',
      workspaceMount: '/workspace',
    });
  });
});
EOF
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: FAIL — `Failed to resolve import "../src/store-origin.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/store-origin.ts`:

```ts
/**
 * Provenance for one agent container's Claude store, read from the
 * `.tracker-origin.json` marker that agent-shell writes at launch.
 */
export interface StoreOrigin {
  container: string;
  image?: string | undefined;
  hostWorkspace?: string | undefined;
  workspaceMount?: string | undefined;
  host?: string | undefined;
  updatedAt?: string | undefined;
}

const DEFAULT_MOUNT = '/workspace';

/**
 * Fallback origin for a store whose marker is missing, malformed, or lacks a
 * hostWorkspace. Keys the project on the store name rather than letting every
 * container collapse into a project called "workspace".
 */
export function synthesizeOrigin(storeName: string): StoreOrigin {
  return {
    container: storeName,
    hostWorkspace: `/${storeName}`,
    workspaceMount: DEFAULT_MOUNT,
  };
}

/**
 * Translate a cwd recorded inside a container into its host equivalent.
 * Returns cwd unchanged when it falls outside the workspace mount.
 */
export function rewriteCwd(cwd: string, origin: StoreOrigin): string {
  const hostWorkspace = origin.hostWorkspace;
  if (hostWorkspace === undefined || hostWorkspace.length === 0) return cwd;
  const mount = origin.workspaceMount ?? DEFAULT_MOUNT;
  if (cwd === mount) return hostWorkspace;
  if (cwd.startsWith(`${mount}/`)) return hostWorkspace + cwd.slice(mount.length);
  return cwd;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/store-origin.ts server/test/store-origin.test.ts
git commit -m "feat: add container cwd rewriting"
```

---

### Task 2: `readStoreOrigin`

The fallback keys on the **field**, not the file. The agent-shell migration script writes markers for pre-existing volumes with `container` set and `hostWorkspace` deliberately omitted, because the original workspace is unrecoverable. Those stores must take the fallback path while keeping the container name the marker does supply.

**Files:**
- Modify: `server/src/store-origin.ts`
- Test: `server/test/store-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/store-origin.test.ts <<'EOF'

describe('readStoreOrigin', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'store-origin-'));
  });

  const write = async (body: string): Promise<void> => {
    await writeFile(join(dir, '.tracker-origin.json'), body, 'utf-8');
  };

  it('reads a complete marker', async () => {
    await write(JSON.stringify({
      container: 'vercel.ai',
      image: 'ai-agent:latest',
      hostWorkspace: '/home/dave/proj',
      workspaceMount: '/workspace',
      host: 'boxy',
      updatedAt: '2026-08-21T22:14:03+01:00',
    }));
    const origin = await readStoreOrigin(dir, 'vercel.ai');
    expect(origin.hostWorkspace).toBe('/home/dave/proj');
    expect(origin.image).toBe('ai-agent:latest');
    expect(origin.host).toBe('boxy');
  });

  it('falls back when the marker is absent', async () => {
    const origin = await readStoreOrigin(dir, 'legacy-shared');
    expect(origin).toEqual(synthesizeOrigin('legacy-shared'));
  });

  it('falls back when hostWorkspace is omitted but keeps the container name', async () => {
    // This is exactly what the agent-shell migration writes for legacy volumes.
    await write(JSON.stringify({ container: 'legacy-shared', workspaceMount: '/workspace' }));
    const origin = await readStoreOrigin(dir, 'legacy-shared');
    expect(origin.hostWorkspace).toBe('/legacy-shared');
    expect(origin.container).toBe('legacy-shared');
  });

  it('falls back on malformed JSON', async () => {
    await write('{ not json');
    expect((await readStoreOrigin(dir, 'broken')).hostWorkspace).toBe('/broken');
  });

  it('falls back on truncated JSON', async () => {
    await write('{"container":"x","hostWorkspace":"/ho');
    expect((await readStoreOrigin(dir, 'trunc')).hostWorkspace).toBe('/trunc');
  });

  it('falls back when the root is not an object', async () => {
    await write('["nope"]');
    expect((await readStoreOrigin(dir, 'arr')).hostWorkspace).toBe('/arr');
  });

  it('falls back when hostWorkspace has the wrong type', async () => {
    await write(JSON.stringify({ container: 'x', hostWorkspace: 42 }));
    expect((await readStoreOrigin(dir, 'typed')).hostWorkspace).toBe('/typed');
  });

  it('defaults container to the store name when the marker omits it', async () => {
    await write(JSON.stringify({ hostWorkspace: '/home/dave/proj' }));
    const origin = await readStoreOrigin(dir, 'unnamed');
    expect(origin.container).toBe('unnamed');
    expect(origin.hostWorkspace).toBe('/home/dave/proj');
  });
});
EOF
```

Then update the import block at the top of the file. Replace the first three lines with:

```bash
python3 - <<'PY'
import pathlib
p = pathlib.Path('server/test/store-origin.test.ts')
s = p.read_text()
s = s.replace(
  "import { describe, it, expect } from 'vitest';\n"
  "import { rewriteCwd, synthesizeOrigin } from '../src/store-origin.ts';\n",
  "import { describe, it, expect, beforeEach } from 'vitest';\n"
  "import { mkdtemp, writeFile } from 'node:fs/promises';\n"
  "import { tmpdir } from 'node:os';\n"
  "import { join } from 'node:path';\n"
  "import { rewriteCwd, synthesizeOrigin, readStoreOrigin } from '../src/store-origin.ts';\n",
  1)
p.write_text(s)
PY
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: FAIL — `readStoreOrigin is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `server/src/store-origin.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a store's provenance marker. Never rejects: any unusable marker —
 * missing, malformed, or lacking hostWorkspace — resolves to a synthesised
 * origin keyed on the store directory name.
 */
export async function readStoreOrigin(
  storePath: string,
  storeName: string,
): Promise<StoreOrigin> {
  const fallback = synthesizeOrigin(storeName);
  const raw = await readFile(join(storePath, '.tracker-origin.json'), 'utf-8')
    .catch(() => null);
  if (raw === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fallback;
  }

  const marker = parsed as Record<string, unknown>;
  const hostWorkspace = stringOrUndefined(marker['hostWorkspace']);
  if (hostWorkspace === undefined) {
    return {
      ...fallback,
      container: stringOrUndefined(marker['container']) ?? storeName,
      image: stringOrUndefined(marker['image']),
      host: stringOrUndefined(marker['host']),
      updatedAt: stringOrUndefined(marker['updatedAt']),
    };
  }

  return {
    container: stringOrUndefined(marker['container']) ?? storeName,
    image: stringOrUndefined(marker['image']),
    hostWorkspace,
    workspaceMount: stringOrUndefined(marker['workspaceMount']) ?? DEFAULT_MOUNT,
    host: stringOrUndefined(marker['host']),
    updatedAt: stringOrUndefined(marker['updatedAt']),
  };
}
```

Move the two `import` lines to the top of the file — TypeScript requires imports before other statements.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/store-origin.ts server/test/store-origin.test.ts
git commit -m "feat: read container store provenance markers"
```

---

### Task 3: `applyOrigin`

**Files:**
- Modify: `server/src/store-origin.ts`
- Test: `server/test/store-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/store-origin.test.ts <<'EOF'

describe('applyOrigin', () => {
  const baseSession = {
    id: 's1',
    sourceId: 'agents:vercel.ai',
    projectId: 'workspace',
    filePath: '/claude/agents/vercel.ai/projects/-workspace/s1.jsonl',
    slug: 's1',
    title: 'A session',
    status: 'done' as const,
    turnCount: 3,
    costUsd: 0.5,
    model: 'claude-opus-5',
    startedAt: '2026-08-21T10:00:00Z',
    lastActivityAt: '2026-08-21T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [],
    logEntries: [],
    toolCalls: [],
    fileChanges: [],
    costBreakdown: { byTool: {}, conversationCost: 0, toolCost: 0, totalCost: 0 },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
  };

  it('rewrites cwd and recomputes projectId', () => {
    const out = applyOrigin(baseSession, {
      container: 'vercel.ai',
      hostWorkspace: '/home/dave/Projects/agent-shell',
    });
    expect(out.cwd).toBe('/home/dave/Projects/agent-shell');
    expect(out.projectId).toBe('agent-shell');
  });

  it('derives the key from a Windows hostWorkspace', () => {
    const out = applyOrigin(baseSession, {
      container: 'c',
      hostWorkspace: 'C:\\Users\\dave\\claude-project-tracker',
    });
    expect(out.projectId).toBe('claude-project-tracker');
  });

  it('keys on the store name under the fallback origin', () => {
    const out = applyOrigin(baseSession, synthesizeOrigin('legacy-shared'));
    expect(out.projectId).toBe('legacy-shared');
  });

  it('changes nothing else about the session', () => {
    const out = applyOrigin(baseSession, {
      container: 'c',
      hostWorkspace: '/home/dave/proj',
    });
    expect({ ...out, cwd: baseSession.cwd, projectId: baseSession.projectId })
      .toEqual(baseSession);
  });

  it('does not mutate the input session', () => {
    applyOrigin(baseSession, { container: 'c', hostWorkspace: '/home/dave/proj' });
    expect(baseSession.cwd).toBe('/workspace');
    expect(baseSession.projectId).toBe('workspace');
  });
});
EOF
```

Add `applyOrigin` to the import list:

```bash
python3 - <<'PY'
import pathlib
p = pathlib.Path('server/test/store-origin.test.ts')
s = p.read_text()
s = s.replace(
  "import { rewriteCwd, synthesizeOrigin, readStoreOrigin } from '../src/store-origin.ts';",
  "import {\n  rewriteCwd, synthesizeOrigin, readStoreOrigin, applyOrigin,\n} from '../src/store-origin.ts';",
  1)
p.write_text(s)
PY
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: FAIL — `applyOrigin is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `server/src/store-origin.ts`, and add `import type { Session } from './types.js';` plus `import { deriveProjectKey } from './project-key.js';` to the imports at the top:

```ts
/**
 * Return a copy of `session` with its container-local cwd translated to the
 * host path and its project key recomputed, so container sessions merge with
 * host sessions for the same folder.
 */
export function applyOrigin(session: Session, origin: StoreOrigin): Session {
  const cwd = rewriteCwd(session.cwd, origin);
  return {
    ...session,
    cwd,
    projectId: deriveProjectKey(cwd, session.sourceId, origin.container),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-origin.test.ts'`
Expected: PASS, 22 tests

- [ ] **Step 5: Typecheck**

Run: `docker compose exec app sh -c 'cd server && npx tsc --noEmit'`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add server/src/store-origin.ts server/test/store-origin.test.ts
git commit -m "feat: apply store provenance to parsed sessions"
```

---

### Task 4: `layout` and `location` on `Source`

**Files:**
- Modify: `server/src/sources.ts`
- Test: `server/test/sources.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/sources.test.ts <<'EOF'

describe('layout and location', () => {
  it('defaults layout to single and location to host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sources-layout-'));
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, JSON.stringify({
      sources: [{ id: 'wsl', name: 'WSL', path: dir }],
    }), 'utf-8');
    const sources = await loadSources(cfg, undefined);
    expect(sources[0]?.layout).toBe('single');
    expect(sources[0]?.location).toBe('host');
  });

  it('accepts an explicit store-set layout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sources-layout-'));
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, JSON.stringify({
      sources: [{ id: 'agents', name: 'Agents', path: dir, layout: 'store-set' }],
    }), 'utf-8');
    const sources = await loadSources(cfg, undefined);
    expect(sources[0]?.layout).toBe('store-set');
    expect(sources[0]?.location).toBe('host');
  });

  it('rejects an unknown layout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sources-layout-'));
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, JSON.stringify({
      sources: [{ id: 'agents', name: 'Agents', path: dir, layout: 'nested' }],
    }), 'utf-8');
    await expect(loadSources(cfg, undefined)).rejects.toThrow(/invalid layout/);
  });

  it('gives the env-var fallback source the defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sources-layout-'));
    const sources = await loadSources(join(dir, 'absent.json'), dir);
    expect(sources[0]?.layout).toBe('single');
    expect(sources[0]?.location).toBe('host');
  });
});
EOF
```

If `sources.test.ts` does not already import `mkdtemp`, `writeFile`, `tmpdir`, and `join`, add them — check the existing imports first with `head -10 server/test/sources.test.ts` and only add what is missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/sources.test.ts'`
Expected: FAIL — `expected undefined to be 'single'`

- [ ] **Step 3: Write minimal implementation**

In `server/src/sources.ts`, add the types below `SourceKind` and extend `Source`:

```ts
export type SourceLocation = 'host' | 'container';
export type SourceLayout = 'single' | 'store-set';

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  layout: SourceLayout;
  location: SourceLocation;
  configPath?: string | undefined;
  origin?: StoreOrigin | undefined;
  parentId?: string | undefined;
}
```

Add `import type { StoreOrigin } from './store-origin.js';` at the top.

In the validation loop, after the `kind` block, add:

```ts
    let layout: SourceLayout;
    if (s.layout === undefined) {
      layout = 'single';
    } else if (s.layout === 'single' || s.layout === 'store-set') {
      layout = s.layout;
    } else {
      throw new Error(
        `[sources] invalid layout (must be "single" or "store-set"): `
        + `${String(s.layout)}`,
      );
    }
```

Add `layout?: unknown;` to the destructured `s` type annotation. Then set `layout` and `location: 'host'` in both `valid.push(...)` branches, and add the same two fields to the env-var fallback return at `server/src/sources.ts:37`:

```ts
    return [{
      id: 'default', name: 'Default', path: fallback,
      kind: 'claude-code', layout: 'single', location: 'host',
    }];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/sources.test.ts'`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/sources.ts server/test/sources.test.ts
git commit -m "feat: add layout and location to source config"
```

---

### Task 5: `SourceWatcher` options

**Files:**
- Modify: `server/src/source-watcher.ts:15-29,80-100,143-159,168-192`
- Test: `server/test/source-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/source-watcher.test.ts <<'EOF'

describe('SourceWatcher options', () => {
  it('applies transformSession to scanned sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-transform-'));
    const projectDir = join(dir, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'a.jsonl'), [
      JSON.stringify({
        type: 'user', uuid: 'u1', timestamp: '2026-08-21T10:00:00Z',
        cwd: '/workspace', sessionId: 'sess-a',
        message: { role: 'user', content: 'hi' },
      }),
    ].join('\n'), 'utf-8');

    const watcher = new SourceWatcher('agents:demo', dir, undefined, {
      watch: false,
      transformSession: s => ({ ...s, cwd: '/host/demo', projectId: 'demo' }),
    });
    await watcher.start();
    await watcher.stop();

    const sessions = watcher.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe('/host/demo');
    expect(sessions[0]?.projectId).toBe('demo');
  });

  it('starts no filesystem watcher when watch is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-nowatch-'));
    await mkdir(join(dir, 'projects'), { recursive: true });
    const watcher = new SourceWatcher('agents:quiet', dir, undefined, { watch: false });
    await watcher.start();

    const events: string[] = [];
    watcher.on('session-created', () => events.push('created'));

    const projectDir = join(dir, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'late.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u9', timestamp: '2026-08-21T11:00:00Z',
      cwd: '/workspace', sessionId: 'sess-late',
      message: { role: 'user', content: 'later' },
    }), 'utf-8');
    await new Promise(r => setTimeout(r, 1500));
    await watcher.stop();

    expect(events).toEqual([]);
  });

  it('watches by default when no options are given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-default-'));
    await mkdir(join(dir, 'projects', '-workspace'), { recursive: true });
    const watcher = new SourceWatcher('agents:loud', dir);
    await watcher.start();

    const seen = new Promise<void>(resolve => {
      watcher.on('session-created', () => resolve());
    });
    await writeFile(join(dir, 'projects', '-workspace', 'new.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u10', timestamp: '2026-08-21T11:00:00Z',
      cwd: '/workspace', sessionId: 'sess-new',
      message: { role: 'user', content: 'new' },
    }), 'utf-8');

    await seen;
    await watcher.stop();
  }, 10_000);
});
EOF
```

Check the existing imports with `head -10 server/test/source-watcher.test.ts` and add any of `describe`, `it`, `expect`, `mkdtemp`, `mkdir`, `writeFile`, `tmpdir`, `join` that are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/source-watcher.test.ts'`
Expected: FAIL — the 4th constructor argument is rejected by `tsc`, and `cwd` is `/workspace` rather than `/host/demo`

- [ ] **Step 3: Write minimal implementation**

In `server/src/source-watcher.ts`, add above the class:

```ts
export interface SourceWatcherOptions {
  /** Start a filesystem watcher for live updates. Defaults to true. */
  watch?: boolean | undefined;
  /** Applied to every parsed session before it is stored or emitted. */
  transformSession?: ((session: Session) => Session) | undefined;
}
```

Change the constructor to accept and store the options:

```ts
  private readonly watchEnabled: boolean;
  private readonly transformSession: (session: Session) => Session;

  constructor(
    public readonly sourceId: string,
    private readonly claudeDir: string,
    db?: TrackerDB,
    options?: SourceWatcherOptions,
  ) {
    super();
    this.projectsDir = join(claudeDir, 'projects');
    this.db = db ?? null;
    this.watchEnabled = options?.watch ?? true;
    this.transformSession = options?.transformSession ?? (s => s);
  }
```

In `start()`, guard the watcher:

```ts
  async start(): Promise<void> {
    await this.scanExisting();
    this.linkSubagents();
    if (this.watchEnabled) this.watchDir();
  }
```

In `parseAndStore`, apply the transform to the parse result:

```ts
      const parsed = await parseSession(filePath, this.sourceId, dirName);
      const session = this.transformSession(parsed);
```

In `handleFileEvent`, apply it after the null check:

```ts
    if (!parsed) return;
    const session = this.transformSession(parsed);
    this.sessions.set(session.id, session);
```

Rename the local `session` binding in `handleFileEvent` to `parsed` so the transform result is what gets stored and emitted.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/source-watcher.test.ts'`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/source-watcher.ts server/test/source-watcher.test.ts
git commit -m "feat: add watch toggle and session transform to SourceWatcher"
```

---

### Task 6: Registry `addSource` / `removeSource`

`SessionRegistry.start()` builds its watcher list once (`server/src/registry.ts:39-72`). Containers come and go, so sources must be addable and removable at runtime.

**Files:**
- Modify: `server/src/registry.ts:24-97,157-159`
- Test: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/registry.test.ts <<'EOF'

describe('runtime source churn', () => {
  const makeStore = async (root: string, name: string, sessionId: string) => {
    const projectDir = join(root, name, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
      type: 'user', uuid: `u-${sessionId}`, timestamp: '2026-08-21T10:00:00Z',
      cwd: '/workspace', sessionId,
      message: { role: 'user', content: 'hi' },
    }), 'utf-8');
    return join(root, name);
  };

  it('adds a source at runtime and ingests its sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-add-'));
    const storePath = await makeStore(root, 'demo', 'sess-demo');
    const registry = new SessionRegistry([]);
    await registry.start();
    expect(registry.getSessions()).toHaveLength(0);

    await registry.addSource({
      id: 'agents:demo', name: 'demo', path: storePath,
      kind: 'claude-code', layout: 'single', location: 'container',
      origin: { container: 'demo', hostWorkspace: '/host/demo' },
    }, { watch: false });

    const sessions = registry.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.projectId).toBe('demo');
    expect(registry.getSources().map(s => s.id)).toContain('agents:demo');
    await registry.stop();
  });

  it('emits sources-changed on add and remove', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-evt-'));
    const storePath = await makeStore(root, 'demo', 'sess-evt');
    const registry = new SessionRegistry([]);
    await registry.start();

    let changes = 0;
    registry.on('sources-changed', () => { changes++; });

    await registry.addSource({
      id: 'agents:demo', name: 'demo', path: storePath,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });
    expect(changes).toBe(1);

    await registry.removeSource('agents:demo');
    expect(changes).toBe(2);
    await registry.stop();
  });

  it('drops the removed source sessions and leaves others intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-rm-'));
    const a = await makeStore(root, 'alpha', 'sess-alpha');
    const b = await makeStore(root, 'beta', 'sess-beta');
    const registry = new SessionRegistry([]);
    await registry.start();

    await registry.addSource({
      id: 'agents:alpha', name: 'alpha', path: a,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });
    await registry.addSource({
      id: 'agents:beta', name: 'beta', path: b,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });
    expect(registry.getSessions()).toHaveLength(2);

    await registry.removeSource('agents:alpha');
    const remaining = registry.getSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sourceId).toBe('agents:beta');
    expect(registry.getSources().map(s => s.id)).toEqual(['agents:beta']);
    await registry.stop();
  });

  it('removing an unknown source is a no-op', async () => {
    const registry = new SessionRegistry([]);
    await registry.start();
    await expect(registry.removeSource('nope')).resolves.toBeUndefined();
    await registry.stop();
  });
});
EOF
```

Add any missing imports (`mkdtemp`, `mkdir`, `writeFile`, `tmpdir`, `join`) after checking `head -10 server/test/registry.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/registry.test.ts'`
Expected: FAIL — `registry.addSource is not a function`

- [ ] **Step 3: Write minimal implementation**

In `server/src/registry.ts`, change `createWatcher` to take options and change the watcher store to a map:

```ts
function createWatcher(
  source: Source,
  db?: TrackerDB,
  options?: SourceWatcherOptions,
): AgentWatcher {
  switch (source.kind) {
    case 'claude-code':
      return new SourceWatcher(source.id, source.path, db, options);
    case 'opencode':
      return new OpenCodeWatcher(source.id, source.path, db);
  }
}
```

Replace `private watchers: AgentWatcher[] = [];` with:

```ts
  private watchers = new Map<string, AgentWatcher>();
  private locationBySourceId: Map<string, SourceLocation>;
```

Initialise `locationBySourceId` in the constructor alongside `kindBySourceId`:

```ts
    this.locationBySourceId = new Map(this.sources.map(s => [s.id, s.location]));
```

Rewrite `start()` to populate the map and route event subscription through one helper, then add the two new methods:

```ts
  private subscribe(watcher: AgentWatcher): void {
    watcher.on('session-created', (s: Session) => {
      this.ingest(s);
      this.emit('session-created', s);
    });
    watcher.on('session-updated', (s: Session) => {
      this.ingest(s);
      this.emit('session-updated', s);
    });
  }

  private watcherOptions(source: Source, watch: boolean): SourceWatcherOptions {
    const origin = source.origin;
    return {
      watch,
      transformSession: origin
        ? (s: Session) => applyOrigin(s, origin)
        : undefined,
    };
  }

  /** Register a source discovered after startup and ingest its sessions. */
  async addSource(source: Source, opts?: { watch?: boolean }): Promise<void> {
    if (this.watchers.has(source.id)) await this.removeSource(source.id);

    const watcher = createWatcher(
      source, this.db ?? undefined,
      this.watcherOptions(source, opts?.watch ?? true),
    );
    this.sources.push(source);
    this.kindBySourceId.set(source.id, source.kind);
    this.locationBySourceId.set(source.id, source.location);
    this.watchers.set(source.id, watcher);

    try {
      await watcher.start();
    } catch (err) {
      console.warn(`[registry] source "${source.id}" failed to start:`, err);
    }
    for (const session of watcher.getAllSessions()) this.ingest(session);
    this.subscribe(watcher);
    this.emit('sources-changed');
  }

  /** Deregister a source and drop the sessions it contributed. */
  async removeSource(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    await watcher.stop().catch(() => undefined);
    watcher.removeAllListeners();
    this.watchers.delete(id);
    this.kindBySourceId.delete(id);
    this.locationBySourceId.delete(id);
    this.sources = this.sources.filter(s => s.id !== id);
    for (const [sessionId, session] of this.sessions) {
      if (session.sourceId === id) this.sessions.delete(sessionId);
    }
    this.emit('sources-changed');
  }
```

Change the constructor parameter from `private sources: Source[]` to a mutable field, since `removeSource` reassigns it:

```ts
  constructor(
    private sources: Source[],
    db?: TrackerDB,
  ) {
```

`sources` is already a `private` field via the parameter property, so `this.sources = ...` is legal — no signature change needed beyond keeping it non-readonly.

Update `start()` and `stop()` to use the map:

```ts
  async start(): Promise<void> {
    for (const source of this.sources) {
      this.watchers.set(
        source.id,
        createWatcher(source, this.db ?? undefined, this.watcherOptions(source, true)),
      );
    }

    const entries = [...this.watchers.entries()];
    const results = await Promise.allSettled(entries.map(([, w]) => w.start()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`[registry] source "${entries[i]![0]}" failed to start:`, r.reason);
      }
    });

    for (const [, w] of entries) {
      for (const session of w.getAllSessions()) this.ingest(session);
    }
    for (const [, w] of entries) this.subscribe(w);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.watchers.values()].map(w => w.stop()));
  }
```

Add the imports: `import { applyOrigin } from './store-origin.js';`, `import type { SourceWatcherOptions } from './source-watcher.js';`, and add `SourceLocation` to the existing `import type { Source, SourceKind }` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/registry.test.ts'`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.ts
git commit -m "feat: support runtime source add and remove"
```

---

### Task 7: `SessionFilter` with locations

`getProjects` and `getSessions` currently take `kinds` positionally. They converge on one filter object rather than growing a third positional parameter.

**Files:**
- Modify: `server/src/registry.ts:99-151`, `server/src/routes.ts:75,82`
- Test: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/registry.test.ts <<'EOF'

describe('location filtering', () => {
  const seed = async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-loc-'));
    const mk = async (name: string, sessionId: string) => {
      const dir = join(root, name, 'projects', '-workspace');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'user', uuid: `u-${sessionId}`, timestamp: '2026-08-21T10:00:00Z',
        cwd: '/workspace', sessionId,
        message: { role: 'user', content: 'hi' },
      }), 'utf-8');
      return join(root, name);
    };
    const registry = new SessionRegistry([]);
    await registry.start();
    await registry.addSource({
      id: 'host-src', name: 'Host', path: await mk('hostish', 'sess-host'),
      kind: 'claude-code', layout: 'single', location: 'host',
      origin: { container: 'hostish', hostWorkspace: '/host/alpha' },
    }, { watch: false });
    await registry.addSource({
      id: 'agents:beta', name: 'beta', path: await mk('beta', 'sess-beta'),
      kind: 'claude-code', layout: 'single', location: 'container',
      origin: { container: 'beta', hostWorkspace: '/host/beta' },
    }, { watch: false });
    return registry;
  };

  it('returns everything with no filter', async () => {
    const r = await seed();
    expect(r.getSessions()).toHaveLength(2);
    expect(r.getProjects()).toHaveLength(2);
    await r.stop();
  });

  it('filters sessions by location', async () => {
    const r = await seed();
    const containers = r.getSessions(undefined, { locations: ['container'] });
    expect(containers).toHaveLength(1);
    expect(containers[0]?.sourceId).toBe('agents:beta');
    await r.stop();
  });

  it('filters projects by location', async () => {
    const r = await seed();
    const hosts = r.getProjects({ locations: ['host'] });
    expect(hosts.map(p => p.id)).toEqual(['alpha']);
    await r.stop();
  });

  it('combines kinds and locations', async () => {
    const r = await seed();
    expect(r.getSessions(undefined, {
      kinds: ['claude-code'], locations: ['container'],
    })).toHaveLength(1);
    expect(r.getSessions(undefined, {
      kinds: ['opencode'], locations: ['container'],
    })).toHaveLength(0);
    await r.stop();
  });

  it('an empty locations array matches nothing', async () => {
    const r = await seed();
    expect(r.getSessions(undefined, { locations: [] })).toHaveLength(0);
    await r.stop();
  });
});
EOF
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/registry.test.ts'`
Expected: FAIL — `getSessions` rejects the object argument under `tsc`

- [ ] **Step 3: Write minimal implementation**

In `server/src/registry.ts`, add above the class:

```ts
export interface SessionFilter {
  kinds?: SourceKind[] | undefined;
  locations?: SourceLocation[] | undefined;
}
```

Replace the two accessor signatures and their guard clauses:

```ts
  private matches(sourceId: string, filter?: SessionFilter): boolean {
    if (filter?.kinds && !filter.kinds.includes(this.kindBySourceId.get(sourceId)!)) {
      return false;
    }
    if (filter?.locations
      && !filter.locations.includes(this.locationBySourceId.get(sourceId)!)) {
      return false;
    }
    return true;
  }

  getProjects(filter?: SessionFilter): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      if (!this.matches(session.sourceId, filter)) continue;
      // ...existing body unchanged from here...
```

and

```ts
  getSessions(projectId?: string, filter?: SessionFilter): Session[] {
    const all = [...this.sessions.values()].filter(
      s => !s.isSubagent && this.matches(s.sourceId, filter),
    );
    // ...existing body unchanged from here...
```

Delete the now-unused `allowedKinds` locals from both methods.

Update the two call sites in `server/src/routes.ts`:

```ts
  app.get('/api/projects', c => c.json(registry.getProjects({ kinds: parseKinds(c) })));
```

```ts
    let sessions = registry.getSessions(projectId, { kinds: parseKinds(c) });
```

Then fix any pre-existing `registry.test.ts` cases that passed `kinds` positionally — search for `getSessions(` and `getProjects(` and wrap the kind arrays in `{ kinds: ... }`.

- [ ] **Step 4: Run the full server suite**

Run: `docker compose exec app sh -c 'cd server && npx vitest run'`
Expected: PASS. Every previously passing test must still pass — this task changes a shared signature, so a failure here means a call site was missed.

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/src/routes.ts server/test/registry.test.ts
git commit -m "feat: filter projects and sessions by source location"
```

---

### Task 8: `StoreSetWatcher` expansion

**Files:**
- Create: `server/src/store-set-watcher.ts`
- Test: `server/test/store-set-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat > server/test/store-set-watcher.test.ts <<'EOF'
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreSetWatcher } from '../src/store-set-watcher.ts';
import type { Source } from '../src/sources.ts';

const parent: Source = {
  id: 'agents', name: 'Agent Containers', path: '',
  kind: 'claude-code', layout: 'store-set', location: 'host',
};

function recordingSink() {
  const added: { source: Source; watch: boolean }[] = [];
  const removed: string[] = [];
  return {
    added, removed,
    addSource: async (source: Source, opts?: { watch?: boolean }) => {
      added.push({ source, watch: opts?.watch ?? true });
    },
    removeSource: async (id: string) => { removed.push(id); },
  };
}

async function makeStore(
  root: string, name: string, opts?: { marker?: object; jsonl?: boolean },
): Promise<string> {
  const store = join(root, name);
  await mkdir(store, { recursive: true });
  if (opts?.marker) {
    await writeFile(
      join(store, '.tracker-origin.json'), JSON.stringify(opts.marker), 'utf-8');
  }
  if (opts?.jsonl !== false) {
    const projectDir = join(store, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'a.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u1', timestamp: '2026-08-21T10:00:00Z',
      cwd: '/workspace', sessionId: `sess-${name}`,
      message: { role: 'user', content: 'hi' },
    }), 'utf-8');
  }
  return store;
}

describe('StoreSetWatcher expansion', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'store-set-')); });

  it('creates one child source per store directory', async () => {
    await makeStore(root, 'vercel.ai', {
      marker: { container: 'vercel.ai', hostWorkspace: '/home/dave/agent-shell' },
    });
    await makeStore(root, 'beta', {
      marker: { container: 'beta', hostWorkspace: '/home/dave/beta' },
    });

    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink);
    await w.start();
    await w.stop();

    const ids = sink.added.map(a => a.source.id).sort();
    expect(ids).toEqual(['agents:beta', 'agents:vercel.ai']);
    const vercel = sink.added.find(a => a.source.id === 'agents:vercel.ai')!.source;
    expect(vercel.location).toBe('container');
    expect(vercel.parentId).toBe('agents');
    expect(vercel.kind).toBe('claude-code');
    expect(vercel.name).toBe('vercel.ai');
    expect(vercel.path).toBe(join(root, 'vercel.ai'));
    expect(vercel.origin?.hostWorkspace).toBe('/home/dave/agent-shell');
  });

  it('synthesises an origin for a store with no marker', async () => {
    await makeStore(root, 'legacy-shared');
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink);
    await w.start();
    await w.stop();
    expect(sink.added[0]?.source.origin?.hostWorkspace).toBe('/legacy-shared');
  });

  it('tolerates a store with no projects directory', async () => {
    await makeStore(root, 'never-ran', { jsonl: false });
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink);
    await w.start();
    await w.stop();
    expect(sink.added.map(a => a.source.id)).toEqual(['agents:never-ran']);
  });

  it('ignores files at the root and tolerates a missing root', async () => {
    await writeFile(join(root, 'stray.txt'), 'x', 'utf-8');
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink);
    await w.start();
    await w.stop();
    expect(sink.added).toHaveLength(0);

    const absent = recordingSink();
    const w2 = new StoreSetWatcher({ ...parent, path: join(root, 'nope') }, absent);
    await expect(w2.start()).resolves.toBeUndefined();
    await w2.stop();
    expect(absent.added).toHaveLength(0);
  });
});
EOF
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-set-watcher.test.ts'`
Expected: FAIL — `Failed to resolve import "../src/store-set-watcher.ts"`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/store-set-watcher.ts`:

```ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readStoreOrigin } from './store-origin.js';
import type { Source } from './sources.js';

/** The subset of SessionRegistry a StoreSetWatcher drives. */
export interface SourceSink {
  addSource(source: Source, opts?: { watch?: boolean }): Promise<void>;
  removeSource(id: string): Promise<void>;
}

/**
 * Expands a `store-set` source — a directory of per-container Claude stores —
 * into one child Source per store.
 */
export class StoreSetWatcher {
  private known = new Set<string>();

  constructor(
    private readonly parent: Source,
    private readonly sink: SourceSink,
  ) {}

  async start(): Promise<void> {
    await this.sync();
  }

  async stop(): Promise<void> {
    // No timers yet; the polling loop arrives in the next task.
  }

  childId(storeName: string): string {
    return `${this.parent.id}:${storeName}`;
  }

  private async listStores(): Promise<string[]> {
    const entries = await readdir(this.parent.path, { withFileTypes: true })
      .catch(() => []);
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  private async buildChild(storeName: string): Promise<Source> {
    const path = join(this.parent.path, storeName);
    return {
      id: this.childId(storeName),
      name: storeName,
      path,
      kind: this.parent.kind,
      layout: 'single',
      location: 'container',
      origin: await readStoreOrigin(path, storeName),
      parentId: this.parent.id,
    };
  }

  protected async sync(): Promise<void> {
    const stores = await this.listStores();
    for (const storeName of stores) {
      if (this.known.has(storeName)) continue;
      this.known.add(storeName);
      await this.sink.addSource(await this.buildChild(storeName));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-set-watcher.test.ts'`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/store-set-watcher.ts server/test/store-set-watcher.test.ts
git commit -m "feat: expand a store-set source into per-container sources"
```

---

### Task 9: Store churn and activity-based watching

Stores are permanent and accumulate — one per container ever launched. Attaching a chokidar watcher to each would leave dozens of pollers stat-ing dead trees every second, since `SourceWatcher` runs `usePolling: true, interval: 1000` (`server/src/source-watcher.ts:144-150`). Every store's sessions are still parsed and served; only the live watch is rationed.

Reactivation is detected through the marker: `ai-agent.sh` rewrites `.tracker-origin.json` on every launch, so a changed marker mtime means a container just started.

**Files:**
- Modify: `server/src/store-set-watcher.ts`
- Test: `server/test/store-set-watcher.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/store-set-watcher.test.ts <<'EOF'

describe('StoreSetWatcher churn and activity', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'store-churn-')); });

  const ageFile = async (path: string, days: number): Promise<void> => {
    const when = new Date(Date.now() - days * 86_400_000);
    await utimes(path, when, when);
  };

  it('adds a store that appears after start', async () => {
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, { pollMs: 0 });
    await w.start();
    expect(sink.added).toHaveLength(0);

    await makeStore(root, 'late', {
      marker: { container: 'late', hostWorkspace: '/home/dave/late' },
    });
    await w.pollOnce();
    expect(sink.added.map(a => a.source.id)).toEqual(['agents:late']);
    await w.stop();
  });

  it('removes a store that disappears', async () => {
    await makeStore(root, 'doomed', {
      marker: { container: 'doomed', hostWorkspace: '/home/dave/doomed' },
    });
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, { pollMs: 0 });
    await w.start();
    expect(sink.added).toHaveLength(1);

    await rm(join(root, 'doomed'), { recursive: true, force: true });
    await w.pollOnce();
    expect(sink.removed).toEqual(['agents:doomed']);
    await w.stop();
  });

  it('does not re-add an unchanged store', async () => {
    await makeStore(root, 'steady', {
      marker: { container: 'steady', hostWorkspace: '/home/dave/steady' },
    });
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, { pollMs: 0 });
    await w.start();
    await w.pollOnce();
    await w.pollOnce();
    expect(sink.added).toHaveLength(1);
    await w.stop();
  });

  it('watches a recently active store and not a stale one', async () => {
    const fresh = await makeStore(root, 'fresh', {
      marker: { container: 'fresh', hostWorkspace: '/home/dave/fresh' },
    });
    const stale = await makeStore(root, 'stale', {
      marker: { container: 'stale', hostWorkspace: '/home/dave/stale' },
    });
    await ageFile(join(stale, 'projects', '-workspace', 'a.jsonl'), 30);
    await ageFile(join(stale, '.tracker-origin.json'), 30);
    void fresh;

    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, {
      pollMs: 0, activeDays: 14,
    });
    await w.start();

    const byId = new Map(sink.added.map(a => [a.source.id, a.watch]));
    expect(byId.get('agents:fresh')).toBe(true);
    expect(byId.get('agents:stale')).toBe(false);
    await w.stop();
  });

  it('a store with no transcripts is treated as inactive', async () => {
    await makeStore(root, 'empty', { jsonl: false });
    await ageFile(join(root, 'empty'), 30);
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, {
      pollMs: 0, activeDays: 14,
    });
    await w.start();
    expect(sink.added[0]?.watch).toBe(false);
    await w.stop();
  });

  it('promotes a stale store to watched when its marker is rewritten', async () => {
    const stale = await makeStore(root, 'relaunch', {
      marker: { container: 'relaunch', hostWorkspace: '/home/dave/relaunch' },
    });
    await ageFile(join(stale, 'projects', '-workspace', 'a.jsonl'), 30);
    await ageFile(join(stale, '.tracker-origin.json'), 30);

    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, {
      pollMs: 0, activeDays: 14,
    });
    await w.start();
    expect(sink.added[0]?.watch).toBe(false);

    // A relaunch rewrites the marker.
    await writeFile(
      join(stale, '.tracker-origin.json'),
      JSON.stringify({ container: 'relaunch', hostWorkspace: '/home/dave/relaunch' }),
      'utf-8');
    await w.pollOnce();

    expect(sink.removed).toEqual(['agents:relaunch']);
    expect(sink.added).toHaveLength(2);
    expect(sink.added[1]?.watch).toBe(true);
    await w.stop();
  });

  it('stop clears the timer so no further polling occurs', async () => {
    await makeStore(root, 'timed', {
      marker: { container: 'timed', hostWorkspace: '/home/dave/timed' },
    });
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink, { pollMs: 20 });
    await w.start();
    await w.stop();
    const countAfterStop = sink.added.length;
    await new Promise(r => setTimeout(r, 100));
    expect(sink.added).toHaveLength(countAfterStop);
  });
});
EOF
```

Extend the import line at the top of the file:

```bash
python3 - <<'PY'
import pathlib
p = pathlib.Path('server/test/store-set-watcher.test.ts')
s = p.read_text()
s = s.replace(
  "import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';",
  "import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';", 1)
p.write_text(s)
PY
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-set-watcher.test.ts'`
Expected: FAIL — `w.pollOnce is not a function`

- [ ] **Step 3: Write minimal implementation**

Rewrite the body of `server/src/store-set-watcher.ts` below the `SourceSink` interface:

```ts
export interface StoreSetWatcherOptions {
  /** Days of inactivity after which a store stops being watched live. */
  activeDays?: number | undefined;
  /** Poll interval in ms. 0 disables the timer; call pollOnce() manually. */
  pollMs?: number | undefined;
}

interface StoreState {
  watched: boolean;
  markerMtimeMs: number;
}

const DEFAULT_ACTIVE_DAYS = 14;
const DEFAULT_POLL_MS = 30_000;

export class StoreSetWatcher {
  private known = new Map<string, StoreState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly activeDays: number;
  private readonly pollMs: number;

  constructor(
    private readonly parent: Source,
    private readonly sink: SourceSink,
    options?: StoreSetWatcherOptions,
  ) {
    this.activeDays = options?.activeDays ?? DEFAULT_ACTIVE_DAYS;
    this.pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  }

  async start(): Promise<void> {
    await this.pollOnce();
    if (this.pollMs > 0) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  childId(storeName: string): string {
    return `${this.parent.id}:${storeName}`;
  }

  private async listStores(): Promise<string[]> {
    const entries = await readdir(this.parent.path, { withFileTypes: true })
      .catch(() => []);
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  private async markerMtimeMs(storePath: string): Promise<number> {
    const info = await stat(join(storePath, '.tracker-origin.json'))
      .catch(() => null);
    return info?.mtimeMs ?? 0;
  }

  /** Newest transcript mtime in the store, or 0 when it holds none. */
  private async newestTranscriptMs(storePath: string): Promise<number> {
    const projectsDir = join(storePath, 'projects');
    const projectDirs = await readdir(projectsDir).catch(() => [] as string[]);
    let newest = 0;
    for (const projectDir of projectDirs) {
      const dir = join(projectsDir, projectDir);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const info = await stat(join(dir, file)).catch(() => null);
        if (info && info.mtimeMs > newest) newest = info.mtimeMs;
      }
    }
    return newest;
  }

  private async isActive(storePath: string): Promise<boolean> {
    const newest = await this.newestTranscriptMs(storePath);
    if (newest === 0) return false;
    return Date.now() - newest < this.activeDays * 86_400_000;
  }

  private async buildChild(storeName: string): Promise<Source> {
    const path = join(this.parent.path, storeName);
    return {
      id: this.childId(storeName),
      name: storeName,
      path,
      kind: this.parent.kind,
      layout: 'single',
      location: 'container',
      origin: await readStoreOrigin(path, storeName),
      parentId: this.parent.id,
    };
  }

  private async attach(storeName: string): Promise<StoreState> {
    const path = join(this.parent.path, storeName);
    const watched = await this.isActive(path);
    await this.sink.addSource(await this.buildChild(storeName), { watch: watched });
    return { watched, markerMtimeMs: await this.markerMtimeMs(path) };
  }

  /**
   * One reconciliation pass: pick up new stores, drop removed ones, and
   * promote a store whose marker was rewritten — which is what a container
   * relaunch looks like from the host.
   */
  async pollOnce(): Promise<void> {
    const stores = new Set(await this.listStores());

    for (const storeName of [...this.known.keys()]) {
      if (stores.has(storeName)) continue;
      this.known.delete(storeName);
      await this.sink.removeSource(this.childId(storeName));
    }

    for (const storeName of stores) {
      const state = this.known.get(storeName);
      if (!state) {
        this.known.set(storeName, await this.attach(storeName));
        continue;
      }
      const path = join(this.parent.path, storeName);
      const markerMtimeMs = await this.markerMtimeMs(path);
      if (markerMtimeMs === state.markerMtimeMs) continue;

      const shouldWatch = await this.isActive(path);
      if (shouldWatch === state.watched) {
        this.known.set(storeName, { ...state, markerMtimeMs });
        continue;
      }
      await this.sink.removeSource(this.childId(storeName));
      this.known.set(storeName, await this.attach(storeName));
    }
  }
}
```

Update the imports at the top to `import { readdir, stat } from 'node:fs/promises';`.

Note: the relaunch test expects promotion after a marker rewrite. The rewritten marker file is newly written, so `newestTranscriptMs` is still stale — promotion therefore keys on the marker being fresh. Add this to `isActive` so a just-relaunched store counts as active:

```ts
  private async isActive(storePath: string): Promise<boolean> {
    const cutoff = Date.now() - this.activeDays * 86_400_000;
    const marker = await this.markerMtimeMs(storePath);
    if (marker > cutoff) return true;
    const newest = await this.newestTranscriptMs(storePath);
    return newest > 0 && newest > cutoff;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/store-set-watcher.test.ts'`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/store-set-watcher.ts server/test/store-set-watcher.test.ts
git commit -m "feat: track store churn and ration live watching by activity"
```

---

### Task 10: Wire `store-set` sources into the registry

**Files:**
- Modify: `server/src/registry.ts`
- Test: `server/test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/registry.test.ts <<'EOF'

describe('store-set sources', () => {
  it('expands a store-set source into child sources at start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-storeset-'));
    for (const name of ['alpha', 'beta']) {
      const dir = join(root, name, 'projects', '-workspace');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 's.jsonl'), JSON.stringify({
        type: 'user', uuid: `u-${name}`, timestamp: '2026-08-21T10:00:00Z',
        cwd: '/workspace', sessionId: `sess-${name}`,
        message: { role: 'user', content: 'hi' },
      }), 'utf-8');
      await writeFile(join(root, name, '.tracker-origin.json'), JSON.stringify({
        container: name, hostWorkspace: `/home/dave/${name}`,
      }), 'utf-8');
    }

    const registry = new SessionRegistry([{
      id: 'agents', name: 'Agent Containers', path: root,
      kind: 'claude-code', layout: 'store-set', location: 'host',
    }]);
    await registry.start();

    const ids = registry.getSources().map(s => s.id).sort();
    expect(ids).toEqual(['agents:alpha', 'agents:beta']);
    expect(registry.getProjects().map(p => p.id).sort()).toEqual(['alpha', 'beta']);
    await registry.stop();
  });

  it('does not create a SourceWatcher for the store-set parent itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-parent-'));
    const registry = new SessionRegistry([{
      id: 'agents', name: 'Agent Containers', path: root,
      kind: 'claude-code', layout: 'store-set', location: 'host',
    }]);
    await registry.start();
    expect(registry.getSources().map(s => s.id)).not.toContain('agents');
    await registry.stop();
  });
});
EOF
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/registry.test.ts'`
Expected: FAIL — `expected [] to equal ['agents:alpha', 'agents:beta']`

- [ ] **Step 3: Write minimal implementation**

In `server/src/registry.ts`, add a field and partition sources in `start()`:

```ts
  private storeSets: StoreSetWatcher[] = [];
```

At the top of `start()`, before the existing watcher loop:

```ts
    const storeSetSources = this.sources.filter(s => s.layout === 'store-set');
    this.sources = this.sources.filter(s => s.layout !== 'store-set');
```

At the end of `start()`, after the subscribe loop:

```ts
    this.storeSets = storeSetSources.map(
      source => new StoreSetWatcher(source, {
        addSource: (child, opts) => this.addSource(child, opts),
        removeSource: id => this.removeSource(id),
      }),
    );
    await Promise.allSettled(this.storeSets.map(w => w.start()));
```

In `stop()`, stop them too:

```ts
  async stop(): Promise<void> {
    await Promise.allSettled(this.storeSets.map(w => w.stop()));
    await Promise.allSettled([...this.watchers.values()].map(w => w.stop()));
  }
```

Add `import { StoreSetWatcher } from './store-set-watcher.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/registry.test.ts'`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/registry.ts server/test/registry.test.ts
git commit -m "feat: expand store-set sources at registry start"
```

---

### Task 11: `?locations=` and `sources-changed` over SSE

**Files:**
- Modify: `server/src/routes.ts:67-88,351-382`
- Test: `server/test/routes.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cat >> server/test/routes.test.ts <<'EOF'

describe('location filtering over HTTP', () => {
  const seedRegistry = async () => {
    const root = await mkdtemp(join(tmpdir(), 'routes-loc-'));
    const mk = async (name: string, sessionId: string) => {
      const dir = join(root, name, 'projects', '-workspace');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({
        type: 'user', uuid: `u-${sessionId}`, timestamp: '2026-08-21T10:00:00Z',
        cwd: '/workspace', sessionId,
        message: { role: 'user', content: 'hi' },
      }), 'utf-8');
      return join(root, name);
    };
    const registry = new SessionRegistry([]);
    await registry.start();
    await registry.addSource({
      id: 'wsl', name: 'WSL', path: await mk('hostish', 'sess-host'),
      kind: 'claude-code', layout: 'single', location: 'host',
      origin: { container: 'hostish', hostWorkspace: '/host/alpha' },
    }, { watch: false });
    await registry.addSource({
      id: 'agents:beta', name: 'beta', path: await mk('beta', 'sess-beta'),
      kind: 'claude-code', layout: 'single', location: 'container',
      origin: { container: 'beta', hostWorkspace: '/host/beta' },
    }, { watch: false });
    return registry;
  };

  it('filters sessions by ?locations=', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');

    const all = await (await app.request('/api/sessions')).json();
    expect(all).toHaveLength(2);

    const containers = await (await app.request('/api/sessions?locations=container')).json();
    expect(containers).toHaveLength(1);
    expect(containers[0].sourceId).toBe('agents:beta');
    await registry.stop();
  });

  it('filters projects by ?locations=', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const hosts = await (await app.request('/api/projects?locations=host')).json();
    expect(hosts.map((p: { id: string }) => p.id)).toEqual(['alpha']);
    await registry.stop();
  });

  it('ignores unknown location values', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const res = await app.request('/api/sessions?locations=bogus');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(0);
    await registry.stop();
  });

  it('exposes location, origin, and parentId on /api/sources', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const sources = await (await app.request('/api/sources')).json();
    const beta = sources.find((s: { id: string }) => s.id === 'agents:beta');
    expect(beta.location).toBe('container');
    expect(beta.origin.hostWorkspace).toBe('/host/beta');
    await registry.stop();
  });
});
EOF
```

`makeTestDb` must match however the existing `routes.test.ts` builds its `TrackerDB` — read the top of the file and reuse that helper rather than inventing one. If the existing tests construct the DB inline, extract it into a `makeTestDb()` helper first and update the existing call sites.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/routes.test.ts'`
Expected: FAIL — `?locations=container` returns both sessions, since the param is ignored

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes.ts`, add next to `parseKinds`:

```ts
  function parseLocations(c: Context): SourceLocation[] | undefined {
    const param = c.req.query('locations');
    if (!param) return undefined;
    return param.split(',').filter(
      (l): l is SourceLocation => l === 'host' || l === 'container',
    );
  }

  function parseFilter(c: Context): SessionFilter {
    return { kinds: parseKinds(c), locations: parseLocations(c) };
  }
```

Update the two endpoints:

```ts
  app.get('/api/projects', c => c.json(registry.getProjects(parseFilter(c))));
```

```ts
    let sessions = registry.getSessions(projectId, parseFilter(c));
```

Add to the SSE handler, alongside `onCreate`/`onUpdate`:

```ts
      const onSourcesChanged = (): void => {
        void stream.writeSSE({ event: 'sources-changed', data: '{}' });
      };
      registry.on('sources-changed', onSourcesChanged);
```

and in the `onAbort` cleanup:

```ts
          registry.off('sources-changed', onSourcesChanged);
```

Add `SourceLocation` to the `import type { SourceKind } from './sources.ts';` line and `import type { SessionFilter } from './registry.ts';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/routes.test.ts'`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add server/src/routes.ts server/test/routes.test.ts
git commit -m "feat: filter by source location over the API"
```

---

### Task 12: End-to-end merge integration test

This is the decisive test for the whole feature: a container session and a host session for the same folder must land in **one** project.

**Files:**
- Create: `server/test/fixtures/agent-stores/` (fixtures), `server/test/container-ingestion.integration.test.ts`

- [ ] **Step 1: Build the fixtures**

```bash
mkdir -p server/test/fixtures/agent-stores/vercel.ai/projects/-workspace
mkdir -p server/test/fixtures/agent-stores/legacy-shared/projects/-workspace

cat > server/test/fixtures/agent-stores/vercel.ai/.tracker-origin.json <<'EOF'
{
  "container": "vercel.ai",
  "image": "ai-agent:latest",
  "hostWorkspace": "/home/dave/Projects/CAT_AI/agent-shell",
  "workspaceMount": "/workspace",
  "host": "wsl-debian",
  "updatedAt": "2026-08-21T22:14:03+01:00"
}
EOF

cat > server/test/fixtures/agent-stores/vercel.ai/projects/-workspace/container-a.jsonl <<'EOF'
{"type":"user","uuid":"cu1","timestamp":"2026-08-21T10:00:00Z","cwd":"/workspace","sessionId":"container-a","message":{"role":"user","content":"from the container"}}
{"type":"assistant","uuid":"ca1","timestamp":"2026-08-21T10:00:05Z","cwd":"/workspace","sessionId":"container-a","message":{"role":"assistant","model":"claude-opus-5","content":[{"type":"text","text":"ack"}],"usage":{"input_tokens":10,"output_tokens":5}}}
EOF

# A store with no marker at all -- must form its own project, not join the others.
cat > server/test/fixtures/agent-stores/legacy-shared/projects/-workspace/legacy-a.jsonl <<'EOF'
{"type":"user","uuid":"lu1","timestamp":"2026-08-20T09:00:00Z","cwd":"/workspace","sessionId":"legacy-a","message":{"role":"user","content":"old commingled session"}}
EOF
```

- [ ] **Step 2: Write the failing test**

```bash
cat > server/test/container-ingestion.integration.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/registry.ts';
import type { Source } from '../src/sources.ts';

// Both packages are "type": "module", so __dirname does not exist. This is the
// same pattern multi-source.integration.test.ts uses.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORES = join(__dirname, 'fixtures', 'agent-stores');

/** A host .claude dir whose session ran in the same folder the container did. */
async function makeHostSource(): Promise<Source> {
  const dir = await mkdtemp(join(tmpdir(), 'host-claude-'));
  const projectDir = join(dir, 'projects', '-home-dave-Projects-CAT-AI-agent-shell');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'host-a.jsonl'), JSON.stringify({
    type: 'user', uuid: 'hu1', timestamp: '2026-08-21T09:00:00Z',
    cwd: '/home/dave/Projects/CAT_AI/agent-shell', sessionId: 'host-a',
    message: { role: 'user', content: 'from the host' },
  }), 'utf-8');
  return {
    id: 'wsl', name: 'WSL', path: dir,
    kind: 'claude-code', layout: 'single', location: 'host',
  };
}

const storeSet: Source = {
  id: 'agents', name: 'Agent Containers', path: STORES,
  kind: 'claude-code', layout: 'store-set', location: 'host',
};

describe('container session ingestion', () => {
  it('merges a container session into the host project for the same folder', async () => {
    const registry = new SessionRegistry([await makeHostSource(), storeSet]);
    await registry.start();

    const projects = registry.getProjects();
    const agentShell = projects.find(p => p.id === 'agent-shell');
    expect(agentShell).toBeDefined();
    expect(agentShell!.sessionCount).toBe(2);
    expect(agentShell!.sources.sort()).toEqual(['agents:vercel.ai', 'wsl']);

    await registry.stop();
  });

  it('keeps a markerless store in its own project', async () => {
    const registry = new SessionRegistry([await makeHostSource(), storeSet]);
    await registry.start();

    const ids = registry.getProjects().map(p => p.id).sort();
    expect(ids).toEqual(['agent-shell', 'legacy-shared']);

    await registry.stop();
  });

  it('rewrites the container session cwd to the host path', async () => {
    const registry = new SessionRegistry([storeSet]);
    await registry.start();

    const session = registry.getSession('container-a');
    expect(session?.cwd).toBe('/home/dave/Projects/CAT_AI/agent-shell');
    expect(session?.projectId).toBe('agent-shell');

    await registry.stop();
  });

  it('isolates container sessions with the location filter', async () => {
    const registry = new SessionRegistry([await makeHostSource(), storeSet]);
    await registry.start();

    const containerOnly = registry.getSessions(undefined, { locations: ['container'] });
    expect(containerOnly.map(s => s.id).sort()).toEqual(['container-a', 'legacy-a']);

    const hostOnly = registry.getSessions(undefined, { locations: ['host'] });
    expect(hostOnly.map(s => s.id)).toEqual(['host-a']);

    await registry.stop();
  });

  it('serves the raw log from the real file path', async () => {
    const registry = new SessionRegistry([storeSet]);
    await registry.start();
    const session = registry.getSession('container-a');
    expect(session?.filePath).toContain('agent-stores/vercel.ai');
    await registry.stop();
  });
});
EOF
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `docker compose exec app sh -c 'cd server && npx vitest run test/container-ingestion.integration.test.ts'`

If Tasks 1–11 are complete this should PASS on the first run — every piece it exercises is already implemented and individually tested. If it fails, the failure is a genuine integration gap; fix it before continuing rather than adjusting the test's expectations.

- [ ] **Step 4: Run the whole suite**

Run: `docker compose exec app sh -c 'cd server && npx vitest run'`
Expected: PASS. Total should now be 127 original + the new cases.

- [ ] **Step 5: Commit**

```bash
git add server/test/fixtures/agent-stores server/test/container-ingestion.integration.test.ts
git commit -m "test: cover container and host session merging end to end"
```

---

### Task 13: Client source types and location filter

**Files:**
- Modify: `client/src/hooks/useSources.ts`, `client/src/hooks/useProjects.ts`, `client/src/hooks/useSessions.ts`, `client/src/App.tsx:28-45,96-98`, `client/src/components/ProjectList.tsx:11-33,73-86`

- [ ] **Step 1: Mirror the new source fields**

In `client/src/hooks/useSources.ts`, add the types and fields:

```ts
export type SourceLocation = 'host' | 'container';

export interface StoreOrigin {
  container: string;
  image?: string;
  hostWorkspace?: string;
  workspaceMount?: string;
  host?: string;
  updatedAt?: string;
}

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  location: SourceLocation;
  configPath?: string;
  origin?: StoreOrigin;
  parentId?: string;
}
```

- [ ] **Step 2: Pass locations through the data hooks**

In `client/src/hooks/useProjects.ts`, accept and forward locations:

```ts
export function useProjects(kinds?: SourceKind[], locations?: SourceLocation[]) {
  const [projects, setProjects] = useState<Project[]>([]);
  const kindsKey = kinds?.join(',') ?? '';
  const locationsKey = locations?.join(',') ?? '';

  const refresh = useCallback(() => {
    const params = new URLSearchParams();
    if (kindsKey) params.set('kinds', kindsKey);
    if (locationsKey) params.set('locations', locationsKey);
    const qs = params.toString();
    void fetch(qs ? `/api/projects?${qs}` : '/api/projects')
      .then(r => r.json()).then(setProjects);
  }, [kindsKey, locationsKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return { projects, setProjects, refresh };
}
```

Add `import type { SourceLocation } from '@/hooks/useSources.ts';`. Apply the same `URLSearchParams` treatment to `useSessions.ts`, preserving whatever parameters it already sends.

- [ ] **Step 3: Add the App-level state**

In `client/src/App.tsx`, mirror the existing `enabledKinds` pattern exactly — including the `null` sentinel meaning "not yet toggled", so a newly appearing location is enabled by default:

```ts
  const allLocations = useMemo(
    () => [...new Set(sources.map(s => s.location))],
    [sources],
  );
  const [enabledLocations, setEnabledLocations] = useState<SourceLocation[] | null>(null);
  const effectiveLocations = enabledLocations ?? allLocations;
  const toggleLocation = (location: SourceLocation) => {
    setEnabledLocations(prev => {
      const base = prev ?? allLocations;
      return base.includes(location)
        ? base.filter(l => l !== location)
        : [...base, location];
    });
  };
```

Pass `effectiveLocations` into `useProjects` and `useSessions`, and pass `allLocations`, `effectiveLocations`, and `toggleLocation` into `ProjectList`.

- [ ] **Step 4: Add the checkboxes**

In `client/src/components/ProjectList.tsx`, add the label map and props, then a second checkbox row directly below the existing kind row (`ProjectList.tsx:73-86`), following the same "only render when there is a choice" convention:

```tsx
const LOCATION_LABELS: Record<SourceLocation, string> = {
  host: 'Host',
  container: 'Containers',
};
```

```tsx
      {allLocations.length > 1 && (
        <div className="flex gap-3 px-4 py-1.5 border-b border-gray-100 text-[11px]">
          {allLocations.map(location => (
            <label key={location} className="flex items-center gap-1 text-gray-600">
              <input
                type="checkbox"
                checked={enabledLocations.includes(location)}
                onChange={() => onToggleLocation(location)}
              />
              {LOCATION_LABELS[location]}
            </label>
          ))}
        </div>
      )}
```

- [ ] **Step 5: Refetch sources when they change**

A container launched after page load must appear without a reload. `useSources()` is consumed by `SessionList`, `ProjectList`, and `ConfigPanel` as a bare array, so rather than changing its return shape, the SSE event is relayed through a window event.

In `client/src/hooks/useSSE.ts`, add the relay inside the existing `useEffect`, next to the other two listeners:

```ts
    es.addEventListener('sources-changed', () => {
      window.dispatchEvent(new Event('tracker:sources-changed'));
    });
```

In `client/src/hooks/useSources.ts`, replace the body of the existing `useEffect` so the fetch can be repeated:

```ts
  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      void fetch('/api/sources')
        .then(r => r.json() as Promise<Source[]>)
        .then(data => {
          if (!cancelled) setSources(data);
        })
        .catch(err => {
          console.error('[useSources] failed to load:', err);
        });
    };

    load();
    window.addEventListener('tracker:sources-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('tracker:sources-changed', load);
    };
  }, []);
```

- [ ] **Step 6: Typecheck**

Run: `docker compose exec app sh -c 'cd client && npx tsc --noEmit --allowImportingTsExtensions'`
Expected: no output

- [ ] **Step 7: Verify in the running app**

Open `http://localhost:5173`. Expected: a Host/Containers checkbox pair below the Claude Code/OpenCode pair, unchecking "Containers" removes container projects from the list, and re-checking restores them.

- [ ] **Step 8: Commit**

```bash
git add client/src/hooks client/src/App.tsx client/src/components/ProjectList.tsx
git commit -m "feat: filter projects and sessions by location in the UI"
```

---

### Task 14: Container badge and provenance header

**Files:**
- Modify: `client/src/components/SessionList.tsx`, `client/src/components/SessionDetail.tsx`

- [ ] **Step 1: Show the container name on the session badge**

`SessionList.tsx:118-127` already renders a per-session source badge. Replace that block so a container source shows its container name, capping the width so many container sources cannot widen the column:

```tsx
                  {sources.length > 1 && source && (
                    <>
                      <SourceKindDots kinds={[source.kind]} />
                      <span
                        title={source.location === 'container'
                          ? `container: ${source.origin?.container ?? source.name}`
                          : source.name}
                        className="px-1.5 py-0.5 rounded text-[9px] font-medium
                          bg-gray-100 text-gray-600 uppercase tracking-wide
                          max-w-[7rem] truncate"
                      >
                        {source.location === 'container'
                          ? (source.origin?.container ?? source.name)
                          : source.name}
                      </span>
                    </>
                  )}
```

- [ ] **Step 2: Show provenance in the detail header**

In `SessionDetail.tsx`, add the import:

```tsx
import { useSources } from '@/hooks/useSources.ts';
```

Call the hook alongside the existing ones, **above** the `if (!fullSession)` early return at `SessionDetail.tsx:39` — hooks cannot run conditionally:

```tsx
  const sources = useSources();
```

Then after that early return, derive the source:

```tsx
  const source = sources.find(s => s.id === fullSession.sourceId);
```

And add the provenance line to the header, directly after the `formatMeta` div (`SessionDetail.tsx:98-100`). Every field is optional because a migrated legacy store carries neither `image` nor a real `hostWorkspace`:

```tsx
        {source?.location === 'container' && (
          <div className="text-[11px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>container: {source.origin?.container ?? source.name}</span>
            {source.origin?.image && <span>· {source.origin.image}</span>}
            {source.origin?.hostWorkspace && (
              <span className="truncate">· {source.origin.hostWorkspace}</span>
            )}
          </div>
        )}
```

- [ ] **Step 3: Typecheck**

Run: `docker compose exec app sh -c 'cd client && npx tsc --noEmit --allowImportingTsExtensions'`
Expected: no output

- [ ] **Step 4: Verify in the running app**

Open `http://localhost:5173`, select a container session. Expected: the list badge shows the container name, and the detail header shows container, image, and host workspace. Select a host session and confirm no provenance line appears.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SessionList.tsx client/src/components/SessionDetail.tsx
git commit -m "feat: show container provenance on sessions"
```

---

### Task 15: Configuration and documentation

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `server/config/sources.example.json`, `CLAUDE.md`

- [ ] **Step 1: Mount the store root**

Add to the `app` service volumes in `docker-compose.yml`, alongside the existing `${CLAUDE_DIR_WSL}` and `${CLAUDE_DIR_WINDOWS}` mounts:

```yaml
      - ${AGENT_CLAUDE_ROOT}:/claude/agents:ro
```

- [ ] **Step 2: Document the variable**

Add to `.env.example`:

```
# Root of agent-shell's host-backed Claude stores (one directory per container)
AGENT_CLAUDE_ROOT=/home/YOURUSER/.agent-shell/claude
```

- [ ] **Step 3: Add the example source**

Add to the `sources` array in `server/config/sources.example.json`:

```json
    {
      "id": "agents",
      "name": "Agent Containers",
      "kind": "claude-code",
      "layout": "store-set",
      "path": "/claude/agents"
    }
```

- [ ] **Step 4: Update the real config**

Add the same entry to `server/config/sources.json`.

- [ ] **Step 5: Update CLAUDE.md**

Add to the architecture notes:

- The multi-source section gains `layout`: `single` (default) is one `.claude` directory; `store-set` is a directory of them, expanded into one child source per subdirectory with `location: 'container'`.
- File layout entries for `server/src/store-origin.ts` and `server/src/store-set-watcher.ts`, describing the cwd rewrite and the activity-based watch rationing.
- `?locations=claude-code,container` on `/api/projects` and `/api/sessions`, next to the existing `?kinds=` note.
- `STORE_ACTIVE_DAYS` (default 14) controls how long a store keeps a live watcher.
- Update the testing section's file list and total test count.

- [ ] **Step 6: Restart and verify end to end**

```bash
docker compose down && docker compose up -d
docker compose logs app --tail 40
```

Expected: no source-loading warnings, and `curl -s localhost:3001/api/sources | jq '.[].id'` lists one `agents:<name>` entry per real store.

- [ ] **Step 7: Confirm a live container session appears**

Launch an agent container in some directory, start a Claude session, and watch the dashboard. Expected: the session appears within a couple of seconds, in the project matching that directory, carrying a container badge — and if you already have host sessions for that folder, in the *same* project row.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml .env.example server/config CLAUDE.md
git commit -m "feat: configure agent container store ingestion"
```

---

## Done when

- `docker compose exec app sh -c 'cd server && npx vitest run'` passes, including the five new `container-ingestion.integration.test.ts` cases.
- `docker compose exec app sh -c 'cd server && npx tsc --noEmit'` and the client typecheck are both clean.
- `docker compose exec app sh -c 'npx oxlint'` is clean.
- A live container session appears in the dashboard in the correct project, with a container badge.
- Unchecking "Containers" hides container sessions and projects; unchecking "Host" hides host ones.
- A container launched after page load appears without a reload.
