import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http2 from 'node:http2';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import { ExporterListener } from '../../src/exporter/listener.ts';
import { ExporterPki } from '../../src/exporter/pki.ts';
import { EnrollStore } from '../../src/exporter/enroll-store.ts';
import { SessionRegistry } from '../../src/registry.ts';
import { TrackerDB } from '../../src/db.ts';
import { encodeFrame } from '../../src/exporter/protocol.ts';

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

const PORT = 48_444;

async function makeClientKeyAndCsr(): Promise<{ keys: CryptoKeyPair; csrPem: string }> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=test-exporter', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  return { keys, csrPem: csr.toString('pem') };
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(pkcs8, 'PRIVATE KEY');
}

describe('ExporterListener', () => {
  let caDir: string;
  let listener: ExporterListener;
  let db: TrackerDB;
  let enrollStore: EnrollStore;
  let registry: SessionRegistry;

  beforeEach(async () => {
    caDir = mkdtempSync(join(tmpdir(), 'exporter-listener-'));
    db = new TrackerDB(':memory:');
    enrollStore = db.enroll;
    registry = new SessionRegistry([], db);
    await registry.start();
    const pki = await ExporterPki.loadOrCreate(caDir);
    listener = new ExporterListener({ port: PORT, pki, enrollStore, registry, db });
    await listener.start();
  });

  afterEach(async () => {
    await listener.stop();
    await registry.stop();
    rmSync(caDir, { recursive: true, force: true });
  });

  async function enroll(): Promise<{ certPem: string; keyPem: string; caCertPem: string }> {
    const token = enrollStore.issueToken('vps1', 'My VPS', undefined, 15 * 60_000);
    const { keys, csrPem } = await makeClientKeyAndCsr();
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;

    const client = http2.connect(`https://localhost:${PORT}`, { ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined });
    const req = client.request({ ':path': '/enroll', ':method': 'POST' });
    req.end(JSON.stringify({ token, csr: csrPem }));
    const body = await new Promise<string>(resolve => {
      let data = '';
      req.on('data', (c: Buffer) => { data += c.toString(); });
      req.on('end', () => resolve(data));
    });
    client.close();
    const parsed = JSON.parse(body) as { cert: string; caCert: string; sourceId: string };
    return { certPem: parsed.cert, keyPem: await exportPrivateKeyPem(keys.privateKey), caCertPem: parsed.caCert };
  }

  it('enrolls a valid token into a signed client certificate', async () => {
    const { certPem } = await enroll();
    expect(certPem).toContain('BEGIN CERTIFICATE');
  });

  it('presents both its leaf and the CA cert during the handshake, not the leaf alone', async () => {
    // A real exporter connecting to /enroll has nothing yet but the CA's
    // pinned SHA-256 fingerprint from the install command - no `ca` option
    // of its own for Node/Go's normal chain verification to use. It can only
    // establish trust by hashing whatever cert the server actually sent and
    // checking that against the pin, so the CA cert itself must be part of
    // the handshake, not just known to this test client out of band. This
    // test deliberately does NOT pass `ca` to the connecting client, and
    // inspects the raw peer certificate chain instead, so it fails the same
    // way an unmodified Go exporter's bootstrap connection would if the
    // server ever regressed to sending the leaf alone.
    const client = http2.connect(`https://localhost:${PORT}`, {
      rejectUnauthorized: false, // this test verifies the chain manually below
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    const socket = (client as unknown as { socket: import('node:tls').TLSSocket }).socket;
    const peerCert = socket.getPeerCertificate(true);
    expect(peerCert.issuerCertificate).toBeDefined();
    expect(peerCert.issuerCertificate.fingerprint256).not.toBe(peerCert.fingerprint256);
    client.close();
  });

  it('rejects an invalid token', async () => {
    const { keys, csrPem } = await makeClientKeyAndCsr();
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;
    const client = http2.connect(`https://localhost:${PORT}`, { ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined });
    const req = client.request({ ':path': '/enroll', ':method': 'POST' });
    req.end(JSON.stringify({ token: 'bogus', csr: csrPem }));
    const status = await new Promise<number>(resolve => {
      req.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(403);
    client.close();
    void keys;
  });

  it('rejects a malformed CSR without crashing, and does not burn the token', async () => {
    const token = enrollStore.issueToken('vps1', 'vps1', undefined, 15 * 60_000);
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;
    const client = http2.connect(`https://localhost:${PORT}`, { ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined });

    const req = client.request({ ':path': '/enroll', ':method': 'POST' });
    req.end(JSON.stringify({ token, csr: 'not a real csr' }));
    const status = await new Promise<number>(resolve => {
      req.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(400);

    // The token must still be usable on the same connection - a bad CSR
    // shouldn't waste a valid token, and the connection/session must still
    // be alive after handling a malformed request (proving it didn't crash
    // the listener).
    const { csrPem } = await makeClientKeyAndCsr();
    const retryReq = client.request({ ':path': '/enroll', ':method': 'POST' });
    retryReq.end(JSON.stringify({ token, csr: csrPem }));
    const retryStatus = await new Promise<number>(resolve => {
      retryReq.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(retryStatus).toBe(200);
    client.close();
  });

  it('rejects an oversized /enroll body', async () => {
    const token = enrollStore.issueToken('vps1', 'vps1', undefined, 15 * 60_000);
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;
    const client = http2.connect(`https://localhost:${PORT}`, { ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined });
    const req = client.request({ ':path': '/enroll', ':method': 'POST' });
    const huge = 'x'.repeat(1024 * 1024); // 1MB, well past any reasonable CSR+token size
    req.end(JSON.stringify({ token, csr: huge }));
    const status = await new Promise<number>(resolve => {
      req.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(413);
    client.close();
  });

  it('accepts a /sync connection presenting the enrolled cert and feeds FileList into the RemoteWatcher', async () => {
    const { certPem, keyPem, caCertPem } = await enroll();
    const client = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert: certPem, key: keyPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const stream = client.request({ ':path': '/sync', ':method': 'POST' });

    const status = await new Promise<number>(resolve => {
      stream.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(200);

    const requestSnapshot = new Promise<unknown>(resolve => {
      let buf = '';
      stream.on('data', (c: Buffer) => {
        buf += c.toString();
        const idx = buf.indexOf('\n');
        if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
      });
    });
    stream.write(encodeFrame({
      type: 'FileList',
      files: [{ relPath: 'demo/sess1.jsonl', size: 10, mtimeUnixMs: 1 }],
    }));
    expect(await requestSnapshot).toEqual({ type: 'RequestSnapshot', relPath: 'demo/sess1.jsonl' });

    expect(registry.getRemoteWatcher('vps1')).toBeDefined();
    stream.close();
    client.close();
  });

  it('rejects a /sync connection with a revoked certificate', async () => {
    const { certPem, keyPem, caCertPem } = await enroll();
    enrollStore.revokeBySourceId('vps1');
    const client = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert: certPem, key: keyPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const stream = client.request({ ':path': '/sync', ':method': 'POST' });
    const status = await new Promise<number>(resolve => {
      stream.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(403);
    client.close();
  });

  it('rejects a /sync connection presenting no client certificate', async () => {
    const caCertPem = (await ExporterPki.loadOrCreate(caDir)).caCertPem;
    const client = http2.connect(`https://localhost:${PORT}`, { ca: caCertPem, rejectUnauthorized: true, checkServerIdentity: () => undefined });
    const stream = client.request({ ':path': '/sync', ':method': 'POST' });
    const status = await new Promise<number>(resolve => {
      stream.on('response', headers => resolve(headers[':status'] as number));
    });
    expect(status).toBe(401);
    client.close();
  });

  it('calls registry.removeSource when a synced connection closes', async () => {
    const { certPem, keyPem, caCertPem } = await enroll();
    const client = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert: certPem, key: keyPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const stream = client.request({ ':path': '/sync', ':method': 'POST' });
    await new Promise<void>(resolve => stream.on('response', () => resolve()));
    stream.close();
    client.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(registry.getSources().find(s => s.id === 'vps1')).toBeUndefined();
  });

  it('a reconnecting exporter does not have its new connection torn down by the old one closing', async () => {
    const { certPem, keyPem, caCertPem } = await enroll();
    const clientA = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert: certPem, key: keyPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const streamA = clientA.request({ ':path': '/sync', ':method': 'POST' });
    await new Promise<void>(resolve => streamA.on('response', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 20)); // let A's addSource land

    // B reconnects for the same source before A's connection has been torn down.
    const clientB = http2.connect(`https://localhost:${PORT}`, {
      ca: caCertPem, cert: certPem, key: keyPem, rejectUnauthorized: true, checkServerIdentity: () => undefined,
    });
    const streamB = clientB.request({ ':path': '/sync', ':method': 'POST' });
    await new Promise<void>(resolve => streamB.on('response', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 100));

    // A's close (arriving late, as if from a network drop that only just resolved) must not
    // tear down B's now-current registration.
    clientA.destroy();
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(registry.getSources().find(s => s.id === 'vps1')).toBeDefined();
    expect(registry.getRemoteWatcher('vps1')).toBeDefined();

    streamB.write(encodeFrame({
      type: 'FileList',
      files: [{ relPath: 'demo/sess1.jsonl', size: 10, mtimeUnixMs: 1 }],
    }));
    const requestSnapshot = new Promise<unknown>(resolve => {
      let buf = '';
      streamB.on('data', (c: Buffer) => {
        buf += c.toString();
        const idx = buf.indexOf('\n');
        if (idx !== -1) resolve(JSON.parse(buf.slice(0, idx)));
      });
    });
    expect(await requestSnapshot).toEqual({ type: 'RequestSnapshot', relPath: 'demo/sess1.jsonl' });

    streamB.close();
    clientB.close();
  });
});
