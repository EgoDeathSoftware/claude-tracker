import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SessionRegistry } from '../src/registry.js';
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
      expect(reg.getSessions(undefined, ['opencode'])).toHaveLength(1);
      expect(reg.getSessions(undefined, ['opencode'])[0]!.sourceId).toBe('opencode');

      expect(reg.getProjects(['claude-code'])).toHaveLength(1);
      expect(reg.getProjects(['claude-code'])[0]!.sources).toEqual(['claude']);

      // Omitting kinds (or passing undefined) returns everything, unchanged
      // from today's behavior.
      expect(reg.getSessions()).toHaveLength(2);
      expect(reg.getProjects()).toHaveLength(2);
    } finally {
      await reg.stop();
    }
  });
});
