import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { listOpenCodeSessions } from './opencode-parser.js';
import { decorateSession } from './session-shape.js';
import type { TrackerDB } from './db.js';
import type { Source } from './sources.js';
import type { Session } from './types.js';

const POLL_INTERVAL_MS = 1000;

export class OpenCodeWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private readonly dbPath: string;
  private readonly walPath: string;
  private db: TrackerDB | null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastDbMtimeMs = 0;
  private lastWalMtimeMs = 0;
  public readonly sourceId: string;

  constructor(
    private readonly source: Source,
    db?: TrackerDB,
  ) {
    super();
    this.sourceId = source.id;
    this.dbPath = join(source.path, 'opencode.db');
    this.walPath = `${this.dbPath}-wal`;
    this.db = db ?? null;
  }

  async start(): Promise<void> {
    const scanned = await this.scan();
    if (scanned) this.applyScan(scanned, false);
    await this.updateMtimes();
    this.pollTimer = setInterval(() => {
      void this.checkAndPoll();
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // Always does a full rescan + diff + emit, regardless of mtime - exposed
  // publicly so tests can drive it deterministically instead of waiting on
  // the real timer or racing filesystem mtime resolution.
  async pollOnce(): Promise<void> {
    const scanned = await this.scan();
    if (scanned) this.applyScan(scanned, true);
  }

  private async scan(): Promise<Session[] | null> {
    try {
      const parsed = await listOpenCodeSessions(this.dbPath, this.sourceId);
      return parsed.map(p => decorateSession(p, this.source));
    } catch (err) {
      console.error(
        `[opencode-watcher:${this.sourceId}] Failed to scan ${this.dbPath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private applyScan(scanned: Session[], emitEvents: boolean): void {
    for (const session of scanned) {
      const existing = this.sessions.get(session.id);
      this.sessions.set(session.id, session);

      if (this.db && !session.isSubagent) {
        this.db.indexSession(session);
      }

      if (!emitEvents) continue;

      if (!existing) {
        this.emit('session-created', session);
      } else if (existing.lastActivityAt !== session.lastActivityAt) {
        this.emit('session-updated', session);
      }
    }

    this.linkSubagents();
  }

  private async mtimeOf(path: string): Promise<number> {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch {
      return 0;
    }
  }

  private async updateMtimes(): Promise<void> {
    this.lastDbMtimeMs = await this.mtimeOf(this.dbPath);
    this.lastWalMtimeMs = await this.mtimeOf(this.walPath);
  }

  // Called on the internal timer - skips the rescan if neither the DB nor its
  // WAL file (WAL-mode writes touch that file, not the main one) changed
  // since the last check.
  private async checkAndPoll(): Promise<void> {
    const dbMtime = await this.mtimeOf(this.dbPath);
    const walMtime = await this.mtimeOf(this.walPath);
    if (dbMtime === this.lastDbMtimeMs && walMtime === this.lastWalMtimeMs) {
      return;
    }
    this.lastDbMtimeMs = dbMtime;
    this.lastWalMtimeMs = walMtime;
    await this.pollOnce();
  }

  // opencode gives subagent parentage directly via session.parent_id (already
  // resolved into parentSessionId by the parser), unlike Claude Code's
  // positional Agent-tool-call heuristic in SourceWatcher.linkSubagents().
  private linkSubagents(): void {
    const childMap = new Map<string, Session[]>();
    for (const session of this.sessions.values()) {
      if (!session.isSubagent || !session.parentSessionId) continue;
      let children = childMap.get(session.parentSessionId);
      if (!children) {
        children = [];
        childMap.set(session.parentSessionId, children);
      }
      children.push(session);
    }

    for (const [parentId, children] of childMap) {
      const parent = this.sessions.get(parentId);
      if (!parent) continue;

      parent.subagents = children.map(child => ({
        sessionId: child.id,
        parentSessionId: parentId,
        turnCount: child.turnCount,
        costUsd: child.costUsd,
        model: child.model,
        startedAt: child.startedAt,
        durationMs: child.durationMs,
      }));
    }
  }

  getAllSessions(): Session[] {
    return [...this.sessions.values()];
  }
}
