import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname } from 'node:path';
import { computeCost } from './pricing.js';
import { deriveProjectKey } from './project-key.js';
import type {
  Session, SessionMessage, SessionStatus, ContentBlock,
  MessageUsage, RawLogEntry, ToolCallEntry, FileChangeEntry,
  CostBreakdown, FileOperation, HookEvent, PermissionEvent, RecapEntry,
} from './types.ts';

const LIVE_THRESHOLD_MS = 60_000;
const DONE_THRESHOLD_MS = 5 * 60_000;
const TITLE_MAX_LEN = 80;

interface RawUserRecord {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  isMeta?: boolean;
  timestamp: string;
  slug?: string;
  cwd?: string;
  sessionId?: string;
  message: { role: 'user'; content: string | ContentBlock[] };
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

interface RawRecord {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
}

function parseJSON(line: string): RawRecord | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as { type?: unknown };
  if (typeof record.type !== 'string') return null;
  return obj as RawRecord;
}

function summarizeRecord(record: RawRecord): string {
  switch (record.type) {
    case 'user': {
      const r = record as unknown as RawUserRecord;
      const text = extractUserText(r.message?.content ?? '');
      return text ? truncate(text, 60) : '(tool result)';
    }
    case 'assistant': {
      const r = record as unknown as RawAssistantRecord;
      const blocks = r.message?.content ?? [];
      const textBlock = blocks.find(b => b.type === 'text');
      const toolBlocks = blocks.filter(b => b.type === 'tool_use');
      if (toolBlocks.length > 0) {
        const names = toolBlocks
          .map(b => b.name ?? 'unknown')
          .join(', ');
        return `Tool calls: ${names}`;
      }
      return textBlock?.text
        ? truncate(textBlock.text, 60)
        : '(no text)';
    }
    case 'progress': {
      const data = record['data'] as
        | { type?: string; hookEvent?: string; hookName?: string }
        | undefined;
      if (data?.type === 'hook_progress') {
        return `Hook: ${data.hookEvent ?? ''} ${data.hookName ?? ''}`.trim();
      }
      if (data?.type === 'agent_progress') return 'Agent progress';
      return `Progress: ${data?.type ?? 'unknown'}`;
    }
    case 'file-history-snapshot': {
      const snap = record['snapshot'] as
        | { trackedFileBackups?: Record<string, unknown> }
        | undefined;
      const count = snap?.trackedFileBackups
        ? Object.keys(snap.trackedFileBackups).length
        : 0;
      return `File snapshot: ${count} files tracked`;
    }
    case 'permission-mode':
      return `Permission mode: ${record['permissionMode'] ?? 'unknown'}`;
    case 'attachment': {
      const att = record['attachment'] as
        | { type?: string }
        | undefined;
      return `Attachment: ${att?.type ?? 'unknown'}`;
    }
    case 'system':
      return `System: ${record['subtype'] ?? (record['content'] as string | undefined) ?? ''}`.trim();
    case 'agent-name':
      return `Agent: ${record['agentName'] ?? 'unknown'}`;
    case 'custom-title':
      return `Title: ${record['customTitle'] ?? 'unknown'}`;
    case 'last-prompt':
      return 'Last prompt saved';
    case 'queue-operation':
      return `Queue: ${record['operation'] ?? 'unknown'}`;
    default:
      return record.type;
  }
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

function extractUserText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }
  return textParts.join('\n');
}

// CLI wraps slash commands and caveats in XML-like tags. Not all are flagged
// with isMeta, so we pattern-match to keep these out of titles and turn counts.
const CLI_WRAPPER_PATTERNS = [
  /^<local-command-caveat>/,
  /^<local-command-stdout>/,
  /^<local-command-stderr>/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
];

function isCliWrapper(text: string): boolean {
  const trimmed = text.trimStart();
  return CLI_WRAPPER_PATTERNS.some(p => p.test(trimmed));
}

async function readLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }
  return lines;
}

const FILE_TOOLS: Record<string, FileOperation> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
};

function extractFilePath(toolName: string, input: unknown): string | null {
  if (!FILE_TOOLS[toolName]) return null;
  if (typeof input !== 'object' || input === null) return null;
  const obj = input as Record<string, unknown>;
  const fp = obj['file_path'] ?? obj['filePath'] ?? obj['path'];
  return typeof fp === 'string' ? fp : null;
}

