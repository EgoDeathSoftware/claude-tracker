import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { parseLines, PARSER_VERSION } from './parser.js';
import { decorateSession, toMeta } from './session-shape.js';
import type { TrackerDB } from './db.js';
import type { Source } from './sources.js';
import type { ParsedSession, SessionMeta, ToolCallEntry } from './types.js';
import type { FileListEntry } from './exporter/protocol.js';

interface AgentCallInput {
  description?: string | undefined;
  subagent_type?: string | undefined;
}

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

function dirNameOf(relPath: string): string {
  return relPath.split('/')[0] ?? relPath;
}

/**
 * AgentWatcher implementation with no filesystem access of its own — every
 * update arrives as a protocol event handed in by ExporterListener. Mirrors
 * SourceWatcher's in-memory shape (SessionMeta + the parent's Agent-call
 * inputs, nothing heavier) so subagent linking works the same way.
 */
export class RemoteWatcher extends EventEmitter {
  private sessions = new Map<string, WatchedSession>();
  public readonly sourceId: string;

  constructor(
    public readonly source: Source,
    private readonly db?: TrackerDB,
  ) {
    super();
    this.sourceId = source.id;
  }

  async start(): Promise<void> {
    // Nothing to scan - everything arrives via the handle* methods below.
  }

  async stop(): Promise<void> {
    this.db?.archive.flushAll();
  }

  getAllMeta(): SessionMeta[] {
    return [...this.sessions.values()].map(entry => entry.meta);
  }

  /** Returns the relPaths whose archived fingerprint doesn't match. */
  handleFileList(files: FileListEntry[]): string[] {
    const needed: string[] = [];
    for (const file of files) {
      const sessionId = basename(file.relPath, '.jsonl');
      const fp = this.db?.archive.fileFingerprint(sessionId) ?? null;
      if (fp && fp.size === file.size && fp.mtimeMs === file.mtimeUnixMs) continue;
      needed.push(file.relPath);
    }
    return needed;
  }

  handleAppendLines(relPath: string, fromLine: number, lines: string[]): void {
    const sessionId = basename(relPath, '.jsonl');
    const existing = this.db?.archive.rawLineStrings(sessionId) ?? [];
    if (fromLine !== existing.length) {
      console.warn(
        `[remote-watcher:${this.sourceId}] out-of-order AppendLines for `
        + `${relPath} (fromLine=${fromLine}, archived=${existing.length}); `
        + 'ignoring - the next reconcile will self-heal',
      );
      return;
    }
    // AppendLines carries no size/mtime (the exporter doesn't stat the file
    // per line written), so this update leaves the archive's stored
    // fingerprint stale until the next FileList reconcile - which is exactly
    // what makes that reconcile ask for a snapshot again. Harmless, since the
    // content itself is already correct from this append.
    this.ingest(relPath, [...existing, ...lines], undefined, undefined);
  }

  handleFileSnapshot(
    relPath: string, size: number, mtimeUnixMs: number, lines: string[],
  ): void {
    this.ingest(relPath, lines, size, mtimeUnixMs);
  }

  handleFileRemoved(relPath: string): void {
    const sessionId = basename(relPath, '.jsonl');
    this.sessions.delete(sessionId);
    // Archive rows are left in place - only the explicit hard-delete route
    // (DELETE /api/archive/sessions/:id) destroys archive data, exactly as
    // for a container source going away.
  }

  private ingest(
    relPath: string,
    lines: string[],
    fileSize: number | undefined,
    fileMtimeMs: number | undefined,
  ): void {
    const dirName = dirNameOf(relPath);
    const syntheticPath = `remote:${this.sourceId}/${relPath}`;
    const fileStat = { mtimeMs: fileMtimeMs ?? Date.now(), birthtimeMs: Date.now() };
    const parsed: ParsedSession = parseLines(
      lines, fileStat, syntheticPath, this.sourceId, dirName,
    );
    const session = decorateSession(parsed, this.source);
    const existed = this.sessions.has(session.id);

    this.sessions.set(session.id, {
      meta: toMeta(session),
      agentCalls: agentCallsOf(session.toolCalls),
    });

    this.db?.archive.put(session, {
      lines,
      fileSize,
      fileMtimeMs,
      parserVersion: PARSER_VERSION,
    });
    if (this.db && !session.isSubagent) this.db.indexSession(session);

    this.linkSubagents();

    const entry = this.sessions.get(session.id)!;
    this.emit(existed ? 'session-updated' : 'session-created', entry.meta);
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
}
