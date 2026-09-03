import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { toMeta, toBody } from './session-shape.js';
import type {
  CostBreakdown, Session, SessionBody, SessionMeta, SessionStatus, SubagentInfo,
} from './types.js';
import type { SourceKind, SourceLocation } from './sources.js';
import type { StoreOrigin } from './store-origin.js';

export interface ArchiveStoreOptions {
  /** Minimum ms between body rewrites for a live session. Default 15000. */
  flushMs?: number | undefined;
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

const DEFAULT_FLUSH_MS = 15_000;

export interface ArchivePutOptions {
  /** Verbatim JSONL lines, when the session came from a file. */
  lines?: string[] | undefined;
  fileSize?: number | undefined;
  fileMtimeMs?: number | undefined;
  parserVersion?: number | undefined;
}

export interface ArchiveFingerprint {
  size: number | null;
  mtimeMs: number | null;
  headHash: string | null;
  lineCount: number;
}

export interface ArchiveStats {
  sessionCount: number;
  rawLineCount: number;
  bytes: number;
}

interface ArchiveRow {
  session_id: string;
  source_id: string;
  source_name: string;
  source_kind: string;
  source_location: string;
  origin_json: string | null;
  project_id: string;
  cwd: string;
  file_path: string;
  slug: string;
  title: string;
  model: string;
  status: string;
  is_subagent: number;
  parent_session_id: string | null;
  turn_count: number;
  cost_usd: number;
  started_at: string;
  last_activity_at: string;
  duration_ms: number;
  summary_json: string;
}

interface SummaryJson {
  costBreakdown: CostBreakdown;
  subagents: SubagentInfo[];
}

const SUMMARY_COLUMNS = `
  session_id, source_id, source_name, source_kind, source_location,
  origin_json, project_id, cwd, file_path, slug, title, model, status,
  is_subagent, parent_session_id, turn_count, cost_usd, started_at,
  last_activity_at, duration_ms, summary_json
`;

const HEAD_HASH_BYTES = 4096;

/**
 * Cheap identity for the head of a transcript. Two files that agree here and
 * differ only in length are treated as the same file having grown, which is
 * what a live Claude Code session does on every turn.
 */
function headHashOf(lines: string[]): string {
  return createHash('sha256')
    .update(lines.join('\n').slice(0, HEAD_HASH_BYTES))
    .digest('hex');
}

function rowToMeta(row: ArchiveRow): SessionMeta {
  const summary = JSON.parse(row.summary_json) as SummaryJson;
  const meta: SessionMeta = {
    id: row.session_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceKind: row.source_kind as SourceKind,
    sourceLocation: row.source_location as SourceLocation,
    projectId: row.project_id,
    filePath: row.file_path,
    slug: row.slug,
    title: row.title,
    status: row.status === 'live' ? 'done' : (row.status as SessionStatus),
    turnCount: row.turn_count,
    costUsd: row.cost_usd,
    model: row.model,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    durationMs: row.duration_ms,
    cwd: row.cwd,
    isSubagent: row.is_subagent === 1,
    costBreakdown: summary.costBreakdown,
    subagents: summary.subagents,
    archived: true,
  };
  if (row.origin_json !== null) {
    meta.origin = JSON.parse(row.origin_json) as StoreOrigin;
  }
  if (row.parent_session_id !== null) {
    meta.parentSessionId = row.parent_session_id;
  }
  return meta;
}

export class ArchiveStore {
  private readonly upsertRow: Database.Statement<{
    sessionId: string;
    sourceId: string;
    sourceName: string;
    sourceKind: string;
    sourceLocation: string;
    originJson: string | null;
    projectId: string;
    cwd: string;
    filePath: string;
    slug: string;
    title: string;
    model: string;
    status: string;
    isSubagent: number;
    parentSessionId: string | null;
    turnCount: number;
    costUsd: number;
    startedAt: string;
    lastActivityAt: string;
    durationMs: number;
    summaryJson: string;
    bodyJson: string;
    parserVersion: number;
    fileSize: number | null;
    fileMtimeMs: number | null;
    headHash: string | null;
    rawLineCount: number;
  }>;

  private readonly touchRaw: Database.Statement<{
    sessionId: string;
    lastActivityAt: string;
    fileSize: number | null;
    fileMtimeMs: number | null;
    headHash: string | null;
    rawLineCount: number;
  }>;

  private readonly updateBody: Database.Statement<{
    sessionId: string;
    status: string;
    title: string;
    model: string;
    turnCount: number;
    costUsd: number;
    durationMs: number;
    lastActivityAt: string;
    summaryJson: string;
    bodyJson: string;
    parserVersion: number;
  }>;

  private readonly flushMs: number;
  private readonly now: () => number;
  private readonly lastBodyWrite = new Map<string, number>();
  private readonly pending = new Map<string, { session: Session; parserVersion: number }>();

