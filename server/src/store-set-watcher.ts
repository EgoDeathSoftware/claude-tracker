import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readStoreOrigin } from './store-origin.js';
import type { Source } from './sources.js';

/** The subset of SessionRegistry a StoreSetWatcher drives. */
export interface SourceSink {
  addSource(source: Source, opts?: { watch?: boolean | undefined }): Promise<void>;
  removeSource(id: string): Promise<void>;
}

export interface StoreSetWatcherOptions {
  /** Days of inactivity after which a store stops being watched live. */
  activeDays?: number | undefined;
  /** Poll interval in ms. 0 disables the timer; call pollOnce() manually. */
  pollMs?: number | undefined;
}

interface StoreState {
  watched: boolean;
  markerMtimeMs: number;
}

const DEFAULT_ACTIVE_DAYS = 14;
const DEFAULT_POLL_MS = 30_000;

/**
 * Expands a `store-set` source — a directory of per-container Claude stores
 * that are never deleted — into one child Source per store, and keeps that
 * expansion current as containers come and go.
 *
 * Every store is scanned and served, but only stores active within
 * `activeDays` get a live filesystem watcher (`watch: true`); the rest are
 * still fully browsable, just not polled continuously. A container relaunch
 * rewrites the store's `.tracker-origin.json` marker, so `pollOnce()` detects
 * that mtime change and re-evaluates whether the store should be watched.
 */
export class StoreSetWatcher {
  private known = new Map<string, StoreState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly activeDays: number;
  private readonly pollMs: number;

  constructor(
    private readonly parent: Source,
    private readonly sink: SourceSink,
    options?: StoreSetWatcherOptions,
  ) {
    this.activeDays = options?.activeDays ?? DEFAULT_ACTIVE_DAYS;
    this.pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  }

  async start(): Promise<void> {
    await this.pollOnce();
    if (this.pollMs > 0) {
      // Not re-entrant-guarded: a pass that outlives pollMs could overlap
      // with the next tick. Not expected to matter at the default 30s
      // interval and current per-store stat/readdir cost; add an in-flight
      // guard here if store counts grow enough to change that.
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  childId(storeName: string): string {
    return `${this.parent.id}:${storeName}`;
  }

  private async listStores(): Promise<string[]> {
    const entries = await readdir(this.parent.path, { withFileTypes: true })
      .catch((err: NodeJS.ErrnoException) => {
        // A missing root is an expected, tolerated state (no containers have
        // ever run yet). Anything else — e.g. a permissions error on the
        // bind-mounted volume — is worth surfacing rather than looking
        // identical to "zero containers found".
        if (err.code !== 'ENOENT') {
          console.warn(
            `[store-set-watcher:${this.parent.id}] failed to read ${this.parent.path}:`,
            err,
          );
        }
        return [];
      });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  private async markerMtimeMs(storePath: string): Promise<number> {
    const info = await stat(join(storePath, '.tracker-origin.json'))
      .catch(() => null);
    return info?.mtimeMs ?? 0;
  }

  /** Newest transcript mtime in the store, or 0 when it holds none. */
  private async newestTranscriptMs(storePath: string): Promise<number> {
    const projectsDir = join(storePath, 'projects');
    const projectDirs = await readdir(projectsDir).catch(() => [] as string[]);
    let newest = 0;
    for (const projectDir of projectDirs) {
      const dir = join(projectsDir, projectDir);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const info = await stat(join(dir, file)).catch(() => null);
        if (info && info.mtimeMs > newest) newest = info.mtimeMs;
      }
    }
    return newest;
  }

  private async isActive(storePath: string): Promise<boolean> {
    const cutoff = Date.now() - this.activeDays * 86_400_000;
    const marker = await this.markerMtimeMs(storePath);
    if (marker > cutoff) return true;
    const newest = await this.newestTranscriptMs(storePath);
    return newest > 0 && newest > cutoff;
  }

  private async buildChild(storeName: string): Promise<Source> {
    const path = join(this.parent.path, storeName);
    return {
      id: this.childId(storeName),
      name: storeName,
      path,
      kind: this.parent.kind,
      layout: 'single',
      location: 'container',
      origin: await readStoreOrigin(path, storeName),
      parentId: this.parent.id,
    };
  }

  private async attach(storeName: string): Promise<StoreState> {
    const path = join(this.parent.path, storeName);
    const watched = await this.isActive(path);
    await this.sink.addSource(await this.buildChild(storeName), { watch: watched });
    return { watched, markerMtimeMs: await this.markerMtimeMs(path) };
  }

  private async reconcileRemovals(currentStores: Set<string>): Promise<void> {
    for (const storeName of this.known.keys()) {
      if (currentStores.has(storeName)) continue;
      try {
        await this.sink.removeSource(this.childId(storeName));
        this.known.delete(storeName);
      } catch (err) {
        console.warn(
          `[store-set-watcher:${this.parent.id}] failed to remove store "${storeName}":`,
          err,
        );
        // Leave it in `known` — we'll retry the removal next pass instead of
        // losing track of a store the sink still thinks exists.
      }
    }
  }

  private async reconcileNew(storeName: string): Promise<void> {
    try {
      this.known.set(storeName, await this.attach(storeName));
    } catch (err) {
      console.warn(
        `[store-set-watcher:${this.parent.id}] failed to add store "${storeName}":`,
        err,
      );
      // Don't record it in `known` — next pass will retry the add from
      // scratch, which is exactly what "not yet known" means.
    }
  }

  private async reconcileExisting(storeName: string, state: StoreState): Promise<void> {
    const path = join(this.parent.path, storeName);
    try {
      const markerMtimeMs = await this.markerMtimeMs(path);
      if (markerMtimeMs === state.markerMtimeMs) return;

      const shouldWatch = await this.isActive(path);
      if (shouldWatch === state.watched) {
        this.known.set(storeName, { ...state, markerMtimeMs });
        return;
      }
      await this.sink.removeSource(this.childId(storeName));
      this.known.delete(storeName);
      this.known.set(storeName, await this.attach(storeName));
    } catch (err) {
      console.warn(
        `[store-set-watcher:${this.parent.id}] failed to re-evaluate store "${storeName}":`,
        err,
      );
      // If removeSource threw, `known` still holds the prior state and we'll
      // retry the promotion/demotion next pass. If it succeeded but the
      // follow-up attach() failed, `known` no longer has this store — the
      // next pass sees it as newly appeared and retries via reconcileNew.
    }
  }

  /**
   * One reconciliation pass: pick up new stores, drop removed ones, and
   * promote/demote a store whose marker changed — which is what a container
   * relaunch looks like from the host. Each store's work is isolated so one
   * store's failure can't abort the whole pass or corrupt `known` for the
   * others. A promote/demote is a remove followed by a re-add (the sink has
   * no way to flip a live watcher's `watch` flag in place), so a store is
   * transiently absent from the sink between the two — if the re-add fails,
   * it stays absent until the next pass re-attaches it as "new".
   */
  async pollOnce(): Promise<void> {
    const stores = new Set(await this.listStores());

    await this.reconcileRemovals(stores);

    for (const storeName of stores) {
      const state = this.known.get(storeName);
      if (!state) {
        await this.reconcileNew(storeName);
      } else {
        await this.reconcileExisting(storeName, state);
      }
    }
  }
}
