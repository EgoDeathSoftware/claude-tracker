import { EventEmitter } from 'node:events';
import { SourceWatcher } from './source-watcher.js';
import { OpenCodeWatcher } from './opencode-watcher.js';
import type { TrackerDB } from './db.js';
import type { Session, Project } from './types.js';
import type { Source, SourceKind } from './sources.js';
import { displayNameFromCwd } from './project-key.js';

interface AgentWatcher extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAllSessions(): Session[];
}

function createWatcher(source: Source, db?: TrackerDB): AgentWatcher {
  switch (source.kind) {
    case 'claude-code':
      return new SourceWatcher(source.id, source.path, db);
    case 'opencode':
      return new OpenCodeWatcher(source.id, source.path, db);
  }
}

export class SessionRegistry extends EventEmitter {
  private watchers: AgentWatcher[] = [];
  private sessions = new Map<string, Session>();
  private db: TrackerDB | null;
  private kindBySourceId: Map<string, SourceKind>;

  constructor(
    private sources: Source[],
    db?: TrackerDB,
  ) {
    super();
    this.db = db ?? null;
    this.kindBySourceId = new Map(this.sources.map(s => [s.id, s.kind]));
  }

  async start(): Promise<void> {
    this.watchers = this.sources.map(
      s => createWatcher(s, this.db ?? undefined),
    );

    const results = await Promise.allSettled(
      this.watchers.map(w => w.start()),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[registry] source "${this.sources[i]!.id}" failed to start:`,
          r.reason,
        );
      }
    });

    for (const w of this.watchers) {
      for (const session of w.getAllSessions()) {
        this.ingest(session);
      }
    }

    for (const w of this.watchers) {
      w.on('session-created', (s: Session) => {
        this.ingest(s);
        this.emit('session-created', s);
      });
      w.on('session-updated', (s: Session) => {
        this.ingest(s);
        this.emit('session-updated', s);
      });
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.watchers.map(w => w.stop()));
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
