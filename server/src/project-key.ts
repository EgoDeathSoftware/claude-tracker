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
 * Strips a trailing git-branch suffix from a directory basename, recovering
 * the real repo name for a git-worktree checkout (e.g. dir
 * "myrepo-feature-x" + branch "feature-x" -> "myrepo"). Tries the full branch
 * name and, since branches can contain "/", its final path segment, each
 * matched case-insensitively against a "-", "_", or "." separator. Falls back
 * to `basename` unchanged when there's no match, or when the match would
 * consume the whole basename (a worktree dir named only after its branch
 * carries no recoverable repo name).
 */
export function stripBranchSuffix(basename: string, gitBranch?: string): string {
  if (!gitBranch) return basename;
  const tail = gitBranch.includes('/')
    ? gitBranch.slice(gitBranch.lastIndexOf('/') + 1)
    : gitBranch;
  const candidates = new Set([gitBranch, tail].filter(c => c.length > 0));
  const lowerBase = basename.toLowerCase();

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();
    for (const sep of ['-', '_', '.']) {
      const suffix = `${sep}${lowerCandidate}`;
      if (lowerBase.endsWith(suffix) && lowerBase.length > suffix.length) {
        return basename.slice(0, basename.length - suffix.length);
      }
    }
  }
  return basename;
}

/**
 * Project identity key. Same folder name → same project, regardless of source
 * or absolute path. Falls back to a source-scoped dir name so sessions without
 * a cwd never merge across sources. A worktree's cwd basename is reduced via
 * `stripBranchSuffix` first, so its sessions merge into the main repo's project.
 */
export function deriveProjectKey(
  cwd: string,
  sourceId: string,
  dirName: string,
  gitBranch?: string,
): string {
  const base = basenameOf(cwd);
  if (base.length > 0) return stripBranchSuffix(base, gitBranch).toLowerCase();
  return `${sourceId}:${dirName}`;
}

/**
 * Display name for a project, preserving the casing of the most recent cwd.
 */
export function displayNameFromCwd(cwd: string, gitBranch?: string): string {
  return stripBranchSuffix(basenameOf(cwd), gitBranch);
}
