import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLlmConfig,
  writeLlmConfig,
  DEFAULT_LLM_CONFIG,
} from '../src/llm-config.js';

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'llm-config-test-'));
}

describe('readLlmConfig', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('returns defaults (pointing at the shared endpoint) when no file exists', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const config = await readLlmConfig(join(dir, 'llm.json'));
    expect(config).toEqual(DEFAULT_LLM_CONFIG);
    expect(config.baseUrl).toBe('http://100.93.145.114:8000/v1');
    expect(config.autoSummarize).toBe(false);
  });

  it('merges a partial file over the defaults', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'llm.json');
    await writeFile(cfg, JSON.stringify({ model: 'llama3.1', autoSummarize: true }));
    const config = await readLlmConfig(cfg);
    expect(config.model).toBe('llama3.1');
    expect(config.autoSummarize).toBe(true);
    expect(config.baseUrl).toBe(DEFAULT_LLM_CONFIG.baseUrl);
  });

  it('falls back to defaults on malformed JSON', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'llm.json');
    await writeFile(cfg, '{ not json');
    const config = await readLlmConfig(cfg);
    expect(config).toEqual(DEFAULT_LLM_CONFIG);
  });
});

describe('writeLlmConfig', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const d of cleanup.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('writes and creates the parent directory if missing', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'nested', 'llm.json');
    const config = { ...DEFAULT_LLM_CONFIG, model: 'phi3', autoSummarize: true };
    await writeLlmConfig(cfg, config);
    const raw = await readFile(cfg, 'utf-8');
    expect(JSON.parse(raw)).toEqual(config);
  });

  it('roundtrips through readLlmConfig', async () => {
    const dir = await makeTmp();
    cleanup.push(dir);
    const cfg = join(dir, 'llm.json');
    const config = {
      provider: 'openai' as const,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      autoSummarize: false,
    };
    await writeLlmConfig(cfg, config);
    const readBack = await readLlmConfig(cfg);
    expect(readBack).toEqual(config);
  });
});
