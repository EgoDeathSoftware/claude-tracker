export interface FileListEntry {
  relPath: string;
  size: number;
  mtimeUnixMs: number;
}

export interface FileListMessage {
  type: 'FileList';
  files: FileListEntry[];
}

export interface AppendLinesMessage {
  type: 'AppendLines';
  relPath: string;
  fromLine: number;
  lines: string[];
}

export interface FileSnapshotMessage {
  type: 'FileSnapshot';
  relPath: string;
  size: number;
  mtimeUnixMs: number;
  lines: string[];
}

export interface FileRemovedMessage {
  type: 'FileRemoved';
  relPath: string;
}

export type ExporterMessage =
  | FileListMessage
  | AppendLinesMessage
  | FileSnapshotMessage
  | FileRemovedMessage;

export interface RequestSnapshotMessage {
  type: 'RequestSnapshot';
  relPath: string;
}

export function encodeFrame(
  msg: ExporterMessage | RequestSnapshotMessage,
): string {
  return `${JSON.stringify(msg)}\n`;
}

function isFileListEntry(v: unknown): v is FileListEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e['relPath'] === 'string'
    && typeof e['size'] === 'number'
    && typeof e['mtimeUnixMs'] === 'number';
}

/**
 * Runtime shape check for a frame that just arrived over the wire from a
 * remote, only-mTLS-authenticated exporter — the TLS layer proves who sent
 * it, not that its JSON is well-formed.
 */
export function parseExporterMessage(raw: unknown): ExporterMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;

  switch (m['type']) {
    case 'FileList': {
      if (!Array.isArray(m['files']) || !m['files'].every(isFileListEntry)) {
        return null;
      }
      return { type: 'FileList', files: m['files'] };
    }
    case 'AppendLines': {
      if (
        typeof m['relPath'] !== 'string'
        || typeof m['fromLine'] !== 'number'
        || !Array.isArray(m['lines'])
        || !m['lines'].every((l): l is string => typeof l === 'string')
      ) {
        return null;
      }
      return {
        type: 'AppendLines',
        relPath: m['relPath'],
        fromLine: m['fromLine'],
        lines: m['lines'],
      };
    }
    case 'FileSnapshot': {
      if (
        typeof m['relPath'] !== 'string'
        || typeof m['size'] !== 'number'
        || typeof m['mtimeUnixMs'] !== 'number'
        || !Array.isArray(m['lines'])
        || !m['lines'].every((l): l is string => typeof l === 'string')
      ) {
        return null;
      }
      return {
        type: 'FileSnapshot',
        relPath: m['relPath'],
        size: m['size'],
        mtimeUnixMs: m['mtimeUnixMs'],
        lines: m['lines'],
      };
    }
    case 'FileRemoved': {
      if (typeof m['relPath'] !== 'string') return null;
      return { type: 'FileRemoved', relPath: m['relPath'] };
    }
    default:
      return null;
  }
}

/**
 * Buffers a TCP/HTTP2-stream byte stream into newline-delimited JSON frames.
 * A line that fails to parse is dropped rather than thrown, so one corrupt
 * frame (a torn write, a bit flip) can't take down the whole connection.
 */
export class FrameDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const frames: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        // Never log the line itself - it's untrusted transcript content and
        // may carry secrets (API keys, tokens) a user pasted into a session.
        console.warn(`[exporter-protocol] dropping malformed frame (${line.length} bytes)`);
      }
    }
    return frames;
  }
}
