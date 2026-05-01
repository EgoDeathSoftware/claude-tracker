import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry } from '../src/registry.js';
import type { Source } from '../src/sources.js';

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
