import { useState, useCallback } from 'react';
import { ProjectList } from '@/components/ProjectList.tsx';
import { SessionList } from '@/components/SessionList.tsx';
import { SessionDetail } from '@/components/SessionDetail.tsx';
import { useProjects } from '@/hooks/useProjects.ts';
import { useSessions } from '@/hooks/useSessions.ts';
import { useSSE } from '@/hooks/useSSE.ts';
import type { Session } from '@/types.ts';

export default function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const { projects, refresh } = useProjects();
  const { sessions, setSessions } = useSessions(selectedProjectId ?? undefined);

  const handleCreated = useCallback((session: Session) => {
    setSessions(prev => [session, ...prev.filter(s => s.id !== session.id)]);
    refresh();
  }, [setSessions, refresh]);

  const handleUpdated = useCallback((session: Session) => {
    setSessions(prev => prev.map(s => s.id === session.id ? session : s));
    refresh();
  }, [setSessions, refresh]);

  useSSE(handleCreated, handleUpdated);

  const selectedSession = sessions.find(s => s.id === selectedSessionId) ?? null;

  return (
    <div className="flex h-screen bg-white text-sm font-sans">
      <ProjectList
        projects={projects}
        selectedId={selectedProjectId}
        onSelect={id => { setSelectedProjectId(id); setSelectedSessionId(null); }}
      />
      <SessionList
        sessions={sessions}
        selectedId={selectedSessionId}
        onSelect={setSelectedSessionId}
      />
      <SessionDetail session={selectedSession} />
    </div>
  );
}
