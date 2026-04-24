/**
 * Returns the last non-empty path segment, splitting on both / and \.
 * Works for WSL paths ("/mnt/c/foo") and Windows paths ("C:\\foo\\bar").
 * Drive-letter-only segments like "C:" are skipped.
 */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (!s) continue;
    if (s.endsWith(':')) continue;
    return s;
  }
  return '';
}

/**
 * Project identity key. Same folder name → same project, regardless of source
 * or absolute path. Falls back to a source-scoped dir name so sessions without
 * a cwd never merge across sources.
 */
export function deriveProjectKey(
  cwd: string,
  sourceId: string,
  dirName: string,
): string {
  const base = basenameOf(cwd);
  if (base.length > 0) return base.toLowerCase();
  return `${sourceId}:${dirName}`;
}

/**
 * Display name for a project, preserving the casing of the most recent cwd.
 */
export function displayNameFromCwd(cwd: string): string {
  return basenameOf(cwd);
}
