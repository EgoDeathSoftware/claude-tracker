import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http2 from 'node:http2';
import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import { TrackerDB } from '../src/db.ts';
import { SessionRegistry } from '../src/registry.ts';
import { ExporterPki } from '../src/exporter/pki.ts';
import { ExporterListener } from '../src/exporter/listener.ts';
import { encodeFrame } from '../src/exporter/protocol.ts';
import type { Source } from '../src/sources.ts';

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);
const PORT = 48_445;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, 'fixtures', 'sources');

describe('remote exporter integration', () => {
  let caDir: string;
  let db: TrackerDB;
  let registry: SessionRegistry;
  let listener: ExporterListener;

  beforeEach(async () => {
    caDir = mkdtempSync(join(tmpdir(), 'exporter-integration-'));
    db = new TrackerDB(':memory:');
    // Mirrors multi-source.integration.test.ts's actual pattern: a plain
    // Source[] pointed at the committed fixture directory, not loadSources()
    // (that fixture has no sources.json - it's read directly by a source-
    // watcher, the same way the real multi-source integration test uses it).
    const hostSources: Source[] = [
      {
        id: 'wsl', name: 'WSL', path: join(FIXTURES, 'wsl'),
        kind: 'claude-code', layout: 'single', location: 'host',
      },
    ];
    registry = new SessionRegistry(hostSources, db);
    await registry.start();
    const pki = await ExporterPki.loadOrCreate(caDir);
    listener = new ExporterListener({ port: PORT, pki, enrollStore: db.enroll, registry, db });
    await listener.start();
  });

  afterEach(async () => {
    await listener.stop();
    await registry.stop();
    rmSync(caDir, { recursive: true, force: true });
  });

  it('merges a remote session into the same project as an existing host fixture, end to end', async () => {
    const hostProjects = registry.getProjects();
    const targetProject = hostProjects[0];
    expect(targetProject).toBeDefined();

    // Enroll.
    const token = db.enroll.issueToken('vps1', 'vps1', undefined, 15 * 60_000);
    const keys = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=vps1', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;
    const enrollClient = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const enrollReq = enrollClient.request({ ':path': '/enroll', ':method': 'POST' });
    enrollReq.end(JSON.stringify({ token, csr: csr.toString('pem') }));
    const enrollBody = await new Promise<string>(resolve => {
      let data = '';
      enrollReq.on('data', (c: Buffer) => { data += c.toString(); });
      enrollReq.on('end', () => resolve(data));
    });
    enrollClient.close();
    const { cert } = JSON.parse(enrollBody) as { cert: string };
    const keyPkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
    const keyPem = x509.PemConverter.encode(keyPkcs8, 'PRIVATE KEY');

    // Sync: send a FileList for a session whose cwd matches the host fixture's
    // project folder basename, then answer the resulting RequestSnapshot.
    const syncClient = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert, key: keyPem, rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    });
    const stream = syncClient.request({ ':path': '/sync', ':method': 'POST' });
    await new Promise<void>(resolve => stream.on('response', () => resolve()));

    const requestSnapshot = new Promise<{ relPath: string }>(resolve => {
      let buf = '';
      stream.on('data', (c: Buffer) => {
        buf += c.toString();
        const idx = buf.indexOf('\n');
        if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
      });
    });
    stream.write(encodeFrame({
      type: 'FileList',
      files: [{ relPath: `${targetProject!.name}/remotesess.jsonl`, size: 1, mtimeUnixMs: 1 }],
    }));
    const { relPath } = await requestSnapshot;

    const line = JSON.stringify({
      type: 'user', uuid: 'ru1', parentUuid: null, isSidechain: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: targetProject!.dirPath, sessionId: 'remotesess',
      message: { role: 'user', content: 'hi from the vps' },
    });
    stream.write(encodeFrame({ type: 'FileSnapshot', relPath, size: line.length, mtimeUnixMs: 2, lines: [line] }));

    await new Promise(resolve => setTimeout(resolve, 100));

    const mergedProjects = registry.getProjects();
    const merged = mergedProjects.find(p => p.id === targetProject!.id);
    expect(merged).toBeDefined();
    expect(merged!.sources).toContain('vps1');

    const remoteMeta = registry.getSessionMeta('remotesess');
    expect(remoteMeta?.sourceLocation).toBe('remote');
    expect(remoteMeta?.projectId).toBe(targetProject!.id);

    stream.close();
    syncClient.close();
  });
});
