import { useEffect, useState } from 'react';

export type SourceKind = 'claude-code' | 'opencode';
export type SourceLocation = 'host' | 'container';

export interface StoreOrigin {
  container: string;
  image?: string;
  hostWorkspace?: string;
  workspaceMount?: string;
  host?: string;
  updatedAt?: string;
}

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  location: SourceLocation;
  configPath?: string;
  origin?: StoreOrigin;
  parentId?: string;
}

export function useSources(): Source[] {
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      void fetch('/api/sources')
        .then(r => r.json() as Promise<Source[]>)
        .then(data => {
          if (!cancelled) setSources(data);
        })
        .catch(err => {
          console.error('[useSources] failed to load:', err);
        });
    };

    load();
    window.addEventListener('tracker:sources-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('tracker:sources-changed', load);
    };
  }, []);

  return sources;
}
