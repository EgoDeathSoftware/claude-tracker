import { useState, useEffect } from 'react';
import type { Session } from '@/types.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';

export function useSessions(
  projectId?: string,
  kinds?: SourceKind[],
  locations?: SourceLocation[],
) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const kindsKey = kinds?.join(',') ?? '';
  const locationsKey = locations?.join(',') ?? '';

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (kindsKey) params.set('kinds', kindsKey);
    if (locationsKey) params.set('locations', locationsKey);
    const qs = params.toString();
    const url = qs ? `/api/sessions?${qs}` : '/api/sessions';
    void fetch(url).then(r => r.json()).then(setSessions);
  }, [projectId, kindsKey, locationsKey]);

  return { sessions, setSessions };
}
