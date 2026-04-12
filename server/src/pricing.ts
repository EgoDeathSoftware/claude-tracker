import type { MessageUsage } from './types.ts';

interface ModelPricing {
  inputPerToken: number;
  cacheWritePerToken: number;
  cacheReadPerToken: number;
  outputPerToken: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':           { inputPerToken: 15/1e6,   cacheWritePerToken: 18.75/1e6, cacheReadPerToken: 1.50/1e6,  outputPerToken: 75/1e6  },
  'claude-sonnet-4-6':         { inputPerToken: 3/1e6,    cacheWritePerToken: 3.75/1e6,  cacheReadPerToken: 0.30/1e6,  outputPerToken: 15/1e6  },
  'claude-haiku-4-5-20251001': { inputPerToken: 0.80/1e6, cacheWritePerToken: 1/1e6,     cacheReadPerToken: 0.08/1e6,  outputPerToken: 4/1e6   },
};

const DEFAULT_PRICING: ModelPricing = {
  inputPerToken: 3/1e6,
  cacheWritePerToken: 3.75/1e6,
  cacheReadPerToken: 0.30/1e6,
  outputPerToken: 15/1e6,
};

const warnedModels = new Set<string>();

export function computeCost(usage: MessageUsage, model: string): number {
  const p = PRICING[model];
  if (!p && !warnedModels.has(model)) {
    warnedModels.add(model);
    console.warn(`[pricing] Unknown model "${model}", using default (sonnet) pricing`);
  }
  const rates = p ?? DEFAULT_PRICING;
  return (
    usage.input_tokens * rates.inputPerToken +
    (usage.cache_creation_input_tokens ?? 0) * rates.cacheWritePerToken +
    (usage.cache_read_input_tokens ?? 0) * rates.cacheReadPerToken +
    usage.output_tokens * rates.outputPerToken
  );
}
