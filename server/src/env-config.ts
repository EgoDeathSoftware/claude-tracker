/**
 * Parses an optional numeric env var. Absent or empty-string returns
 * undefined silently (both mean "not set"); a present-but-non-numeric value
 * warns and also returns undefined, so a caller's default takes over instead
 * of a malformed override silently doing nothing (e.g. `Number('')` is `0`,
 * not `NaN`, so the empty-string case must be checked explicitly).
 */
export function parseOptionalNumberEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[server] ignoring invalid ${name} "${raw}"; using the default`);
    return undefined;
  }
  return parsed;
}
