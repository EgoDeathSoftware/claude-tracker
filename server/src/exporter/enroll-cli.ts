import { join } from 'node:path';
import { TrackerDB } from '../db.js';
import { ExporterPki } from './pki.js';
import { isValidExporterName, remoteSourceId } from '../exporter-routes.js';

const TOKEN_TTL_MS = 15 * 60_000;

function parseArgs(argv: string[]): { name: string; dir?: string } {
  let name: string | undefined;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') name = argv[++i];
    else if (argv[i] === '--dir') dir = argv[++i];
  }
  if (!name) {
    throw new Error('usage: exporter:enroll --name <source-id> [--dir <remote-path>]');
  }
  if (!isValidExporterName(name)) {
    throw new Error('--name must match [a-zA-Z0-9_-]+');
  }
  return dir === undefined ? { name } : { name, dir };
}

async function main(): Promise<void> {
  const { name, dir } = parseArgs(process.argv.slice(2));
  const dataDir = process.env['DATA_DIR']
    ?? join(process.env['HOME'] ?? '.', '.claude', 'tracker');
  const caDir = process.env['EXPORTER_CA_DIR']
    ?? join(dataDir, 'exporter-ca');
  const publicAddr = process.env['EXPORTER_PUBLIC_ADDR'];
  if (!publicAddr) {
    throw new Error('EXPORTER_PUBLIC_ADDR must be set (e.g. tracker.example:8444)');
  }

  const db = new TrackerDB(join(dataDir, 'tracker.db'));
  const pki = await ExporterPki.loadOrCreate(caDir);
  const token = db.enroll.issueToken(remoteSourceId(name), name, dir, TOKEN_TTL_MS);
  db.close();

  console.log(`curl -fsSL https://${publicAddr}/exporter/install.sh \\`);
  console.log(`  | sh -s -- --token ${token} --server ${publicAddr} \\`);
  console.log(`  --ca-fingerprint ${pki.caFingerprintSha256}`);
  console.log('');
  console.log('Windows (PowerShell):');
  console.log(`irm https://${publicAddr}/exporter/install.ps1 | iex -Args `
    + `"-Token ${token} -Server ${publicAddr} -CaFingerprint ${pki.caFingerprintSha256}"`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
