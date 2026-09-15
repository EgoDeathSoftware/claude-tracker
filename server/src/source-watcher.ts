import { watch } from 'chokidar';
import { readdir, stat } from 'node:fs/promises';
import { join, basename, dirname, relative, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseSessionDetailed, PARSER_VERSION } from './parser.js';
import { decorateSession, toMeta } from './session-shape.js';
import { Limiter } from './limiter.js';
import type { TrackerDB } from './db.js';
import type { Source } from './sources.js';
import type { ParsedSession, SessionMeta, ToolCallEntry } from './types.js';

export interface SourceWatcherOptions {
  /** Start a filesystem watcher for live updates. Defaults to true. */
  watch?: boolean | undefined;
  /** Applied to every parsed session before it is decorated or stored. */
  transformSession?: ((session: ParsedSession) => ParsedSession) | undefined;
  /** Re-parse every file even when its fingerprint is unchanged. Default false. */
  rescan?: boolean | undefined;
  /** Shared parse-concurrency cap. Defaults to a private one per watcher. */
  limiter?: Limiter | undefined;
}

/** The `Agent` tool-call input a parent uses to describe one subagent. */
interface AgentCallInput {
  description?: string | undefined;
  subagent_type?: string | undefined;
}

/**
 * What a watcher retains per session: list-view metadata plus the only body
 * data subagent linking needs. Bodies stay in the archive and are loaded on
 * demand — holding them here pins the whole corpus in the heap for the life
 * of the process.
 */
interface WatchedSession {
  meta: SessionMeta;
  agentCalls: AgentCallInput[];
}

function agentCallsOf(toolCalls: ToolCallEntry[]): AgentCallInput[] {
  const calls: AgentCallInput[] = [];
  for (const call of toolCalls) {
    if (call.toolName !== 'Agent') continue;
    const input = call.input as AgentCallInput | undefined;
    calls.push({
      description: input?.description,
      subagent_type: input?.subagent_type,
    });
  }
  return calls;
}

export class SourceWatcher extends EventEmitter {
  private sessions = new Map<string, WatchedSession>();
  private projectsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private db: TrackerDB | null;
  private readonly watchEnabled: boolean;
  private readonly transformSession: (session: ParsedSession) => ParsedSession;
  private readonly rescan: boolean;
  private readonly limiter: Limiter;
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
    this.rescan = options?.rescan ?? false;
    this.limiter = options?.limiter ?? new Limiter();
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

  private async collectFiles(): Promise<{ path: string; dirName: string }[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.projectsDir);
    } catch {
      return [];
    }

    const files: { path: string; dirName: string }[] = [];

    for (const projectDir of projectDirs) {
      const projectPath = join(this.projectsDir, projectDir);
      const entries = await readdir(projectPath).catch(
        () => [] as string[],
      );

      for (const entry of entries) {
        const entryPath = join(projectPath, entry);

        if (entry.endsWith('.jsonl')) {
          files.push({ path: entryPath, dirName: projectDir });
          continue;
        }

        const subagentsDir = join(entryPath, 'subagents');
        const subFiles = await readdir(subagentsDir).catch(
          () => [] as string[],
        );
        for (const subFile of subFiles) {
          if (!subFile.endsWith('.jsonl')) continue;
          files.push({
            path: join(subagentsDir, subFile),
            dirName: projectDir,
          });
        }
      }
    }

    return files;
  }

  private async scanExisting(): Promise<void> {
    const files = await this.collectFiles();
    // Every task is created up front but each waits on the shared limiter, so
    // only a handful of transcripts are ever parsed — and resident — at once.
    await Promise.all(
      files.map(file =>
        this.limiter.run(() => this.parseAndStore(file.path, file.dirName)),
      ),
    );
  }

  private async parseAndStore(
    filePath: string,
    dirName: string,
  ): Promise<void> {
    try {
      const sessionId = basename(filePath, '.jsonl');
      if (!this.rescan && this.db) {
        const fp = this.db.archive.fileFingerprint(sessionId);
        const st = await stat(filePath).catch(() => null);
        // Both must match exactly. A file that grew, shrank, or was rewritten
        // has a different size or mtime and falls through to a full parse.
        if (fp && st && fp.size === st.size && fp.mtimeMs === st.mtimeMs) {
          const body = this.db.archive.getBody(sessionId);
          const meta = this.db.archive.loadSummary(sessionId);
          if (body && meta) {
            // The body is read only to recover the parent's Agent calls for
            // linking; it goes out of scope here rather than being retained.
            this.sessions.set(sessionId, {
              meta: { ...meta, archived: false },
              agentCalls: agentCallsOf(body.toolCalls),
            });
            return;
          }
        }
      }

      const parsed = await parseSessionDetailed(filePath, this.sourceId, dirName);
      const session = decorateSession(
        this.transformSession(parsed.session), this.source,
      );
      this.sessions.set(session.id, {
        meta: toMeta(session),
        agentCalls: agentCallsOf(session.toolCalls),
      });
      this.db?.archive.put(session, {
        lines: parsed.lines,
        fileSize: parsed.size,
        fileMtimeMs: parsed.mtimeMs,
        parserVersion: PARSER_VERSION,
      });
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
    const childMap = new Map<string, SessionMeta[]>();
    for (const { meta } of this.sessions.values()) {
      if (!meta.isSubagent || !meta.parentSessionId) continue;
      let children = childMap.get(meta.parentSessionId);
      if (!children) {
        children = [];
        childMap.set(meta.parentSessionId, children);
      }
      children.push(meta);
    }

    for (const [parentId, children] of childMap) {
      const parent = this.sessions.get(parentId);
      if (!parent) continue;

      parent.meta.subagents = children.map((child, i) => {
        const input = parent.agentCalls[i];

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
    this.db?.archive.flushAll();
  }

  private async handleFileEvent(
    filePath: string,
    eventName: 'session-created' | 'session-updated',
  ): Promise<void> {
    const dirName = this.dirNameFromPath(filePath);
    const parsed = await this.limiter
      .run(() => parseSessionDetailed(filePath, this.sourceId, dirName))
      .catch(err => {
        console.error(
          `[source-watcher:${this.sourceId}] Failed to parse ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      });
    if (!parsed) return;
    const session = decorateSession(
      this.transformSession(parsed.session), this.source,
    );
    const entry: WatchedSession = {
      meta: toMeta(session),
      agentCalls: agentCallsOf(session.toolCalls),
    };
    this.sessions.set(session.id, entry);
    this.db?.archive.put(session, {
      lines: parsed.lines,
      fileSize: parsed.size,
      fileMtimeMs: parsed.mtimeMs,
      parserVersion: PARSER_VERSION,
    });

    // Re-parsing any session resets its own `subagents` field, so a parent
    // that keeps updating after its subagent finishes needs relinking too —
    // not just when the changed file is itself a subagent.
    this.linkSubagents();

    // Emitted after linking so the payload carries the freshly linked
    // `subagents`; `entry.meta` is the object linkSubagents mutates in place.
    this.emit(eventName, entry.meta);
  }

  getAllMeta(): SessionMeta[] {
    return [...this.sessions.values()].map(entry => entry.meta);
  }
}
