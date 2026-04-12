// Frontend type definitions (mirrors server/src/types.ts)
// Keep in sync with server/src/types.ts when making changes.

export type SessionStatus = 'live' | 'waiting' | 'done';

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
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

export interface Session {
  id: string;
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
  messages: SessionMessage[];
}

export interface Project {
  id: string;
  name: string;
  dirPath: string;
  sessionCount: number;
  liveCount: number;
  lastActivityAt: string;
}