function extractToolResultText(
  content: string | ContentBlock[] | undefined,
): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('\n');
}

function buildCostBreakdown(
  toolCalls: ToolCallEntry[],
  totalCost: number,
): CostBreakdown {
  const byTool: Record<string, { calls: number; cost: number }> = {};
  let toolCost = 0;

  for (const tc of toolCalls) {
    const cost = tc.costUsd ?? 0;
    toolCost += cost;
    const existing = byTool[tc.toolName];
    if (existing) {
      existing.calls++;
      existing.cost += cost;
    } else {
      byTool[tc.toolName] = { calls: 1, cost };
    }
  }

  return {
    byTool,
    conversationCost: totalCost - toolCost,
    toolCost,
    totalCost,
  };
}

function detectParentSessionId(filePath: string): string | undefined {
  // Subagent paths: .../projects/{projectId}/{parentSessionId}/subagents/agent-xxx.jsonl
  const dir = dirname(filePath);
  const dirName = basename(dir);
  if (dirName === 'subagents') {
    return basename(dirname(dir));
  }
  return undefined;
}

export async function parseSession(
  filePath: string,
  sourceId: string,
  dirName: string,
): Promise<Session> {
  const [lines, fileStat] = await Promise.all([readLines(filePath), stat(filePath)]);

  const messages: SessionMessage[] = [];
  const logEntries: RawLogEntry[] = [];
  const toolCallMap = new Map<string, ToolCallEntry>();
  const fileChanges: FileChangeEntry[] = [];
  const hookEvents: HookEvent[] = [];
  const permissionEvents: PermissionEvent[] = [];
  const recaps: RecapEntry[] = [];
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const raw = parseJSON(line);
    if (!raw) continue;

    logEntries.push({
      lineNumber: i + 1,
      type: raw.type,
      uuid: raw.uuid,
      timestamp: raw.timestamp,
      summary: summarizeRecord(raw),
    });

    // Extract hook events from progress records
    if (raw.type === 'progress') {
      const data = raw['data'] as
        | { type?: string; hookEvent?: string; hookName?: string; command?: string }
        | undefined;
      if (data?.type === 'hook_progress' && data.hookEvent && data.hookName) {
        hookEvents.push({
          timestamp: raw.timestamp ?? '',
          hookEvent: data.hookEvent,
          hookName: data.hookName,
          command: data.command,
          toolUseId: raw['parentToolUseID'] as string | undefined,
        });
      }
    }

    // Extract permission mode changes
    if (raw.type === 'permission-mode') {
      const mode = raw['permissionMode'] as string | undefined;
      permissionEvents.push({
        timestamp: raw.timestamp ?? '',
        type: 'mode-set',
        detail: `Permission mode: ${mode ?? 'unknown'}`,
      });
    }

    // Extract hook results from attachment records
    if (raw.type === 'attachment') {
      const att = raw['attachment'] as
        | { type?: string; content?: string }
        | undefined;
      if (att?.type === 'hook_error') {
        permissionEvents.push({
          timestamp: raw.timestamp ?? '',
          type: 'hook-block',
          detail: att.content ?? 'Hook blocked execution',
        });
      } else if (att?.type === 'hook_success') {
        permissionEvents.push({
          timestamp: raw.timestamp ?? '',
          type: 'hook-pass',
          detail: att.content || 'Hook passed',
        });
      }
    }

    // Claude Code's own "away recap" — generated by the CLI itself when
    // returning to a session after being away. Free, no LLM call needed.
    if (raw.type === 'system' && raw['subtype'] === 'away_summary') {
      const content = raw['content'] as string | undefined;
      if (content) {
        recaps.push({ timestamp: raw.timestamp ?? '', content });
      }
    }

    // Only process user/assistant for the conversation view
    if (raw.type !== 'user' && raw.type !== 'assistant') continue;

    if (raw.type === 'user') {
      const rec = raw as unknown as RawUserRecord;
      if (rec.isSidechain || rec.isMeta) continue;

      if (!firstTimestamp) firstTimestamp = rec.timestamp;
      lastTimestamp = rec.timestamp;
      lastType = 'user';

      if (!slug && rec.slug) slug = rec.slug;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (rec.sessionId) sessionId = rec.sessionId;

      const userText = extractUserText(rec.message.content);
      const hasRealText = userText.trim().length > 0;
      // Slash-command/caveat wrappers emitted by the CLI look like real user
      // text but aren't what the user typed. Skip them for title + turn count.
      const isWrapper = hasRealText && isCliWrapper(userText);

      if (hasRealText && !isWrapper) {
        if (turnCount === 0) {
          title = truncate(userText, TITLE_MAX_LEN);
        }
        turnCount++;
      }

      // Match tool_result blocks to their tool_use entries
      if (Array.isArray(rec.message.content)) {
        for (const block of rec.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const tc = toolCallMap.get(block.tool_use_id);
            if (tc) {
              tc.output = extractToolResultText(block.content)
                .slice(0, 2000);
              tc.resultTimestamp = rec.timestamp;
              tc.durationMs = new Date(rec.timestamp).getTime()
                - new Date(tc.timestamp).getTime();
            }
          }
        }
      }

      messages.push({
        uuid: rec.uuid,
        type: 'user',
        timestamp: rec.timestamp,
        content: rec.message.content,
      });
    } else {
      const rec = raw as unknown as RawAssistantRecord;
      if (rec.isSidechain) continue;

      if (!firstTimestamp) firstTimestamp = rec.timestamp;
      lastTimestamp = rec.timestamp;
      lastType = 'assistant';

      model = rec.message.model ?? model;

      let msgCost = 0;
      if (rec.message.usage) {
        msgCost = computeCost(rec.message.usage, rec.message.model);
        totalCostUsd += msgCost;
      }

      // Extract tool_use blocks
      const toolBlocks = rec.message.content.filter(
        b => b.type === 'tool_use' && b.id && b.name,
      );
      const costPerTool = toolBlocks.length > 0
        ? msgCost / toolBlocks.length
        : 0;

      for (const block of toolBlocks) {
        const entry: ToolCallEntry = {
          toolUseId: block.id!,
          toolName: block.name!,
          input: block.input,
          timestamp: rec.timestamp,
          costUsd: costPerTool,
        };
        toolCallMap.set(block.id!, entry);

        const fp = extractFilePath(block.name!, block.input);
        if (fp) {
          fileChanges.push({
            filePath: fp,
            operation: FILE_TOOLS[block.name!]!,
            timestamp: rec.timestamp,
            toolUseId: block.id!,
          });
        }
      }

      const assistantMsg: SessionMessage = {
        uuid: rec.uuid,
        type: 'assistant',
        timestamp: rec.timestamp,
        content: rec.message.content,
        model: rec.message.model,
      };
      if (rec.message.usage) {
        assistantMsg.usage = rec.message.usage;
      }
      messages.push(assistantMsg);
    }
  }

  const startedAt = firstTimestamp || new Date(fileStat.birthtimeMs).toISOString();
  const lastActivityAt = new Date(fileStat.mtimeMs).toISOString();
  const durationMs = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : 0;

  const parentSessionId = detectParentSessionId(filePath);
  const projectId = deriveProjectKey(cwd, sourceId, dirName);

  return {
    id: sessionId,
    sourceId,
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
    logEntries,
    toolCalls: [...toolCallMap.values()],
    fileChanges,
    costBreakdown: buildCostBreakdown([...toolCallMap.values()], totalCostUsd),
    hookEvents: hookEvents.map(he => ({
      ...he,
      toolName: he.toolUseId
        ? toolCallMap.get(he.toolUseId)?.toolName
        : undefined,
    })),
    permissionEvents,
    subagents: [],
    parentSessionId,
    isSubagent: parentSessionId !== undefined,
    recaps,
  };
}

export async function readRawLines(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{ lines: { lineNumber: number; content: unknown }[]; total: number }> {
  const allLines = await readLines(filePath);
  const total = allLines.length;
  const result: { lineNumber: number; content: unknown }[] = [];
  const end = Math.min(offset + limit, total);
  for (let i = offset; i < end; i++) {
    let content: unknown;
    try {
      content = JSON.parse(allLines[i]!);
    } catch {
      content = allLines[i];
    }
    result.push({ lineNumber: i + 1, content });
  }
  return { lines: result, total };
}
