import 'reflect-metadata';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { Crypto } from '@peculiar/webcrypto';

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const SIGNING_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

export interface SignedCert {
  certPem: string;
  serial: string;
  expiresAt: string;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const der = x509.PemConverter.decode(pem);
  const first = der[0];
  if (!first) throw new Error('empty PEM');
  return first;
}

/**
 * A private CA plus one server leaf cert, persisted under `caDir` and
 * generated once on first use. The exporter pins trust to `caFingerprintSha256`
 * (embedded in the install command) rather than any ambient trust store.
 */
export class ExporterPki {
  private constructor(
    private readonly caCert: x509.X509Certificate,
    private readonly caPrivateKey: CryptoKey,
    readonly caCertPem: string,
    readonly serverCertPem: string,
    readonly serverKeyPem: string,
  ) {}

  get caFingerprintSha256(): string {
    return createHash('sha256')
      .update(Buffer.from(this.caCert.rawData))
      .digest('hex');
  }

  static async loadOrCreate(caDir: string): Promise<ExporterPki> {
    await mkdir(caDir, { recursive: true });
    const caCertPath = join(caDir, 'ca-cert.pem');
    const caKeyPath = join(caDir, 'ca-key.pem');
    const serverCertPath = join(caDir, 'server-cert.pem');
    const serverKeyPath = join(caDir, 'server-key.pem');

    const existing = await Promise.all([
      readFile(caCertPath, 'utf-8').catch(() => null),
      readFile(caKeyPath, 'utf-8').catch(() => null),
      readFile(serverCertPath, 'utf-8').catch(() => null),
      readFile(serverKeyPath, 'utf-8').catch(() => null),
    ]);

    if (existing.every((v): v is string => v !== null)) {
      const [caCertPem, caKeyPem, serverCertPem, serverKeyPem] = existing as string[];
      const caPrivateKey = await crypto.subtle.importKey(
        'pkcs8', pemToArrayBuffer(caKeyPem!), ALG, false, ['sign'],
      );
      return new ExporterPki(
        new x509.X509Certificate(caCertPem!),
        caPrivateKey,
        caCertPem!, serverCertPem!, serverKeyPem!,
      );
    }

    const caKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const caCert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=Claude Tracker Exporter CA',
      notBefore: new Date(),
      notAfter: new Date(Date.now() + TEN_YEARS_MS),
      signingAlgorithm: SIGNING_ALG,
      keys: caKeys,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
      ],
    });
    const caKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', caKeys.privateKey);
    const caKeyPem = x509.PemConverter.encode(caKeyPkcs8, 'PRIVATE KEY');
    const caCertPem = caCert.toString('pem');

    const serverKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const serverCert = await x509.X509CertificateGenerator.create({
      serialNumber: '02',
      subject: 'CN=claude-tracker-exporter-listener',
      issuer: caCert.subject,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + TEN_YEARS_MS),
      signingAlgorithm: SIGNING_ALG,
      publicKey: serverKeys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true,
        ),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true), // serverAuth
        await x509.AuthorityKeyIdentifierExtension.create(caCert),
      ],
    });
    const serverKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', serverKeys.privateKey);
    const serverKeyPem = x509.PemConverter.encode(serverKeyPkcs8, 'PRIVATE KEY');
    const serverCertPem = serverCert.toString('pem');

    await writeFile(caCertPath, caCertPem, { mode: 0o644 });
    await writeFile(caKeyPath, caKeyPem, { mode: 0o600 });
    await writeFile(serverCertPath, serverCertPem, { mode: 0o644 });
    await writeFile(serverKeyPath, serverKeyPem, { mode: 0o600 });

    return new ExporterPki(
      caCert, caKeys.privateKey, caCertPem, serverCertPem, serverKeyPem,
    );
  }

  /**
   * Signs an exporter's CSR into a client-auth leaf certificate. Deliberately
   * ignores any extensions the CSR itself requested — a CA that copied
   * CSR-supplied extensions verbatim would let a client escalate its own
   * cert's capabilities.
   */
  async signCsr(csrPem: string, validityDays: number): Promise<SignedCert> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    // Only used as generator input, not stored - see the serial re-read below.
    const randomSerialSeed = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16)),
    ).toString('hex');
    const notAfter = new Date(Date.now() + validityDays * 86_400_000);

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerialSeed,
      subject: csr.subject,
      issuer: this.caCert.subject,
      notBefore: new Date(),
      notAfter,
      signingAlgorithm: SIGNING_ALG,
      publicKey: csr.publicKey,
      signingKey: this.caPrivateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'], true), // clientAuth
        await x509.AuthorityKeyIdentifierExtension.create(this.caCert),
      ],
    });

    return {
      certPem: cert.toString('pem'),
      // Read back from the generated cert rather than trusting
      // randomSerialSeed verbatim: X.509's ASN.1 INTEGER encoding strips a
      // leading zero byte (about 1-in-256 of our 16 random bytes), and
      // cert.serialNumber already reflects that normalized encoding - the
      // same one node:tls's getPeerCertificate().serialNumber will report
      // from a live connection. Storing the raw seed instead would make
      // EnrollStore.certRecordBySerial's lookup miss forever for any cert
      // whose random serial happened to start with 0x00.
      serial: cert.serialNumber.toLowerCase(),
      expiresAt: notAfter.toISOString(),
    };
  }
}
