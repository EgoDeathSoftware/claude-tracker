import { describe, it, expect } from 'vitest';
import { computeCost, getUnpricedModels } from '../src/pricing.js';
import type { MessageUsage } from '../src/types.js';

/** Usage with only the field under test set, so a cost maps to a single rate. */
function usage(over: Partial<MessageUsage> = {}): MessageUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  } as MessageUsage;
}

const MTOK = 1_000_000;

describe('computeCost', () => {
  it('prices the Claude 5 family at current rates', () => {
    const cases: [string, number, number][] = [
      ['claude-fable-5', 10, 50],
      ['claude-opus-5', 5, 25],
      ['claude-sonnet-5', 3, 15],
      ['claude-haiku-4-5', 1, 5],
    ];
    for (const [model, input, output] of cases) {
      expect(computeCost(usage({ input_tokens: MTOK }), model)).toBeCloseTo(input, 6);
      expect(computeCost(usage({ output_tokens: MTOK }), model)).toBeCloseTo(output, 6);
    }
  });

  it('prices Opus at $5/$25, not the stale Opus-4.5-era $15/$75', () => {
    // The live bug this table fixes: every Opus session was billed at 3x.
    expect(computeCost(usage({ input_tokens: MTOK }), 'claude-opus-4-6')).toBeCloseTo(5, 6);
    expect(computeCost(usage({ output_tokens: MTOK }), 'claude-opus-4-6')).toBeCloseTo(25, 6);
  });

  it('derives cache rates from the input rate (write 1.25x, read 0.1x)', () => {
    const write = computeCost(usage({ cache_creation_input_tokens: MTOK }), 'claude-opus-5');
    const read = computeCost(usage({ cache_read_input_tokens: MTOK }), 'claude-opus-5');
    expect(write).toBeCloseTo(5 * 1.25, 6);
    expect(read).toBeCloseTo(5 * 0.1, 6);
  });

  it('resolves variant suffixes and vendor prefixes to the same rates', () => {
    const base = computeCost(usage({ input_tokens: MTOK }), 'claude-opus-5');
    for (const variant of [
      'claude-opus-5[1m]',
      'claude-opus-5-fast',
      'anthropic.claude-opus-5',
      '  claude-opus-5  ',
    ]) {
      expect(computeCost(usage({ input_tokens: MTOK }), variant)).toBeCloseTo(base, 6);
    }
  });

  it('resolves a dated snapshot to its alias', () => {
    const dated = computeCost(usage({ input_tokens: MTOK }), 'claude-haiku-4-5-20251001');
    expect(dated).toBeCloseTo(1, 6);
  });

  it('treats synthetic and empty model ids as non-billable', () => {
    for (const model of ['<synthetic>', '<none>', '']) {
      const cost = computeCost(
        usage({ input_tokens: MTOK, output_tokens: MTOK, cache_read_input_tokens: MTOK }),
        model,
      );
      expect(cost).toBe(0);
    }
  });

  it('records an unknown model instead of silently defaulting', () => {
    expect(getUnpricedModels()).not.toContain('claude-unreleased-9');
    const cost = computeCost(usage({ input_tokens: MTOK }), 'claude-unreleased-9');
    // Still priced (at the Sonnet fallback) so the column isn't blank...
    expect(cost).toBeCloseTo(3, 6);
    // ...but recorded, so a report can flag it as an estimate.
    expect(getUnpricedModels()).toContain('claude-unreleased-9');
  });

  it('does not record non-billable placeholders as unpriced', () => {
    computeCost(usage({ input_tokens: MTOK }), '<synthetic>');
    expect(getUnpricedModels()).not.toContain('<synthetic>');
    expect(getUnpricedModels()).not.toContain('');
  });

  it('sums every usage component', () => {
    const cost = computeCost(
      usage({
        input_tokens: MTOK,
        output_tokens: MTOK,
        cache_creation_input_tokens: MTOK,
        cache_read_input_tokens: MTOK,
      }),
      'claude-opus-5',
    );
    expect(cost).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
  });

  it('treats absent cache fields as zero rather than NaN', () => {
    const partial = { input_tokens: MTOK, output_tokens: 0 } as MessageUsage;
    expect(computeCost(partial, 'claude-opus-5')).toBeCloseTo(5, 6);
  });
});
