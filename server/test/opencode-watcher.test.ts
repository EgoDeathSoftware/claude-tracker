import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { OpenCodeWatcher } from '../src/opencode-watcher.js';
import { TrackerDB } from '../src/db.js';
import type { Session } from '../src/types.js';
import type { Source } from '../src/sources.js';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-watcher-test-'));
}

function src(id: string, path: string): Source {
  return { id, name: id, path, kind: 'opencode', layout: 'single', location: 'host' };
}

// Mirrors the real opencode schema (verified against a live install) -
// parts live in their own table, one row per part, keyed by message_id.
function createDb(dataDir: string): Database.Database {
  const dbPath = join(dataDir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, display_name TEXT, root_directory TEXT, created_at TEXT
    );
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
  return db;
}

function insertSession(
  db: Database.Database,
  session: {
    id: string;
    projectId: string;
    directory: string;
    title: string;
    timeUpdated: number;
    parentId?: string | null;
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO session (id, project_id, directory, model, cost, parent_id, time_updated, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.projectId,
    session.directory,
    JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6' }),
    0.001,
    session.parentId ?? null,
    session.timeUpdated,
    session.title,
  );

  const msgId = `${session.id}-msg-1`;
  db.prepare(`INSERT OR REPLACE INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    msgId,
    session.id,
    session.timeUpdated,
    JSON.stringify({ role: 'user' }),
  );
  db.prepare(`INSERT OR REPLACE INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
    `${msgId}-part-1`,
    msgId,
    session.timeUpdated,
    JSON.stringify({ type: 'text', text: 'hello' }),
  );
}

describe('OpenCodeWatcher', () => {
  const cleanup: string[] = [];
  const watchers: OpenCodeWatcher[] = [];

  beforeEach(() => {
    cleanup.length = 0;
    watchers.length = 0;
  });

  afterEach(async () => {
    for (const w of watchers.splice(0)) {
      await w.stop();
    }
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('populates getAllSessions() from an initial scan without emitting events', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Initial session',
      timeUpdated: Date.now() - 60_000,
    });
    db.close();

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);

    const created: Session[] = [];
    watcher.on('session-created', (s: Session) => created.push(s));

    await watcher.start();

    expect(watcher.getAllSessions()).toHaveLength(1);
    expect(watcher.getAllSessions()[0]!.id).toBe('session-1');
    // The initial scan should not be treated as new arrivals
    expect(created).toHaveLength(0);
  });

  it('emits session-created when pollOnce() finds a new session', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Initial session',
      timeUpdated: Date.now() - 60_000,
    });

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);
    await watcher.start();

    const created: Session[] = [];
    watcher.on('session-created', (s: Session) => created.push(s));

    insertSession(db, {
      id: 'session-2',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'New session',
      timeUpdated: Date.now(),
    });
    db.close();

    await watcher.pollOnce();

    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe('session-2');
    expect(watcher.getAllSessions()).toHaveLength(2);
  });

  it('emits session-updated when pollOnce() finds a changed session', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Original title',
      timeUpdated: Date.now() - 60_000,
    });

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);
    await watcher.start();

    const updated: Session[] = [];
    const created: Session[] = [];
    watcher.on('session-updated', (s: Session) => updated.push(s));
    watcher.on('session-created', (s: Session) => created.push(s));

    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Updated title',
      timeUpdated: Date.now(),
    });
    db.close();

    await watcher.pollOnce();

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.title).toBe('Updated title');
    expect(watcher.getAllSessions()).toHaveLength(1);
    expect(watcher.getAllSessions()[0]!.title).toBe('Updated title');
  });

  it('does not re-emit when pollOnce() finds no changes', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Steady session',
      timeUpdated: Date.now() - 60_000,
    });
    db.close();

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);
    await watcher.start();

    const created: Session[] = [];
    const updated: Session[] = [];
    watcher.on('session-created', (s: Session) => created.push(s));
    watcher.on('session-updated', (s: Session) => updated.push(s));

    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('links subagents by parentSessionId after a poll', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'parent-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Parent',
      timeUpdated: Date.now() - 60_000,
    });

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);
    await watcher.start();

    insertSession(db, {
      id: 'child-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Child',
      timeUpdated: Date.now(),
      parentId: 'parent-1',
    });
    db.close();

    await watcher.pollOnce();

    const parent = watcher.getAllSessions().find(s => s.id === 'parent-1')!;
    expect(parent.subagents).toHaveLength(1);
    expect(parent.subagents[0]!.sessionId).toBe('child-1');

    const child = watcher.getAllSessions().find(s => s.id === 'child-1')!;
    expect(child.isSubagent).toBe(true);
    expect(child.parentSessionId).toBe('parent-1');
  });

  it('getAllSessions() returns an empty array when the DB does not exist yet', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    watchers.push(watcher);
    await watcher.start();

    expect(watcher.getAllSessions()).toHaveLength(0);
  });

  it('stop() clears the poll timer without throwing', async () => {
    const dataDir = makeTmp();
    cleanup.push(dataDir);

    const db = createDb(dataDir);
    insertSession(db, {
      id: 'session-1',
      projectId: 'proj-1',
      directory: '/home/user/my-project',
      title: 'Session',
      timeUpdated: Date.now(),
    });
    db.close();

    const watcher = new OpenCodeWatcher(src('test-source', dataDir));
    await watcher.start();
    await expect(watcher.stop()).resolves.toBeUndefined();
  });
});

describe('OpenCodeWatcher archive write-through', () => {
  const ocCleanup: string[] = [];
  afterEach(async () => {
    for (const d of ocCleanup.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('archives scanned sessions with a body and no raw lines', async () => {
    const dataDir = makeTmp();
    ocCleanup.push(dataDir);
    const ocDb = createDb(dataDir);
    insertSession(ocDb, {
      id: 'oc-1', projectId: 'p1', directory: '/workspace',
      timeUpdated: 1_756_000_000_000, title: 'OpenCode session',
    });
    ocDb.close();

    const db = new TrackerDB(':memory:');
    const watcher = new OpenCodeWatcher(
      { id: 'oc', name: 'OpenCode', path: dataDir,
        kind: 'opencode', layout: 'single', location: 'host' },
      db,
    );
    await watcher.start();

    const summaries = db.archive.loadSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]!.sourceKind).toBe('opencode');
    expect(db.archive.getBody(summaries[0]!.id)).not.toBeNull();
    expect(db.archive.stats().rawLineCount).toBe(0);
    await watcher.stop();
  });
});
