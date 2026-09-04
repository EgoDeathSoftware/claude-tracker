import { describe, it, expect } from 'vitest';
import {
  basenameOf,
  deriveProjectKey,
  displayNameFromCwd,
  stripBranchSuffix,
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

describe('stripBranchSuffix', () => {
  it('strips a dash-separated branch suffix', () => {
    expect(stripBranchSuffix('claude-project-tracker-feature-x', 'feature-x'))
      .toBe('claude-project-tracker');
  });

  it('strips an underscore-separated branch suffix', () => {
    expect(stripBranchSuffix('myrepo_feature-x', 'feature-x')).toBe('myrepo');
  });

  it('strips a dot-separated branch suffix', () => {
    expect(stripBranchSuffix('myrepo.feature-x', 'feature-x')).toBe('myrepo');
  });

  it('matches on the final path segment of a branch containing slashes', () => {
    expect(stripBranchSuffix('myrepo-login-page', 'feature/login-page'))
      .toBe('myrepo');
  });

  it('matches case-insensitively while preserving the remaining casing', () => {
    expect(stripBranchSuffix('MyRepo-Feature-X', 'feature-x')).toBe('MyRepo');
  });

  it('returns basename unchanged when there is no match', () => {
    expect(stripBranchSuffix('myrepo', 'feature-x')).toBe('myrepo');
  });

  it('returns basename unchanged when the whole basename is the branch', () => {
    expect(stripBranchSuffix('feature-x', 'feature-x')).toBe('feature-x');
  });

  it('is a no-op when gitBranch is undefined or empty', () => {
    expect(stripBranchSuffix('myrepo-feature-x', undefined)).toBe('myrepo-feature-x');
    expect(stripBranchSuffix('myrepo-feature-x', '')).toBe('myrepo-feature-x');
  });
});

describe('deriveProjectKey with gitBranch', () => {
  it('merges a worktree cwd into the main repo project key', () => {
    const main = deriveProjectKey(
      '/mnt/c/Users/david/Projects/myrepo',
      'wsl',
      '-mnt-c-myrepo',
      'master',
    );
    const worktree = deriveProjectKey(
      '/mnt/c/Users/david/Projects/myrepo-feature-x',
      'wsl',
      '-mnt-c-myrepo-feature-x',
      'feature-x',
    );
    expect(worktree).toBe(main);
    expect(worktree).toBe('myrepo');
  });

  it('is unaffected when gitBranch is omitted', () => {
    expect(
      deriveProjectKey('/mnt/c/Users/david/Projects/Foo', 'wsl', '-mnt-c-Foo'),
    ).toBe('foo');
  });
});

describe('displayNameFromCwd with gitBranch', () => {
  it('strips the branch suffix for display', () => {
    expect(displayNameFromCwd('/home/david/myrepo-feature-x', 'feature-x'))
      .toBe('myrepo');
  });

  it('is unaffected when gitBranch is omitted', () => {
    expect(displayNameFromCwd('C:\\Users\\david\\Projects\\MyApp'))
      .toBe('MyApp');
  });
});
