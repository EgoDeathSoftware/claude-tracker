import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import type { TrackerDB } from './db.js';
import type { Session } from './types.js';

export class SourceWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private projectsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private db: TrackerDB | null;

  constructor(
    public readonly sourceId: string,
    private readonly claudeDir: string,
    db?: TrackerDB,
  ) {
    super();
    this.projectsDir = join(claudeDir, 'projects');
    this.db = db ?? null;
  }

  async start(): Promise<void> {
    await this.scanExisting();
    this.linkSubagents();
    this.watchDir();
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
      const session = await parseSession(
        filePath,
        this.sourceId,
        dirName,
      );
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

  private watchDir(): void {
    this.watcher = watch(`${this.projectsDir}/**/*.jsonl`, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 1000,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('add', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-created');
    });

    this.watcher.on('change', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-updated');
    });
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
    const session = await parseSession(
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
    if (!session) return;
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
