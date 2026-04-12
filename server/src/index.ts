import { serve } from '@hono/node-server';
import { SessionWatcher } from './watcher.js';
import { buildApp } from './routes.js';

const claudeDir = process.env['CLAUDE_DIR'] ?? `${process.env['HOME']}/.claude`;
const port = Number(process.env['PORT'] ?? 3001);

const watcher = new SessionWatcher(claudeDir);
await watcher.start();

const app = buildApp(watcher);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Claude Tracker server running on http://localhost:${port}`);
  console.log(`Watching: ${claudeDir}/projects`);
});
