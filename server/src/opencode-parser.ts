import Database from 'better-sqlite3';
import { deriveProjectKey } from './project-key.js';
import type {
  Session, SessionMessage, ToolCallEntry, FileChangeEntry,
  ContentBlock, CostBreakdown,
} from './types.js';

const LIVE_THRESHOLD_MS = 60_000;
const DONE_THRESHOLD_MS = 5 * 60_000;

const FILE_TOOLS: Record<string, 'read' | 'write' | 'edit'> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
};

function deriveStatus(timeUpdatedMs: number): 'live' | 'waiting' | 'done' {
  const ageMs = Date.now() - timeUpdatedMs;
  if (ageMs < LIVE_THRESHOLD_MS) return 'live';
  if (ageMs < DONE_THRESHOLD_MS) return 'waiting';
  return 'done';
}

function parseModel(modelJson: string): string {
  const parsed = JSON.parse(modelJson);
  if (parsed.providerID && parsed.id) {
    return `${parsed.providerID}/${parsed.id}`;
  }
  // If the model doesn't have the expected structure, treat as invalid
  throw new Error('Invalid model structure');
}

function buildCostBreakdown(
  toolCalls: ToolCallEntry[],
  totalCost: number,
): CostBreakdown {
  const byTool: Record<string, { calls: number; cost: number }> = {};

  // Count calls per tool
  for (const tc of toolCalls) {
    const existing = byTool[tc.toolName];
    if (existing) {
      existing.calls++;
    } else {
      byTool[tc.toolName] = { calls: 1, cost: 0 };
    }
  }

  // When tool calls exist, all cost is attributed to tools
  // When no tool calls, all cost is conversation cost
  const toolCost = toolCalls.length > 0 ? totalCost : 0;
  const conversationCost = toolCalls.length > 0 ? 0 : totalCost;

  return {
    byTool,
    conversationCost,
    toolCost,
    totalCost,
  };
}

function timestampFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  try {
    const info = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return (info as Array<{ name: string }>).some(col => col.name === columnName);
  } catch {
    return false;
  }
}

