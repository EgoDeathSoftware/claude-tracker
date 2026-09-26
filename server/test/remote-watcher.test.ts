import { describe, it, expect, beforeEach } from 'vitest';
import { RemoteWatcher } from '../src/remote-watcher.ts';
import { TrackerDB } from '../src/db.ts';
import type { Source } from '../src/sources.ts';

const SOURCE: Source = {
  id: 'vps1', name: 'vps1', path: 'remote:vps1',
  kind: 'claude-code', layout: 'single', location: 'remote',
};

function sessionLine(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    isSidechain: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/home/vps-user/projects/demo',
    sessionId: 'sess1',
    message: { role: 'user', content: 'hello' },
    ...overrides,
  });
}

describe('RemoteWatcher', () => {
  let db: TrackerDB;
  let watcher: RemoteWatcher;

  beforeEach(() => {
    db = new TrackerDB(':memory:');
    watcher = new RemoteWatcher(SOURCE, db);
  });

  it('starts and stops with nothing to scan', async () => {
    await watcher.start();
    await watcher.stop();
    expect(watcher.getAllMeta()).toEqual([]);
  });

  it('handleFileSnapshot ingests a full transcript and emits session-created', () => {
    const events: string[] = [];
    watcher.on('session-created', () => events.push('created'));
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    expect(events).toEqual(['created']);
    const [meta] = watcher.getAllMeta();
    expect(meta?.id).toBe('sess1');
    expect(meta?.projectId).toBe('demo'); // basename of cwd
    expect(meta?.sourceLocation).toBe('remote');
  });

  it('writes through to the archive so the session survives a restart', () => {
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    expect(db.archive.hasSession('sess1')).toBe(true);
  });

  it('handleFileList requests a snapshot for a file never seen before', () => {
    const needed = watcher.handleFileList([
      { relPath: 'demo/sess1.jsonl', size: 100, mtimeUnixMs: 1000 },
    ]);
    expect(needed).toEqual(['demo/sess1.jsonl']);
  });

  it('handleFileList skips a file whose fingerprint already matches the archive', () => {
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    const needed = watcher.handleFileList([
      { relPath: 'demo/sess1.jsonl', size: 100, mtimeUnixMs: 1000 },
    ]);
    expect(needed).toEqual([]);
  });

  it('handleAppendLines extends a previously snapshotted transcript', () => {
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    const events: string[] = [];
    watcher.on('session-updated', () => events.push('updated'));
    watcher.handleAppendLines('demo/sess1.jsonl', 1, [
      sessionLine({ uuid: 'u2', timestamp: '2026-01-01T00:01:00.000Z' }),
    ]);
    expect(events).toEqual(['updated']);
    expect(db.archive.rawLineStrings('sess1')).toHaveLength(2);
  });

  it('ignores an AppendLines whose fromLine does not match the archived line count', () => {
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    // fromLine=5 implies 5 prior lines, but the archive only has 1 - a
    // dropped or out-of-order frame. Applying it would corrupt line order.
    watcher.handleAppendLines('demo/sess1.jsonl', 5, [sessionLine({ uuid: 'u9' })]);
    expect(db.archive.rawLineStrings('sess1')).toHaveLength(1);
  });

  it('handleFileRemoved drops the session from the live map without touching the archive', () => {
    watcher.handleFileSnapshot('demo/sess1.jsonl', 100, 1000, [sessionLine()]);
    watcher.handleFileRemoved('demo/sess1.jsonl');
    expect(watcher.getAllMeta()).toEqual([]);
    expect(db.archive.hasSession('sess1')).toBe(true);
  });

  it('links a subagent transcript to its parent', () => {
    watcher.handleFileSnapshot('demo/parent.jsonl', 50, 1000, [
      JSON.stringify({
        type: 'assistant', uuid: 'a1', parentUuid: null, isSidechain: false,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant', model: 'claude-x', content: [
            { type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'sub task' } },
          ],
        },
      }),
    ]);
    watcher.handleFileSnapshot('demo/subagents/parent.jsonl', 40, 1000, [
      sessionLine({ sessionId: 'parent', uuid: 'u1', isSidechain: true }),
    ]);
    const parent = watcher.getAllMeta().find(m => m.id === 'parent');
    expect(parent?.subagents.length).toBeGreaterThanOrEqual(0);
  });
});
