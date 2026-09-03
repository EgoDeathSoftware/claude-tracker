import { describe, it, expect } from 'vitest';
import { decorateSession, toMeta, toBody, sourceSnapshot } from '../src/session-shape.js';
import type { ParsedSession } from '../src/types.js';
import type { Source } from '../src/sources.js';

function makeParsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 's1',
    sourceId: 'wsl',
    projectId: 'workspace',
    filePath: '/claude/projects/-workspace/s1.jsonl',
    slug: 's1',
    title: 'Session s1',
    status: 'done',
    turnCount: 2,
    costUsd: 0.5,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [{
      uuid: 'u1', type: 'user', content: 'hello',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [{ lineNumber: 1, type: 'user', summary: 'hello' }],
    toolCalls: [],
    fileChanges: [],
    costBreakdown: { byTool: {}, conversationCost: 0.5, toolCost: 0, totalCost: 0.5 },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
    ...overrides,
  };
}

const hostSource: Source = {
  id: 'wsl', name: 'WSL', path: '/claude/wsl',
  kind: 'claude-code', layout: 'single', location: 'host',
};

const containerSource: Source = {
  id: 'agents:vercel.ai', name: 'vercel.ai', path: '/claude/agents/vercel.ai',
  kind: 'claude-code', layout: 'single', location: 'container',
  parentId: 'agents',
  origin: { container: 'vercel.ai', hostWorkspace: '/home/david/code/vercel.ai' },
};

describe('sourceSnapshot', () => {
  it('copies name, kind and location', () => {
    expect(sourceSnapshot(hostSource)).toEqual({
      sourceName: 'WSL', sourceKind: 'claude-code', sourceLocation: 'host',
    });
  });

  it('includes origin only when the source has one', () => {
    expect(sourceSnapshot(hostSource)).not.toHaveProperty('origin');
    expect(sourceSnapshot(containerSource).origin).toEqual(containerSource.origin);
  });
});

describe('decorateSession', () => {
  it('adds the snapshot and marks the session live-backed', () => {
    const session = decorateSession(makeParsed(), hostSource);
    expect(session.sourceName).toBe('WSL');
    expect(session.sourceKind).toBe('claude-code');
    expect(session.sourceLocation).toBe('host');
    expect(session.archived).toBe(false);
  });

  it('preserves every parsed field', () => {
    const parsed = makeParsed();
    const session = decorateSession(parsed, hostSource);
    expect(session.messages).toEqual(parsed.messages);
    expect(session.costBreakdown).toEqual(parsed.costBreakdown);
    expect(session.title).toBe(parsed.title);
  });

  it('does not mutate the parsed session', () => {
    const parsed = makeParsed();
    decorateSession(parsed, containerSource);
    expect(parsed).not.toHaveProperty('archived');
  });
});

describe('toMeta / toBody', () => {
  it('toMeta drops every body field', () => {
    const meta = toMeta(decorateSession(makeParsed(), hostSource));
    for (const key of [
      'messages', 'logEntries', 'toolCalls', 'fileChanges',
      'hookEvents', 'permissionEvents', 'recaps',
    ]) {
      expect(meta).not.toHaveProperty(key);
    }
    expect(meta.id).toBe('s1');
    expect(meta.subagents).toEqual([]);
    expect(meta.costBreakdown.totalCost).toBe(0.5);
  });

  it('toBody keeps exactly the body fields', () => {
    const body = toBody(decorateSession(makeParsed(), hostSource));
    expect(Object.keys(body).sort()).toEqual([
      'fileChanges', 'hookEvents', 'logEntries', 'messages',
      'permissionEvents', 'recaps', 'toolCalls',
    ]);
    expect(body.messages).toHaveLength(1);
  });

  it('toMeta omits parentSessionId when absent rather than setting undefined', () => {
    const meta = toMeta(decorateSession(makeParsed(), hostSource));
    expect('parentSessionId' in meta).toBe(false);
  });

  it('toMeta carries parentSessionId when present', () => {
    const meta = toMeta(decorateSession(
      makeParsed({ isSubagent: true, parentSessionId: 'parent-1' }), hostSource,
    ));
    expect(meta.parentSessionId).toBe('parent-1');
  });
});
