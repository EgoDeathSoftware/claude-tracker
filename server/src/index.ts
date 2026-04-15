import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { SessionWatcher } from './watcher.js';
import { TrackerDB } from './db.js';
import { buildApp } from './routes.js';

const claudeDir = process.env['CLAUDE_DIR'] ?? `${process.env['HOME']}/.claude`;
const dataDir = process.env['DATA_DIR'] ?? join(claudeDir, 'tracker');
const port = Number(process.env['PORT'] ?? 3001);

const db = new TrackerDB(join(dataDir, 'tracker.db'));
const watcher = new SessionWatcher(claudeDir, db);
await watcher.start();

const app = buildApp(watcher, db);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Watching: ${claudeDir}/projects`);
  console.log(`Database: ${join(dataDir, 'tracker.db')}`);
});
