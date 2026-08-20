import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { listOpenCodeSessions } from '../src/opencode-parser.js';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-test-'));
}

describe('listOpenCodeSessions', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  function createTestDB(fixture: {
    projectId: string;
    sessions: Array<{
      id: string;
      project_id: string;
      directory: string;
      model: string;
      cost: number;
      parent_id?: string | null;
      time_updated: number;
    }>;
    messages: Array<{
      id: string;
      session_id: string;
      time_created: number;
      role: 'user' | 'assistant';
      data: { parts: Array<{ type: string; id?: string; tool?: string; text?: string; callID?: string; state?: unknown }> };
    }>;
  }): string {
    const dbPath = join(makeTmp(), 'test.db');
    cleanup.push(dbPath);

    const db = new Database(dbPath);

    // Schema mirrors the real opencode DB (verified against a live install):
    // parts live in their own table, one row per part, keyed by message_id -
    // message.data does not embed a parts array, and message has no role
    // column (role lives inside data JSON).
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        root_directory TEXT,
        created_at TEXT
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        model TEXT,
        cost REAL,
        parent_id TEXT,
        time_updated INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES project(id)
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT,
        FOREIGN KEY (session_id) REFERENCES session(id)
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT,
        FOREIGN KEY (message_id) REFERENCES message(id)
      );
    `);

    // Insert project
    db.prepare(`
      INSERT INTO project (id, display_name, root_directory, created_at)
      VALUES (?, ?, ?, ?)
    `).run(fixture.projectId, 'Test Project', fixture.sessions[0]?.directory || '', new Date().toISOString());

    // Insert sessions
    const sessionStmt = db.prepare(`
      INSERT INTO session (id, project_id, directory, model, cost, parent_id, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of fixture.sessions) {
      sessionStmt.run(
        session.id,
        session.project_id,
        session.directory,
        session.model,
        session.cost,
        session.parent_id ?? null,
        session.time_updated,
      );
    }

    // Insert messages - data holds only {role}, matching the real schema
    const messageStmt = db.prepare(`
      INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `);

    for (const msg of fixture.messages) {
      messageStmt.run(
        msg.id,
        msg.session_id,
        msg.time_created,
        JSON.stringify({ role: msg.role }),
      );
    }

    // Insert parts - one row per part, data holds {type, tool, text, callID, state}
    const partStmt = db.prepare(`
      INSERT INTO part (id, message_id, time_created, data)
      VALUES (?, ?, ?, ?)
    `);

    for (const msg of fixture.messages) {
      for (let partIdx = 0; partIdx < msg.data.parts.length; partIdx++) {
        const part = msg.data.parts[partIdx];
        partStmt.run(
          part.id || `${msg.id}-${part.type}-${part.tool || 'text'}-${partIdx}`,
          msg.id,
          msg.time_created + partIdx,
          JSON.stringify({
            type: part.type,
            tool: part.tool,
            text: part.text,
            callID: part.callID,
            state: part.state,
          }),
        );
      }
    }

    db.close();
    return dbPath;
  }

  it('returns Sessions matching session rows from SQLite DB', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Hello, fix the login bug.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              { type: 'text', text: 'I will fix it.' },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('session-1');
    expect(sessions[0]!.projectId).toBe('my-project');
    expect(sessions[0]!.sourceId).toBe('test-source');
    expect(sessions[0]!.fileChanges).toHaveLength(0);
    expect(sessions[0]!.toolCalls).toHaveLength(0);
    expect(sessions[0]!.hookEvents).toEqual([]);
    expect(sessions[0]!.permissionEvents).toEqual([]);
    expect(sessions[0]!.recaps).toEqual([]);
    expect(sessions[0]!.subagents).toEqual([]);
    expect(sessions[0]!.isSubagent).toBe(false);
    expect(sessions[0]!.parentSessionId).toBeUndefined();
    expect(sessions[0]!.costUsd).toBe(0.001);
  });

  it('correctly maps fileChanges for read/write/edit operations and excludes bash', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Read and edit a file.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              {
                type: 'tool',
                tool: 'read',
                callID: 'toolu_1',
                state: {
                  input: { file_path: '/home/user/my-project/src/app.ts' },
                },
              },
              {
                type: 'tool',
                tool: 'write',
                callID: 'toolu_2',
                state: {
                  input: { file_path: '/home/user/my-project/src/new.ts', content: 'hello' },
                },
              },
              {
                type: 'tool',
                tool: 'edit',
                callID: 'toolu_3',
                state: {
                  input: {
                    file_path: '/home/user/my-project/src/app.ts',
                    old_string: 'old',
                    new_string: 'new',
                  },
                },
              },
              {
                type: 'tool',
                tool: 'bash',
                callID: 'toolu_4',
                state: {
                  input: { command: 'ls -la' },
                },
              },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.fileChanges).toHaveLength(3);

    // Check read
    const readChange = session.fileChanges.find(f => f.operation === 'read');
    expect(readChange).toBeDefined();
    expect(readChange?.filePath).toBe('/home/user/my-project/src/app.ts');

    // Check write
    const writeChange = session.fileChanges.find(f => f.operation === 'write');
    expect(writeChange).toBeDefined();
    expect(writeChange?.filePath).toBe('/home/user/my-project/src/new.ts');

    // Check edit
    const editChange = session.fileChanges.find(f => f.operation === 'edit');
    expect(editChange).toBeDefined();
    expect(editChange?.filePath).toBe('/home/user/my-project/src/app.ts');

    // bash should NOT be in fileChanges
    const bashChange = session.fileChanges.find(f => f.operation === 'bash');
    expect(bashChange).toBeUndefined();
  });

  it('populates toolCalls with all tool parts including bash', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Run a command and read a file.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              {
                type: 'tool',
                tool: 'read',
                callID: 'toolu_1',
                state: {
                  input: { file_path: '/home/user/my-project/src/app.ts' },
                },
              },
              {
                type: 'tool',
                tool: 'write',
                callID: 'toolu_2',
                state: {
                  input: { file_path: '/home/user/my-project/src/new.ts', content: 'hello' },
                },
              },
              {
                type: 'tool',
                tool: 'edit',
                callID: 'toolu_3',
                state: {
                  input: {
                    file_path: '/home/user/my-project/src/app.ts',
                    old_string: 'old',
                    new_string: 'new',
                  },
                },
              },
              {
                type: 'tool',
                tool: 'bash',
                callID: 'toolu_4',
                state: {
                  input: { command: 'ls -la' },
                },
              },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.toolCalls).toHaveLength(4);

    // Check all tool calls are present
    const toolMap = new Map(session.toolCalls.map(tc => [tc.toolUseId, tc]));
    expect(toolMap.has('toolu_1')).toBe(true);
    expect(toolMap.has('toolu_2')).toBe(true);
    expect(toolMap.has('toolu_3')).toBe(true);
    expect(toolMap.has('toolu_4')).toBe(true);

    // Check tool names
    expect(toolMap.get('toolu_1')?.toolName).toBe('read');
    expect(toolMap.get('toolu_2')?.toolName).toBe('write');
    expect(toolMap.get('toolu_3')?.toolName).toBe('edit');
    expect(toolMap.get('toolu_4')?.toolName).toBe('bash');

    // Check input is preserved
    expect(toolMap.get('toolu_1')?.input).toEqual({ file_path: '/home/user/my-project/src/app.ts' });
    expect(toolMap.get('toolu_4')?.input).toEqual({ command: 'ls -la' });
  });

  it('correctly computes costUsd and costBreakdown', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.0025,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Hello.' },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.costUsd).toBe(0.0025);
    expect(session.costBreakdown.totalCost).toBe(0.0025);
    expect(session.costBreakdown.conversationCost).toBe(0.0025);
    expect(session.costBreakdown.toolCost).toBe(0);
    expect(Object.keys(session.costBreakdown.byTool)).toHaveLength(0);
  });

  it('marks child session with isSubagent=true and parentSessionId', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'parent-123',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
        {
          id: 'child-456',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.0005,
          parent_id: 'parent-123',
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'parent-123',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Task.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'child-456',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Child task.' },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(2);

    const parent = sessions.find(s => s.id === 'parent-123')!;
    expect(parent.isSubagent).toBe(false);
    expect(parent.parentSessionId).toBeUndefined();

    const child = sessions.find(s => s.id === 'child-456')!;
    expect(child.isSubagent).toBe(true);
    expect(child.parentSessionId).toBe('parent-123');
  });

  it('skips malformed session rows without crashing', async () => {
    const dbPath = join(makeTmp(), 'test.db');
    cleanup.push(dbPath);

    const db = new Database(dbPath);

    // Create schema
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        root_directory TEXT,
        created_at TEXT
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        model TEXT,
        cost REAL,
        parent_id TEXT,
        time_updated INTEGER NOT NULL
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT
      );
    `);

    // Insert project
    db.prepare(`INSERT INTO project (id, display_name, root_directory, created_at)
      VALUES (?, ?, ?, ?)`).run('proj-1', 'Test Project', '/home/user/my-project', new Date().toISOString());

    // Insert valid session
    db.prepare(`INSERT INTO session (id, project_id, directory, model, cost, time_updated)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      'valid-session',
      'proj-1',
      '/home/user/my-project',
      JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
      0.001,
      Date.now(),
    );

    // Insert malformed session (invalid JSON in model column)
    db.prepare(`INSERT INTO session (id, project_id, directory, model, cost, time_updated)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      'malformed-session',
      'proj-1',
      '/home/user/my-project',
      'not valid json',
      0.001,
      Date.now(),
    );

    // Insert valid message + part for valid session
    db.prepare(`INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)`).run(
      'msg-1',
      'valid-session',
      Date.now() - 10 * 60_000,
      JSON.stringify({ role: 'user' }),
    );
    db.prepare(`INSERT INTO part (id, message_id, time_created, data)
      VALUES (?, ?, ?, ?)`).run(
      'part-1',
      'msg-1',
      Date.now() - 10 * 60_000,
      JSON.stringify({ type: 'text', text: 'Hello' }),
    );

    // Second message + part, both well-formed
    db.prepare(`INSERT INTO message (id, session_id, time_created, data)
      VALUES (?, ?, ?, ?)`).run(
      'msg-2',
      'valid-session',
      Date.now() - 10 * 60_000 + 1000,
      JSON.stringify({ role: 'assistant' }),
    );
    db.prepare(`INSERT INTO part (id, message_id, time_created, data)
      VALUES (?, ?, ?, ?)`).run(
      'part-2',
      'msg-2',
      Date.now() - 10 * 60_000 + 1000,
      JSON.stringify({ type: 'text', text: 'Hi' }),
    );

    db.close();

    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    // Only the valid session should be returned
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('valid-session');

    // The malformed session should have been skipped (no crash)
    expect(sessions.find(s => s.id === 'malformed-session')).toBeUndefined();
  });

  it('handles malformed JSON in part.data gracefully', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Check part.', id: 'part-broken' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              {
                type: 'tool',
                tool: 'read',
                callID: 'toolu_1',
                state: {
                  input: { file_path: '/home/user/my-project/src/app.ts' },
                },
              },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);

    // Corrupt msg-1's part row directly - createTestDB always writes valid
    // JSON, so this is the only way to exercise the per-part try/catch.
    const db = new Database(dbPath);
    db.prepare(`UPDATE part SET data = ? WHERE id = ?`).run('not valid json', 'part-broken');
    db.close();

    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('session-1');
    // The corrupted part is skipped, but the rest of msg-1 and msg-2 still parse
    expect(sessions[0]!.messages).toHaveLength(2);
    expect(sessions[0]!.toolCalls).toHaveLength(1);
    expect(sessions[0]!.toolCalls[0]!.toolName).toBe('read');
    expect(sessions[0]!.toolCalls[0]!.toolUseId).toBe('toolu_1');
  });

  it('sets model from session.model JSON', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'openai', id: 'gpt-4o' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Hello.' },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.model).toBe('openai/gpt-4o');
  });

  it('derives status based on time_updated', async () => {
    // Recent (live) - less than 60 seconds ago
    const recent = Date.now() - 30_000;
    const fixtureLive = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-live',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: recent,
        },
      ],
      messages: [],
    };

    // Old (done) - more than 5 minutes ago
    const old = Date.now() - 10 * 60_000;
    const fixtureDone = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-done',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: old,
        },
      ],
      messages: [],
    };

    const dbPathLive = createTestDB(fixtureLive);
    const dbPathDone = createTestDB(fixtureDone);

    const sessionsLive = await listOpenCodeSessions(dbPathLive, 'test-source');
    const sessionsDone = await listOpenCodeSessions(dbPathDone, 'test-source');

    expect(sessionsLive[0]!.status).toBe('live');
    expect(sessionsDone[0]!.status).toBe('done');
  });

  it('includes all parts in SessionMessage content', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Hello, fix the login bug.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              { type: 'text', text: 'I will fix it.' },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]!.type).toBe('user');
    expect(session.messages[0]!.content).toEqual('Hello, fix the login bug.');
    expect(session.messages[1]!.type).toBe('assistant');
    expect(session.messages[1]!.content).toEqual('I will fix it.');
  });

  it('sets costBreakdown with byTool counts (when tool calls present)', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.0015,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [
        {
          id: 'msg-1',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000,
          role: 'user',
          data: {
            parts: [
              { type: 'text', text: 'Do work.' },
            ],
          },
        },
        {
          id: 'msg-2',
          session_id: 'session-1',
          time_created: Date.now() - 10 * 60_000 + 1000,
          role: 'assistant',
          data: {
            parts: [
              {
                type: 'tool',
                tool: 'read',
                callID: 'toolu_1',
                state: { input: { file_path: '/home/user/my-project/src/app.ts' } },
              },
              {
                type: 'tool',
                tool: 'read',
                callID: 'toolu_2',
                state: { input: { file_path: '/home/user/my-project/src/util.ts' } },
              },
            ],
          },
        },
      ],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.costBreakdown.byTool['read']).toBeDefined();
    expect(session.costBreakdown.byTool['read']!.calls).toBe(2);
    expect(session.costBreakdown.totalCost).toBe(0.0015);
    expect(session.costBreakdown.toolCost).toBe(0.0015);
    expect(session.costBreakdown.conversationCost).toBe(0);
  });

  it('sets filePath to the database path', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/my-project',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.filePath).toBe(dbPath);
  });

  it('derives projectId from session.directory using deriveProjectKey', async () => {
    const fixture = {
      projectId: 'proj-1',
      sessions: [
        {
          id: 'session-1',
          project_id: 'proj-1',
          directory: '/home/user/My-Project-Name',
          model: JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
          cost: 0.001,
          time_updated: Date.now() - 10 * 60_000,
        },
      ],
      messages: [],
    };

    const dbPath = createTestDB(fixture);
    const sessions = await listOpenCodeSessions(dbPath, 'test-source');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.projectId).toBe('my-project-name');
  });
});
