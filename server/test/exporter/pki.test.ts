import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';
import { ExporterPki } from '../../src/exporter/pki.ts';

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

let caDir: string;

beforeEach(() => {
  caDir = mkdtempSync(join(tmpdir(), 'exporter-ca-'));
});

afterEach(() => {
  rmSync(caDir, { recursive: true, force: true });
});

async function makeCsrPem(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=test-exporter',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  });
  return csr.toString('pem');
}

describe('ExporterPki.loadOrCreate', () => {
  it('creates a CA on first use', async () => {
    const pki = await ExporterPki.loadOrCreate(caDir);
    expect(pki.caCertPem).toContain('BEGIN CERTIFICATE');
    expect(existsSync(join(caDir, 'ca-cert.pem'))).toBe(true);
    expect(existsSync(join(caDir, 'ca-key.pem'))).toBe(true);
  });

  it('loads the same CA on a second call instead of regenerating', async () => {
    const first = await ExporterPki.loadOrCreate(caDir);
    const second = await ExporterPki.loadOrCreate(caDir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.caFingerprintSha256).toBe(first.caFingerprintSha256);
  });

  it('issues a server leaf cert signed by the CA', async () => {
    const pki = await ExporterPki.loadOrCreate(caDir);
    const serverCert = new x509.X509Certificate(pki.serverCertPem);
    const caCert = new x509.X509Certificate(pki.caCertPem);
    expect(await serverCert.verify({ publicKey: caCert.publicKey })).toBe(true);
  });
});

describe('ExporterPki#signCsr', () => {
  it('signs a CSR into a cert that chains to the CA', async () => {
    const pki = await ExporterPki.loadOrCreate(caDir);
    const csrPem = await makeCsrPem();
    const signed = await pki.signCsr(csrPem, 365);
    const leaf = new x509.X509Certificate(signed.certPem);
    const caCert = new x509.X509Certificate(pki.caCertPem);
    expect(await leaf.verify({ publicKey: caCert.publicKey })).toBe(true);
    expect(signed.serial).toMatch(/^[0-9a-f]+$/i);
  });

  it('issues distinct serial numbers for successive CSRs', async () => {
    const pki = await ExporterPki.loadOrCreate(caDir);
    const a = await pki.signCsr(await makeCsrPem(), 365);
    const b = await pki.signCsr(await makeCsrPem(), 365);
    expect(a.serial).not.toBe(b.serial);
  });

  it('records the serial in the same format node:tls will report from a live connection, even when the random serial has a leading zero byte', async () => {
    // A raw 16-byte random hex serial has a 1/256 chance per byte of a
    // leading 0x00 byte. X.509's ASN.1 INTEGER encoding (and therefore what
    // node:crypto's X509Certificate - the same OpenSSL binding
    // TLSSocket.getPeerCertificate() uses - reports back) strips that
    // leading zero byte, so a serial recorded verbatim from the pre-cert
    // random bytes silently drifts from what a live /sync connection will
    // ever present, and EnrollStore.certRecordBySerial's lookup misses
    // forever. Loop until we hit that case (~1/256 per try) instead of
    // relying on a fixed input, since the random bytes aren't exposed for
    // injection.
    const pki = await ExporterPki.loadOrCreate(caDir);
    const csrPem = await makeCsrPem();
    const { X509Certificate: NodeX509Certificate } = await import('node:crypto');
    let sawLeadingZeroCase = false;
    for (let i = 0; i < 2000; i++) {
      const signed = await pki.signCsr(csrPem, 365);
      const nodeReportedSerial = new NodeX509Certificate(signed.certPem).serialNumber
        .replace(/:/g, '')
        .toLowerCase();
      expect(signed.serial).toBe(nodeReportedSerial);
      if (nodeReportedSerial.length < 32) sawLeadingZeroCase = true;
    }
    expect(sawLeadingZeroCase).toBe(true);
  });
});
