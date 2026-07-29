import { describe, it, expect, vi, afterEach } from 'vitest';
import { listModels, testConnection, generateSummary } from '../src/llm.js';
import type { LlmConfig } from '../src/llm-config.js';
import type { Session } from '../src/types.js';

const CONFIG: LlmConfig = {
  provider: 'ollama',
  baseUrl: 'http://example.test:8000/v1',
  apiKey: '',
  model: 'llama3.1',
  autoSummarize: false,
};

function makeLongMessages(turns: number): Session['messages'] {
  const messages: Session['messages'] = [];
  for (let i = 0; i < turns; i++) {
    const n = String(i).padStart(3, '0');
    messages.push({
      uuid: `u${n}`,
      type: 'user',
      timestamp: `2026-04-01T10:00:00.000Z`,
      content: `user turn ${i}`,
    });
    messages.push({
      uuid: `a${n}`,
      type: 'assistant',
      timestamp: `2026-04-01T10:00:01.000Z`,
      content: [{ type: 'text', text: `assistant turn ${i}` }],
    });
  }
  return messages;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    sourceId: 'default',
    projectId: 'proj',
    filePath: '/tmp/s1.jsonl',
    slug: '',
    title: 'Fix the bug',
    status: 'done',
    turnCount: 1,
    costUsd: 0,
    model: 'claude-sonnet-4-6',
    startedAt: '2026-04-01T10:00:00.000Z',
    lastActivityAt: '2026-04-01T10:05:00.000Z',
    durationMs: 300_000,
    cwd: '/home/user/project',
    messages: [
      { uuid: 'u1', type: 'user', timestamp: '2026-04-01T10:00:00.000Z', content: 'fix the login bug' },
      { uuid: 'a1', type: 'assistant', timestamp: '2026-04-01T10:00:05.000Z', content: [{ type: 'text', text: 'Fixed it in auth.ts' }] },
    ],
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

describe('llm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listModels', () => {
    it('requests /models and returns model ids', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(url).toBe('http://example.test:8000/v1/models');
        return new Response(
          JSON.stringify({ data: [{ id: 'llama3.1' }, { id: 'phi3' }] }),
          { status: 200 },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const models = await listModels(CONFIG);
      expect(models).toEqual(['llama3.1', 'phi3']);
    });

    it('sends an Authorization header when an apiKey is set', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer sk-test');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      await listModels({ ...CONFIG, apiKey: 'sk-test' });
    });

    it('throws when the response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('', { status: 500, statusText: 'Internal Error' })));

      await expect(listModels(CONFIG)).rejects.toThrow('models request failed');
    });
  });

  describe('testConnection', () => {
    it('returns ok=true with models on success', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'llama3.1' }] }), { status: 200 })));

      const result = await testConnection(CONFIG);
      expect(result).toEqual({ ok: true, models: ['llama3.1'] });
    });

    it('returns ok=false with an error message on failure', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('fetch failed');
      }));

      const result = await testConnection(CONFIG);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('fetch failed');
    });
  });

  describe('generateSummary', () => {
    it('posts a chat completion request and returns the parsed summary', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('http://example.test:8000/v1/chat/completions');
        const body = JSON.parse(init!.body as string);
        expect(body.model).toBe('llama3.1');
        expect(body.messages[1].content).toContain('fix the login bug');
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '  Fixed the login bug in auth.ts.  ' } }] }),
          { status: 200 },
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const summary = await generateSummary(makeSession(), CONFIG);
      expect(summary.content).toBe('Fixed the login bug in auth.ts.');
      expect(summary.model).toBe('llama3.1');
      expect(summary.provider).toBe('ollama');
      expect(summary.sourceLastActivityAt).toBe('2026-04-01T10:05:00.000Z');
    });

    it('throws when no model is configured', async () => {
      await expect(generateSummary(makeSession(), { ...CONFIG, model: '' }))
        .rejects.toThrow('no model selected');
    });

    it('throws when the endpoint returns a non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('server error', { status: 500, statusText: 'Internal Error' })));

      await expect(generateSummary(makeSession(), CONFIG))
        .rejects.toThrow('chat completion failed');
    });

    it('throws when the response has no content', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 })));

      await expect(generateSummary(makeSession(), CONFIG))
        .rejects.toThrow('empty response');
    });

    it('keeps only the start and end of long sessions, omitting the middle', async () => {
      let transcript = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        transcript = body.messages[1].content as string;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'summary' } }] }),
          { status: 200 },
        );
      }));

      const session = makeSession({ messages: makeLongMessages(20) });
      await generateSummary(session, CONFIG);

      expect(transcript).toContain('user turn 0');
      expect(transcript).toContain('assistant turn 0');
      expect(transcript).toContain('user turn 19');
      expect(transcript).toContain('assistant turn 19');
      expect(transcript).not.toContain('turn 10');
      expect(transcript).toContain('omitted from the middle of the session');
    });

    it('keeps the full transcript for short sessions (no omission marker)', async () => {
      let transcript = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(init!.body as string);
        transcript = body.messages[1].content as string;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'summary' } }] }),
          { status: 200 },
        );
      }));

      const session = makeSession({ messages: makeLongMessages(5) });
      await generateSummary(session, CONFIG);

      expect(transcript).toContain('user turn 0');
      expect(transcript).toContain('user turn 4');
      expect(transcript).not.toContain('omitted');
    });
  });
});
