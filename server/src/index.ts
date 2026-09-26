import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { SessionRegistry } from './registry.js';
import { loadSources } from './sources.js';
import { TrackerDB } from './db.js';
import { buildApp } from './routes.js';
import { startAutoSummarizePoller } from './auto-summarize.js';
import { parseOptionalNumberEnv } from './env-config.js';
import { ExporterPki } from './exporter/pki.js';
import { ExporterListener } from './exporter/listener.js';
import type { ExporterRouteDeps } from './exporter-routes.js';

const sourcesConfigPath = process.env['SOURCES_CONFIG']
  ?? join(process.cwd(), 'config', 'sources.json');
const llmConfigPath = process.env['LLM_CONFIG']
  ?? join(process.cwd(), 'config', 'llm.json');
const dataDir = process.env['DATA_DIR']
  ?? join(process.env['HOME'] ?? '.', '.claude', 'tracker');
const port = Number(process.env['PORT'] ?? 3001);

const storeActiveDays = parseOptionalNumberEnv('STORE_ACTIVE_DAYS');
const storePollMs = parseOptionalNumberEnv('STORE_POLL_MS');
const archiveFlushMs = parseOptionalNumberEnv('ARCHIVE_FLUSH_MS');
const archiveRescan = process.env['ARCHIVE_RESCAN'] === '1';

const sources = await loadSources(
  sourcesConfigPath,
  process.env['CLAUDE_DIR'],
);

if (sources.length === 0) {
  console.warn(
    '[server] starting with zero sources — projects and sessions will be empty',
  );
}

const db = new TrackerDB(join(dataDir, 'tracker.db'), { flushMs: archiveFlushMs });
const registry = new SessionRegistry(
  sources, db,
  { activeDays: storeActiveDays, pollMs: storePollMs, rescan: archiveRescan },
);
await registry.start();
startAutoSummarizePoller(registry, db, llmConfigPath);

const exporterEnabled = process.env['EXPORTER_ENABLED'] === '1';
let exporterDeps: ExporterRouteDeps | undefined;

if (exporterEnabled) {
  const exporterCaDir = process.env['EXPORTER_CA_DIR']
    ?? join(dataDir, 'exporter-ca');
  const exporterPort = parseOptionalNumberEnv('EXPORTER_LISTEN_PORT') ?? 8444;
  const publicAddr = process.env['EXPORTER_PUBLIC_ADDR'];
  if (!publicAddr) {
    throw new Error('EXPORTER_PUBLIC_ADDR must be set when EXPORTER_ENABLED=1');
  }

  const pki = await ExporterPki.loadOrCreate(exporterCaDir);
  const listener = new ExporterListener({
    port: exporterPort, pki, enrollStore: db.enroll, registry, db,
  });
  await listener.start();
  exporterDeps = { enrollStore: db.enroll, pki, listener, publicAddr };
  console.log(`Exporter listener running on port ${exporterPort}`);
}

const app = buildApp(registry, db, llmConfigPath, exporterDeps);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Sources:`);
  for (const s of sources) {
    console.log(`  - ${s.id} (${s.name}): ${s.path}`);
  }
  console.log(`Database: ${join(dataDir, 'tracker.db')}`);
});
