import { useState, useEffect, useCallback } from 'react';
import type { Project } from '@/types.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';

export function useProjects(kinds?: SourceKind[], locations?: SourceLocation[]) {
  const [projects, setProjects] = useState<Project[]>([]);
  // undefined means "no filter"; '' means "filtered down to nothing" (every
  // checkbox deselected) — these must stay distinguishable all the way to
  // the server, so this is NOT `?? ''`.
  const kindsKey = kinds?.join(',');
  const locationsKey = locations?.join(',');

  const refresh = useCallback(() => {
    const params = new URLSearchParams();
    if (kindsKey !== undefined) params.set('kinds', kindsKey);
    if (locationsKey !== undefined) params.set('locations', locationsKey);
    const qs = params.toString();
    void fetch(qs ? `/api/projects?${qs}` : '/api/projects')
      .then(r => r.json()).then(setProjects);
  }, [kindsKey, locationsKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return { projects, setProjects, refresh };
}