  constructor(
    private readonly db: Database.Database,
    options?: ArchiveStoreOptions,
  ) {
    this.flushMs = options?.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options?.now ?? (() => Date.now());
    this.upsertRow = this.db.prepare(`
      INSERT INTO archive_sessions (
        session_id, source_id, source_name, source_kind, source_location,
        origin_json, project_id, cwd, file_path, slug, title, model, status,
        is_subagent, parent_session_id, turn_count, cost_usd, started_at,
        last_activity_at, duration_ms, summary_json, body_json, body_codec,
        parser_version, file_size, file_mtime_ms, head_hash, raw_line_count,
        first_seen_at, last_ingested_at
      ) VALUES (
        @sessionId, @sourceId, @sourceName, @sourceKind, @sourceLocation,
        @originJson, @projectId, @cwd, @filePath, @slug, @title, @model, @status,
        @isSubagent, @parentSessionId, @turnCount, @costUsd, @startedAt,
        @lastActivityAt, @durationMs, @summaryJson, @bodyJson, 'json',
        @parserVersion, @fileSize, @fileMtimeMs, @headHash, @rawLineCount,
        datetime('now'), datetime('now')
      )
      ON CONFLICT (session_id) DO UPDATE SET
        source_id = excluded.source_id,
        source_name = excluded.source_name,
        source_kind = excluded.source_kind,
        source_location = excluded.source_location,
        origin_json = excluded.origin_json,
        project_id = excluded.project_id,
        cwd = excluded.cwd,
        file_path = excluded.file_path,
        slug = excluded.slug,
        title = excluded.title,
        model = excluded.model,
        status = excluded.status,
        is_subagent = excluded.is_subagent,
        parent_session_id = excluded.parent_session_id,
        turn_count = excluded.turn_count,
        cost_usd = excluded.cost_usd,
        started_at = excluded.started_at,
        last_activity_at = excluded.last_activity_at,
        duration_ms = excluded.duration_ms,
        summary_json = excluded.summary_json,
        body_json = excluded.body_json,
        parser_version = excluded.parser_version,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        head_hash = excluded.head_hash,
        raw_line_count = excluded.raw_line_count,
        last_ingested_at = datetime('now')
    `);

    this.touchRaw = db.prepare(`
      UPDATE archive_sessions SET
        last_activity_at = @lastActivityAt,
        file_size = @fileSize,
        file_mtime_ms = @fileMtimeMs,
        head_hash = @headHash,
        raw_line_count = @rawLineCount,
        last_ingested_at = datetime('now')
      WHERE session_id = @sessionId
    `);

    this.updateBody = db.prepare(`
      UPDATE archive_sessions SET
        status = @status,
        title = @title,
        model = @model,
        turn_count = @turnCount,
        cost_usd = @costUsd,
        duration_ms = @durationMs,
        last_activity_at = @lastActivityAt,
        summary_json = @summaryJson,
        body_json = @bodyJson,
        parser_version = @parserVersion,
        last_ingested_at = datetime('now')
      WHERE session_id = @sessionId
    `);
  }

  loadSummaries(): SessionMeta[] {
    const rows = this.db
      .prepare(`
        SELECT ${SUMMARY_COLUMNS} FROM archive_sessions
        ORDER BY last_activity_at DESC
      `)
      .all() as ArchiveRow[];
    return rows.map(rowToMeta);
  }

  getBody(sessionId: string): SessionBody | null {
    const row = this.db
      .prepare('SELECT body_json FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) as { body_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.body_json) as SessionBody;
  }

  hasSession(sessionId: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) !== undefined;
  }

  firstSeenAt(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT first_seen_at FROM archive_sessions WHERE session_id = ?')
      .get(sessionId) as { first_seen_at: string } | undefined;
    return row?.first_seen_at ?? null;
  }

  fileFingerprint(sessionId: string): ArchiveFingerprint | null {
    const row = this.db
      .prepare(`
        SELECT file_size, file_mtime_ms, head_hash, raw_line_count
        FROM archive_sessions WHERE session_id = ?
      `)
      .get(sessionId) as {
        file_size: number | null;
        file_mtime_ms: number | null;
        head_hash: string | null;
        raw_line_count: number;
      } | undefined;
    if (!row) return null;
    return {
      size: row.file_size,
      mtimeMs: row.file_mtime_ms,
      headHash: row.head_hash,
      lineCount: row.raw_line_count,
    };
  }

  getRawLines(
    sessionId: string, offset: number, limit: number,
  ): { lines: { lineNumber: number; content: unknown }[]; total: number } {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM archive_raw_lines WHERE session_id = ?')
        .get(sessionId) as { n: number }
    ).n;

    const rows = this.db
      .prepare(`
        SELECT line_number, content FROM archive_raw_lines
        WHERE session_id = ? ORDER BY line_number LIMIT ? OFFSET ?
      `)
      .all(sessionId, limit, offset) as { line_number: number; content: string }[];

    const lines = rows.map(r => {
      let content: unknown;
      try {
        content = JSON.parse(r.content);
      } catch {
        content = r.content;
      }
      return { lineNumber: r.line_number, content };
    });
    return { lines, total };
  }

