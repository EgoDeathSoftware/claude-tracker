import type { Session, AiSummary } from './types.ts';
import type { LlmConfig } from './llm-config.ts';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM_PROMPT = `You summarize coding-assistant sessions for a developer `
  + `reviewing their own work log. Write a concise 2-4 sentence summary `
  + `covering: what the user asked for, what was actually done, and anything `
  + `left unresolved. Be specific — name files, features, or errors when `
  + `relevant. For long sessions, the middle of the conversation is omitted `
  + `and marked as such — base the summary on how the session started and `
  + `how it concluded rather than assuming a gap in the actual work. Output `
  + `only the summary text, no preamble, no markdown headers.`;

const TRANSCRIPT_CHAR_LIMIT = 12_000;
const HEAD_MESSAGES = 10;
const TAIL_MESSAGES = 10;

function messageText(msg: Session['messages'][number]): string {
  return typeof msg.content === 'string'
    ? msg.content
    : msg.content
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n');
}

function buildTranscript(session: Session): string {
  const parts: string[] = [];

  const entries = session.messages
    .map(msg => ({ msg, text: messageText(msg) }))
    .filter(e => e.text.trim().length > 0);

  const format = (e: { msg: Session['messages'][number]; text: string }) =>
    `${e.msg.type === 'user' ? 'User' : 'Assistant'}: ${e.text}`;

  if (entries.length <= HEAD_MESSAGES + TAIL_MESSAGES) {
    parts.push(...entries.map(format));
  } else {
    const head = entries.slice(0, HEAD_MESSAGES);
    const tail = entries.slice(-TAIL_MESSAGES);
    const omitted = entries.length - HEAD_MESSAGES - TAIL_MESSAGES;
    parts.push(
      ...head.map(format),
      `[... ${omitted} messages omitted from the middle of the session ...]`,
      ...tail.map(format),
    );
  }

  const toolNames = [...new Set(session.toolCalls.map(tc => tc.toolName))];
  if (toolNames.length > 0) {
    parts.push(`Tools used: ${toolNames.join(', ')}`);
  }

  const files = [...new Set(session.fileChanges.map(fc => fc.filePath))];
  if (files.length > 0) {
    parts.push(`Files touched: ${files.slice(0, 30).join(', ')}`);
  }

  return parts.join('\n\n').slice(0, TRANSCRIPT_CHAR_LIMIT);
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
}

function authHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  return headers;
}

export async function listModels(config: LlmConfig): Promise<string[]> {
  if (!config.baseUrl) throw new Error('no endpoint configured');

  const res = await fetch(modelsUrl(config.baseUrl), {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    throw new Error(`models request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as { data?: { id: string }[] };
  return (data.data ?? []).map(m => m.id);
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
}

export async function testConnection(
  config: LlmConfig,
): Promise<ConnectionTestResult> {
  try {
    const models = await listModels(config);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function generateSummary(
  session: Session,
  config: LlmConfig,
): Promise<AiSummary> {
  if (!config.baseUrl) throw new Error('no LLM endpoint configured');
  if (!config.model) throw new Error('no model selected');

  const transcript = buildTranscript(session);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: transcript || '(session had no textual content)',
    },
  ];

  const res = await fetch(chatUrl(config.baseUrl), {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `chat completion failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('empty response from LLM endpoint');

  return {
    content,
    model: config.model,
    provider: config.provider,
    generatedAt: new Date().toISOString(),
    sourceLastActivityAt: session.lastActivityAt,
  };
}
