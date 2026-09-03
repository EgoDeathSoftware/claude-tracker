import type Database from 'better-sqlite3';
import { toMeta, toBody } from './session-shape.js';
import type {
  CostBreakdown, Session, SessionBody, SessionMeta, SessionStatus, SubagentInfo,
} from './types.js';
import type { SourceKind, SourceLocation } from './sources.js';
import type { StoreOrigin } from './store-origin.js';

export interface ArchivePutOptions {
  /** Verbatim JSONL lines, when the session came from a file. */
  lines?: string[] | undefined;
  fileSize?: number | undefined;
  fileMtimeMs?: number | undefined;
  parserVersion?: number | undefined;
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
  constructor(private readonly db: Database.Database) {}

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

  put(session: Session, opts?: ArchivePutOptions): void {
    const meta = toMeta(session);
    const summaryJson = JSON.stringify({
      costBreakdown: meta.costBreakdown,
      subagents: meta.subagents,
    } satisfies SummaryJson);
    const bodyJson = JSON.stringify(toBody(session));

    this.db
      .prepare(`
        INSERT INTO archive_sessions (
          session_id, source_id, source_name, source_kind, source_location,
          origin_json, project_id, cwd, file_path, slug, title, model, status,
          is_subagent, parent_session_id, turn_count, cost_usd, started_at,
          last_activity_at, duration_ms, summary_json, body_json, body_codec,
          parser_version, first_seen_at, last_ingested_at
        ) VALUES (
          @sessionId, @sourceId, @sourceName, @sourceKind, @sourceLocation,
          @originJson, @projectId, @cwd, @filePath, @slug, @title, @model, @status,
          @isSubagent, @parentSessionId, @turnCount, @costUsd, @startedAt,
          @lastActivityAt, @durationMs, @summaryJson, @bodyJson, 'json',
          @parserVersion, datetime('now'), datetime('now')
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
          last_ingested_at = datetime('now')
      `)
      .run({
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
      });
  }

  deleteSession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM archive_sessions WHERE session_id = ?')
      .run(sessionId);
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
