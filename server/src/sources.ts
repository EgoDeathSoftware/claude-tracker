import { readFile, stat } from 'node:fs/promises';
import type { StoreOrigin } from './store-origin.js';

export type SourceKind = 'claude-code' | 'opencode';
export type SourceLocation = 'host' | 'container';
export type SourceLayout = 'single' | 'store-set';

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  layout: SourceLayout;
  location: SourceLocation;
  configPath?: string | undefined;
  origin?: StoreOrigin | undefined;
  parentId?: string | undefined;
}

const ID_PATTERN = /^[a-z0-9_-]+$/;

export async function loadSources(
  configPath: string,
  envClaudeDir: string | undefined,
): Promise<Source[]> {
  const raw = await readFile(configPath, 'utf-8').catch(() => null);

  if (raw === null) {
    const fallback = envClaudeDir ?? (
      process.env['HOME']
        ? `${process.env['HOME']}/.claude`
        : null
    );
    if (fallback === null) {
      throw new Error(
        `[sources] ${configPath} not found and no fallback available `
        + `(set CLAUDE_DIR env var or create the config file)`,
      );
    }
    console.log(
      `[sources] ${configPath} not found; `
      + `using single source: ${fallback}`,
    );
    return [{
      id: 'default', name: 'Default', path: fallback,
      kind: 'claude-code', layout: 'single', location: 'host',
    }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[sources] malformed JSON in ${configPath}: ${msg}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `[sources] config root must be an object with a "sources" array `
      + `in ${configPath}`,
    );
  }

  const list = (parsed as { sources?: unknown }).sources;
  if (!Array.isArray(list)) {
    throw new Error(
      `[sources] expected "sources" array in ${configPath}`,
    );
  }

  const seen = new Set<string>();
  const valid: Source[] = [];

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(
        `[sources] source entry is not an object: ${JSON.stringify(entry)}`,
      );
    }
    const s = entry as {
      id?: unknown;
      name?: unknown;
      path?: unknown;
      kind?: unknown;
      layout?: unknown;
      configPath?: unknown;
    };
    if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) {
      throw new Error(
        `[sources] invalid id (must match [a-z0-9_-]+): ${String(s.id)}`,
      );
    }
    if (typeof s.name !== 'string' || s.name.length === 0) {
      throw new Error(`[sources] source ${s.id} missing non-empty name`);
    }
    if (typeof s.path !== 'string' || s.path.length === 0) {
      throw new Error(`[sources] source ${s.id} missing non-empty path`);
    }
    let kind: SourceKind;
    if (s.kind === undefined) {
      kind = 'claude-code';
    } else if (s.kind === 'claude-code' || s.kind === 'opencode') {
      kind = s.kind;
    } else {
      throw new Error(
        `[sources] invalid kind (must be "claude-code" or "opencode"): `
        + `${String(s.kind)}`,
      );
    }
    let layout: SourceLayout;
    if (s.layout === undefined) {
      layout = 'single';
    } else if (s.layout === 'single' || s.layout === 'store-set') {
      layout = s.layout;
    } else {
      throw new Error(
        `[sources] invalid layout (must be "single" or "store-set"): `
        + `${String(s.layout)}`,
      );
    }
    let configPath: string | undefined;
    if (s.configPath !== undefined) {
      if (typeof s.configPath !== 'string' || s.configPath.length === 0) {
        throw new Error(`[sources] source ${s.id} has invalid configPath`);
      }
      configPath = s.configPath;
    }
    if (seen.has(s.id)) {
      throw new Error(`[sources] duplicate source id: ${s.id}`);
    }
    seen.add(s.id);
    valid.push(
      configPath === undefined
        ? { id: s.id, name: s.name, path: s.path, kind, layout, location: 'host' }
        : { id: s.id, name: s.name, path: s.path, kind, layout, location: 'host', configPath },
    );
  }

  const reachable: Source[] = [];
  for (const src of valid) {
    try {
      await stat(src.path);
      reachable.push(src);
    } catch {
      console.warn(
        `[sources] skipping unreachable source "${src.id}" at ${src.path}`,
      );
    }
  }

  return reachable;
}
