import type Database from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';

export interface ConsumedToken {
  sourceId: string;
  sourceName: string;
  dirOverride: string | undefined;
}

export interface ExporterCertRecord {
  serial: string;
  sourceId: string;
  sourceName: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface EnrollStoreOptions {
  now?: (() => number) | undefined;
}

interface ConsumeRow {
  sourceId: string;
  sourceName: string;
  dirOverride: string | null;
}

interface CertRow {
  serial: string;
  source_id: string;
  source_name: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function rowToCert(row: CertRow): ExporterCertRecord {
  return {
    serial: row.serial,
    sourceId: row.source_id,
    sourceName: row.source_name,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class EnrollStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    options?: EnrollStoreOptions,
  ) {
    this.now = options?.now ?? (() => Date.now());
  }

  /** Returns the raw token. Only its SHA-256 hash is ever stored. */
  issueToken(
    sourceId: string,
    sourceName: string,
    dirOverride: string | undefined,
    ttlMs: number,
  ): string {
    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(this.now() + ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO exporter_tokens (token_hash, source_id, source_name, dir_override, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenHash, sourceId, sourceName, dirOverride ?? null, expiresAt);
    return raw;
  }

  /**
   * Atomically marks a token used and returns what it was issued for, or
   * null if it's unknown, already used, or past its expiry. The UPDATE's
   * WHERE clause and RETURNING together make this safe against two enroll
   * attempts racing on the same token: at most one can match the row while
   * `used_at IS NULL` still holds.
   */
  consumeToken(rawToken: string): ConsumedToken | null {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const nowIso = new Date(this.now()).toISOString();
    const row = this.db.prepare(`
      UPDATE exporter_tokens
      SET used_at = ?
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING source_id AS sourceId, source_name AS sourceName, dir_override AS dirOverride
    `).get(nowIso, tokenHash, nowIso) as ConsumeRow | undefined;
    if (!row) return null;
    return {
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      dirOverride: row.dirOverride ?? undefined,
    };
  }

  recordCert(
    serial: string, sourceId: string, sourceName: string, expiresAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO exporter_certs (serial, source_id, source_name, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(serial, sourceId, sourceName, expiresAt);
  }

  certRecordBySerial(serial: string): ExporterCertRecord | null {
    const row = this.db
      .prepare('SELECT * FROM exporter_certs WHERE serial = ?')
      .get(serial) as CertRow | undefined;
    return row ? rowToCert(row) : null;
  }

  isRevoked(serial: string): boolean {
    const row = this.db
      .prepare('SELECT revoked_at FROM exporter_certs WHERE serial = ?')
      .get(serial) as { revoked_at: string | null } | undefined;
    return row?.revoked_at !== null && row?.revoked_at !== undefined;
  }

  revokeBySourceId(sourceId: string): void {
    this.db.prepare(`
      UPDATE exporter_certs SET revoked_at = ?
      WHERE source_id = ? AND revoked_at IS NULL
    `).run(new Date(this.now()).toISOString(), sourceId);
  }

  listCerts(): ExporterCertRecord[] {
    return (
      this.db.prepare('SELECT * FROM exporter_certs ORDER BY issued_at DESC').all() as CertRow[]
    ).map(rowToCert);
  }
}
