import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseSession } from '../src/parser.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures/sample.jsonl');

describe('parseSession', () => {
  it('returns a Session with correct id and projectId', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.id).toBe('abc-123');
    expect(session.projectId).toBe('proj-1');
  });

  it('derives title from first non-sidechain user message', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.title).toBe('Fix the login bug');
  });

  it('sets slug from first user record', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.slug).toBe('test-session');
  });

  it('counts only non-sidechain user messages as turns', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.turnCount).toBe(1);
  });

  it('computes cost from usage', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    // 10 input × 3/1e6 + 20 output × 15/1e6 = 0.00033
    expect(session.costUsd).toBeCloseTo(0.00033, 5);
  });

  it('sets model from last assistant message', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.model).toBe('claude-sonnet-4-6');
  });

  it('includes only user and assistant messages (no attachments, no sidechains)', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.messages).toHaveLength(2);
  });

  it('sets cwd from first user record', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.cwd).toBe('/home/user/my-project');
  });

  it('computes durationMs from first to last timestamp', async () => {
    const session = await parseSession(FIXTURE, 'proj-1');
    expect(session.durationMs).toBe(5000);
  });
});

describe('parseSession edge cases', () => {
  it('returns empty session for an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parser-test-'));
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '');
    try {
      const session = await parseSession(file, 'proj-1');
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
      const session = await parseSession(file, 'proj-1');
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
      const session = await parseSession(file, 'proj-1');
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
      const session = await parseSession(file, 'proj-1');
      expect(session.status).toBe('live');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
