import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import { decorateSession } from './session-shape.js';
import type { TrackerDB } from './db.js';
import type { Source } from './sources.js';
import type { ParsedSession, Session } from './types.js';

export interface SourceWatcherOptions {
  /** Start a filesystem watcher for live updates. Defaults to true. */
  watch?: boolean | undefined;
  /** Applied to every parsed session before it is decorated or stored. */
  transformSession?: ((session: ParsedSession) => ParsedSession) | undefined;
}

export class SourceWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private projectsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private db: TrackerDB | null;
  private readonly watchEnabled: boolean;
  private readonly transformSession: (session: ParsedSession) => ParsedSession;
  public readonly sourceId: string;

  constructor(
    private readonly source: Source,
    db?: TrackerDB,
    options?: SourceWatcherOptions,
  ) {
    super();
    this.sourceId = source.id;
    this.projectsDir = join(source.path, 'projects');
    this.db = db ?? null;
    this.watchEnabled = options?.watch ?? true;
    this.transformSession = options?.transformSession ?? (s => s);
  }

  async start(): Promise<void> {
    await this.scanExisting();
    this.linkSubagents();
    if (this.watchEnabled) await this.watchDir();
  }

  private dirNameFromPath(filePath: string): string {
    const rel = relative(this.projectsDir, filePath);
    const firstSegment = rel.split(sep)[0];
    return firstSegment ?? basename(dirname(filePath));
  }

  private async scanExisting(): Promise<void> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return;
    }

    const parses: Promise<void>[] = [];

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const entries = await readdir(projectPath).catch(
        () => [] as string[],
      );

      for (const entry of entries) {
        const entryPath = join(projectPath, entry);

        if (entry.endsWith('.jsonl')) {
          parses.push(this.parseAndStore(entryPath, projectDir));
          continue;
        }

        const subagentsDir = join(entryPath, 'subagents');
        const subFiles = await readdir(subagentsDir).catch(
          () => [] as string[],
        );
        for (const subFile of subFiles) {
          if (!subFile.endsWith('.jsonl')) continue;
          parses.push(
            this.parseAndStore(
              join(subagentsDir, subFile),
              projectDir,
            ),
          );
        }
      }
    }

    await Promise.all(parses);
  }

  private async parseAndStore(
    filePath: string,
    dirName: string,
  ): Promise<void> {
    try {
      const parsed = await parseSession(
        filePath,
        this.sourceId,
        dirName,
      );
      const session = decorateSession(this.transformSession(parsed), this.source);
      this.sessions.set(session.id, session);
      if (this.db && !session.isSubagent) {
        this.db.indexSession(session);
      }
    } catch (err) {
      console.error(
        `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

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

      const agentToolCalls = parent.toolCalls.filter(
        tc => tc.toolName === 'Agent',
      );

      parent.subagents = children.map((child, i) => {
        const agentCall = agentToolCalls[i];
        const input = agentCall?.input as
          | { description?: string; subagent_type?: string }
          | undefined;

        return {
          sessionId: child.id,
          parentSessionId: parentId,
          description: input?.description,
          subagentType: input?.subagent_type,
          turnCount: child.turnCount,
          costUsd: child.costUsd,
          model: child.model,
          startedAt: child.startedAt,
          durationMs: child.durationMs,
        };
      });
    }
  }

  private async watchDir(): Promise<void> {
    // chokidar v4 dropped glob-pattern support, so we watch the directory
    // itself (recursively, by default) and filter for .jsonl in the handlers.
    const watcher = watch(this.projectsDir, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    this.watcher = watcher;

    watcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      void this.handleFileEvent(filePath, 'session-created');
    });

    watcher.on('change', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      void this.handleFileEvent(filePath, 'session-updated');
    });

    // chokidar throws (crashing the process) if 'error' fires with no
    // listener attached, e.g. EMFILE from too many polling watchers.
    watcher.on('error', err => {
      console.error(`[source-watcher:${this.sourceId}] chokidar error:`, err);
    });

    // Wait for chokidar to finish its initial crawl and attach OS-level
    // watches before returning, otherwise a write immediately after start()
    // can race ahead of setup and be missed entirely. This is not fully
    // sufficient under polling-backend churn — see the retry note on the
    // "watches by default" test in source-watcher.test.ts.
    await new Promise<void>(resolve => watcher.once('ready', resolve));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async handleFileEvent(
    filePath: string,
    eventName: 'session-created' | 'session-updated',
  ): Promise<void> {
    const dirName = this.dirNameFromPath(filePath);
    const parsed = await parseSession(
      filePath,
      this.sourceId,
      dirName,
    ).catch(err => {
      console.error(
        `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (!parsed) return;
    const session = decorateSession(this.transformSession(parsed), this.source);
    this.sessions.set(session.id, session);

    if (session.isSubagent) {
      this.linkSubagents();
    }

    this.emit(eventName, session);
  }

  getAllSessions(): Session[] {
    return [...this.sessions.values()];
  }
}
