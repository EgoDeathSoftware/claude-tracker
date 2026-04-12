import { watch } from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSession } from './parser.js';
import type { Session, Project } from './types.ts';

export class SessionWatcher extends EventEmitter {
  private sessions = new Map<string, Session>();
  private claudeDir: string;
  private watcher: ReturnType<typeof watch> | null = null;

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
            .catch(err => {
              console.error(
                `[watcher] Failed to parse ${filePath}:`,
                err instanceof Error ? err.message : err,
              );
            })
        );
      }
    }
    await Promise.all(parses);
  }

  private watchDir(projectsDir: string): void {
    this.watcher = watch(`${projectsDir}/**/*.jsonl`, {
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
          existing.dirPath = session.cwd;
        }
      }
    }
    return [...map.values()].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    );
  }

  getSessions(projectId?: string): Session[] {
    const all = [...this.sessions.values()];
    const filtered = projectId ? all.filter(s => s.projectId === projectId) : all;
    return filtered.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
    );
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}

function deriveProjectName(dirName: string): string {
  // "-home-david-projects-my-app" → "my-app"
  // "-mnt-c-Users-david-Projects-my-app" → "my-app"
  // Strategy: strip the encoded path prefix, return the basename.
  // The encoded format replaces '/' with '-', so the last segment is the working dir.
  const parts = dirName.replace(/^-/, '').split('-').filter(p => p.length > 0);
  if (parts.length === 0) return dirName;
  // Walk from the end, collecting parts until we hit a known path segment.
  const pathSegments = new Set([
    'mnt', 'c', 'd', 'home', 'Users', 'users', 'projects', 'Projects', 'var', 'opt', 'srv',
  ]);
  const nameParts: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === undefined) break;
    if (pathSegments.has(part)) break;
    // Also stop if we hit what looks like a username (single-word followed by Projects/projects)
    if (i > 0 && pathSegments.has(parts[i - 1] ?? '')) {
      nameParts.unshift(part);
      break;
    }
    nameParts.unshift(part);
    // Cap at 3 segments to avoid very long names
    if (nameParts.length >= 3) break;
  }
  return nameParts.length > 0 ? nameParts.join('-') : dirName;
}
