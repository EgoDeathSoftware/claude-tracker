import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpenCodeAgentFile {
  name: string;
  content: string;
}

// Strips // and /* */ comments from JSONC, respecting string literals -
// a naive regex (e.g. /\/\/.*$/gm) also matches "//" inside string values
// like "$schema": "https://opencode.ai/config.json", corrupting real config.
function stripJsonComments(input: string): string {
  let result = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        result += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += c;
      if (c === '\\') {
        // Preserve the escaped character as-is (e.g. \" or \\).
        result += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      result += c;
    } else if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      result += c;
    }
  }

  return result;
}

export async function readOpenCodeConfig(
  configPath: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(configPath, 'opencode.json'), 'utf-8').catch(() => null);
  if (raw === null) return {};
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return {};
  }
}

export async function listOpenCodeAgents(
  configPath: string,
): Promise<OpenCodeAgentFile[]> {
  const dir = join(configPath, 'agents');
  const files = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(
    files
      .filter(f => f.endsWith('.md'))
      .map(async name => ({
        name,
        content: await readFile(join(dir, name), 'utf-8'),
      })),
  );
}
