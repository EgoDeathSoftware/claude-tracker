import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface SeedSession {
  id: string;
  projectId: string;
  directory: string;
  timeUpdated: number;
  parentId?: string | null;
  title?: string;
  parts?: Array<{ type: 'text' | 'tool'; text?: string; tool?: string; callID?: string; state?: unknown }>;
}

// Mirrors the real opencode DB (verified against a live install, opencode
// 1.18.18): parts live in their own table, one row per part, keyed by
// message_id - message.data does not embed a parts array, and message has
// no role column (role lives inside data JSON). Written once (opencode-parser
// .test.ts), then duplicated into opencode-watcher.test.ts, registry.test.ts,
// and routes.test.ts before being extracted here for the integration test -
// consolidating those four call sites is a follow-up, not done as part of
// this change, to avoid touching already-passing, already-committed tests.
export async function seedOpenCodeDb(
  dataDir: string,
  sessions: SeedSession[],
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, model TEXT, cost REAL,
      parent_id TEXT, time_updated INTEGER NOT NULL, title TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER NOT NULL, data TEXT
    );
  `);

  const sessionStmt = db.prepare(`
    INSERT INTO session (id, project_id, directory, model, cost, parent_id, time_updated, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const messageStmt = db.prepare(`
    INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)
  `);
  const partStmt = db.prepare(`
    INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)
  `);

  for (const session of sessions) {
    sessionStmt.run(
      session.id,
      session.projectId,
      session.directory,
      JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
      0.001,
      session.parentId ?? null,
      session.timeUpdated,
      session.title ?? 'OpenCode session',
    );

    const msgId = `${session.id}-msg-1`;
    messageStmt.run(msgId, session.id, session.timeUpdated, JSON.stringify({ role: 'user' }));

    const parts = session.parts ?? [{ type: 'text' as const, text: 'hello' }];
    parts.forEach((part, i) => {
      partStmt.run(
        `${msgId}-part-${i}`,
        msgId,
        session.timeUpdated + i,
        JSON.stringify(part),
      );
    });
  }

  db.close();
}
