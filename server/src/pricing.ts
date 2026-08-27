import type { MessageUsage } from './types.ts';

/** Per-token USD rates for one model. Cache rates are derived, not stored. */
interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
}

const M = 1e6;

/**
 * A 5-minute cache write costs 1.25x base input; a cache read 0.1x. Deriving both from the
 * input rate keeps a row to two numbers, so a rate change can't leave the cache columns stale.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

/**
 * Rates current as of 2026-08-26, mirroring `pricing.py` in the sibling `claude-session-analyzer`
 * repo's sessionkit toolkit, so the UI and the CLI report the same figure for the same session.
 *
 * Sonnet 5 carries introductory pricing of $2/$10 through 2026-08-31; the standard $3/$15 is
 * used rather than tracking a promo window that expires within days of writing.
 */
const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5':    { inputPerToken: 10.00 / M, outputPerToken: 50.00 / M },
  'claude-mythos-5':   { inputPerToken: 10.00 / M, outputPerToken: 50.00 / M },
  'claude-opus-5':     { inputPerToken: 5.00 / M,  outputPerToken: 25.00 / M },
  'claude-opus-4-8':   { inputPerToken: 5.00 / M,  outputPerToken: 25.00 / M },
  'claude-opus-4-7':   { inputPerToken: 5.00 / M,  outputPerToken: 25.00 / M },
  'claude-opus-4-6':   { inputPerToken: 5.00 / M,  outputPerToken: 25.00 / M },
  'claude-opus-4-5':   { inputPerToken: 5.00 / M,  outputPerToken: 25.00 / M },
  'claude-sonnet-5':   { inputPerToken: 3.00 / M,  outputPerToken: 15.00 / M },
  'claude-sonnet-4-6': { inputPerToken: 3.00 / M,  outputPerToken: 15.00 / M },
  'claude-sonnet-4-5': { inputPerToken: 3.00 / M,  outputPerToken: 15.00 / M },
  'claude-haiku-4-5':  { inputPerToken: 1.00 / M,  outputPerToken: 5.00 / M },
};

const DEFAULT_PRICING: ModelPricing = PRICING['claude-sonnet-5']!;

const FREE_PRICING: ModelPricing = { inputPerToken: 0, outputPerToken: 0 };

/**
 * Placeholder model ids Claude Code writes for locally-injected messages. They cost nothing
 * and must not be reported as unpriced, or every corpus looks misconfigured.
 */
const NON_BILLABLE = new Set(['<synthetic>', '<none>', '']);

/**
 * Deployment-variant suffixes Claude Code appends to a model id, e.g. `claude-opus-5[1m]`.
 * The 1M-context variants bill at standard rates (no long-context premium), so the suffix is
 * stripped before lookup rather than priced separately.
 */
const VARIANT_SUFFIX = /\[[^\]]*\]$|-fast$/;
const DATE_SUFFIX = /-\d{8}$/;

const unpricedModels = new Set<string>();

/**
 * Reduce a raw transcript model id to a `PRICING` key.
 *
 * Strips deployment-variant suffixes, the Bedrock `anthropic.` prefix, and — only when the id
 * isn't already a known key — a trailing date stamp, so `claude-haiku-4-5-20251001` resolves
 * to its alias.
 */
function normalizeModel(model: string): string {
  let key = (model ?? '').trim().replace(VARIANT_SUFFIX, '');
  if (key.startsWith('anthropic.')) {
    key = key.slice('anthropic.'.length);
  }
  if (key in PRICING) return key;
  return key.replace(DATE_SUFFIX, '');
}

function ratesFor(model: string): ModelPricing {
  if (NON_BILLABLE.has((model ?? '').trim())) return FREE_PRICING;

  const key = normalizeModel(model);
  const found = PRICING[key];
  if (found) return found;

  if (key) unpricedModels.add(key);
  return DEFAULT_PRICING;
}

/**
 * Model ids seen so far that had no pricing entry and were billed at the fallback rate.
 *
 * Surfaced rather than silently defaulted, so a report can state which sessions are estimates.
 */
export function getUnpricedModels(): string[] {
  return [...unpricedModels].sort();
}

/** Estimated USD cost of one message's token usage. */
export function computeCost(usage: MessageUsage, model: string): number {
  const rates = ratesFor(model);
  return (
    usage.input_tokens * rates.inputPerToken
    + (usage.cache_creation_input_tokens ?? 0) * rates.inputPerToken * CACHE_WRITE_MULTIPLIER
    + (usage.cache_read_input_tokens ?? 0) * rates.inputPerToken * CACHE_READ_MULTIPLIER
    + usage.output_tokens * rates.outputPerToken
  );
}
