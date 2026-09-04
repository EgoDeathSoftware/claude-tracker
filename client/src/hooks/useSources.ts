import { useEffect, useState } from 'react';
import type { SourceKind, SourceLocation, StoreOrigin } from '@/types.ts';

export type { SourceKind, SourceLocation, StoreOrigin } from '@/types.ts';

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
