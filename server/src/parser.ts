import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { computeCost } from './pricing.js';
import type { Session, SessionMessage, SessionStatus, ContentBlock, MessageUsage } from './types.ts';

const LIVE_THRESHOLD_MS = 60_000;
const DONE_THRESHOLD_MS = 5 * 60_000;
const TITLE_MAX_LEN = 80;

interface RawUserRecord {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string;
  slug?: string;
  cwd?: string;
  sessionId?: string;
  message: { role: 'user'; content: string };
}

interface RawAssistantRecord {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string;
  message: {
    role: 'assistant';
    model: string;
    content: ContentBlock[];
    usage?: MessageUsage;
  };
}

function parseRecord(line: string): RawUserRecord | RawAssistantRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as { type?: unknown };
  if (record.type === 'user') return obj as RawUserRecord;
  if (record.type === 'assistant') return obj as RawAssistantRecord;
  return null;
}

function deriveStatus(mtimeMs: number, lastType: 'user' | 'assistant' | null): SessionStatus {
  const ageMs = Date.now() - mtimeMs;
  if (ageMs < LIVE_THRESHOLD_MS) return 'live';
  if (ageMs < DONE_THRESHOLD_MS && lastType === 'user') return 'waiting';
  return 'done';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

async function readLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }
  return lines;
}

export async function parseSession(filePath: string, projectId: string): Promise<Session> {
  const [lines, fileStat] = await Promise.all([readLines(filePath), stat(filePath)]);

  const messages: SessionMessage[] = [];
  let title = '(untitled)';
  let slug = '';
  let cwd = '';
  let sessionId = basename(filePath, '.jsonl');
  let model = 'unknown';
  let totalCostUsd = 0;
  let turnCount = 0;
  let firstTimestamp = '';
  let lastTimestamp = '';
  let lastType: 'user' | 'assistant' | null = null;

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;

    if (record.type === 'user') {
      if (record.isSidechain) continue;

      if (!firstTimestamp) firstTimestamp = record.timestamp;
      lastTimestamp = record.timestamp;
      lastType = 'user';

      if (!slug && record.slug) slug = record.slug;
      if (!cwd && record.cwd) cwd = record.cwd;
      if (record.sessionId) sessionId = record.sessionId;

      if (turnCount === 0) {
        title = truncate(record.message.content, TITLE_MAX_LEN);
      }
      turnCount++;

      messages.push({
        uuid: record.uuid,
        type: 'user',
        timestamp: record.timestamp,
        content: record.message.content,
      });
    } else {
      if (record.isSidechain) continue;

      if (!firstTimestamp) firstTimestamp = record.timestamp;
      lastTimestamp = record.timestamp;
      lastType = 'assistant';

      model = record.message.model ?? model;

      if (record.message.usage) {
        totalCostUsd += computeCost(record.message.usage, record.message.model);
      }

      const assistantMsg: SessionMessage = {
        uuid: record.uuid,
        type: 'assistant',
        timestamp: record.timestamp,
        content: record.message.content,
        model: record.message.model,
      };
      if (record.message.usage) {
        assistantMsg.usage = record.message.usage;
      }
      messages.push(assistantMsg);
    }
  }

  const startedAt = firstTimestamp || new Date(fileStat.birthtimeMs).toISOString();
  const lastActivityAt = new Date(fileStat.mtimeMs).toISOString();
  const durationMs = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : 0;

  return {
    id: sessionId,
    projectId,
    filePath,
    slug,
    title,
    status: deriveStatus(fileStat.mtimeMs, lastType),
    turnCount,
    costUsd: totalCostUsd,
    model,
    startedAt,
    lastActivityAt,
    durationMs,
    cwd,
    messages,
  };
}
