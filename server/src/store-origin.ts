import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from './types.js';
import { deriveProjectKey } from './project-key.js';

/**
 * Provenance for one agent container's Claude store, read from the
 * `.tracker-origin.json` marker that agent-shell writes at launch.
 */
export interface StoreOrigin {
  container: string;
  image?: string | undefined;
  hostWorkspace?: string | undefined;
  workspaceMount?: string | undefined;
  host?: string | undefined;
  updatedAt?: string | undefined;
}

const DEFAULT_MOUNT = '/workspace';

/**
 * Fallback origin for a store whose marker is missing, malformed, or lacks a
 * hostWorkspace. Keys the project on the store name rather than letting every
 * container collapse into a project called "workspace".
 */
export function synthesizeOrigin(storeName: string): StoreOrigin {
  return {
    container: storeName,
    hostWorkspace: `/${storeName}`,
    workspaceMount: DEFAULT_MOUNT,
  };
}

/**
 * Translate a cwd recorded inside a container into its host equivalent.
 * Returns cwd unchanged when it falls outside the workspace mount.
 */
export function rewriteCwd(cwd: string, origin: StoreOrigin): string {
  const hostWorkspace = origin.hostWorkspace;
  if (hostWorkspace === undefined || hostWorkspace.length === 0) return cwd;
  const mount = origin.workspaceMount ?? DEFAULT_MOUNT;
  if (cwd === mount) return hostWorkspace;
  if (cwd.startsWith(`${mount}/`)) return hostWorkspace + cwd.slice(mount.length);
  return cwd;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a store's provenance marker. Never rejects: any unusable marker —
 * missing, malformed, or lacking hostWorkspace — resolves to a synthesised
 * origin keyed on the store directory name.
 */
export async function readStoreOrigin(
  storePath: string,
  storeName: string,
): Promise<StoreOrigin> {
  const fallback = synthesizeOrigin(storeName);
  const raw = await readFile(join(storePath, '.tracker-origin.json'), 'utf-8')
    .catch(() => null);
  if (raw === null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fallback;
  }

  const marker = parsed as Record<string, unknown>;
  const hostWorkspace = stringOrUndefined(marker['hostWorkspace']);
  if (hostWorkspace === undefined) {
    return {
      ...fallback,
      container: stringOrUndefined(marker['container']) ?? storeName,
      image: stringOrUndefined(marker['image']),
      host: stringOrUndefined(marker['host']),
      updatedAt: stringOrUndefined(marker['updatedAt']),
    };
  }

  return {
    container: stringOrUndefined(marker['container']) ?? storeName,
    image: stringOrUndefined(marker['image']),
    hostWorkspace,
    workspaceMount: stringOrUndefined(marker['workspaceMount']) ?? DEFAULT_MOUNT,
    host: stringOrUndefined(marker['host']),
    updatedAt: stringOrUndefined(marker['updatedAt']),
  };
}

/**
 * Return a copy of `session` with its container-local cwd translated to the
 * host path and its project key recomputed, so container sessions merge with
 * host sessions for the same folder.
 */
export function applyOrigin(session: Session, origin: StoreOrigin): Session {
  const cwd = rewriteCwd(session.cwd, origin);
  return {
    ...session,
    cwd,
    projectId: deriveProjectKey(cwd, session.sourceId, origin.container),
  };
}
