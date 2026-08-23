import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SessionRegistry } from '../src/registry.js';
import { TrackerDB } from '../src/db.js';
import type { Source } from '../src/sources.js';

// Mirrors the real opencode DB (verified against a live install) - parts
// live in their own table, one row per part, keyed by message_id.
async function seedOpenCodeDb(
  dataDir: string,
  session: { id: string; projectId: string; directory: string; timeUpdated: number },
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, model TEXT, cost REAL,
      parent_id TEXT, time_updated INTEGER NOT NULL, title TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER NOT NULL, data TEXT
    );
  `);
  db.prepare(`
    INSERT INTO session (id, project_id, directory, model, cost, parent_id, time_updated, title)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    session.id, session.projectId, session.directory,
    JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
    0.001, session.timeUpdated, 'OpenCode session',
  );
  const msgId = `${session.id}-msg-1`;
  db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    msgId, session.id, session.timeUpdated, JSON.stringify({ role: 'user' }),
  );
  db.prepare(`INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    `${msgId}-part-1`, msgId, session.timeUpdated, JSON.stringify({ type: 'text', text: 'hello' }),
  );
  db.close();
}

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
    await new Promise(r => setTimeout(r, 10));
    await seedSession(
      winDir,
      'C--Users-david-Projects-X',
      'sess-b',
      'C:\\Users\\david\\Projects\\X',
      '2026-04-02T10:00:00.000Z',
    );

    const sources: Source[] = [
      {
        id: 'wsl', name: 'WSL', path: wslDir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'windows', name: 'Windows', path: winDir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
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
      {
        id: 'wsl', name: 'WSL', path: dir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
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
      {
        id: 'wsl', name: 'WSL', path: dir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
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
      {
        id: 'wsl', name: 'WSL', path: dir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
    ]);
    await reg.start();
    try {
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.id).toBe('foo');
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
      {
        id: 'gone', name: 'Gone', path: '/definitely/not/here',
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'ok', name: 'OK', path: ok,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
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

  it('dispatches an OpenCodeWatcher for kind: opencode and merges with a claude-code source', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'reg-cc-'));
    const opencodeDir = await mkdtemp(join(tmpdir(), 'reg-oc-'));
    cleanup.push(claudeDir, opencodeDir);

    await seedSession(
      claudeDir,
      '-shared-project',
      'cc-sess',
      '/shared/project',
      '2026-04-01T10:00:00.000Z',
    );
    await seedOpenCodeDb(opencodeDir, {
      id: 'oc-sess',
      projectId: 'proj-1',
      directory: '/shared/project',
      timeUpdated: new Date('2026-04-02T10:00:00.000Z').getTime(),
    });

    const reg = new SessionRegistry([
      {
        id: 'claude', name: 'Claude Code', path: claudeDir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'opencode', name: 'OpenCode', path: opencodeDir,
        kind: 'opencode', layout: 'single', location: 'host',
      },
    ]);
    await reg.start();
    try {
      const sessions = reg.getSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sourceId).sort()).toEqual(['claude', 'opencode']);

      // Proves the aggregation layer really is kind-agnostic: both sources'
      // sessions share a project basename and merge into one Project.
      const projects = reg.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.sources.sort()).toEqual(['claude', 'opencode']);
      expect(projects[0]!.sessionCount).toBe(2);
    } finally {
      await reg.stop();
    }
  });

  it('filters getProjects/getSessions by kind, and returns everything when kinds is omitted', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'reg-cc2-'));
    const opencodeDir = await mkdtemp(join(tmpdir(), 'reg-oc2-'));
    cleanup.push(claudeDir, opencodeDir);

    await seedSession(
      claudeDir,
      '-claude-only-project',
      'cc-sess',
      '/claude/only/claude-project',
      '2026-04-01T10:00:00.000Z',
    );
    await seedOpenCodeDb(opencodeDir, {
      id: 'oc-sess',
      projectId: 'proj-1',
      directory: '/opencode/only/opencode-project',
      timeUpdated: new Date('2026-04-02T10:00:00.000Z').getTime(),
    });

    const reg = new SessionRegistry([
      {
        id: 'claude', name: 'Claude Code', path: claudeDir,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'opencode', name: 'OpenCode', path: opencodeDir,
        kind: 'opencode', layout: 'single', location: 'host',
      },
    ]);
    await reg.start();
    try {
      expect(reg.getSessions(undefined, { kinds: ['opencode'] })).toHaveLength(1);
      expect(reg.getSessions(undefined, { kinds: ['opencode'] })[0]!.sourceId).toBe('opencode');

      expect(reg.getProjects({ kinds: ['claude-code'] })).toHaveLength(1);
      expect(reg.getProjects({ kinds: ['claude-code'] })[0]!.sources).toEqual(['claude']);

      // Omitting kinds (or passing undefined) returns everything, unchanged
      // from today's behavior.
      expect(reg.getSessions()).toHaveLength(2);
      expect(reg.getProjects()).toHaveLength(2);
    } finally {
      await reg.stop();
    }
  });
});

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

  it('removes SQLite state when a source is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-db-rm-'));
    const storePath = await makeStore(root, 'demo', 'sess-searchme');
    const db = new TrackerDB(':memory:');
    const registry = new SessionRegistry([], db);
    await registry.start();

    await registry.addSource({
      id: 'agents:demo', name: 'demo', path: storePath,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });
    expect(registry.getSessions()).toHaveLength(1);
    expect(db.search('hi')).toHaveLength(1);

    await registry.removeSource('agents:demo');
    expect(db.search('hi')).toHaveLength(0);
    await registry.stop();
  });

  it('replaces a source cleanly when addSource is called twice sequentially with the same id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'registry-add-twice-'));
    const first = await makeStore(root, 'first', 'sess-first');
    const second = await makeStore(root, 'second', 'sess-second');
    const registry = new SessionRegistry([]);
    await registry.start();

    await registry.addSource({
      id: 'agents:demo', name: 'demo', path: first,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });
    await registry.addSource({
      id: 'agents:demo', name: 'demo', path: second,
      kind: 'claude-code', layout: 'single', location: 'container',
    }, { watch: false });

    const sources = registry.getSources().filter(s => s.id === 'agents:demo');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.path).toBe(second);

    const sessions = registry.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('sess-second');
    await registry.stop();
  });
});

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
