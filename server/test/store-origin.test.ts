import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rewriteCwd, synthesizeOrigin, readStoreOrigin, applyOrigin,
} from '../src/store-origin.ts';
import type { StoreOrigin } from '../src/store-origin.ts';
import type { ParsedSession } from '../src/types.ts';

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

describe('applyOrigin', () => {
  const baseSession: ParsedSession = {
    id: 's1',
    sourceId: 'agents:vercel.ai',
    projectId: 'workspace',
    filePath: '/claude/agents/vercel.ai/projects/-workspace/s1.jsonl',
    slug: 's1',
    title: 'A session',
    status: 'done' as const,
    turnCount: 3,
    costUsd: 0.5,
    model: 'claude-opus-5',
    startedAt: '2026-08-21T10:00:00Z',
    lastActivityAt: '2026-08-21T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [],
    logEntries: [],
    toolCalls: [],
    fileChanges: [],
    costBreakdown: { byTool: {}, conversationCost: 0, toolCost: 0, totalCost: 0 },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
  };

  it('rewrites cwd and recomputes projectId', () => {
    const out = applyOrigin(baseSession, {
      container: 'vercel.ai',
      hostWorkspace: '/home/dave/Projects/agent-shell',
    });
    expect(out.cwd).toBe('/home/dave/Projects/agent-shell');
    expect(out.projectId).toBe('agent-shell');
  });

  it('derives the key from a Windows hostWorkspace', () => {
    const out = applyOrigin(baseSession, {
      container: 'c',
      hostWorkspace: 'C:\\Users\\dave\\claude-project-tracker',
    });
    expect(out.projectId).toBe('claude-project-tracker');
  });

  it('keys on the store name under the fallback origin', () => {
    const out = applyOrigin(baseSession, synthesizeOrigin('legacy-shared'));
    expect(out.projectId).toBe('legacy-shared');
  });

  it('changes nothing else about the session', () => {
    const out = applyOrigin(baseSession, {
      container: 'c',
      hostWorkspace: '/home/dave/proj',
    });
    expect({ ...out, cwd: baseSession.cwd, projectId: baseSession.projectId })
      .toEqual(baseSession);
  });

  it('does not mutate the input session', () => {
    applyOrigin(baseSession, { container: 'c', hostWorkspace: '/home/dave/proj' });
    expect(baseSession.cwd).toBe('/workspace');
    expect(baseSession.projectId).toBe('workspace');
  });
});

describe('applyOrigin with gitBranch', () => {
  it('strips a worktree branch suffix from the container name when deriving projectId', () => {
    const worktreeSession: ParsedSession = {
      id: 's2',
      sourceId: 'agents:vercel.ai-feature-x',
      projectId: 'workspace',
      filePath: '/claude/agents/vercel.ai-feature-x/projects/-workspace/s2.jsonl',
      slug: 's2',
      title: 'A worktree session',
      status: 'done' as const,
      turnCount: 1,
      costUsd: 0.1,
      model: 'claude-opus-5',
      startedAt: '2026-08-21T10:00:00Z',
      lastActivityAt: '2026-08-21T10:05:00Z',
      durationMs: 60_000,
      cwd: '/workspace',
      gitBranch: 'feature-x',
      messages: [],
      logEntries: [],
      toolCalls: [],
      fileChanges: [],
      costBreakdown: { byTool: {}, conversationCost: 0, toolCost: 0, totalCost: 0 },
      hookEvents: [],
      permissionEvents: [],
      subagents: [],
      isSubagent: false,
      recaps: [],
    };
    const out = applyOrigin(worktreeSession, {
      container: 'myrepo-feature-x',
      hostWorkspace: '/home/dave/Projects/myrepo-feature-x',
    });
    expect(out.projectId).toBe('myrepo');
  });
});
