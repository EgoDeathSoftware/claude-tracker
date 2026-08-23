import { EventEmitter } from 'node:events';
import { SourceWatcher } from './source-watcher.js';
import type { SourceWatcherOptions } from './source-watcher.js';
import { OpenCodeWatcher } from './opencode-watcher.js';
import { applyOrigin } from './store-origin.js';
import type { TrackerDB } from './db.js';
import type { Session, Project } from './types.js';
import type { Source, SourceKind, SourceLocation } from './sources.js';
import { displayNameFromCwd } from './project-key.js';

interface AgentWatcher extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAllSessions(): Session[];
}

function createWatcher(
  source: Source,
  db?: TrackerDB,
  options?: SourceWatcherOptions,
): AgentWatcher {
  switch (source.kind) {
    case 'claude-code':
      return new SourceWatcher(source.id, source.path, db, options);
    case 'opencode':
      return new OpenCodeWatcher(source.id, source.path, db);
  }
}

export class SessionRegistry extends EventEmitter {
  private watchers = new Map<string, AgentWatcher>();
  private sessions = new Map<string, Session>();
  private db: TrackerDB | null;
  private kindBySourceId: Map<string, SourceKind>;
  private locationBySourceId: Map<string, SourceLocation>;

  constructor(
    private sources: Source[],
    db?: TrackerDB,
  ) {
    super();
    this.db = db ?? null;
    this.kindBySourceId = new Map(this.sources.map(s => [s.id, s.kind]));
    this.locationBySourceId = new Map(this.sources.map(s => [s.id, s.location]));
  }

  private subscribe(watcher: AgentWatcher): void {
    watcher.on('session-created', (s: Session) => {
      this.ingest(s);
      this.emit('session-created', s);
    });
    watcher.on('session-updated', (s: Session) => {
      this.ingest(s);
      this.emit('session-updated', s);
    });
  }

  private watcherOptions(source: Source, watch: boolean): SourceWatcherOptions {
    const origin = source.origin;
    return {
      watch,
      transformSession: origin ? (s: Session) => applyOrigin(s, origin) : undefined,
    };
  }

  async start(): Promise<void> {
    for (const source of this.sources) {
      this.watchers.set(
        source.id,
        createWatcher(source, this.db ?? undefined, this.watcherOptions(source, true)),
      );
    }

    const entries = [...this.watchers.entries()];
    const results = await Promise.allSettled(entries.map(([, w]) => w.start()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[registry] source "${entries[i]![0]}" failed to start:`,
          r.reason,
        );
      }
    });

    for (const [, w] of entries) {
      for (const session of w.getAllSessions()) {
        this.ingest(session);
      }
    }

    for (const [, w] of entries) this.subscribe(w);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.watchers.values()].map(w => w.stop()));
  }

  /** Register a source discovered after startup and ingest its sessions. */
  async addSource(source: Source, opts?: { watch?: boolean }): Promise<void> {
    if (this.watchers.has(source.id)) await this.removeSource(source.id);

    const watcher = createWatcher(
      source,
      this.db ?? undefined,
      this.watcherOptions(source, opts?.watch ?? true),
    );
    this.sources.push(source);
    this.kindBySourceId.set(source.id, source.kind);
    this.locationBySourceId.set(source.id, source.location);
    this.watchers.set(source.id, watcher);

    try {
      await watcher.start();
    } catch (err) {
      console.warn(`[registry] source "${source.id}" failed to start:`, err);
    }
    for (const session of watcher.getAllSessions()) this.ingest(session);
    this.subscribe(watcher);
    this.emit('sources-changed');
  }

  /** Deregister a source and drop the sessions it contributed. */
  async removeSource(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    await watcher.stop().catch(() => undefined);
    watcher.removeAllListeners();
    this.watchers.delete(id);
    this.kindBySourceId.delete(id);
    this.locationBySourceId.delete(id);
    this.sources = this.sources.filter(s => s.id !== id);
    for (const [sessionId, session] of this.sessions) {
      if (session.sourceId === id) this.sessions.delete(sessionId);
    }
    this.emit('sources-changed');
  }

  private ingest(session: Session): void {
    const existing = this.sessions.get(session.id);
    if (existing && existing.sourceId !== session.sourceId) {
      const incomingNewer
        = new Date(session.lastActivityAt).getTime()
        >= new Date(existing.lastActivityAt).getTime();
      if (!incomingNewer) {
        console.warn(
          `[registry] session ID collision: ${session.id} `
          + `(keeping ${existing.sourceId}, discarding ${session.sourceId})`,
        );
        return;
      }
      console.warn(
        `[registry] session ID collision: ${session.id} `
        + `(replacing ${existing.sourceId} with ${session.sourceId})`,
      );
    }
    this.sessions.set(session.id, session);
  }

  getProjects(kinds?: SourceKind[]): Project[] {
    const allowedKinds = kinds ? new Set(kinds) : null;
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      if (allowedKinds && !allowedKinds.has(this.kindBySourceId.get(session.sourceId)!)) continue;
      const existing = map.get(session.projectId);
      if (!existing) {
        map.set(session.projectId, {
          id: session.projectId,
          name: displayNameFromCwd(session.cwd) || session.projectId,
          dirPath: session.cwd,
          sessionCount: 1,
          liveCount: session.status === 'live' ? 1 : 0,
          lastActivityAt: session.lastActivityAt,
          sources: [session.sourceId],
        });
      } else {
        existing.sessionCount++;
        if (session.status === 'live') existing.liveCount++;
        if (session.lastActivityAt > existing.lastActivityAt) {
          existing.lastActivityAt = session.lastActivityAt;
          existing.dirPath = session.cwd;
          existing.name
            = displayNameFromCwd(session.cwd) || session.projectId;
        }
        if (!existing.sources.includes(session.sourceId)) {
          existing.sources.push(session.sourceId);
        }
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime()
        - new Date(a.lastActivityAt).getTime(),
    );
  }

  getSessions(projectId?: string, kinds?: SourceKind[]): Session[] {
    const allowedKinds = kinds ? new Set(kinds) : null;
    const all = [...this.sessions.values()].filter(
      s => !s.isSubagent
        && (!allowedKinds || allowedKinds.has(this.kindBySourceId.get(s.sourceId)!)),
    );
    const filtered = projectId
      ? all.filter(s => s.projectId === projectId)
      : all;
    return filtered.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime()
        - new Date(a.lastActivityAt).getTime(),
    );
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSources(): Source[] {
    return this.sources;
  }
}
