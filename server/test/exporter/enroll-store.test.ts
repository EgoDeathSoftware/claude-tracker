import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EnrollStore } from '../../src/exporter/enroll-store.ts';

let db: Database.Database;
let now: number;
let store: EnrollStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE exporter_tokens (
      token_hash TEXT PRIMARY KEY, source_id TEXT NOT NULL,
      source_name TEXT NOT NULL, dir_override TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE exporter_certs (
      serial TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL, revoked_at TEXT
    );
  `);
  now = Date.parse('2026-01-01T00:00:00.000Z');
  store = new EnrollStore(db, { now: () => now });
});

describe('token lifecycle', () => {
  it('a freshly issued token consumes successfully once', () => {
    const token = store.issueToken('vps1', 'vps1', undefined, 15 * 60_000);
    const consumed = store.consumeToken(token);
    expect(consumed).toEqual({ sourceId: 'vps1', sourceName: 'vps1', dirOverride: undefined });
  });

  it('rejects a second consume of the same token', () => {
    const token = store.issueToken('vps1', 'vps1', undefined, 15 * 60_000);
    store.consumeToken(token);
    expect(store.consumeToken(token)).toBeNull();
  });

  it('rejects a token after its TTL has elapsed', () => {
    const token = store.issueToken('vps1', 'vps1', undefined, 60_000);
    now += 61_000;
    expect(store.consumeToken(token)).toBeNull();
  });

  it('rejects a token that was never issued', () => {
    expect(store.consumeToken('not-a-real-token')).toBeNull();
  });

  it('carries a directory override through', () => {
    const token = store.issueToken('vps1', 'vps1', '/opt/claude', 15 * 60_000);
    expect(store.consumeToken(token)?.dirOverride).toBe('/opt/claude');
  });
});

describe('certificate revocation', () => {
  it('a recorded cert is not revoked until explicitly revoked', () => {
    store.recordCert('aa', 'vps1', 'vps1', '2027-01-01T00:00:00.000Z');
    expect(store.isRevoked('aa')).toBe(false);
  });

  it('revokeBySourceId revokes every cert for that source', () => {
    store.recordCert('aa', 'vps1', 'vps1', '2027-01-01T00:00:00.000Z');
    store.recordCert('bb', 'vps1', 'vps1', '2027-01-01T00:00:00.000Z');
    store.revokeBySourceId('vps1');
    expect(store.isRevoked('aa')).toBe(true);
    expect(store.isRevoked('bb')).toBe(true);
  });

  it('an unknown serial is not treated as revoked', () => {
    expect(store.isRevoked('never-issued')).toBe(false);
  });

  it('certRecordBySerial resolves sourceId/sourceName for a live sync connection', () => {
    store.recordCert('aa', 'vps1', 'My VPS', '2027-01-01T00:00:00.000Z');
    expect(store.certRecordBySerial('aa')).toMatchObject({
      sourceId: 'vps1', sourceName: 'My VPS', revokedAt: null,
    });
  });

  it('listCerts returns every issued cert', () => {
    store.recordCert('aa', 'vps1', 'vps1', '2027-01-01T00:00:00.000Z');
    store.recordCert('bb', 'vps2', 'vps2', '2027-01-01T00:00:00.000Z');
    expect(store.listCerts().map(c => c.serial).sort()).toEqual(['aa', 'bb']);
  });
});
