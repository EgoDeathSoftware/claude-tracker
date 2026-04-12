import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import type { Session, Project } from './types.ts';

export class SessionWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private claudeDir: string;

  constructor(claudeDir: string) {
    super();
    this.claudeDir = claudeDir;
  }

  async start(): Promise<void> {
    const projectsDir = join(this.claudeDir, 'projects');
    await this.scanExisting(projectsDir);
    this.watchDir(projectsDir);
  }

  private projectIdFromPath(filePath: string): string {
    return basename(dirname(filePath));
  }

  private async scanExisting(projectsDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(projectsDir);
    } catch {
      return;
    }

    const parses: Promise<void>[] = [];
    for (const entry of entries) {
      const entryPath = join(projectsDir, entry);
      const files = await readdir(entryPath).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(entryPath, file);
        parses.push(
          parseSession(filePath, entry)
            .then(session => { this.sessions.set(session.id, session); })
            .catch(() => undefined)
        );
      }
    }
    await Promise.all(parses);
  }

  private watchDir(projectsDir: string): void {
    const watcher = watch(`${projectsDir}/**/*.jsonl`, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    watcher.on('add', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-created');
    });

    watcher.on('change', (filePath: string) => {
      void this.handleFileEvent(filePath, 'session-updated');
    });
  }

  private async handleFileEvent(
    filePath: string,
    eventName: 'session-created' | 'session-updated',
  ): Promise<void> {
    const projectId = this.projectIdFromPath(filePath);
    const session = await parseSession(filePath, projectId).catch(() => null);
    if (!session) return;
    this.sessions.set(session.id, session);
    this.emit(eventName, session);
  }

  getProjects(): Project[] {
    const map = new Map<string, Project>();
    for (const session of this.sessions.values()) {
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
        }
      }
    }
    return [...map.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  getSessions(projectId?: string): Session[] {
    const all = [...this.sessions.values()];
    const filtered = projectId ? all.filter(s => s.projectId === projectId) : all;
    return filtered.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}

function deriveProjectName(dirName: string): string {
  // "-mnt-c-Users-david-Projects-my-app" → "my-app"
  const parts = dirName.replace(/^-/, '').split('-');
  const skipSegments = new Set(['mnt', 'c', 'home', 'Users', 'users', 'projects', 'Projects']);
  const meaningful = parts.filter(p => p.length > 1 && !skipSegments.has(p));
  if (meaningful.length === 0) return dirName;
  return meaningful.slice(-2).join('-');
}
