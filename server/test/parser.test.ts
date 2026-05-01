import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdtemp, rm, utimes, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseSession, readRawLines } from '../src/parser.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures/sample.jsonl');

describe('parseSession', () => {
  it('returns a Session with correct id and projectId derived from cwd basename', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.id).toBe('abc-123');
    // projectId is now derived from basename(cwd), lowercased
    expect(session.projectId).toBe('my-project');
    expect(session.sourceId).toBe('test-source');
  });

  it('derives title from first non-sidechain user message', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.title).toBe('Fix the login bug');
  });

  it('sets slug from first user record', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.slug).toBe('test-session');
  });

  it('counts only non-sidechain user messages as turns', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.turnCount).toBe(1);
  });

  it('computes cost from usage', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    // 10 input × 3/1e6 + 20 output × 15/1e6 = 0.00033
    expect(session.costUsd).toBeCloseTo(0.00033, 5);
  });

  it('sets model from last assistant message', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.model).toBe('claude-sonnet-4-6');
  });

  it('includes only user and assistant messages (no attachments, no sidechains)', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.messages).toHaveLength(2);
  });

  it('sets cwd from first user record', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.cwd).toBe('/home/user/my-project');
  });

  it('computes durationMs from first to last timestamp', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.durationMs).toBe(5000);
  });
});

