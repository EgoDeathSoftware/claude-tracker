import { useState, useEffect, useCallback } from 'react';
import type { Project } from '@/types.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';

export function useProjects(kinds?: SourceKind[], locations?: SourceLocation[]) {
  const [projects, setProjects] = useState<Project[]>([]);
  const kindsKey = kinds?.join(',') ?? '';
  const locationsKey = locations?.join(',') ?? '';

  const refresh = useCallback(() => {
    const params = new URLSearchParams();
    if (kindsKey) params.set('kinds', kindsKey);
    if (locationsKey) params.set('locations', locationsKey);
    const qs = params.toString();
    void fetch(qs ? `/api/projects?${qs}` : '/api/projects')
      .then(r => r.json()).then(setProjects);
  }, [kindsKey, locationsKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return { projects, setProjects, refresh };
}
