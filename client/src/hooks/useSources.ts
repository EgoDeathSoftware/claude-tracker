import { useEffect, useState } from 'react';

export type SourceKind = 'claude-code' | 'opencode';

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  configPath?: string;
}

export function useSources(): Source[] {
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/sources')
      .then(r => r.json() as Promise<Source[]>)
      .then(data => {
        if (!cancelled) setSources(data);
      })
      .catch(err => {
        console.error('[useSources] failed to load:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return sources;
}
