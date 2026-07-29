import type { SessionRegistry } from './registry.ts';
import type { TrackerDB } from './db.ts';
import type { SessionStatus } from './types.ts';
import { readLlmConfig } from './llm-config.js';
import { generateSummary } from './llm.js';

const POLL_INTERVAL_MS = 20_000;

/**
 * Polls session statuses and auto-generates a summary the first time a
 * session transitions away from "live", when enabled in llm.json. Status
 * changes aren't pushed as events (they're derived from file mtime), so
 * this has to poll rather than react to registry events.
 */
export function startAutoSummarizePoller(
  registry: SessionRegistry,
  db: TrackerDB,
  llmConfigPath: string,
): () => void {
  const lastStatus = new Map<string, SessionStatus>();

  const tick = async (): Promise<void> => {
    const config = await readLlmConfig(llmConfigPath);
    const sessions = registry.getSessions();
    const seen = new Set<string>();

    for (const session of sessions) {
      seen.add(session.id);
      const prev = lastStatus.get(session.id);
      lastStatus.set(session.id, session.status);

      const wentIdle = prev === 'live' && session.status !== 'live';
      if (!wentIdle || !config.autoSummarize) continue;
      if (db.hasSessionSummary(session.id)) continue;

      try {
        const summary = await generateSummary(session, config);
        db.saveSessionSummary(session.id, summary);
        console.log(`[auto-summarize] generated summary for ${session.id}`);
      } catch (err) {
        console.warn(
          `[auto-summarize] failed for ${session.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Drop tracked statuses for sessions no longer present.
    for (const id of lastStatus.keys()) {
      if (!seen.has(id)) lastStatus.delete(id);
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  return () => clearInterval(interval);
}
