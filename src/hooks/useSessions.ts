import { useState, useEffect } from 'react';
import type { Session } from '@/types.ts';

export function useSessions(projectId?: string) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    const url = projectId ? `/api/sessions?projectId=${projectId}` : '/api/sessions';
    void fetch(url).then(r => r.json()).then(setSessions);
  }, [projectId]);

  return { sessions, setSessions };
}
