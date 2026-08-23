import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '../src/registry.js';
import type { Source } from '../src/sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, 'fixtures', 'sources');

describe('multi-source integration', () => {
  let registry: SessionRegistry;

  beforeAll(async () => {
    const sources: Source[] = [
      {
        id: 'wsl', name: 'WSL', path: join(FIXTURES, 'wsl'),
        kind: 'claude-code', layout: 'single', location: 'host',
      },
      {
        id: 'windows', name: 'Windows', path: join(FIXTURES, 'windows'),
        kind: 'claude-code', layout: 'single', location: 'host',
      },
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
    expect(demo!.name).toBe('Demo');
  });
});