  rawLineStrings(sessionId: string): string[] {
    return (
      this.db
        .prepare(`
          SELECT content FROM archive_raw_lines
          WHERE session_id = ? ORDER BY line_number
        `)
        .all(sessionId) as { content: string }[]
    ).map(r => r.content);
  }

  private writeLines(
    sessionId: string, lines: string[], previous: ArchiveFingerprint | null,
  ): void {
    const canAppend
      = previous !== null
      && previous.headHash === headHashOf(lines)
      && lines.length >= previous.lineCount;
    const from = canAppend ? previous.lineCount : 0;

    if (!canAppend) {
      this.db
        .prepare('DELETE FROM archive_raw_lines WHERE session_id = ?')
        .run(sessionId);
    }

    const insert = this.db.prepare(`
      INSERT INTO archive_raw_lines (session_id, line_number, content)
      VALUES (?, ?, ?)
      ON CONFLICT (session_id, line_number) DO UPDATE SET content = excluded.content
    `);
    for (let i = from; i < lines.length; i++) {
      insert.run(sessionId, i + 1, lines[i]!);
    }
  }

  put(session: Session, opts?: ArchivePutOptions): void {
    const meta = toMeta(session);
    const summaryJson = JSON.stringify({
      costBreakdown: meta.costBreakdown,
      subagents: meta.subagents,
    } satisfies SummaryJson);
    const bodyJson = JSON.stringify(toBody(session));
    const lines = opts?.lines;

    const now = this.now();
    const existed = this.hasSession(meta.id);
    const withinWindow
      = (now - (this.lastBodyWrite.get(meta.id) ?? 0)) < this.flushMs;
    const defer = existed && meta.status === 'live' && withinWindow;

    const txn = this.db.transaction(() => {
      const previous = this.fileFingerprint(meta.id);
      const lineCount = lines ? lines.length : (previous?.lineCount ?? 0);
      const headHash = lines ? headHashOf(lines) : (previous?.headHash ?? null);
      const fileSize = opts?.fileSize ?? previous?.size ?? null;
      const fileMtimeMs = opts?.fileMtimeMs ?? previous?.mtimeMs ?? null;

      if (defer) {
        this.touchRaw.run({
          sessionId: meta.id,
          lastActivityAt: meta.lastActivityAt,
          fileSize, fileMtimeMs, headHash, rawLineCount: lineCount,
        });
        if (lines) this.writeLines(meta.id, lines, previous);
        this.pending.set(meta.id, {
          session, parserVersion: opts?.parserVersion ?? 0,
        });
        return;
      }

      this.upsertRow.run({
        sessionId: meta.id,
        sourceId: meta.sourceId,
        sourceName: meta.sourceName,
        sourceKind: meta.sourceKind,
        sourceLocation: meta.sourceLocation,
        originJson: meta.origin ? JSON.stringify(meta.origin) : null,
        projectId: meta.projectId,
        cwd: meta.cwd,
        filePath: meta.filePath,
        slug: meta.slug,
        title: meta.title,
        model: meta.model,
        status: meta.status,
        isSubagent: meta.isSubagent ? 1 : 0,
        parentSessionId: meta.parentSessionId ?? null,
        turnCount: meta.turnCount,
        costUsd: meta.costUsd,
        startedAt: meta.startedAt,
        lastActivityAt: meta.lastActivityAt,
        durationMs: meta.durationMs,
        summaryJson,
        bodyJson,
        parserVersion: opts?.parserVersion ?? 0,
        fileSize,
        fileMtimeMs,
        headHash,
        rawLineCount: lineCount,
      });

      if (lines) this.writeLines(meta.id, lines, previous);
      this.lastBodyWrite.set(meta.id, now);
      this.pending.delete(meta.id);
    });

    txn();
  }

  /** Write a deferred body through. Leaves raw-line bookkeeping alone. */
  flush(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    const meta = toMeta(entry.session);
    this.updateBody.run({
      sessionId: meta.id,
      status: meta.status,
      title: meta.title,
      model: meta.model,
      turnCount: meta.turnCount,
      costUsd: meta.costUsd,
      durationMs: meta.durationMs,
      lastActivityAt: meta.lastActivityAt,
      summaryJson: JSON.stringify({
        costBreakdown: meta.costBreakdown, subagents: meta.subagents,
      } satisfies SummaryJson),
      bodyJson: JSON.stringify(toBody(entry.session)),
      parserVersion: entry.parserVersion,
    });
    this.pending.delete(sessionId);
    this.lastBodyWrite.set(sessionId, this.now());
  }

  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }

  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM archive_raw_lines WHERE session_id = ?')
        .run(sessionId);
      this.db
        .prepare('DELETE FROM archive_sessions WHERE session_id = ?')
        .run(sessionId);
    })();
  }

  stats(): ArchiveStats {
    return this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM archive_sessions) AS sessionCount,
          (SELECT COUNT(*) FROM archive_raw_lines) AS rawLineCount,
          (SELECT COALESCE(SUM(LENGTH(body_json) + LENGTH(summary_json)), 0)
             FROM archive_sessions)
          + (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM archive_raw_lines)
            AS bytes
      `)
      .get() as ArchiveStats;
  }
}
