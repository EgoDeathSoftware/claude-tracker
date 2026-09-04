import type { SourceKind, SourceLocation } from './sources.ts';
import type { StoreOrigin } from './store-origin.ts';

export type SessionStatus = 'live' | 'waiting' | 'done';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
  tool_use_id?: string;
}

export interface MessageUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens: number;
}

export interface SessionMessage {
  uuid: string;
  type: 'user' | 'assistant';
  timestamp: string;
  content: string | ContentBlock[];
  model?: string;
  usage?: MessageUsage;
}

export interface RawLogEntry {
  lineNumber: number;
  type: string;
  uuid?: string | undefined;
  timestamp?: string | undefined;
  summary: string;
}

export type FileOperation = 'read' | 'write' | 'edit';

export interface ToolCallEntry {
  toolUseId: string;
  toolName: string;
  input: unknown;
  output?: string | undefined;
  timestamp: string;
  resultTimestamp?: string | undefined;
  durationMs?: number | undefined;
  costUsd?: number | undefined;
}

export interface FileChangeEntry {
  filePath: string;
  operation: FileOperation;
  timestamp: string;
  toolUseId: string;
}

export interface CostBreakdown {
  byTool: Record<string, { calls: number; cost: number }>;
  conversationCost: number;
  toolCost: number;
  totalCost: number;
}

export interface HookEvent {
  timestamp: string;
  hookEvent: string;
  hookName: string;
  command?: string | undefined;
  toolUseId?: string | undefined;
  toolName?: string | undefined;
}

export interface PermissionEvent {
  timestamp: string;
  type: 'mode-set' | 'hook-block' | 'hook-pass';
  detail: string;
}

export interface RecapEntry {
  timestamp: string;
  content: string;
}

export interface AiSummary {
  content: string;
  model: string;
  provider: string;
  generatedAt: string;
  sourceLastActivityAt: string;
}

export interface SubagentInfo {
  sessionId: string;
  parentSessionId: string;
  description?: string | undefined;
  subagentType?: string | undefined;
  turnCount: number;
  costUsd: number;
  model: string;
  startedAt: string;
  durationMs: number;
}

/** Provenance snapshotted onto a session so it survives its source's removal. */
export interface SourceSnapshot {
  sourceName: string;
  sourceKind: SourceKind;
  sourceLocation: SourceLocation;
  origin?: StoreOrigin | undefined;
}

/** Everything list views and filters need. Small and bounded; held in memory. */
export interface SessionMeta extends SourceSnapshot {
  id: string;
  sourceId: string;
  projectId: string;
  filePath: string;
  slug: string;
  title: string;
  status: SessionStatus;
  turnCount: number;
  costUsd: number;
  model: string;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  cwd: string;
  gitBranch?: string | undefined;
  isSubagent: boolean;
  parentSessionId?: string | undefined;
  costBreakdown: CostBreakdown;
  subagents: SubagentInfo[];
  /** True when no live watcher currently backs this session. Derived, never stored. */
  archived: boolean;
  aiSummary?: AiSummary | undefined;
}

/** The heavy arrays. Stored in SQLite, loaded only when a session is opened. */
export interface SessionBody {
  messages: SessionMessage[];
  logEntries: RawLogEntry[];
  toolCalls: ToolCallEntry[];
  fileChanges: FileChangeEntry[];
  hookEvents: HookEvent[];
  permissionEvents: PermissionEvent[];
  recaps: RecapEntry[];
}

export type Session = SessionMeta & SessionBody;

/**
 * What `parseSession` returns: a session before its source snapshot is
 * attached. The parser is handed a sourceId, not a Source, so it cannot
 * know the source's name, kind, or location.
 */
export type ParsedSession =
  Omit<SessionMeta, keyof SourceSnapshot | 'archived' | 'aiSummary'> & SessionBody;

export interface Project {
  id: string;
  name: string;
  dirPath: string;
  sessionCount: number;
  liveCount: number;
  lastActivityAt: string;
  sources: string[];
}
