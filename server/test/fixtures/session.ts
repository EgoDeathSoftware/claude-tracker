import type { Session } from '../../src/types.js';

/** A fully-formed session as it would look coming out of a dead source. */
export function archivedSession(id: string, sourceId: string): Session {
  return {
    id,
    sourceId,
    sourceName: sourceId,
    sourceKind: 'claude-code',
    sourceLocation: 'host',
    projectId: 'workspace',
    filePath: `/gone/projects/-workspace/${id}.jsonl`,
    slug: id,
    title: `Session ${id}`,
    status: 'done',
    turnCount: 1,
    costUsd: 0.1,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    isSubagent: false,
    costBreakdown: { byTool: {}, conversationCost: 0.1, toolCost: 0, totalCost: 0.1 },
    subagents: [],
    archived: false,
    messages: [{
      uuid: `${id}-u1`, type: 'user', content: 'archived hello',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [],
    toolCalls: [],
    fileChanges: [],
    hookEvents: [],
    permissionEvents: [],
    recaps: [],
  };
}
