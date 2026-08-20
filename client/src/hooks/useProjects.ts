import { useState, useEffect, useCallback } from 'react';
import type { Project } from '@/types.ts';
import type { SourceKind } from '@/hooks/useSources.ts';

export function useProjects(kinds?: SourceKind[]) {
  const [projects, setProjects] = useState<Project[]>([]);
  const kindsKey = kinds?.join(',') ?? '';

  const refresh = useCallback(() => {
    const url = kindsKey ? `/api/projects?kinds=${kindsKey}` : '/api/projects';
    void fetch(url).then(r => r.json()).then(setProjects);
  }, [kindsKey]);

  useEffect(() => { refresh(); }, [refresh]);

  return { projects, setProjects, refresh };
}
