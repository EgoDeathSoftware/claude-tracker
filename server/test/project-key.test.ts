import { describe, it, expect } from 'vitest';
import {
  basenameOf,
  deriveProjectKey,
  displayNameFromCwd,
} from '../src/project-key.js';

describe('basenameOf', () => {
  it('extracts folder name from a WSL path', () => {
    expect(
      basenameOf('/mnt/c/Users/david/Projects/claude-project-tracker'),
    ).toBe('claude-project-tracker');
  });

  it('extracts folder name from a Windows path', () => {
    expect(
      basenameOf('C:\\Users\\david\\Projects\\claude-project-tracker'),
    ).toBe('claude-project-tracker');
  });

  it('handles trailing forward slash', () => {
    expect(basenameOf('/home/david/foo/')).toBe('foo');
  });

  it('handles trailing backslash', () => {
    expect(basenameOf('C:\\Users\\david\\foo\\')).toBe('foo');
  });

  it('skips drive-letter-only segments', () => {
    expect(basenameOf('C:')).toBe('');
    expect(basenameOf('C:\\')).toBe('');
  });

  it('returns empty for empty input', () => {
    expect(basenameOf('')).toBe('');
  });

  it('handles mixed separators', () => {
    expect(basenameOf('C:/Users/david\\foo')).toBe('foo');
  });
});

describe('deriveProjectKey', () => {
  it('uses lowercased basename when cwd is present', () => {
    expect(
      deriveProjectKey(
        '/mnt/c/Users/david/Projects/Foo',
        'wsl',
        '-mnt-c-Foo',
      ),
    ).toBe('foo');
  });

  it('merges WSL and Windows cwds for the same folder', () => {
    const a = deriveProjectKey(
      '/mnt/c/Users/david/Projects/X',
      'wsl',
      '-mnt-c-X',
    );
    const b = deriveProjectKey(
      'C:\\Users\\david\\Projects\\X',
      'windows',
      'C--X',
    );
    expect(a).toBe(b);
    expect(a).toBe('x');
  });

  it('falls back to source-scoped dir name when cwd is empty', () => {
    expect(deriveProjectKey('', 'wsl', '-some-dir'))
      .toBe('wsl:-some-dir');
  });

  it('falls back when cwd yields no basename (root only)', () => {
    expect(deriveProjectKey('C:\\', 'windows', 'C--'))
      .toBe('windows:C--');
  });
});

describe('displayNameFromCwd', () => {
  it('preserves original casing for display', () => {
    expect(displayNameFromCwd('C:\\Users\\david\\Projects\\MyApp'))
      .toBe('MyApp');
  });

  it('returns empty string when cwd has no basename', () => {
    expect(displayNameFromCwd('')).toBe('');
  });
});
