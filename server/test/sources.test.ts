import { describe, it, expect, afterEach, vi } from 'vitest';
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
      { id: 'wsl', name: 'WSL', path: src1, kind: 'claude-code' },
      { id: 'windows', name: 'Windows', path: src2, kind: 'claude-code' },
    ]);
  });

  it('falls back to env CLAUDE_DIR when config is missing', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const missing = join(dir, 'nope.json');
    const out = await loadSources(missing, '/tmp/fake-claude');
    expect(out).toEqual([
      { id: 'default', name: 'Default', path: '/tmp/fake-claude', kind: 'claude-code' },
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await loadSources(cfg, undefined);
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe('ok');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('gone'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('/definitely/not/here'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('loads a source with kind "opencode" and configPath', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const src = join(dir, 'oc');
    const cfgDir = join(dir, 'oc-config');
    await mkdir(src);
    await mkdir(cfgDir);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [
          {
            id: 'oc',
            name: 'OpenCode',
            kind: 'opencode',
            path: src,
            configPath: cfgDir,
          },
        ],
      }),
    );
    const out = await loadSources(cfg, undefined);
    expect(out).toEqual([
      { id: 'oc', name: 'OpenCode', path: src, kind: 'opencode', configPath: cfgDir },
    ]);
  });

  it('throws on invalid kind', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const a = join(dir, 'a');
    await mkdir(a);
    const cfg = join(dir, 'sources.json');
    await writeFile(
      cfg,
      JSON.stringify({
        sources: [{ id: 'x', name: 'A', kind: 'bogus', path: a }],
      }),
    );
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/invalid kind/);
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

  it('throws when the config root is null', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'sources.json');
    await writeFile(cfg, 'null');
    await expect(loadSources(cfg, undefined))
      .rejects.toThrow(/config root must be an object/);
  });
});
