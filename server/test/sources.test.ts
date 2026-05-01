import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSources } from '../src/sources.js';

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sources-test-'));
}

describe('loadSources', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('loads a valid config with multiple sources', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const src1 = join(dir, 'one');
    const src2 = join(dir, 'two');
    await mkdir(src1);
    await mkdir(src2);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'wsl', name: 'WSL', path: src1 },
          { id: 'windows', name: 'Windows', path: src2 },
        ],
      }),
    );
    const out = await loadSources(cfg, undefined);
    expect(out).toEqual([
      { id: 'wsl', name: 'WSL', path: src1 },
      { id: 'windows', name: 'Windows', path: src2 },
    ]);
  });

  it('falls back to env CLAUDE_DIR when config is missing', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const missing = join(dir, 'nope.json');
    const out = await loadSources(missing, '/tmp/fake-claude');
    expect(out).toEqual([
      { id: 'default', name: 'Default', path: '/tmp/fake-claude' },
    ]);
  });

  it('skips unreachable source paths with a warning', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const ok = join(dir, 'ok');
    await mkdir(ok);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'ok', name: 'OK', path: ok },
          { id: 'gone', name: 'Gone', path: '/definitely/not/here' },
        ],
      }),
    );
    const out = await loadSources(cfg, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('ok');
  });

  it('throws on duplicate ids', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const a = join(dir, 'a');
    await mkdir(a);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          { id: 'x', name: 'A', path: a },
          { id: 'x', name: 'B', path: a },
        ],
      }),
    );
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/duplicate source id: x/);
  });

  it('throws on invalid id characters', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const a = join(dir, 'a');
    await mkdir(a);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [{ id: 'Bad Id!', name: 'A', path: a }],
      }),
    );
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/invalid id/);
  });

  it('throws on malformed JSON', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, '{ not json');
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/malformed JSON/);
  });

  it('throws when sources is not an array', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, JSON.stringify({ sources: 'nope' }));
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/expected "sources" array/);
  });
});
