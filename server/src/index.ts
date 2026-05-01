import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { SessionRegistry } from './registry.js';
import { loadSources } from './sources.js';
import { TrackerDB } from './db.js';
import { buildApp } from './routes.js';

const sourcesConfigPath = process.env['SOURCES_CONFIG']
  ?? join(process.cwd(), 'config', 'sources.json');
const dataDir = process.env['DATA_DIR']
  ?? join(process.env['HOME'] ?? '.', '.claude', 'tracker');
const port = Number(process.env['PORT'] ?? 3001);

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
const registry = new SessionRegistry(sources, db);
await registry.start();

const app = buildApp(registry, db);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Sources:`);
  for (const s of sources) {
    console.log(`  - ${s.id} (${s.name}): ${s.path}`);
  }
  console.log(`Database: ${join(dataDir, 'tracker.db')}`);
});
