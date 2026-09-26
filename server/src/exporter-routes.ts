import type { Hono } from 'hono';
import type { EnrollStore } from './exporter/enroll-store.js';
import type { ExporterPki } from './exporter/pki.js';
import type { ExporterListener } from './exporter/listener.js';

const TOKEN_TTL_MS = 15 * 60_000;

export interface ExporterRouteDeps {
  enrollStore: EnrollStore;
  pki: ExporterPki;
  listener: ExporterListener;
  publicAddr: string;
}

export function registerExporterRoutes(app: Hono, deps: ExporterRouteDeps): void {
  app.get('/api/exporters', c => c.json(deps.enrollStore.listCerts()));

  app.post('/api/exporters/enroll', async c => {
    const body = await c.req.json<{ name?: string; dir?: string }>();
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name required' }, 400);

    const token = deps.enrollStore.issueToken(name, name, body.dir, TOKEN_TTL_MS);
    const fp = deps.pki.caFingerprintSha256;
    const installCommand
      = `curl -fsSL https://${deps.publicAddr}/exporter/install.sh \\\n`
      + `  | sh -s -- --token ${token} --server ${deps.publicAddr} --ca-fingerprint ${fp}`;
    const installCommandPowershell
      = `irm https://${deps.publicAddr}/exporter/install.ps1 | iex -Args `
      + `"-Token ${token} -Server ${deps.publicAddr} -CaFingerprint ${fp}"`;

    return c.json({ installCommand, installCommandPowershell }, 201);
  });

  app.delete('/api/exporters/:sourceId', c => {
    const sourceId = c.req.param('sourceId');
    deps.enrollStore.revokeBySourceId(sourceId);
    deps.listener.forceDisconnect(sourceId);
    return c.json({ revoked: sourceId });
  });
}
