import { EventEmitter } from 'node:events';
import { SourceWatcher } from './source-watcher.js';
import type { SourceWatcherOptions } from './source-watcher.js';
import { OpenCodeWatcher } from './opencode-watcher.js';
import { StoreSetWatcher } from './store-set-watcher.js';
import type { StoreSetWatcherOptions } from './store-set-watcher.js';
import { applyOrigin } from './store-origin.js';
import type { TrackerDB } from './db.js';
import type { ParsedSession, Session, Project } from './types.js';
import type { Source, SourceKind, SourceLocation } from './sources.js';
import { displayNameFromCwd } from './project-key.js';

export interface SessionFilter {
  kinds?: SourceKind[] | undefined;
  locations?: SourceLocation[] | undefined;
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
  private sessions = new Map<string, Session>();
  private db: TrackerDB | null;
  private kindBySourceId: Map<string, SourceKind>;
  private locationBySourceId: Map<string, SourceLocation>;

  constructor(
    private sources: Source[],
    db?: TrackerDB,
    private readonly storeSetOptions?: StoreSetWatcherOptions,
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
      transformSession: origin
        ? (s: ParsedSession) => applyOrigin(s, origin)
        : undefined,
    };
  }

  async start(): Promise<void> {
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

  /**
   * Deregister a source and drop the sessions it contributed. Callers must
   * not remove a source with `parentId` set except through its owning
   * StoreSetWatcher — that watcher's own `known` state wouldn't learn of an
   * external removal, so the store would silently stay gone until its
   * container relaunches and rewrites its marker.
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
    this.kindBySourceId.delete(id);
    this.locationBySourceId.delete(id);
    this.sources = this.sources.filter(s => s.id !== id);
    for (const [sessionId, session] of this.sessions) {
      if (session.sourceId === id) {
        this.sessions.delete(sessionId);
        this.db?.removeSession(sessionId);
      }
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

  /**
   * Single predicate consulted by both getProjects and getSessions. Sessions
   * whose source has since been removed (kind/location lookup misses) are
   * excluded from any active filter rather than risking a stale match.
   */
  private matches(sourceId: string, filter?: SessionFilter): boolean {
    if (filter?.kinds) {
      const kind = this.kindBySourceId.get(sourceId);
      if (!kind || !filter.kinds.includes(kind)) return false;
    }
    if (filter?.locations) {
      const location = this.locationBySourceId.get(sourceId);
      if (!location || !filter.locations.includes(location)) return false;
    }
    return true;
  }

  getProjects(filter?: SessionFilter): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      if (!this.matches(session.sourceId, filter)) continue;
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

  getSessions(projectId?: string, filter?: SessionFilter): Session[] {
    const all = [...this.sessions.values()].filter(
      s => !s.isSubagent && this.matches(s.sourceId, filter),
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
