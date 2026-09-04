import { EventEmitter } from 'node:events';
import { SourceWatcher } from './source-watcher.js';
import type { SourceWatcherOptions } from './source-watcher.js';
import { OpenCodeWatcher } from './opencode-watcher.js';
import { StoreSetWatcher } from './store-set-watcher.js';
import type { StoreSetWatcherOptions } from './store-set-watcher.js';
import { applyOrigin } from './store-origin.js';
import { toMeta } from './session-shape.js';
import type { TrackerDB } from './db.js';
import type { ParsedSession, Session, SessionBody, SessionMeta, Project } from './types.js';
import type { Source, SourceKind, SourceLocation } from './sources.js';
import { displayNameFromCwd } from './project-key.js';

const EMPTY_BODY: SessionBody = {
  messages: [], logEntries: [], toolCalls: [], fileChanges: [],
  hookEvents: [], permissionEvents: [], recaps: [],
};

export interface SessionFilter {
  kinds?: SourceKind[] | undefined;
  locations?: SourceLocation[] | undefined;
}

export interface RegistryOptions extends StoreSetWatcherOptions {
  /** Re-parse every transcript at startup, ignoring archive fingerprints. */
  rescan?: boolean | undefined;
}

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
      return new SourceWatcher(source, db, options);
    case 'opencode':
      return new OpenCodeWatcher(source, db);
  }
}

export class SessionRegistry extends EventEmitter {
  private watchers = new Map<string, AgentWatcher>();
  private storeSets: StoreSetWatcher[] = [];
  private sessions = new Map<string, SessionMeta>();
  private db: TrackerDB | null;

  constructor(
    private sources: Source[],
    db?: TrackerDB,
    private readonly storeSetOptions?: RegistryOptions,
  ) {
    super();
    this.db = db ?? null;
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
      transformSession: origin
        ? (s: ParsedSession) => applyOrigin(s, origin)
        : undefined,
      rescan: this.storeSetOptions?.rescan,
    };
  }

  async start(): Promise<void> {
    // Hydrate from the archive first: the UI is browsable before a single
    // JSONL file is opened, and sessions whose source is gone stay listed.
    for (const meta of this.db?.archive.loadSummaries() ?? []) {
      this.sessions.set(meta.id, meta);
    }

    // A store-set source has no .claude directory of its own — source.path is
    // the parent of many stores — so it never gets an ordinary watcher.
    // getSources() must not surface it either, hence trimming this.sources.
    const storeSetSources = this.sources.filter(s => s.layout === 'store-set');
    const ordinarySources = this.sources.filter(s => s.layout !== 'store-set');
    this.sources = ordinarySources;

    for (const source of ordinarySources) {
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

    this.storeSets = storeSetSources.map(
      source => new StoreSetWatcher(source, {
        addSource: (child, opts) => this.addSource(child, opts),
        removeSource: id => this.removeSource(id),
      }, this.storeSetOptions),
    );
    const storeSetResults = await Promise.allSettled(this.storeSets.map(w => w.start()));
    storeSetResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[registry] store-set "${storeSetSources[i]!.id}" failed to start:`,
          r.reason,
        );
      }
    });
  }

  async stop(): Promise<void> {
    // Store-sets must stop first: this halts their polling before the
    // watcher-map snapshot below is taken, so a poll tick can't register a
    // new child watcher (via addSource) that this stop() call would then
    // miss and leak.
    await Promise.allSettled(this.storeSets.map(w => w.stop()));
    await Promise.allSettled([...this.watchers.values()].map(w => w.stop()));
    this.db?.archive.flushAll();
  }

  /**
   * Register a source discovered after startup and ingest its sessions.
   * Not safe to call concurrently for the same source id: a second call's
   * `removeSource` can race the first call's in-flight `watcher.start()`
   * and leave an orphaned, never-stopped watcher running under the old
   * reference. Callers must serialize add/remove per source id.
   */
  async addSource(source: Source, opts?: { watch?: boolean | undefined }): Promise<void> {
    if (this.watchers.has(source.id)) await this.removeSource(source.id);

    const watcher = createWatcher(
      source,
      this.db ?? undefined,
      this.watcherOptions(source, opts?.watch ?? true),
    );
    this.sources.push(source);
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

  /**
   * Deregister a source and archive the sessions it contributed in place —
   * they stay listed and browsable from the archive. Callers must not remove
   * a source with `parentId` set except through its owning StoreSetWatcher —
   * that watcher's own `known` state wouldn't learn of an external removal,
   * so the store would silently stay gone until its container relaunches and
   * rewrites its marker.
   */
  async removeSource(id: string): Promise<void> {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    try {
      await watcher.stop();
    } catch (err) {
      console.warn(`[registry] source "${id}" failed to stop:`, err);
    }
    watcher.removeAllListeners();
    this.watchers.delete(id);
    this.sources = this.sources.filter(s => s.id !== id);

    // A destroyed container takes this path on every StoreSetWatcher poll.
    // Its sessions stay listed, browsable from the archive, and keep their
    // FTS rows, tags and cached summaries; only the live binding is dropped.
    this.db?.archive.flushAll();
    for (const [sessionId, session] of this.sessions) {
      if (session.sourceId === id) {
        this.sessions.set(sessionId, { ...session, archived: true });
      }
    }
    this.emit('sources-changed');
  }

  private ingest(session: Session): void {
    const existing = this.sessions.get(session.id);
    if (existing && !existing.archived && existing.sourceId !== session.sourceId) {
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
    this.sessions.set(session.id, toMeta(session));
  }

  /**
   * Single predicate consulted by both getProjects and getSessions. Kind and
   * location come from the session's own snapshot rather than the live source
   * table, so a session whose source has been removed still filters correctly.
   */
  private matches(session: SessionMeta, filter?: SessionFilter): boolean {
    if (filter?.kinds && !filter.kinds.includes(session.sourceKind)) return false;
    if (filter?.locations && !filter.locations.includes(session.sourceLocation)) {
      return false;
    }
    return true;
  }

  getProjects(filter?: SessionFilter): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      if (!this.matches(session, filter)) continue;
      const existing = map.get(session.projectId);
      if (!existing) {
        map.set(session.projectId, {
          id: session.projectId,
          name: displayNameFromCwd(session.cwd, session.gitBranch) || session.projectId,
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
            = displayNameFromCwd(session.cwd, session.gitBranch) || session.projectId;
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

  getSessions(projectId?: string, filter?: SessionFilter): SessionMeta[] {
    const all = [...this.sessions.values()].filter(
      s => !s.isSubagent && this.matches(s, filter),
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

  getSessionMeta(id: string): SessionMeta | undefined {
    return this.sessions.get(id);
  }

  /**
   * Full session for the detail view. The body comes from the archive; a
   * missing body row is corruption rather than a normal state, so it degrades
   * to empty arrays with a warning instead of 404ing a session that is listed.
   */
  async getSessionDetail(id: string): Promise<Session | undefined> {
    const meta = this.sessions.get(id);
    if (!meta) return undefined;
    const body = this.db?.archive.getBody(id) ?? null;
    if (body === null) {
      console.warn(`[registry] no archived body for session ${id}`);
      return { ...meta, ...EMPTY_BODY };
    }
    return { ...meta, ...body };
  }

  getSources(): Source[] {
    return this.sources;
  }

  /** Drop a session from the in-memory map. Called by the delete route only. */
  forgetSession(id: string): void {
    this.sessions.delete(id);
  }

  /** Refresh a session's in-memory meta. Called by the reparse route only. */
  updateSessionMeta(id: string, meta: SessionMeta): void {
    this.sessions.set(id, meta);
  }
}
