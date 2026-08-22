import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { SessionRegistry } from './registry.ts';
import type { TrackerDB } from './db.ts';
import type { SourceKind } from './sources.ts';
import { readRawLines } from './parser.js';
import {
  readSettings,
  writeSettings,
  readClaudeJson,
  writeClaudeJson,
  listClaudeMdFiles,
  readClaudeMd,
  writeClaudeMd,
  listHookScripts,
  writeHookScript,
} from './config.js';
import type { SettingsJson, McpServer } from './config.js';
import { readLlmConfig, writeLlmConfig } from './llm-config.js';
import type { LlmConfig } from './llm-config.js';
import { listModels, testConnection, generateSummary } from './llm.js';
import { readOpenCodeConfig, listOpenCodeAgents } from './opencode-config.js';

export function buildApp(
  registry: SessionRegistry,
  db: TrackerDB,
  llmConfigPath: string,
): Hono {
  const app = new Hono();
  const sources = registry.getSources();
  const primarySource = sources[0];
  if (!primarySource) {
    console.warn(
      '[routes] no sources configured — config management endpoints will 503',
    );
  }
  const primaryClaudeDir = primarySource?.path ?? '';
  const primaryHomeDir = primaryClaudeDir.replace(/\/\.claude$/, '');
  const primaryOpenCodeSource = sources.find(
    s => s.kind === 'opencode' && s.configPath,
  );

  app.use('*', cors({ origin: 'http://localhost:5173' }));

  // --- Config: opencode (read-only) - independent of the primarySource gate
  // below, since Claude Code config and opencode config are separate
  // surfaces and one being unconfigured shouldn't 503 the other.

  app.get('/api/config/opencode', async c => {
    if (!primaryOpenCodeSource?.configPath) {
      return c.json({ error: 'no opencode source configured' }, 503);
    }
    return c.json(await readOpenCodeConfig(primaryOpenCodeSource.configPath));
  });

  app.get('/api/config/opencode/agents', async c => {
    if (!primaryOpenCodeSource?.configPath) {
      return c.json({ error: 'no opencode source configured' }, 503);
    }
    return c.json(await listOpenCodeAgents(primaryOpenCodeSource.configPath));
  });

  // --- Projects & Sessions ---

  function parseKinds(c: Context): SourceKind[] | undefined {
    const kindsParam = c.req.query('kinds');
    if (!kindsParam) return undefined;
    return kindsParam.split(',').filter(
      (k): k is SourceKind => k === 'claude-code' || k === 'opencode',
    );
  }

  app.get('/api/projects', c => c.json(registry.getProjects(parseKinds(c))));

  app.get('/api/sources', c => c.json(registry.getSources()));

  app.get('/api/sessions', c => {
    const projectId = c.req.query('projectId');
    const tag = c.req.query('tag');
    let sessions = registry.getSessions(projectId, parseKinds(c));
    if (tag) {
      const tagSessionIds = new Set(db.getSessionsByTag(tag));
      sessions = sessions.filter(s => tagSessionIds.has(s.id));
    }
    return c.json(sessions);
  });

  app.get('/api/sessions/:id', c => {
    const session = registry.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const aiSummary = db.getSessionSummary(session.id) ?? undefined;
    return c.json({ ...session, aiSummary });
  });

  app.get('/api/sessions/:id/raw', async c => {
    const session = registry.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    const offset = Number(c.req.query('offset') ?? '0');
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);

    // opencode has no per-session file to tail - synthesize the same
    // { lines: [{ lineNumber, content }], total } shape readRawLines
    // returns, paginating over the already-parsed messages instead.
    const source = registry.getSources().find(s => s.id === session.sourceId);
    if (source?.kind === 'opencode') {
      const total = session.messages.length;
      const end = Math.min(offset + limit, total);
      const lines: { lineNumber: number; content: unknown }[] = [];
      for (let i = offset; i < end; i++) {
        lines.push({ lineNumber: i + 1, content: session.messages[i] });
      }
      return c.json({ lines, total });
    }

    const result = await readRawLines(session.filePath, offset, limit);
    return c.json(result);
  });

  // --- Search ---

  app.get('/api/search', c => {
    const q = c.req.query('q') ?? '';
    const projectId = c.req.query('projectId');
    if (q.trim().length === 0) return c.json([]);
    return c.json(db.search(q, projectId));
  });

  // --- Tags ---

  app.get('/api/tags', c => c.json(db.getAllTags()));

  app.get('/api/sessions/:id/tags', c => {
    return c.json(db.getSessionTags(c.req.param('id')));
  });

  app.post('/api/sessions/:id/tags', async c => {
    const body = await c.req.json<{ name?: string }>();
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    const tag = db.addSessionTag(c.req.param('id'), name);
    return c.json(tag, 201);
  });

  app.delete('/api/sessions/:id/tags/:tagId', c => {
    db.removeSessionTag(
      c.req.param('id'),
      Number(c.req.param('tagId')),
    );
    return c.json({ ok: true });
  });

  // --- Prompts ---

  app.get('/api/prompts', c => c.json(db.getAllPrompts()));

  app.post('/api/prompts', async c => {
    const body = await c.req.json<{ name?: string; content?: string }>();
    const name = body.name?.trim();
    const content = body.content?.trim();
    if (!name || !content) {
      return c.json({ error: 'name and content required' }, 400);
    }
    return c.json(db.createPrompt(name, content), 201);
  });

  app.put('/api/prompts/:id', async c => {
    const body = await c.req.json<{ name?: string; content?: string }>();
    const name = body.name?.trim();
    const content = body.content?.trim();
    if (!name || !content) {
      return c.json({ error: 'name and content required' }, 400);
    }
    const prompt = db.updatePrompt(Number(c.req.param('id')), name, content);
    if (!prompt) return c.json({ error: 'not found' }, 404);
    return c.json(prompt);
  });

  app.delete('/api/prompts/:id', c => {
    db.deletePrompt(Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // --- AI Summaries ---

  app.get('/api/llm/config', async c => {
    const config = await readLlmConfig(llmConfigPath);
    return c.json(config);
  });

  app.put('/api/llm/config', async c => {
    const body = await c.req.json<LlmConfig>();
    await writeLlmConfig(llmConfigPath, body);
    return c.json({ ok: true });
  });

  app.get('/api/llm/models', async c => {
    const config = await readLlmConfig(llmConfigPath);
    try {
      const models = await listModels(config);
      return c.json({ models });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  app.post('/api/llm/test', async c => {
    const config = await readLlmConfig(llmConfigPath);
    const result = await testConnection(config);
    return c.json(result, result.ok ? 200 : 502);
  });

  app.get('/api/sessions/:id/summary', c => {
    const summary = db.getSessionSummary(c.req.param('id'));
    return c.json(summary);
  });

  app.post('/api/sessions/:id/summarize', async c => {
    const session = registry.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);

    const config = await readLlmConfig(llmConfigPath);
    try {
      const summary = await generateSummary(session, config);
      db.saveSessionSummary(session.id, summary);
      return c.json(summary);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  // --- Session Comparison ---

  app.get('/api/sessions/compare', c => {
    const aId = c.req.query('a');
    const bId = c.req.query('b');
    if (!aId || !bId) {
      return c.json({ error: 'a and b session IDs required' }, 400);
    }
    const a = registry.getSession(aId);
    const b = registry.getSession(bId);
    if (!a || !b) return c.json({ error: 'session not found' }, 404);

    return c.json({
      a: summarizeForComparison(a),
      b: summarizeForComparison(b),
    });
  });

  // --- Config: gate all /api/config/* routes on a primary source ---

  app.use('/api/config/*', async (c, next) => {
    if (!primarySource) {
      return c.json(
        { error: 'no source configured; cannot manage config' },
        503,
      );
    }
    await next();
  });

  // --- Config: settings.json ---

  app.get('/api/config/settings', async c => {
    return c.json(await readSettings(primaryClaudeDir));
  });

  app.put('/api/config/settings', async c => {
    const body = await c.req.json<SettingsJson>();
    await writeSettings(primaryClaudeDir, body);
    return c.json({ ok: true });
  });

  // --- Config: CLAUDE.md files ---

  app.get('/api/config/claude-md', async c => {
    return c.json(await listClaudeMdFiles(primaryClaudeDir));
  });

  app.get('/api/config/claude-md/read', async c => {
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'path required' }, 400);
    const content = await readClaudeMd(filePath);
    return c.json({ path: filePath, content });
  });

  app.put('/api/config/claude-md', async c => {
    const body = await c.req.json<{
      path?: string;
      content?: string;
    }>();
    if (!body.path || body.content === undefined) {
      return c.json({ error: 'path and content required' }, 400);
    }
    await writeClaudeMd(body.path, body.content);
    return c.json({ ok: true });
  });

  // --- Config: MCP servers ---

  app.get('/api/config/mcp', async c => {
    const data = await readClaudeJson(primaryHomeDir);
    return c.json(data.mcpServers ?? {});
  });

  app.put('/api/config/mcp/:name', async c => {
    const name = c.req.param('name');
    const server = await c.req.json<McpServer>();
    const data = await readClaudeJson(primaryHomeDir);
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers[name] = server;
    await writeClaudeJson(primaryHomeDir, data);
    return c.json({ ok: true });
  });

  app.delete('/api/config/mcp/:name', async c => {
    const name = c.req.param('name');
    const data = await readClaudeJson(primaryHomeDir);
    if (data.mcpServers) {
      delete data.mcpServers[name];
    }
    await writeClaudeJson(primaryHomeDir, data);
    return c.json({ ok: true });
  });

  // --- Config: Hook scripts ---

  app.get('/api/config/hooks', async c => {
    return c.json(await listHookScripts(primaryClaudeDir));
  });

  app.put('/api/config/hooks/:name', async c => {
    const name = c.req.param('name');
    const body = await c.req.json<{ content?: string }>();
    if (body.content === undefined) {
      return c.json({ error: 'content required' }, 400);
    }
    await writeHookScript(primaryClaudeDir, name, body.content);
    return c.json({ ok: true });
  });

  // --- SSE ---

  app.get('/api/events', c => {
    return streamSSE(c, async stream => {
      const onCreate = (session: unknown): void => {
        void stream.writeSSE({
          event: 'session-created',
          data: JSON.stringify(session),
        });
      };
      const onUpdate = (session: unknown): void => {
        void stream.writeSSE({
          event: 'session-updated',
          data: JSON.stringify(session),
        });
      };

      registry.on('session-created', onCreate);
      registry.on('session-updated', onUpdate);

      const interval = setInterval(() => {
        void stream.writeSSE({ data: 'ping' });
      }, 15_000);

      await new Promise<void>(resolve => {
        stream.onAbort(() => {
          clearInterval(interval);
          registry.off('session-created', onCreate);
          registry.off('session-updated', onUpdate);
          resolve();
        });
      });
    });
  });

  return app;
}

interface SessionSummaryForCompare {
  id: string;
  title: string;
  model: string;
  status: string;
  turnCount: number;
  costUsd: number;
  durationMs: number;
  startedAt: string;
  toolNames: string[];
  toolCallCount: number;
  filesPaths: string[];
  filesCount: number;
}

function summarizeForComparison(
  s: import('./types.ts').Session,
): SessionSummaryForCompare {
  const toolNames = [
    ...new Set(s.toolCalls.map(tc => tc.toolName)),
  ].sort();
  const filesPaths = [
    ...new Set(s.fileChanges.map(fc => fc.filePath)),
  ].sort();

  return {
    id: s.id,
    title: s.title,
    model: s.model,
    status: s.status,
    turnCount: s.turnCount,
    costUsd: s.costUsd,
    durationMs: s.durationMs,
    startedAt: s.startedAt,
    toolNames,
    toolCallCount: s.toolCalls.length,
    filesPaths,
    filesCount: filesPaths.length,
  };
}
