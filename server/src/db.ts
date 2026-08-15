import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session, AiSummary } from './types.ts';

const SCHEMA_VERSION = 2;

export interface SearchResult {
  sessionId: string;
  projectId: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface Tag {
  id: number;
  name: string;
}

export interface Prompt {
  id: number;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export class TrackerDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    // Rebuild FTS if the schema version changed. Done eagerly here so any
    // subsequent indexSession() calls write into the up-to-date table.
    this.maybeRebuildFts();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_id,
        project_id,
        title,
        content,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (session_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        source_last_activity_at TEXT NOT NULL
      );
    `);
  }

  currentSchemaVersion(): number {
    const row = this.db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number } | undefined;
    return row?.version ?? 0;
  }

  markSchemaVersion(version: number): void {
    this.db.exec('DELETE FROM schema_version');
    this.db
      .prepare('INSERT INTO schema_version (version) VALUES (?)')
      .run(version);
  }

  /**
   * If the stored schema version doesn't match the current one, drop and
   * recreate the FTS table. Caller is responsible for re-indexing sessions
   * after this returns.
   * Returns true if the FTS was rebuilt.
   */
  maybeRebuildFts(): boolean {
    const stored = this.currentSchemaVersion();
    if (stored === SCHEMA_VERSION) return false;

    console.log(
      `[db] schema version ${stored} -> ${SCHEMA_VERSION}; `
      + 'rebuilding FTS index',
    );
    this.db.exec('DROP TABLE IF EXISTS session_fts');
    this.db.exec(`
      CREATE VIRTUAL TABLE session_fts USING fts5(
        session_id,
        project_id,
        title,
        content,
        tokenize='porter unicode61'
      );
    `);
    this.markSchemaVersion(SCHEMA_VERSION);
    return true;
  }

  close(): void {
    this.db.close();
  }

  // --- FTS Indexing ---

  indexSession(session: Session): void {
    const textParts: string[] = [];
    for (const msg of session.messages) {
      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          }
        }
      }
    }
    const content = textParts.join('\n').slice(0, 50_000);

    // Delete then re-insert (FTS5 doesn't support upsert)
    this.db
      .prepare('DELETE FROM session_fts WHERE session_id = ?')
      .run(session.id);

    this.db
      .prepare(`
        INSERT INTO session_fts (session_id, project_id, title, content)
        VALUES (?, ?, ?, ?)
      `)
      .run(session.id, session.projectId, session.title, content);
  }

  // --- Search ---

  search(query: string, projectId?: string): SearchResult[] {
    const ftsQuery = query
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => `"${w.replace(/"/g, '""')}"`)
      .join(' ');

    if (ftsQuery.length === 0) return [];

    if (projectId) {
      return this.db
        .prepare(`
          SELECT
            session_id AS sessionId,
            project_id AS projectId,
            title,
            snippet(session_fts, 3, '<mark>', '</mark>', '...', 40) AS snippet,
            rank
          FROM session_fts
          WHERE session_fts MATCH ? AND project_id = ?
          ORDER BY rank
          LIMIT 50
        `)
        .all(ftsQuery, projectId) as SearchResult[];
    }

    return this.db
      .prepare(`
        SELECT
          session_id AS sessionId,
          project_id AS projectId,
          title,
          snippet(session_fts, 3, '<mark>', '</mark>', '...', 40) AS snippet,
          rank
        FROM session_fts
        WHERE session_fts MATCH ?
        ORDER BY rank
        LIMIT 50
      `)
      .all(ftsQuery) as SearchResult[];
  }

  // --- Tags ---

  getAllTags(): Tag[] {
    return this.db
      .prepare('SELECT id, name FROM tags ORDER BY name')
      .all() as Tag[];
  }

  getSessionTags(sessionId: string): Tag[] {
    return this.db
      .prepare(`
        SELECT t.id, t.name
        FROM tags t
        JOIN session_tags st ON st.tag_id = t.id
        WHERE st.session_id = ?
        ORDER BY t.name
      `)
      .all(sessionId) as Tag[];
  }

  addSessionTag(sessionId: string, tagName: string): Tag {
    const insertTag = this.db.prepare(`
      INSERT INTO tags (name) VALUES (?)
      ON CONFLICT (name) DO UPDATE SET name = name
    `);
    const getTag = this.db.prepare(
      'SELECT id, name FROM tags WHERE name = ?',
    );
    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO session_tags (session_id, tag_id)
      VALUES (?, ?)
    `);

    const txn = this.db.transaction((sid: string, name: string) => {
      insertTag.run(name);
      const tag = getTag.get(name) as Tag;
      insertLink.run(sid, tag.id);
      return tag;
    });

    return txn(sessionId, tagName);
  }

  removeSessionTag(sessionId: string, tagId: number): void {
    this.db
      .prepare('DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?')
      .run(sessionId, tagId);

    // Clean up orphan tags
    this.db
      .prepare(`
        DELETE FROM tags WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM session_tags WHERE tag_id = ?)
      `)
      .run(tagId, tagId);
  }

  getSessionsByTag(tagName: string): string[] {
    return (
      this.db
        .prepare(`
          SELECT st.session_id
          FROM session_tags st
          JOIN tags t ON t.id = st.tag_id
          WHERE t.name = ?
        `)
        .all(tagName) as { session_id: string }[]
    ).map(r => r.session_id);
  }

  // --- Prompts ---

  getAllPrompts(): Prompt[] {
    return this.db
      .prepare(`
        SELECT id, name, content, created_at AS createdAt, updated_at AS updatedAt
        FROM prompts ORDER BY updated_at DESC
      `)
      .all() as Prompt[];
  }

  createPrompt(name: string, content: string): Prompt {
    const result = this.db
      .prepare('INSERT INTO prompts (name, content) VALUES (?, ?)')
      .run(name, content);
    return this.db
      .prepare(`
        SELECT id, name, content, created_at AS createdAt, updated_at AS updatedAt
        FROM prompts WHERE id = ?
      `)
      .get(result.lastInsertRowid) as Prompt;
  }

  updatePrompt(id: number, name: string, content: string): Prompt | null {
    this.db
      .prepare(`
        UPDATE prompts SET name = ?, content = ?, updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(name, content, id);
    return (
      this.db
        .prepare(`
          SELECT id, name, content, created_at AS createdAt, updated_at AS updatedAt
          FROM prompts WHERE id = ?
        `)
        .get(id) as Prompt | undefined
    ) ?? null;
  }

  deletePrompt(id: number): void {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // --- AI Summaries ---

  getSessionSummary(sessionId: string): AiSummary | null {
    const row = this.db
      .prepare(`
        SELECT
          content, model, provider,
          generated_at AS generatedAt,
          source_last_activity_at AS sourceLastActivityAt
        FROM session_summaries WHERE session_id = ?
      `)
      .get(sessionId) as AiSummary | undefined;
    return row ?? null;
  }

  hasSessionSummary(sessionId: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM session_summaries WHERE session_id = ?')
      .get(sessionId) !== undefined;
  }

  saveSessionSummary(
    sessionId: string,
    summary: Omit<AiSummary, 'generatedAt'>,
  ): AiSummary {
    this.db
      .prepare(`
        INSERT INTO session_summaries
          (session_id, content, model, provider, source_last_activity_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          content = excluded.content,
          model = excluded.model,
          provider = excluded.provider,
          generated_at = datetime('now'),
          source_last_activity_at = excluded.source_last_activity_at
      `)
      .run(
        sessionId,
        summary.content,
        summary.model,
        summary.provider,
        summary.sourceLastActivityAt,
      );
    return this.getSessionSummary(sessionId)!;
  }
}
