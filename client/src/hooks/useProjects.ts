import { useState, useEffect, useCallback } from 'react';
import type { Project } from '@/types.ts';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(() => {
    void fetch('/api/projects').then(r => r.json()).then(setProjects);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { projects, setProjects, refresh };
}
