import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseOptionalNumberEnv } from '../src/env-config.js';

describe('parseOptionalNumberEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when the var is absent', () => {
    expect(parseOptionalNumberEnv('MISSING_VAR', {})).toBeUndefined();
  });

  it('returns undefined when the var is set to an empty string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseOptionalNumberEnv('EMPTY_VAR', { EMPTY_VAR: '' })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses a valid numeric value', () => {
    expect(parseOptionalNumberEnv('N', { N: '30' })).toBe(30);
  });

  it('parses a decimal value', () => {
    expect(parseOptionalNumberEnv('N', { N: '2.5' })).toBe(2.5);
  });

  it('warns and returns undefined for a non-numeric value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseOptionalNumberEnv('N', { N: 'abc' })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ignoring invalid N "abc"'),
    );
  });

  it('returns undefined silently for a whitespace-only value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseOptionalNumberEnv('N', { N: '   ' })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('defaults to reading process.env when no env object is passed', () => {
    const original = process.env['ENV_CONFIG_TEST_VAR'];
    process.env['ENV_CONFIG_TEST_VAR'] = '42';
    try {
      expect(parseOptionalNumberEnv('ENV_CONFIG_TEST_VAR')).toBe(42);
    } finally {
      if (original === undefined) delete process.env['ENV_CONFIG_TEST_VAR'];
      else process.env['ENV_CONFIG_TEST_VAR'] = original;
    }
  });
});
