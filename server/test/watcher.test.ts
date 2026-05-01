import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../src/watcher.ts';

function makeUserLine(uuid: string, content: string, ts: string): string {
  return JSON.stringify({
    type: 'user', uuid, parentUuid: null, isSidechain: false,
    timestamp: ts, message: { role: 'user', content },
  });
}

function makeAssistantLine(
  uuid: string, parentUuid: string, ts: string,
  toolUses?: { id: string; name: string; input: unknown }[],
): string {
  const content = toolUses
    ? toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))
    : [{ type: 'text', text: 'response' }];
  return JSON.stringify({
    type: 'assistant', uuid, parentUuid, isSidechain: false,
    timestamp: ts,
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content,
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  });
}

describe('SessionWatcher subagent support', () => {
  let cleanupDir: string | null = null;

  afterEach(async () => {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true });
      cleanupDir = null;
    }
  });

  it('scans subagent files and links them to parent sessions', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    cleanupDir = claudeDir;

    const projectDir = join(claudeDir, 'projects', '-test-project');
    await mkdir(projectDir, { recursive: true });

    // Create parent session with an Agent tool call
    const parentContent = [
      makeUserLine('u1', 'run subagent', '2026-04-01T10:00:00.000Z'),
      makeAssistantLine('a1', 'u1', '2026-04-01T10:00:01.000Z', [
        { id: 'tu1', name: 'Agent', input: { description: 'explore codebase', subagent_type: 'Explore' } },
      ]),
    ].join('\n');
    await writeFile(join(projectDir, 'parent-sess.jsonl'), parentContent);

    // Create subagent file
    const subagentDir = join(projectDir, 'parent-sess', 'subagents');
    await mkdir(subagentDir, { recursive: true });
    const subContent = [
      makeUserLine('su1', 'subagent work', '2026-04-01T10:00:02.000Z'),
      makeAssistantLine('sa1', 'su1', '2026-04-01T10:00:03.000Z'),
    ].join('\n');
    await writeFile(join(subagentDir, 'agent-abc.jsonl'), subContent);

    const watcher = new SessionWatcher(claudeDir);
    await watcher.start();

    try {
      // Subagents should be filtered from getSessions
      const sessions = watcher.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.isSubagent).toBe(false);

      // Parent should have subagent info populated
      const parent = sessions[0]!;
      expect(parent.subagents).toHaveLength(1);
      expect(parent.subagents[0]!.description).toBe('explore codebase');
      expect(parent.subagents[0]!.subagentType).toBe('Explore');
      expect(parent.subagents[0]!.turnCount).toBe(1);

      // Subagent should exist via getSession()
      const sub = watcher.getSession(parent.subagents[0]!.sessionId);
      expect(sub).toBeDefined();
      expect(sub!.isSubagent).toBe(true);
      expect(sub!.parentSessionId).toBe('parent-sess');

      // Projects should not count subagents
      const projects = watcher.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.sessionCount).toBe(1);
    } finally {
      await watcher.stop();
    }
  });

  it('correctly derives projectId for subagent paths', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    cleanupDir = claudeDir;

    const projectDir = join(claudeDir, 'projects', '-my-project');
    await mkdir(projectDir, { recursive: true });

    // Just a top-level session
    const content = [
      makeUserLine('u1', 'hello', '2026-04-01T10:00:00.000Z'),
    ].join('\n');
    await writeFile(join(projectDir, 'sess1.jsonl'), content);

    // A subagent in a nested path
    const subDir = join(projectDir, 'sess1', 'subagents');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'agent-x.jsonl'), content);

    const watcher = new SessionWatcher(claudeDir);
    await watcher.start();

    try {
      // Both should have projectId = '-my-project'
      const all = watcher.getSessions();
      expect(all).toHaveLength(1); // subagent filtered
      expect(all[0]!.projectId).toBe('default:-my-project');

      // Subagent too
      const sub = watcher.getSession('agent-x');
      expect(sub?.projectId).toBe('default:-my-project');
    } finally {
      await watcher.stop();
    }
  });
});
