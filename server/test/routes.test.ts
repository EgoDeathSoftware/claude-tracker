import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { buildApp } from '../src/routes.js';
import { SessionRegistry } from '../src/registry.js';
import { TrackerDB } from '../src/db.js';
import type { Source } from '../src/sources.js';
import { archivedSession } from './fixtures/session.js';
import { PARSER_VERSION } from '../src/parser.js';

function makeUserLine(uuid: string, content: string, ts: string, cwd?: string): string {
  const rec: Record<string, unknown> = {
    type: 'user', uuid, parentUuid: null, isSidechain: false,
    timestamp: ts, message: { role: 'user', content },
  };
  if (cwd) rec['cwd'] = cwd;
  return JSON.stringify(rec);
}

async function seedClaudeSession(
  claudeDir: string, dirName: string, sessionId: string, cwd: string, ts: string,
): Promise<void> {
  const projectDir = join(claudeDir, 'projects', dirName);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${sessionId}.jsonl`), makeUserLine('u1', 'hello', ts, cwd));
}

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
    `${msgId}-part-1`, msgId, session.timeUpdated, JSON.stringify({ type: 'text', text: 'hello from opencode' }),
  );
  db.close();
}

function makeTestDb(): TrackerDB {
  return new TrackerDB(':memory:');
}

describe('routes', () => {
  const cleanup: string[] = [];
  const registries: SessionRegistry[] = [];

  afterEach(async () => {
    for (const reg of registries.splice(0)) {
      await reg.stop();
    }
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  async function buildTestApp(sources: Source[]) {
    const db = makeTestDb();
    const registry = new SessionRegistry(sources, db);
    registries.push(registry);
    await registry.start();
    const app = buildApp(registry, db, '/tmp/routes-test-llm-config-nonexistent.json');
    return { app, registry };
  }

  describe('kinds filtering', () => {
    it('filters GET /api/projects and /api/sessions by ?kinds=', async () => {
      const claudeDir = await mkdtemp(join(tmpdir(), 'routes-cc-'));
      const opencodeDir = await mkdtemp(join(tmpdir(), 'routes-oc-'));
      cleanup.push(claudeDir, opencodeDir);

      await seedClaudeSession(
        claudeDir, '-claude-only', 'cc-sess', '/claude/only', '2026-04-01T10:00:00.000Z',
      );
      await seedOpenCodeDb(opencodeDir, {
        id: 'oc-sess', projectId: 'proj-1', directory: '/opencode/only',
        timeUpdated: new Date('2026-04-02T10:00:00.000Z').getTime(),
      });

      const { app } = await buildTestApp([
        {
          id: 'claude', name: 'Claude Code', path: claudeDir,
          kind: 'claude-code', layout: 'single', location: 'host',
        },
        {
          id: 'opencode', name: 'OpenCode', path: opencodeDir,
          kind: 'opencode', layout: 'single', location: 'host',
        },
      ]);

      const allSessions = await app.request('/api/sessions').then(r => r.json());
      expect(allSessions).toHaveLength(2);

      const ocSessions = await app.request('/api/sessions?kinds=opencode').then(r => r.json());
      expect(ocSessions).toHaveLength(1);
      expect(ocSessions[0].sourceId).toBe('opencode');

      const ccProjects = await app.request('/api/projects?kinds=claude-code').then(r => r.json());
      expect(ccProjects).toHaveLength(1);
      expect(ccProjects[0].sources).toEqual(['claude']);
    });
  });

  describe('raw-log kind branch', () => {
    it('synthesizes a paginated transcript for opencode sessions', async () => {
      const opencodeDir = await mkdtemp(join(tmpdir(), 'routes-oc-raw-'));
      cleanup.push(opencodeDir);
      await seedOpenCodeDb(opencodeDir, {
        id: 'oc-sess', projectId: 'proj-1', directory: '/opencode/project',
        timeUpdated: Date.now(),
      });

      const { app } = await buildTestApp([
        {
          id: 'opencode', name: 'OpenCode', path: opencodeDir,
          kind: 'opencode', layout: 'single', location: 'host',
        },
      ]);

      const res = await app.request('/api/sessions/oc-sess/raw');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.lines).toHaveLength(1);
      expect(body.lines[0].lineNumber).toBe(1);
      expect(body.lines[0].content.content).toBe('hello from opencode');
    });

    it('still tails the JSONL file for claude-code sessions', async () => {
      const claudeDir = await mkdtemp(join(tmpdir(), 'routes-cc-raw-'));
      cleanup.push(claudeDir);
      await seedClaudeSession(
        claudeDir, '-proj', 'cc-sess', '/proj', '2026-04-01T10:00:00.000Z',
      );

      const { app } = await buildTestApp([
        {
          id: 'claude', name: 'Claude Code', path: claudeDir,
          kind: 'claude-code', layout: 'single', location: 'host',
        },
      ]);

      const res = await app.request('/api/sessions/cc-sess/raw');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.lines[0].content.type).toBe('user');
    });
  });

  describe('opencode config endpoints', () => {
    it('returns 503 when no opencode source with configPath is configured', async () => {
      const claudeDir = await mkdtemp(join(tmpdir(), 'routes-cc-cfg-'));
      cleanup.push(claudeDir);

      const { app } = await buildTestApp([
        {
          id: 'claude', name: 'Claude Code', path: claudeDir,
          kind: 'claude-code', layout: 'single', location: 'host',
        },
      ]);

      const configRes = await app.request('/api/config/opencode');
      expect(configRes.status).toBe(503);
      const agentsRes = await app.request('/api/config/opencode/agents');
      expect(agentsRes.status).toBe(503);
    });

    it('returns parsed opencode.json and agent files when configPath is set', async () => {
      const opencodeDataDir = await mkdtemp(join(tmpdir(), 'routes-oc-data-'));
      const opencodeConfigDir = await mkdtemp(join(tmpdir(), 'routes-oc-cfg-'));
      cleanup.push(opencodeDataDir, opencodeConfigDir);

      await writeFile(
        join(opencodeConfigDir, 'opencode.json'),
        JSON.stringify({ model: 'llama-swap/qwen3.8-27b' }),
      );
      const agentsDir = join(opencodeConfigDir, 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, 'implementer.md'), '# Implementer');

      const { app } = await buildTestApp([
        {
          id: 'opencode', name: 'OpenCode', path: opencodeDataDir,
          kind: 'opencode', configPath: opencodeConfigDir,
          layout: 'single', location: 'host',
        },
      ]);

      const configRes = await app.request('/api/config/opencode');
      expect(configRes.status).toBe(200);
      const config = await configRes.json();
      expect(config.model).toBe('llama-swap/qwen3.8-27b');

      const agentsRes = await app.request('/api/config/opencode/agents');
      expect(agentsRes.status).toBe(200);
      const agents = await agentsRes.json();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('implementer.md');
    });

    it('works with an opencode-only source list (no claude-code source at all)', async () => {
      const opencodeDataDir = await mkdtemp(join(tmpdir(), 'routes-oc-only-data-'));
      const opencodeConfigDir = await mkdtemp(join(tmpdir(), 'routes-oc-only-cfg-'));
      cleanup.push(opencodeDataDir, opencodeConfigDir);
      await writeFile(join(opencodeConfigDir, 'opencode.json'), JSON.stringify({ model: 'x' }));

      const { app } = await buildTestApp([
        {
          id: 'opencode', name: 'OpenCode', path: opencodeDataDir,
          kind: 'opencode', configPath: opencodeConfigDir,
          layout: 'single', location: 'host',
        },
      ]);

      const ocConfigRes = await app.request('/api/config/opencode');
      expect(ocConfigRes.status).toBe(200);
      const config = await ocConfigRes.json();
      expect(config.model).toBe('x');
    });
  });
});

describe('location filtering over HTTP', () => {
  const registries: SessionRegistry[] = [];
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const reg of registries.splice(0)) {
      await reg.stop();
    }
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const seedRegistry = async () => {
    const root = await mkdtemp(join(tmpdir(), 'routes-loc-'));
    cleanup.push(root);
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
    registries.push(registry);
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
  });

  it('filters projects by ?locations=', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const hosts = await (await app.request('/api/projects?locations=host')).json();
    expect(hosts.map((p: { id: string }) => p.id)).toEqual(['alpha']);
  });

  it('ignores unknown location values', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const res = await app.request('/api/sessions?locations=bogus');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(0);
  });

  it('an explicitly empty ?locations= filters to nothing, unlike an absent param', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');

    const noParam = await (await app.request('/api/sessions')).json();
    expect(noParam).toHaveLength(2);

    const emptyParam = await (await app.request('/api/sessions?locations=')).json();
    expect(emptyParam).toHaveLength(0);
  });

  it('an explicitly empty ?kinds= filters to nothing, unlike an absent param', async () => {
    const registry = await seedRegistry();
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');

    const noParam = await (await app.request('/api/projects')).json();
    expect(noParam.length).toBeGreaterThan(0);

    const emptyParam = await (await app.request('/api/projects?kinds=')).json();
    expect(emptyParam).toHaveLength(0);
  });

  it('exposes location, origin, and parentId on /api/sources', async () => {
    const registry = await seedRegistry();
    const gammaDir = await mkdtemp(join(tmpdir(), 'routes-loc-gamma-'));
    cleanup.push(gammaDir);
    await registry.addSource({
      id: 'agents:gamma', name: 'gamma', path: gammaDir,
      kind: 'claude-code', layout: 'single', location: 'container',
      origin: { container: 'gamma', hostWorkspace: '/host/gamma' },
      parentId: 'agents',
    }, { watch: false });
    const app = buildApp(registry, makeTestDb(), '/tmp/llm.json');
    const sources = await (await app.request('/api/sources')).json();
    const beta = sources.find((s: { id: string }) => s.id === 'agents:beta');
    expect(beta.location).toBe('container');
    expect(beta.origin.hostWorkspace).toBe('/host/beta');
    const gamma = sources.find((s: { id: string }) => s.id === 'agents:gamma');
    expect(gamma.parentId).toBe('agents');
  });
});

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
