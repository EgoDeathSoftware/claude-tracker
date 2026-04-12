import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
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
