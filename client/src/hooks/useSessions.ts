import { useState, useEffect } from 'react';
import type { Session } from '@/types.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';

export function useSessions(
  projectId?: string,
  kinds?: SourceKind[],
  locations?: SourceLocation[],
) {
  const [sessions, setSessions] = useState<Session[]>([]);
  // undefined means "no filter"; '' means "filtered down to nothing" (every
  // checkbox deselected) — these must stay distinguishable all the way to
  // the server, so this is NOT `?? ''`.
  const kindsKey = kinds?.join(',');
  const locationsKey = locations?.join(',');

  useEffect(() => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (kindsKey !== undefined) params.set('kinds', kindsKey);
    if (locationsKey !== undefined) params.set('locations', locationsKey);
    const qs = params.toString();
    const url = qs ? `/api/sessions?${qs}` : '/api/sessions';
    void fetch(url).then(r => r.json()).then(setSessions);
  }, [projectId, kindsKey, locationsKey]);

  return { sessions, setSessions };
}
