import { useState, useEffect } from 'react';
import type { Session } from '@/types.ts';
import type { SourceKind } from '@/hooks/useSources.ts';

export function useSessions(projectId?: string, kinds?: SourceKind[]) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const kindsKey = kinds?.join(',') ?? '';

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (kindsKey) params.set('kinds', kindsKey);
    const qs = params.toString();
    const url = qs ? `/api/sessions?${qs}` : '/api/sessions';
    void fetch(url).then(r => r.json()).then(setSessions);
  }, [projectId, kindsKey]);

  return { sessions, setSessions };
}
