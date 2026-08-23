import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/registry.js';
import { seedOpenCodeDb } from './fixtures/opencode/seed.js';
import type { Source } from '../src/sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLAUDE_FIXTURE = join(__dirname, 'fixtures', 'sources', 'multi-agent', 'claude');

describe('multi-agent integration (claude-code + opencode)', () => {
  let registry: SessionRegistry;
  let opencodeDir: string;

  beforeAll(async () => {
    opencodeDir = await mkdtemp(join(tmpdir(), 'multi-agent-oc-'));
    await seedOpenCodeDb(opencodeDir, [
      {
        id: 'oc-sess',
        projectId: 'proj-1',
        // Same basename ("shared-demo") as the committed claude-code
        // fixture's cwd, so they're expected to merge into one project.
        directory: '/home/user/shared-demo',
        timeUpdated: new Date('2026-04-11T09:00:00.000Z').getTime(),
        parts: [{ type: 'text', text: 'opencode session in the shared project' }],
      },
    ]);

    const sources: Source[] = [
      {
        id: 'claude', name: 'Claude Code', path: CLAUDE_FIXTURE,
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'opencode', name: 'OpenCode', path: opencodeDir,
        kind: 'opencode', layout: 'single', location: 'host',
      },
    ];
    registry = new SessionRegistry(sources);
    await registry.start();
  });

  afterAll(async () => {
    await registry.stop();
    await rm(opencodeDir, { recursive: true, force: true });
  });

  it('merges claude-code and opencode sessions into one project by basename', () => {
    const projects = registry.getProjects();
    const shared = projects.find(p => p.id === 'shared-demo');
    expect(shared).toBeDefined();
    expect(shared!.sessionCount).toBe(2);
    expect(shared!.sources.sort()).toEqual(['claude', 'opencode']);
  });

  it('tags each session with the correct sourceId and kind-appropriate content', () => {
    const sessions = registry.getSessions('shared-demo');
    expect(sessions).toHaveLength(2);

    const claudeSession = sessions.find(s => s.sourceId === 'claude');
    expect(claudeSession).toBeDefined();
    expect(claudeSession!.id).toBe('sess-cc');

    const opencodeSession = sessions.find(s => s.sourceId === 'opencode');
    expect(opencodeSession).toBeDefined();
    expect(opencodeSession!.id).toBe('oc-sess');
  });

  it('filters getSessions by kind, returning only opencode sessions', () => {
    const opencodeOnly = registry.getSessions('shared-demo', { kinds: ['opencode'] });
    expect(opencodeOnly).toHaveLength(1);
    expect(opencodeOnly[0]!.sourceId).toBe('opencode');
  });

  it('filters getProjects by kind, excluding the merged project when its only opencode session is filtered out', () => {
    const claudeOnlyProjects = registry.getProjects({ kinds: ['claude-code'] });
    const shared = claudeOnlyProjects.find(p => p.id === 'shared-demo');
    expect(shared).toBeDefined();
    expect(shared!.sessionCount).toBe(1);
    expect(shared!.sources).toEqual(['claude']);
  });
});
