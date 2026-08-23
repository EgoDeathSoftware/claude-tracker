import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteCwd, synthesizeOrigin, readStoreOrigin } from '../src/store-origin.ts';
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
