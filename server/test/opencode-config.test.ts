import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOpenCodeConfig, listOpenCodeAgents } from '../src/opencode-config.js';

describe('opencode-config', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  describe('readOpenCodeConfig', () => {
    it('parses a valid opencode.json', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);
      await writeFile(
        join(dir, 'opencode.json'),
        JSON.stringify({ model: 'llama-swap/qwen3.8-27b', provider: { llama_swap: {} } }),
      );

      const config = await readOpenCodeConfig(dir);
      expect(config['model']).toBe('llama-swap/qwen3.8-27b');
      expect(config['provider']).toEqual({ llama_swap: {} });
    });

    it('tolerates JSONC line and block comments', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);
      await writeFile(
        join(dir, 'opencode.json'),
        [
          '{',
          '  // this is the active model',
          '  "model": "llama-swap/qwen3.8-27b",',
          '  /* block comment',
          '     spanning lines */',
          '  "agent": "implementer"',
          '}',
        ].join('\n'),
      );

      const config = await readOpenCodeConfig(dir);
      expect(config['model']).toBe('llama-swap/qwen3.8-27b');
      expect(config['agent']).toBe('implementer');
    });

    it('does not treat "//" inside a string value (e.g. a URL) as a comment', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);
      await writeFile(
        join(dir, 'opencode.json'),
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          provider: {
            'llama-swap': { options: { baseURL: 'http://100.93.145.114:8000/v1/' } },
          },
        }),
      );

      const config = await readOpenCodeConfig(dir);
      expect(config['$schema']).toBe('https://opencode.ai/config.json');
      expect(
        (config['provider'] as { 'llama-swap': { options: { baseURL: string } } })['llama-swap'].options.baseURL,
      ).toBe('http://100.93.145.114:8000/v1/');
    });

    it('returns {} when opencode.json is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);

      const config = await readOpenCodeConfig(dir);
      expect(config).toEqual({});
    });

    it('returns {} when opencode.json is malformed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);
      await writeFile(join(dir, 'opencode.json'), 'not valid json {{{');

      const config = await readOpenCodeConfig(dir);
      expect(config).toEqual({});
    });
  });

  describe('listOpenCodeAgents', () => {
    it('lists agent markdown files with their content', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);
      const agentsDir = join(dir, 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, 'implementer.md'), '# Implementer\n\nDoes stuff.');
      await writeFile(join(agentsDir, 'reviewer.md'), '# Reviewer');
      await writeFile(join(agentsDir, 'notes.txt'), 'not an agent');

      const agents = await listOpenCodeAgents(dir);
      expect(agents).toHaveLength(2);
      const byName = new Map(agents.map(a => [a.name, a.content]));
      expect(byName.get('implementer.md')).toContain('Does stuff.');
      expect(byName.get('reviewer.md')).toBe('# Reviewer');
      expect(byName.has('notes.txt')).toBe(false);
    });

    it('returns an empty array when the agents dir does not exist', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
      cleanup.push(dir);

      const agents = await listOpenCodeAgents(dir);
      expect(agents).toEqual([]);
    });
  });
});
