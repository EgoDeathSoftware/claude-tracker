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
