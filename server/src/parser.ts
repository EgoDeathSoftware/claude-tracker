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

type RawRecord = RawUserRecord | RawAssistantRecord | { type: string };

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
    let record: RawRecord;
    try {
      record = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }

    if (record.type === 'user') {
      const r = record as RawUserRecord;
      if (r.isSidechain) continue;

      if (!firstTimestamp) firstTimestamp = r.timestamp;
      lastTimestamp = r.timestamp;
      lastType = 'user';

      if (!slug && r.slug) slug = r.slug;
      if (!cwd && r.cwd) cwd = r.cwd;
      if (r.sessionId) sessionId = r.sessionId;

      if (turnCount === 0) {
        title = truncate(r.message.content, TITLE_MAX_LEN);
      }
      turnCount++;

      messages.push({ uuid: r.uuid, type: 'user', timestamp: r.timestamp, content: r.message.content });
    } else if (record.type === 'assistant') {
      const r = record as RawAssistantRecord;
      if (r.isSidechain) continue;

      if (!firstTimestamp) firstTimestamp = r.timestamp;
      lastTimestamp = r.timestamp;
      lastType = 'assistant';

      model = r.message.model ?? model;

      if (r.message.usage) {
        totalCostUsd += computeCost(r.message.usage, r.message.model);
      }

      const assistantMsg: SessionMessage = {
        uuid: r.uuid,
        type: 'assistant',
        timestamp: r.timestamp,
        content: r.message.content,
        model: r.message.model,
      };
      if (r.message.usage) {
        assistantMsg.usage = r.message.usage;
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
