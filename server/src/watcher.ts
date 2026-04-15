import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import type { TrackerDB } from './db.ts';
import type { Session, Project } from './types.ts';

export class SessionWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private claudeDir: string;
  private projectsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private db: TrackerDB | null;

  constructor(claudeDir: string, db?: TrackerDB) {
    super();
    this.claudeDir = claudeDir;
    this.projectsDir = join(claudeDir, 'projects');
    this.db = db ?? null;
  }

  async start(): Promise<void> {
    await this.scanExisting();
    this.linkSubagents();
    this.watchDir();
  }

  private projectIdFromPath(filePath: string): string {
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
          // Top-level session file
          parses.push(this.parseAndStore(entryPath, projectDir));
          continue;
        }

        // Check for subagent directories:
        // {sessionId}/subagents/*.jsonl
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
    projectId: string,
  ): Promise<void> {
    try {
      const session = await parseSession(filePath, projectId);
      this.sessions.set(session.id, session);
      if (this.db && !session.isSubagent) {
        this.db.indexSession(session);
      }
    } catch (err) {
      console.error(
        `[watcher] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private linkSubagents(): void {
    // Build map: parentSessionId -> child sessions
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

    // For each parent session, populate its subagents array
    for (const [parentId, children] of childMap) {
      const parent = this.sessions.get(parentId);
      if (!parent) continue;

      // Try to match Agent tool calls to subagents by order
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
    const projectId = this.projectIdFromPath(filePath);
    const session = await parseSession(filePath, projectId).catch(err => {
      console.error(
        `[watcher] Failed to parse ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    });
    if (!session) return;
    this.sessions.set(session.id, session);

    // Re-link subagents when any file changes
    if (session.isSubagent) {
      this.linkSubagents();
    }

    this.emit(eventName, session);
  }

  getProjects(): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      const existing = map.get(session.projectId);
      if (!existing) {
        map.set(session.projectId, {
          id: session.projectId,
          name: deriveProjectName(session.projectId),
          dirPath: session.cwd,
          sessionCount: 1,
          liveCount: session.status === 'live' ? 1 : 0,
          lastActivityAt: session.lastActivityAt,
        });
      } else {
        existing.sessionCount++;
        if (session.status === 'live') existing.liveCount++;
        if (session.lastActivityAt > existing.lastActivityAt) {
          existing.lastActivityAt = session.lastActivityAt;
          existing.dirPath = session.cwd;
        }
      }
    }
    return [...map.values()].sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime()
        - new Date(a.lastActivityAt).getTime(),
    );
  }

  getSessions(projectId?: string): Session[] {
    const all = [...this.sessions.values()].filter(s => !s.isSubagent);
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
}

function deriveProjectName(dirName: string): string {
  const parts = dirName
    .replace(/^-/, '')
    .split('-')
    .filter(p => p.length > 0);
  if (parts.length === 0) return dirName;
  const pathSegments = new Set([
    'mnt', 'c', 'd', 'home', 'Users', 'users',
    'projects', 'Projects', 'var', 'opt', 'srv',
  ]);
  const nameParts: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === undefined) break;
    if (pathSegments.has(part)) break;
    if (i > 0 && pathSegments.has(parts[i - 1] ?? '')) {
      nameParts.unshift(part);
      break;
    }
    nameParts.unshift(part);
    if (nameParts.length >= 3) break;
  }
  return nameParts.length > 0 ? nameParts.join('-') : dirName;
}
