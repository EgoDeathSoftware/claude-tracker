import { useState, useEffect } from 'react';
import type { Project } from '@/types.ts';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    void fetch('/api/projects').then(r => r.json()).then(setProjects);
  }, []);

  return { projects, setProjects };
}
