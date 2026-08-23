import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { SessionRegistry } from './registry.js';
import { loadSources } from './sources.js';
import { TrackerDB } from './db.js';
import { buildApp } from './routes.js';
import { startAutoSummarizePoller } from './auto-summarize.js';

const sourcesConfigPath = process.env['SOURCES_CONFIG']
  ?? join(process.cwd(), 'config', 'sources.json');
const llmConfigPath = process.env['LLM_CONFIG']
  ?? join(process.cwd(), 'config', 'llm.json');
const dataDir = process.env['DATA_DIR']
  ?? join(process.env['HOME'] ?? '.', '.claude', 'tracker');
const port = Number(process.env['PORT'] ?? 3001);

/** Parses an optional numeric env var, warning and falling back on a malformed value. */
function parseOptionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[server] ignoring invalid ${name} "${raw}"; using the default`);
    return undefined;
  }
  return parsed;
}

const storeActiveDays = parseOptionalNumberEnv('STORE_ACTIVE_DAYS');
const storePollMs = parseOptionalNumberEnv('STORE_POLL_MS');

const sources = await loadSources(
  sourcesConfigPath,
  process.env['CLAUDE_DIR'],
);

if (sources.length === 0) {
  console.warn(
    '[server] starting with zero sources — projects and sessions will be empty',
  );
}

const db = new TrackerDB(join(dataDir, 'tracker.db'));
const registry = new SessionRegistry(
  sources, db, { activeDays: storeActiveDays, pollMs: storePollMs },
);
await registry.start();
startAutoSummarizePoller(registry, db, llmConfigPath);

const app = buildApp(registry, db, llmConfigPath);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Sources:`);
  for (const s of sources) {
    console.log(`  - ${s.id} (${s.name}): ${s.path}`);
  }
  console.log(`Database: ${join(dataDir, 'tracker.db')}`);
});
