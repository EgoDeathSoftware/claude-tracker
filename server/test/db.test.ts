import { describe, it, expect } from 'vitest';
import { TrackerDB } from '../src/db.js';
import type { Session } from '../src/types.js';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    sourceId: 'wsl',
    sourceName: 'WSL',
    sourceKind: 'claude-code',
    sourceLocation: 'host',
    archived: false,
    projectId: 'workspace',
    filePath: `/claude/projects/-workspace/${id}.jsonl`,
    slug: id,
    title: `Session ${id}`,
    status: 'done',
    turnCount: 1,
    costUsd: 0,
    model: 'claude-opus-5',
    startedAt: '2026-08-21T10:00:00Z',
    lastActivityAt: '2026-08-21T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [{
      uuid: `${id}-u1`, type: 'user', content: 'hello searchable world',
      timestamp: '2026-08-21T10:00:00Z',
    }],
    logEntries: [],
    toolCalls: [],
    fileChanges: [],
    costBreakdown: { byTool: {}, conversationCost: 0, toolCost: 0, totalCost: 0 },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
    ...overrides,
  };
}

describe('TrackerDB.removeSession', () => {
  it('removes the session from search results', () => {
    const db = new TrackerDB(':memory:');
    const session = makeSession('s1');
    db.indexSession(session);
    expect(db.search('searchable')).toHaveLength(1);

    db.removeSession('s1');
    expect(db.search('searchable')).toHaveLength(0);
  });

  it('drops the session-tag link and removes an orphaned tag', () => {
    const db = new TrackerDB(':memory:');
    db.indexSession(makeSession('s1'));
    const tag = db.addSessionTag('s1', 'important');
    expect(db.getSessionTags('s1')).toEqual([tag]);

    db.removeSession('s1');
    expect(db.getSessionTags('s1')).toEqual([]);
    expect(db.getAllTags()).toEqual([]);
  });

  it('keeps a tag alive when another session still uses it', () => {
    const db = new TrackerDB(':memory:');
    db.indexSession(makeSession('s1'));
    db.indexSession(makeSession('s2'));
    const tag = db.addSessionTag('s1', 'shared');
    db.addSessionTag('s2', 'shared');

    db.removeSession('s1');
    expect(db.getSessionTags('s1')).toEqual([]);
    expect(db.getAllTags()).toEqual([tag]);
    expect(db.getSessionsByTag('shared')).toEqual(['s2']);
  });

  it('removes a cached AI summary', () => {
    const db = new TrackerDB(':memory:');
    db.indexSession(makeSession('s1'));
    db.saveSessionSummary('s1', {
      content: 'summary text',
      model: 'claude-opus-5',
      provider: 'anthropic',
      sourceLastActivityAt: '2026-08-21T10:05:00Z',
    });
    expect(db.hasSessionSummary('s1')).toBe(true);

    db.removeSession('s1');
    expect(db.hasSessionSummary('s1')).toBe(false);
  });

  it('does not throw for a session with no fts row, tags, or summary', () => {
    const db = new TrackerDB(':memory:');
    expect(() => db.removeSession('never-indexed')).not.toThrow();
  });
});
