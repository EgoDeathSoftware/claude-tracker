import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { SessionWatcher } from './watcher.ts';

export function buildApp(watcher: SessionWatcher): Hono {
  const app = new Hono();

  app.use('*', cors({ origin: 'http://localhost:5173' }));

  app.get('/api/projects', c => c.json(watcher.getProjects()));

  app.get('/api/sessions', c => {
    const projectId = c.req.query('projectId');
    return c.json(watcher.getSessions(projectId));
  });

  app.get('/api/sessions/:id', c => {
    const session = watcher.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'not found' }, 404);
    return c.json(session);
  });

  app.get('/api/events', c => {
    return streamSSE(c, async stream => {
      const onCreate = (session: unknown): void => {
        void stream.writeSSE({ event: 'session-created', data: JSON.stringify(session) });
      };
      const onUpdate = (session: unknown): void => {
        void stream.writeSSE({ event: 'session-updated', data: JSON.stringify(session) });
      };

      watcher.on('session-created', onCreate);
      watcher.on('session-updated', onUpdate);

      const interval = setInterval(() => {
        void stream.writeSSE({ data: 'ping' });
      }, 15_000);

      stream.onAbort(() => {
        clearInterval(interval);
        watcher.off('session-created', onCreate);
        watcher.off('session-updated', onUpdate);
      });

      // Hold the connection open until aborted
      await new Promise<void>(resolve => {
        stream.onAbort(() => resolve());
      });
    });
  });

  return app;
}