export async function listOpenCodeSessions(
  dbPath: string,
  sourceId: string,
): Promise<Session[]> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const hasSessionTimeCreated = columnExists(db, 'session', 'time_created');
    const hasMessageTimeCreated = columnExists(db, 'message', 'time_created');

    // Query sessions - use time_created if available, otherwise time_updated
    let rows: unknown[];
    if (hasSessionTimeCreated) {
      const stmt = db.prepare('SELECT * FROM session ORDER BY time_created');
      rows = stmt.all();
    } else {
      const stmt = db.prepare('SELECT * FROM session ORDER BY time_updated');
      rows = stmt.all();
    }

    const sessions: Session[] = [];
    for (const row of rows) {
      try {
        const session = row as {
          id: string;
          project_id: string;
          directory: string;
          model: string;
          cost: number;
          parent_id: string | null;
          time_updated: number;
          title: string;
          time_created?: number;
        };

        const sessionId = session.id;
        const directory = session.directory;
        const projectId = deriveProjectKey(directory, sourceId, session.project_id);

        // Query messages ordered by time_created (or time_updated if that's all that's available)
        let msgStmt: Database.Statement<unknown[]>;
        if (hasMessageTimeCreated) {
          msgStmt = db.prepare(
            'SELECT * FROM message WHERE session_id = ? ORDER BY time_created',
          );
        } else {
          msgStmt = db.prepare(
            'SELECT * FROM message WHERE session_id = ? ORDER BY time_updated',
          );
        }
        const msgRows = msgStmt.all(sessionId);

        const messages: SessionMessage[] = [];
        const toolCallEntries: ToolCallEntry[] = [];
        const fileChanges: FileChangeEntry[] = [];
        let firstTimestamp = 0;
        let lastTimestamp = 0;

        for (const msgRow of msgRows as Array<{
          id: string;
          session_id: string;
          time_created: number;
          time_updated: number;
          role: string;
          data: string;
        }>) {
          // Use time_created if available, otherwise fall back to time_updated
          const msgTime = (msgRow as any).time_created || (msgRow as any).time_updated;

          if (!firstTimestamp) firstTimestamp = msgTime;
          lastTimestamp = msgTime;

          let parts: Array<{
            id?: string;
            type: string;
            tool?: string;
            text?: string;
            call_id?: string;
            state?: Record<string, unknown>;
          }> = [];

          try {
            const msgData = JSON.parse(msgRow.data);
            if (msgData.parts && Array.isArray(msgData.parts)) {
              parts = msgData.parts;
            }
          } catch {
            // Skip malformed message data, but still include an empty message
          }

          // Build content for SessionMessage
          const contentBlocks: ContentBlock[] = [];
          let contentString = '';
          let isTextOnly = true;

          for (const part of parts) {
            if (part.type === 'text' && part.text) {
              contentString += (contentString ? '\n' : '') + part.text;
            } else if (part.type === 'tool') {
              isTextOnly = false;
              const toolName = part.tool ?? 'unknown';
              const toolUseId = part.call_id || '';

              // Parse input from state
              let input: unknown = {};
              if (part.state) {
                // state is already a parsed object (not a JSON string)
                const state = part.state;
                input = state['input'] ?? state;
              }

              // Build ToolCallEntry
              const toolEntry: ToolCallEntry = {
                toolUseId,
                toolName,
                input,
                timestamp: timestampFromMs(msgTime),
              };

              // Try to extract output from state (for tool_result parts in some tests)
              let output: string | undefined;
              if (part.state) {
                // state is already a parsed object (not a JSON string)
                const state = part.state;
                if (state['output'] !== undefined) {
                  output = typeof state['output'] === 'string' ? state['output'] : JSON.stringify(state['output']);
                }
              }
              if (output) {
                toolEntry.output = output;
              }

              toolCallEntries.push(toolEntry);

              // Build ContentBlock for tool use
              contentBlocks.push({
                type: 'tool_use',
                id: toolUseId,
                name: toolName,
                input,
              });

              // Check if this tool is a file operation
              if (FILE_TOOLS[toolName]) {
                let filePath = '';
                if (typeof input === 'object' && input !== null) {
                  const inp = input as Record<string, unknown>;
                  filePath = inp['file_path'] as string ?? inp['filePath'] as string ?? inp['path'] as string ?? '';
                }
                if (filePath) {
                  fileChanges.push({
                    filePath,
                    operation: FILE_TOOLS[toolName],
                    timestamp: timestampFromMs(msgTime),
                    toolUseId,
                  });
                }
              }
            }
          }

          const role = msgRow.role === 'user' ? 'user' : 'assistant';
          messages.push({
            uuid: msgRow.id,
            type: role,
            timestamp: timestampFromMs(msgTime),
            content: isTextOnly ? contentString : contentBlocks,
          });
        }

        // Compute cost breakdown
        const costBreakdown = buildCostBreakdown(toolCallEntries, session.cost);

        // Derive status from time_updated
        const status = deriveStatus(session.time_updated);

        // Determine if subagent
        const isSubagent = session.parent_id != null;
        const parentSessionId = session.parent_id ?? undefined;

        const lastActivityAt = timestampFromMs(session.time_updated);
        const startedAt = firstTimestamp > 0 ? timestampFromMs(firstTimestamp) : lastActivityAt;
        const durationMs = firstTimestamp > 0 && lastTimestamp > 0
          ? lastTimestamp - firstTimestamp
          : 0;

        sessions.push({
          id: sessionId,
          sourceId,
          projectId,
          filePath: dbPath,
          slug: '',
          title: session.title,
          status,
          turnCount: messages.filter(m => m.type === 'user').length,
          costUsd: session.cost,
          model: parseModel(session.model),
          startedAt,
          lastActivityAt,
          durationMs,
          cwd: directory,
          messages,
          logEntries: [],
          toolCalls: toolCallEntries,
          fileChanges,
          costBreakdown,
          hookEvents: [],
          permissionEvents: [],
          subagents: [],
          parentSessionId,
          isSubagent,
          recaps: [],
        });
      } catch (err) {
        console.error(`Failed to parse session row:`, err);
        // Skip malformed session rows without crashing
        continue;
      }
    }

    return sessions;
  } finally {
    db.close();
  }
}
