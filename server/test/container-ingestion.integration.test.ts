import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/registry.js';
import type { Source } from '../src/sources.js';
import { TrackerDB } from '../src/db.js';
import { buildApp } from '../src/routes.js';

// Both packages are "type": "module", so __dirname does not exist. This is the
// same pattern multi-source.integration.test.ts uses.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STORES = join(__dirname, 'fixtures', 'agent-stores');

const cleanup: string[] = [];
afterEach(async () => {
  for (const d of cleanup.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

/** A host .claude dir whose session ran in the same folder the container did. */
async function makeHostSource(): Promise<Source> {
  const dir = await mkdtemp(join(tmpdir(), 'host-claude-'));
  cleanup.push(dir);
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
    expect(registry.getSessions('agent-shell').map(s => s.id).sort())
      .toEqual(['container-a', 'host-a']);

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

    const session = registry.getSessionMeta('container-a');
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
    const session = registry.getSessionMeta('container-a');
    expect(session?.filePath).toBe(
      join(STORES, 'vercel.ai', 'projects', '-workspace', 'container-a.jsonl'),
    );
    await registry.stop();
  });
});

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
