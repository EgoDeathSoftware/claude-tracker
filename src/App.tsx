import { useState, useCallback } from 'react';
import { ProjectList } from '@/components/ProjectList.tsx';
import { SessionList } from '@/components/SessionList.tsx';
import { SessionDetail } from '@/components/SessionDetail.tsx';
import { PromptLibrary } from '@/components/PromptLibrary.tsx';
import { SessionComparison } from '@/components/SessionComparison.tsx';
import { useProjects } from '@/hooks/useProjects.ts';
import { useSessions } from '@/hooks/useSessions.ts';
import { useSSE } from '@/hooks/useSSE.ts';
import type { Session } from '@/types.ts';

export default function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<
    string | null
  >(null);
  const [selectedSessionId, setSelectedSessionId] = useState<
    string | null
  >(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const { projects, refresh } = useProjects();
  const { sessions, setSessions } = useSessions(
    selectedProjectId ?? undefined,
  );

  const handleCreated = useCallback(
    (session: Session) => {
      setSessions(prev => [
        session,
        ...prev.filter(s => s.id !== session.id),
      ]);
      refresh();
    },
    [setSessions, refresh],
  );

  const handleUpdated = useCallback(
    (session: Session) => {
      setSessions(prev =>
        prev.map(s => (s.id === session.id ? session : s)),
      );
      refresh();
    },
    [setSessions, refresh],
  );

  useSSE(handleCreated, handleUpdated);

  const selectedSession =
    sessions.find(s => s.id === selectedSessionId) ?? null;

  const toggleCompare = (id: string) => {
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  };

  return (
    <div className="flex h-screen bg-white text-sm font-sans">
      <div className="flex flex-col">
        <ProjectList
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={id => {
            setSelectedProjectId(id);
            setSelectedSessionId(null);
          }}
        />
        <div className="border-t border-gray-200 p-2 space-y-1">
          <button
            onClick={() => setPromptsOpen(true)}
            className="w-full text-left px-3 py-1.5 text-xs
              text-gray-600 hover:bg-gray-100 rounded"
          >
            Prompt Library
          </button>
          <button
            onClick={() => {
              setCompareMode(!compareMode);
              setCompareIds([]);
            }}
            className={`w-full text-left px-3 py-1.5 text-xs rounded
              ${compareMode
                ? 'bg-indigo-50 text-indigo-700'
                : 'text-gray-600 hover:bg-gray-100'
              }`}
          >
            {compareMode ? 'Exit Compare' : 'Compare Sessions'}
          </button>
        </div>
      </div>
      <SessionList
        sessions={sessions}
        selectedId={selectedSessionId}
        projectId={selectedProjectId ?? undefined}
        onSelect={setSelectedSessionId}
        compareMode={compareMode}
        compareIds={compareIds}
        onToggleCompare={toggleCompare}
      />
      <SessionDetail session={selectedSession} />

      <PromptLibrary
        open={promptsOpen}
        onClose={() => setPromptsOpen(false)}
      />

      {compareMode && compareIds.length === 2 && (
        <SessionComparison
          sessionA={compareIds[0]!}
          sessionB={compareIds[1]!}
          onClose={() => setCompareIds([])}
        />
      )}
    </div>
  );
}
