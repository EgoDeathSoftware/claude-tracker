import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readStoreOrigin } from './store-origin.js';
import type { Source } from './sources.js';

/** The subset of SessionRegistry a StoreSetWatcher drives. */
export interface SourceSink {
  addSource(source: Source, opts?: { watch?: boolean }): Promise<void>;
  removeSource(id: string): Promise<void>;
}

/**
 * Expands a `store-set` source — a directory of per-container Claude stores —
 * into one child Source per store.
 */
export class StoreSetWatcher {
  private known = new Set<string>();

  constructor(
    private readonly parent: Source,
    private readonly sink: SourceSink,
  ) {}

  async start(): Promise<void> {
    await this.sync();
  }

  async stop(): Promise<void> {
    // No timers yet; the polling loop arrives in the next task.
  }

  childId(storeName: string): string {
    return `${this.parent.id}:${storeName}`;
  }

  private async listStores(): Promise<string[]> {
    const entries = await readdir(this.parent.path, { withFileTypes: true })
      .catch(() => []);
    return entries.filter(e => e.isDirectory()).map(e => e.name);
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

  protected async sync(): Promise<void> {
    const stores = await this.listStores();
    for (const storeName of stores) {
      if (this.known.has(storeName)) continue;
      this.known.add(storeName);
      await this.sink.addSource(await this.buildChild(storeName));
    }
  }
}
