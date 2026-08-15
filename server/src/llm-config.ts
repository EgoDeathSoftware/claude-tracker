import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LlmConfig {
  provider: 'ollama' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  autoSummarize: boolean;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: 'ollama',
  baseUrl: 'http://100.93.145.114:8000/v1',
  apiKey: '',
  model: '',
  autoSummarize: false,
};

export async function readLlmConfig(configPath: string): Promise<LlmConfig> {
  const raw = await readFile(configPath, 'utf-8').catch(() => null);
  if (raw === null) return { ...DEFAULT_LLM_CONFIG };

  try {
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return { ...DEFAULT_LLM_CONFIG, ...parsed };
  } catch {
    console.warn(`[llm-config] malformed JSON in ${configPath}; using defaults`);
    return { ...DEFAULT_LLM_CONFIG };
  }
}

export async function writeLlmConfig(
  configPath: string,
  config: LlmConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
}
