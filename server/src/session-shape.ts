import type { Source } from './sources.js';
import type {
  ParsedSession, Session, SessionBody, SessionMeta, SourceSnapshot,
} from './types.js';

const BODY_KEYS = [
  'messages', 'logEntries', 'toolCalls', 'fileChanges',
  'hookEvents', 'permissionEvents', 'recaps',
] as const;

/** Copy a source's identity so a session keeps it after the source is gone. */
export function sourceSnapshot(source: Source): SourceSnapshot {
  const snapshot: SourceSnapshot = {
    sourceName: source.name,
    sourceKind: source.kind,
    sourceLocation: source.location,
  };
  if (source.origin !== undefined) snapshot.origin = source.origin;
  return snapshot;
}

/** Attach the source snapshot to a freshly parsed session. */
export function decorateSession(parsed: ParsedSession, source: Source): Session {
  return { ...parsed, ...sourceSnapshot(source), archived: false };
}

export function toBody(session: Session): SessionBody {
  return {
    messages: session.messages,
    logEntries: session.logEntries,
    toolCalls: session.toolCalls,
    fileChanges: session.fileChanges,
    hookEvents: session.hookEvents,
    permissionEvents: session.permissionEvents,
    recaps: session.recaps,
  };
}

export function toMeta(session: Session): SessionMeta {
  const meta = { ...session } as Session & Partial<SessionBody>;
  for (const key of BODY_KEYS) delete meta[key];
  return meta as SessionMeta;
}
