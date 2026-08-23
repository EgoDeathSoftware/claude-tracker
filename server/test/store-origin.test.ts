import { describe, it, expect } from 'vitest';
import { rewriteCwd, synthesizeOrigin } from '../src/store-origin.ts';
import type { StoreOrigin } from '../src/store-origin.ts';

const origin: StoreOrigin = {
  container: 'vercel.ai',
  hostWorkspace: '/home/dave/Projects/agent-shell',
  workspaceMount: '/workspace',
};

describe('rewriteCwd', () => {
  it('maps the mount root to the host workspace', () => {
    expect(rewriteCwd('/workspace', origin)).toBe('/home/dave/Projects/agent-shell');
  });

  it('maps a path under the mount', () => {
    expect(rewriteCwd('/workspace/server/src', origin))
      .toBe('/home/dave/Projects/agent-shell/server/src');
  });

  it('leaves an unrelated path untouched', () => {
    expect(rewriteCwd('/etc/hosts', origin)).toBe('/etc/hosts');
  });

  it('does not match a prefix that is not a path boundary', () => {
    expect(rewriteCwd('/workspace-other/x', origin)).toBe('/workspace-other/x');
  });

  it('honours a custom workspaceMount', () => {
    const custom: StoreOrigin = { ...origin, workspaceMount: '/srv/work' };
    expect(rewriteCwd('/srv/work/a', custom)).toBe('/home/dave/Projects/agent-shell/a');
    expect(rewriteCwd('/workspace', custom)).toBe('/workspace');
  });

  it('defaults workspaceMount to /workspace when absent', () => {
    const noMount: StoreOrigin = { container: 'c', hostWorkspace: '/host/proj' };
    expect(rewriteCwd('/workspace', noMount)).toBe('/host/proj');
  });

  it('returns cwd unchanged when hostWorkspace is absent', () => {
    expect(rewriteCwd('/workspace', { container: 'c' })).toBe('/workspace');
  });

  it('handles a Windows hostWorkspace', () => {
    const win: StoreOrigin = { container: 'c', hostWorkspace: 'C:\\Users\\dave\\proj' };
    expect(rewriteCwd('/workspace', win)).toBe('C:\\Users\\dave\\proj');
  });
});

describe('synthesizeOrigin', () => {
  it('builds a fallback rooted at the store name', () => {
    expect(synthesizeOrigin('legacy-shared')).toEqual({
      container: 'legacy-shared',
      hostWorkspace: '/legacy-shared',
      workspaceMount: '/workspace',
    });
  });
});
