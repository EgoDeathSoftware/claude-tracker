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