describe('parseSession edge cases', () => {
  it('returns empty session for an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '');
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.messages).toHaveLength(0);
      expect(session.turnCount).toBe(0);
      expect(session.title).toBe('(untitled)');
      expect(session.durationMs).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips malformed JSON lines and parses valid ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'partial.jsonl');
    const content = [
      '{ this is not valid json',
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"Hello"}}',
      'garbage',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.messages).toHaveLength(2);
      expect(session.title).toBe('Hello');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('derives status=done when mtime is older than 5 minutes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'old.jsonl');
    await writeFile(file, '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"old"}}\n');
    // Set mtime to 10 minutes ago
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(file, tenMinutesAgo, tenMinutesAgo);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.status).toBe('done');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('derives status=live when mtime is recent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'fresh.jsonl');
    await writeFile(file, '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"fresh"}}\n');
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.status).toBe('live');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('handles user messages with array content (tool results) without crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'tool-result.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"hello"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":5,"output_tokens":5}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-04-01T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file1.txt\\nfile2.txt"}]}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      // Title should come from first user text message, not the tool result
      expect(session.title).toBe('hello');
      expect(typeof session.title).toBe('string');
      // Turn count should be 1 (only the real text message, not the tool-result continuation)
      expect(session.turnCount).toBe(1);
      // All 3 messages should still be preserved
      expect(session.messages).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips CLI wrapper messages (slash commands, caveats) from titles and turn counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'cli-wrappers.jsonl');
    const content = [
      // Slash-command echo — not flagged with isMeta but still CLI-generated
      '{"type":"user","uuid":"c1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"<command-name>/model</command-name>\\n<command-message>model</command-message>"}}',
      // Command output — also not flagged
      '{"type":"user","uuid":"c2","parentUuid":"c1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"user","content":"<local-command-stdout>Set model to Sonnet 4.6</local-command-stdout>"}}',
      // Real user message — should populate title and be the only counted turn
      '{"type":"user","uuid":"u1","parentUuid":"c2","isSidechain":false,"timestamp":"2026-04-01T10:00:02.000Z","message":{"role":"user","content":"now lets debug the bug"}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.title).toBe('now lets debug the bug');
      expect(session.turnCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips isMeta user records so titles come from real user messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'meta.jsonl');
    const content = [
      // CLI-injected meta record (local-command-caveat wrapper) — should be skipped
      '{"type":"user","uuid":"m1","parentUuid":null,"isSidechain":false,"isMeta":true,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands."}}',
      // CLI-injected slash-command echo — should be skipped
      '{"type":"user","uuid":"m2","parentUuid":"m1","isSidechain":false,"isMeta":true,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"user","content":"<command-name>/init</command-name>"}}',
      // Real user message — should populate title
      '{"type":"user","uuid":"u1","parentUuid":"m2","isSidechain":false,"timestamp":"2026-04-01T10:00:02.000Z","message":{"role":"user","content":"what is the current status"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:03.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"all good"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      // Title must come from the real user message, not from the CLI-injected meta records
      expect(session.title).toBe('what is the current status');
      // Only one real user turn (the meta records do not count)
      expect(session.turnCount).toBe(1);
      // Meta user records are filtered from messages; only the real user and the assistant remain
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0]?.uuid).toBe('u1');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('logEntries', () => {
  it('captures all record types from sample fixture', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    // sample.jsonl has: permission-mode, user, assistant, sidechain user, attachment
    expect(session.logEntries.length).toBeGreaterThanOrEqual(4);
    const types = session.logEntries.map(e => e.type);
    expect(types).toContain('permission-mode');
    expect(types).toContain('user');
    expect(types).toContain('assistant');
    expect(types).toContain('attachment');
  });

  it('includes line numbers starting at 1', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.logEntries[0]?.lineNumber).toBe(1);
    const lineNums = session.logEntries.map(e => e.lineNumber);
    for (let i = 1; i < lineNums.length; i++) {
      expect(lineNums[i]).toBeGreaterThan(lineNums[i - 1]!);
    }
  });

  it('generates summaries for each record type', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    for (const entry of session.logEntries) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
    const permEntry = session.logEntries.find(e => e.type === 'permission-mode');
    expect(permEntry?.summary).toContain('default');
  });

  it('includes progress and file-history-snapshot types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'mixed.jsonl');
    const content = [
      '{"type":"permission-mode","permissionMode":"default","sessionId":"s1"}',
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"progress","uuid":"p1","timestamp":"2026-04-01T10:00:01.000Z","data":{"type":"hook_progress","hookEvent":"PreToolUse","hookName":"check-lint"}}',
      '{"type":"file-history-snapshot","uuid":"f1","timestamp":"2026-04-01T10:00:02.000Z","snapshot":{"trackedFileBackups":{"a.ts":{},"b.ts":{}}}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:03.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.logEntries).toHaveLength(5);

      const progress = session.logEntries.find(e => e.type === 'progress');
      expect(progress?.summary).toContain('Hook');
      expect(progress?.summary).toContain('PreToolUse');

      const fileSnap = session.logEntries.find(e => e.type === 'file-history-snapshot');
      expect(fileSnap?.summary).toContain('2 files');

      // messages should still only have user + assistant
      expect(session.messages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('readRawLines', () => {
  it('returns paginated raw lines with total count', async () => {
    const result = await readRawLines(FIXTURE, 0, 2);
    expect(result.total).toBe(5); // 5 lines in sample.jsonl
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.lineNumber).toBe(1);
    expect(result.lines[1]?.lineNumber).toBe(2);
  });

  it('returns parsed JSON content', async () => {
    const result = await readRawLines(FIXTURE, 0, 1);
    const content = result.lines[0]?.content as { type?: string };
    expect(content?.type).toBe('permission-mode');
  });

  it('handles offset beyond total lines', async () => {
    const result = await readRawLines(FIXTURE, 100, 10);
    expect(result.total).toBe(5);
    expect(result.lines).toHaveLength(0);
  });
});

describe('toolCalls extraction', () => {
  it('extracts tool calls from assistant messages and matches results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'tools.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"list files"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-04-01T10:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file1.txt\\nfile2.txt"}]}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.toolCalls).toHaveLength(1);
      const tc = session.toolCalls[0]!;
      expect(tc.toolName).toBe('Bash');
      expect(tc.toolUseId).toBe('tu1');
      expect(tc.output).toBe('file1.txt\nfile2.txt');
      expect(tc.durationMs).toBe(2000);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('extracts multiple tool calls from a single assistant message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'multi-tools.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"read two files"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/a.ts"}},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/b.ts"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
      '{"type":"user","uuid":"u2","parentUuid":"a1","isSidechain":false,"timestamp":"2026-04-01T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"contents a"},{"type":"tool_result","tool_use_id":"tu2","content":"contents b"}]}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.toolCalls).toHaveLength(2);
      expect(session.toolCalls[0]!.toolName).toBe('Read');
      expect(session.toolCalls[1]!.toolName).toBe('Read');
      // Cost should be split evenly between the two tool calls
      const totalCost = session.costUsd;
      expect(session.toolCalls[0]!.costUsd).toBeCloseTo(totalCost / 2, 8);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('fileChanges extraction', () => {
  it('extracts Read, Write, Edit file operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'file-ops.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"do stuff"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/src/app.ts"}},{"type":"tool_use","id":"tu2","name":"Edit","input":{"file_path":"/src/app.ts","old_string":"a","new_string":"b"}},{"type":"tool_use","id":"tu3","name":"Write","input":{"file_path":"/src/new.ts","content":"hello"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.fileChanges).toHaveLength(3);
      expect(session.fileChanges[0]).toEqual(
        expect.objectContaining({ filePath: '/src/app.ts', operation: 'read' }),
      );
      expect(session.fileChanges[1]).toEqual(
        expect.objectContaining({ filePath: '/src/app.ts', operation: 'edit' }),
      );
      expect(session.fileChanges[2]).toEqual(
        expect.objectContaining({ filePath: '/src/new.ts', operation: 'write' }),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('ignores non-file tools like Bash and Grep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'no-files.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"run"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","id":"tu2","name":"Grep","input":{"pattern":"foo"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.fileChanges).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('costBreakdown', () => {
  it('splits cost between tools and conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'cost.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"thinking..."}],"usage":{"input_tokens":100,"output_tokens":50}}}',
      '{"type":"assistant","uuid":"a2","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:02.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":100,"output_tokens":50}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      const cb = session.costBreakdown;
      expect(cb.totalCost).toBeCloseTo(session.costUsd, 8);
      expect(cb.toolCost).toBeGreaterThan(0);
      expect(cb.conversationCost).toBeGreaterThan(0);
      expect(cb.toolCost + cb.conversationCost).toBeCloseTo(cb.totalCost, 8);
      expect(cb.byTool['Bash']).toBeDefined();
      expect(cb.byTool['Bash']!.calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns zero breakdown for sessions with no cost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'no-cost.jsonl');
    await writeFile(file, '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}\n');
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.costBreakdown.totalCost).toBe(0);
      expect(session.costBreakdown.toolCost).toBe(0);
      expect(session.costBreakdown.conversationCost).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('hookEvents extraction', () => {
  it('extracts hook_progress events from progress records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'hooks.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"test"}}',
      '{"type":"progress","uuid":"p1","timestamp":"2026-04-01T10:00:01.000Z","data":{"type":"hook_progress","hookEvent":"PreToolUse","hookName":"check-lint","command":"eslint ."}}',
      '{"type":"progress","uuid":"p2","timestamp":"2026-04-01T10:00:02.000Z","data":{"type":"hook_progress","hookEvent":"PostToolUse","hookName":"log-tool"}}',
      '{"type":"progress","uuid":"p3","timestamp":"2026-04-01T10:00:03.000Z","data":{"type":"agent_progress"}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.hookEvents).toHaveLength(2);
      expect(session.hookEvents[0]!.hookEvent).toBe('PreToolUse');
      expect(session.hookEvents[0]!.hookName).toBe('check-lint');
      expect(session.hookEvents[0]!.command).toBe('eslint .');
      expect(session.hookEvents[1]!.hookEvent).toBe('PostToolUse');
      expect(session.hookEvents[1]!.hookName).toBe('log-tool');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('resolves toolName from toolUseId via tool call map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'hook-resolve.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"test"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":5,"output_tokens":5}}}',
      '{"type":"progress","uuid":"p1","timestamp":"2026-04-01T10:00:02.000Z","parentToolUseID":"tu1","data":{"type":"hook_progress","hookEvent":"PostToolUse","hookName":"log-bash"}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.hookEvents).toHaveLength(1);
      expect(session.hookEvents[0]!.toolName).toBe('Bash');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('permissionEvents extraction', () => {
  it('extracts permission-mode records', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    const modeEvents = session.permissionEvents.filter(e => e.type === 'mode-set');
    expect(modeEvents.length).toBeGreaterThanOrEqual(1);
    expect(modeEvents[0]!.detail).toContain('default');
  });

  it('extracts hook_success and hook_error from attachment records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'perms.jsonl');
    const content = [
      '{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"s1","timestamp":"2026-04-01T10:00:00.000Z"}',
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"user","content":"test"}}',
      '{"type":"attachment","uuid":"att1","timestamp":"2026-04-01T10:00:02.000Z","attachment":{"type":"hook_error","content":"BLOCKED: unsafe command"}}',
      '{"type":"attachment","uuid":"att2","timestamp":"2026-04-01T10:00:03.000Z","attachment":{"type":"hook_success","content":""}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.permissionEvents).toHaveLength(3);

      const modeSet = session.permissionEvents.find(e => e.type === 'mode-set');
      expect(modeSet!.detail).toContain('bypassPermissions');

      const blocked = session.permissionEvents.find(e => e.type === 'hook-block');
      expect(blocked!.detail).toContain('BLOCKED');

      const passed = session.permissionEvents.find(e => e.type === 'hook-pass');
      expect(passed).toBeDefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('returns empty arrays when no hook/permission events exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'plain.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.hookEvents).toHaveLength(0);
      expect(session.permissionEvents).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe('subagent detection', () => {
  it('sets isSubagent=false and parentSessionId=undefined for top-level files', async () => {
    const session = await parseSession(FIXTURE, 'test-source', 'proj-1');
    expect(session.isSubagent).toBe(false);
    expect(session.parentSessionId).toBeUndefined();
    expect(session.subagents).toHaveLength(0);
  });

  it('sets isSubagent=true and parentSessionId for files in subagents dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const parentDir = join(dir, 'parent-session-123', 'subagents');
    await mkdir(parentDir, { recursive: true });
    const file = join(parentDir, 'agent-abc.jsonl');
    const content = [
      '{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"timestamp":"2026-04-01T10:00:00.000Z","message":{"role":"user","content":"subagent task"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":false,"timestamp":"2026-04-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":5,"output_tokens":5}}}',
    ].join('\n');
    await writeFile(file, content);
    try {
      const session = await parseSession(file, 'test-source', 'proj-1');
      expect(session.isSubagent).toBe(true);
      expect(session.parentSessionId).toBe('parent-session-123');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
