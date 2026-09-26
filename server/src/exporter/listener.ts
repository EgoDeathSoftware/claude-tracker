import 'reflect-metadata';
import { createSecureServer } from 'node:http2';
import type { Http2SecureServer, ServerHttp2Stream, IncomingHttpHeaders } from 'node:http2';
import type { TLSSocket } from 'node:tls';
import type { ServerHttp2Session } from 'node:http2';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import type { ExporterPki } from './pki.js';
import type { EnrollStore } from './enroll-store.js';
import { FrameDecoder, encodeFrame, parseExporterMessage } from './protocol.js';
import type { RemoteWatcher } from '../remote-watcher.js';
import type { SessionRegistry } from '../registry.js';
import type { TrackerDB } from '../db.js';

export interface ExporterListenerOptions {
  port: number;
  pki: ExporterPki;
  enrollStore: EnrollStore;
  registry: SessionRegistry;
  db: TrackerDB;
  installDir?: string | undefined;
  binariesDir?: string | undefined;
}

const MAX_ENROLL_BODY_BYTES = 16 * 1024;

class BodyTooLargeError extends Error {}

/**
 * /enroll is reachable before any authentication (that's the whole point of
 * bootstrap enrollment), so its body must be bounded - an unauthenticated
 * caller must not be able to make the server buffer arbitrary amounts of
 * memory.
 */
