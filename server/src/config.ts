import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// --- settings.json ---

export interface SettingsJson {
  [key: string]: unknown;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  hooks?: Record<string, HookGroup[]>;
  env?: Record<string, string>;
  enableAllProjectMcpServers?: boolean;
  enabledPlugins?: Record<string, boolean>;
  alwaysThinkingEnabled?: boolean;
  statusLine?: { type: string; command: string };
}

export interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface HookEntry {
  type: string;
  command: string;
}

export async function readSettings(
  claudeDir: string,
): Promise<SettingsJson> {
  const filePath = join(claudeDir, 'settings.json');
  const raw = await readFile(filePath, 'utf-8').catch(() => '{}');
  return JSON.parse(raw) as SettingsJson;
}

export async function writeSettings(
  claudeDir: string,
  settings: SettingsJson,
): Promise<void> {
  const filePath = join(claudeDir, 'settings.json');
  await writeFile(filePath, JSON.stringify(settings, null, 2) + '\n');
}

// --- .claude.json (MCP servers) ---

export interface McpServer {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface ClaudeJson {
  [key: string]: unknown;
  mcpServers?: Record<string, McpServer>;
}

export async function readClaudeJson(
  homeDir: string,
): Promise<ClaudeJson> {
  const filePath = join(homeDir, '.claude.json');
  const raw = await readFile(filePath, 'utf-8').catch(() => '{}');
  return JSON.parse(raw) as ClaudeJson;
}

export async function writeClaudeJson(
  homeDir: string,
  data: ClaudeJson,
): Promise<void> {
  const filePath = join(homeDir, '.claude.json');
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

// --- CLAUDE.md files ---

export interface ClaudeMdFile {
  path: string;
  name: string;
  content: string;
}

export async function readClaudeMd(
  filePath: string,
): Promise<string> {
  return readFile(filePath, 'utf-8').catch(() => '');
}

export async function writeClaudeMd(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content);
}

export async function listClaudeMdFiles(
  claudeDir: string,
): Promise<ClaudeMdFile[]> {
  const results: ClaudeMdFile[] = [];

  // Global CLAUDE.md
  const globalPath = join(claudeDir, 'CLAUDE.md');
  const globalContent = await readFile(globalPath, 'utf-8')
    .catch(() => '');
  if (globalContent) {
    results.push({
      path: globalPath,
      name: 'Global (CLAUDE.md)',
      content: globalContent,
    });
  }

  // Language-specific CLAUDE.*.md in claude dir
  const claudeDirEntries = await readdir(claudeDir).catch(
    () => [] as string[],
  );
  for (const entry of claudeDirEntries) {
    if (
      entry.startsWith('CLAUDE.')
      && entry.endsWith('.md')
      && entry !== 'CLAUDE.md'
    ) {
      const p = join(claudeDir, entry);
      const c = await readFile(p, 'utf-8').catch(() => '');
      if (c) {
        results.push({ path: p, name: entry, content: c });
      }
    }
  }

  return results;
}

// --- Hook scripts ---

export interface HookScript {
  name: string;
  path: string;
  content: string;
}

export async function listHookScripts(
  claudeDir: string,
): Promise<HookScript[]> {
  const hooksDir = join(claudeDir, 'hooks');
  const entries = await readdir(hooksDir).catch(() => [] as string[]);
  const scripts: HookScript[] = [];

  for (const entry of entries) {
    const p = join(hooksDir, entry);
    const content = await readFile(p, 'utf-8').catch(() => '');
    scripts.push({ name: entry, path: p, content });
  }

  return scripts;
}

export async function writeHookScript(
  claudeDir: string,
  name: string,
  content: string,
): Promise<void> {
  const filePath = join(claudeDir, 'hooks', name);
  await writeFile(filePath, content, { mode: 0o755 });
}
