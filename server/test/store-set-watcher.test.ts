import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
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

  it('ignores files at the root', async () => {
    await writeFile(join(root, 'stray.txt'), 'x', 'utf-8');
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: root }, sink);
    await w.start();
    await w.stop();
    expect(sink.added).toHaveLength(0);
  });

  it('tolerates a missing root', async () => {
    const sink = recordingSink();
    const w = new StoreSetWatcher({ ...parent, path: join(root, 'nope') }, sink);
    await expect(w.start()).resolves.toBeUndefined();
    await w.stop();
    expect(sink.added).toHaveLength(0);
  });
});

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

describe('StoreSetWatcher per-store error isolation', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'store-errors-')); });

  it('does not let one store failing to add abort the rest of the pass', async () => {
    await makeStore(root, 'bad', {
      marker: { container: 'bad', hostWorkspace: '/home/dave/bad' },
    });
    await makeStore(root, 'good', {
      marker: { container: 'good', hostWorkspace: '/home/dave/good' },
    });

    const added: { source: Source; watch: boolean }[] = [];
    const sink = {
      addSource: async (source: Source, opts?: { watch?: boolean }) => {
        if (source.id === 'agents:bad') throw new Error('boom');
        added.push({ source, watch: opts?.watch ?? true });
      },
      removeSource: async () => {},
    };

    const w = new StoreSetWatcher({ ...parent, path: root }, sink, { pollMs: 0 });
    await expect(w.start()).resolves.toBeUndefined();

    expect(added.map(a => a.source.id)).toEqual(['agents:good']);

    // The failed store should be retried on the next pass, not skipped
    // forever, since it was never recorded as known.
    await w.pollOnce();
    expect(added.map(a => a.source.id)).toEqual(['agents:good']);

    await w.stop();
  });
});