function readBody(stream: ServerHttp2Stream, maxBytes = MAX_ENROLL_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    stream.on('data', (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        reject(new BodyTooLargeError('body exceeds maximum size'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

function sendJson(stream: ServerHttp2Stream, status: number, body: unknown): void {
  stream.respond({ ':status': status, 'content-type': 'application/json' });
  stream.end(JSON.stringify(body));
}

export class ExporterListener {
  private server: Http2SecureServer;
  private streams = new Map<string, ServerHttp2Stream>();
  // Chains each sourceId's addSource/removeSource calls so a reconnect's
  // addSource and the superseded connection's removeSource can never run
  // concurrently, honoring registry.addSource's documented "callers must
  // serialize add/remove per source id" contract.
  private registryQueues = new Map<string, Promise<unknown>>();
  // Every open TLS session, not just ones that reached a synced source - an
  // /enroll bootstrap connection or a rejected /sync attempt can otherwise
  // keep server.close()'s callback from ever firing, since Node only calls
  // it once every connection has fully ended on its own.
  private sessions = new Set<ServerHttp2Session>();

  constructor(private readonly opts: ExporterListenerOptions) {
    this.server = createSecureServer({
      key: opts.pki.serverKeyPem,
      // Leaf + CA, concatenated - not the leaf alone. A bootstrapping
      // exporter connecting to /enroll has nothing yet except the CA's
      // pinned SHA-256 fingerprint from the install command; it has no `ca`
      // option of its own to hand Node/Go's normal chain verification. Its
      // only way to establish trust is to inspect the certs the server
      // actually sends during the handshake, hash the CA one, and check it
      // against the pinned fingerprint - which requires the CA's bytes to be
      // part of what's sent. Sending the leaf alone would make fingerprint
      // pinning at /enroll structurally impossible: there would be no CA
      // cert in the handshake to fingerprint or to verify the leaf's
      // signature against. See docs/superpowers/plans/2026-09-26-remote-
      // exporter-server.md's "Cross-plan fix" section.
      cert: `${opts.pki.serverCertPem}\n${opts.pki.caCertPem}`,
      ca: opts.pki.caCertPem,
      // This is the SERVER's TLS config, not the client's: rejectUnauthorized
      // here governs whether *this server* accepts a *client* cert that's
      // missing or fails to chain to `ca`, not whether callers verify this
      // server's own identity (every exporter/test client in this plan
      // connects with rejectUnauthorized: true and a pinned `ca`). It must be
      // false because /enroll deliberately has no client cert yet - the
      // handshake has to succeed either way, and /sync enforces its own
      // requirement (plus the revocation check, which no TLS option can
      // express) explicitly in handleSync below.
      requestCert: true,
      rejectUnauthorized: false,
      allowHTTP1: false,
    });
    this.server.on('stream', (stream, headers) => this.handleStream(stream, headers));
    this.server.on('session', session => {
      this.sessions.add(session);
      session.on('close', () => this.sessions.delete(session));
    });
    this.server.on('error', err => console.error('[exporter-listener] server error:', err));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const stream of this.streams.values()) stream.close();
    for (const session of this.sessions) session.destroy();
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }

  /** Actively drops a connected exporter's stream, e.g. right after revoking it. */
  forceDisconnect(sourceId: string): void {
    this.streams.get(sourceId)?.destroy();
  }

  /** Runs `fn` after every previously enqueued call for this sourceId has settled. */
  private enqueue(sourceId: string, fn: () => Promise<void>): Promise<void> {
    const prior = this.registryQueues.get(sourceId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.registryQueues.set(sourceId, next.catch(() => undefined));
    return next;
  }

  private handleStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    const path = headers[':path'];
    if (path === '/enroll') { void this.handleEnroll(stream); return; }
    if (path === '/sync') { this.handleSync(stream); return; }
    if (path === '/exporter/install.sh') { void this.serveStatic(stream, 'install.sh', 'text/x-shellscript'); return; }
    if (path === '/exporter/install.ps1') { void this.serveStatic(stream, 'install.ps1', 'text/plain'); return; }
    if (typeof path === 'string' && path.startsWith('/exporter/binary/')) {
      void this.serveBinary(stream, path.slice('/exporter/binary/'.length));
      return;
    }
    stream.respond({ ':status': 404 });
    stream.end();
  }

  private async serveStatic(stream: ServerHttp2Stream, filename: string, contentType: string): Promise<void> {
    const dir = this.opts.installDir ?? join(process.cwd(), '..', 'exporter');
    try {
      const content = await readFile(join(dir, filename), 'utf-8');
      stream.respond({ ':status': 200, 'content-type': contentType });
      stream.end(content);
    } catch {
      stream.respond({ ':status': 404 });
      stream.end(`${filename} has not been built yet`);
    }
  }

  private async serveBinary(stream: ServerHttp2Stream, name: string): Promise<void> {
    const dir = this.opts.binariesDir ?? join(process.cwd(), 'exporter-binaries');
    // Reject path traversal outright rather than relying on readFile to fail safely.
    if (name.includes('..') || name.includes('/')) {
      stream.respond({ ':status': 400 });
      stream.end();
      return;
    }
    try {
      const content = await readFile(join(dir, name));
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      stream.end(content);
    } catch {
      stream.respond({ ':status': 404 });
      stream.end(`binary "${name}" has not been published yet`);
    }
  }

  /**
   * Every branch below is defensive: /enroll is reachable before any
   * authentication, so a malformed or hostile payload must produce an HTTP
   * response, never an uncaught throw - `signCsr`/x509 parsing throws
   * synchronously on garbage input, and this method previously had no
   * top-level catch, which turned that into an unhandled rejection capable
   * of taking down the whole process for every connected exporter, not just
   * the offending caller.
   */
  private async handleEnroll(stream: ServerHttp2Stream): Promise<void> {
    try {
      let body: string;
      try {
        body = await readBody(stream);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(stream, 413, { error: 'body too large' });
        } else {
          sendJson(stream, 400, { error: 'failed to read body' });
        }
        return;
      }

      let payload: { token?: unknown; csr?: unknown };
      try {
        payload = JSON.parse(body) as { token?: unknown; csr?: unknown };
      } catch {
        sendJson(stream, 400, { error: 'malformed JSON body' });
        return;
      }
      if (typeof payload.token !== 'string' || typeof payload.csr !== 'string') {
        sendJson(stream, 400, { error: 'token and csr are required' });
        return;
      }

      // Validate the CSR (parses, and verifies proof-of-possession of the
      // private key) before consuming the token, so a malformed or invalid
      // CSR never wastes a valid single-use token.
      let csr: x509.Pkcs10CertificateRequest;
      try {
        csr = new x509.Pkcs10CertificateRequest(payload.csr);
        if (!(await csr.verify())) throw new Error('CSR signature does not verify');
      } catch {
        sendJson(stream, 400, { error: 'invalid CSR' });
        return;
      }

      const consumed = this.opts.enrollStore.consumeToken(payload.token);
      if (!consumed) {
        sendJson(stream, 403, { error: 'invalid, expired, or already-used token' });
        return;
      }
      const signed = await this.opts.pki.signCsr(payload.csr, 365);
      this.opts.enrollStore.recordCert(signed.serial, consumed.sourceId, consumed.sourceName, signed.expiresAt);
      sendJson(stream, 200, {
        cert: signed.certPem,
        caCert: this.opts.pki.caCertPem,
        sourceId: consumed.sourceId,
      });
    } catch (err) {
      console.error('[exporter-listener] unexpected error handling /enroll:', err);
      if (!stream.destroyed) sendJson(stream, 500, { error: 'internal error' });
    }
  }

  private handleSync(stream: ServerHttp2Stream): void {
    const socket = stream.session?.socket as TLSSocket | undefined;
    if (!socket?.authorized) {
      sendJson(stream, 401, { error: 'client certificate required' });
      return;
    }
    const peerCert = socket.getPeerCertificate();
    const serial = peerCert.serialNumber?.toLowerCase();
    const record = serial ? this.opts.enrollStore.certRecordBySerial(serial) : null;
    if (!record) {
      sendJson(stream, 403, { error: 'certificate not recognized' });
      return;
    }
    if (this.opts.enrollStore.isRevoked(serial!)) {
      sendJson(stream, 403, { error: 'certificate revoked' });
      return;
    }

    const sourceId = record.sourceId;
    stream.respond({ ':status': 200 });
    // A reconnecting exporter's new stream supersedes any old one still on
    // record for this sourceId - destroy it now rather than leaving two
    // live streams for one source, so its eventual 'close' cleanup (which
    // may arrive well after this point, e.g. a network drop that only
    // resolves later) has something to no-op against instead of tearing
    // down the connection that just replaced it.
    this.streams.get(sourceId)?.destroy();
    this.streams.set(sourceId, stream);
    void this.attachSync(stream, sourceId, record.sourceName);
  }

  private async attachSync(
    stream: ServerHttp2Stream, sourceId: string, sourceName: string,
  ): Promise<void> {
    await this.enqueue(sourceId, () => this.opts.registry.addSource({
      id: sourceId, name: sourceName, path: `remote:${sourceId}`,
      kind: 'claude-code', layout: 'single', location: 'remote',
    }));
    const watcher = this.opts.registry.getRemoteWatcher(sourceId);
    if (!watcher) {
      console.error(`[exporter-listener] no RemoteWatcher registered for ${sourceId} right after addSource`);
      stream.destroy();
      return;
    }

    const decoder = new FrameDecoder();
    stream.setEncoding('utf-8');
    stream.on('data', (chunk: string) => {
      for (const raw of decoder.push(chunk)) {
        const msg = parseExporterMessage(raw);
        if (!msg) {
          console.warn(`[exporter-listener:${sourceId}] dropping malformed frame (${chunk.length} bytes)`);
          continue;
        }
        try {
          this.dispatch(sourceId, watcher, stream, msg);
        } catch (err) {
          // A frame that parses as valid NDJSON but carries a transcript
          // line the parser can't handle must not take down the listener
          // (or any other connected exporter) - log without the content,
          // which may be sensitive transcript data, and keep going.
          console.warn(`[exporter-listener:${sourceId}] failed to process ${msg.type} frame:`, err);
        }
      }
    });
    const cleanup = (): void => {
      // The stream that's closing may have already been superseded by a
      // newer connection for the same sourceId (handleSync destroys the
      // old stream on reconnect, but its 'close' event can still arrive
      // after the new one is already registered) - only tear down the
      // registration if this is still the stream on record for it.
      if (this.streams.get(sourceId) !== stream) return;
      this.streams.delete(sourceId);
      void this.enqueue(sourceId, () => this.opts.registry.removeSource(sourceId));
    };
    stream.on('close', cleanup);
    stream.on('error', err => {
      console.warn(`[exporter-listener:${sourceId}] stream error:`, err);
    });
  }

  private dispatch(
    sourceId: string,
    watcher: RemoteWatcher,
    stream: ServerHttp2Stream,
    msg: ReturnType<typeof parseExporterMessage> & object,
  ): void {
    switch (msg.type) {
      case 'FileList': {
        const needed = watcher.handleFileList(msg.files);
        for (const relPath of needed) {
          stream.write(encodeFrame({ type: 'RequestSnapshot', relPath }));
        }
        break;
      }
      case 'AppendLines':
        watcher.handleAppendLines(msg.relPath, msg.fromLine, msg.lines);
        break;
      case 'FileSnapshot':
        watcher.handleFileSnapshot(msg.relPath, msg.size, msg.mtimeUnixMs, msg.lines);
        break;
      case 'FileRemoved':
        watcher.handleFileRemoved(msg.relPath);
        break;
    }
  }
}
