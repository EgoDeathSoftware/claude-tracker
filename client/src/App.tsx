import { useState, useCallback, useMemo } from 'react';
import { ProjectList } from '@/components/ProjectList.tsx';
import { SessionList } from '@/components/SessionList.tsx';
import { SessionDetail } from '@/components/SessionDetail.tsx';
import { PromptLibrary } from '@/components/PromptLibrary.tsx';
import { SessionComparison } from '@/components/SessionComparison.tsx';
import { ConfigPanel } from '@/components/config/ConfigPanel.tsx';
import { useProjects } from '@/hooks/useProjects.ts';
import { useSessions } from '@/hooks/useSessions.ts';
import { useSSE } from '@/hooks/useSSE.ts';
import { useSources } from '@/hooks/useSources.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';
import type { SessionMeta } from '@/types.ts';

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
  const [configOpen, setConfigOpen] = useState(false);

  const sources = useSources();
  const allKinds = useMemo(
    () => [...new Set(sources.map(s => s.kind))],
    [sources],
  );
  // null = "not yet toggled by the user" - falls back to allKinds, so a
  // newly-configured source kind shows up enabled by default.
  const [enabledKinds, setEnabledKinds] = useState<SourceKind[] | null>(null);
  const effectiveKinds = enabledKinds ?? allKinds;
  const toggleKind = (kind: SourceKind) => {
    setEnabledKinds(prev => {
      const base = prev ?? allKinds;
      return base.includes(kind)
        ? base.filter(k => k !== kind)
        : [...base, kind];
    });
  };

  const allLocations = useMemo(
    () => [...new Set(sources.map(s => s.location))],
    [sources],
  );
  // null = "not yet toggled by the user" - falls back to allLocations, so a
  // newly-appearing location shows up enabled by default.
  const [enabledLocations, setEnabledLocations] = useState<SourceLocation[] | null>(null);
  const effectiveLocations = enabledLocations ?? allLocations;
  const toggleLocation = (location: SourceLocation) => {
    setEnabledLocations(prev => {
      const base = prev ?? allLocations;
      return base.includes(location)
        ? base.filter(l => l !== location)
        : [...base, location];
    });
  };

  const { projects, refresh } = useProjects(effectiveKinds, effectiveLocations);
  const { sessions, setSessions } = useSessions(
    selectedProjectId ?? undefined,
    effectiveKinds,
    effectiveLocations,
  );

  const handleCreated = useCallback(
    (session: SessionMeta) => {
      setSessions(prev => [
        session,
        ...prev.filter(s => s.id !== session.id),
      ]);
      refresh();
    },
    [setSessions, refresh],
  );

  const handleUpdated = useCallback(
    (session: SessionMeta) => {
      setSessions(prev =>
        prev.map(s => (s.id === session.id ? session : s)),
      );
      refresh();
    },
    [setSessions, refresh],
  );

  useSSE(handleCreated, handleUpdated);

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
            setConfigOpen(false);
          }}
          allKinds={allKinds}
          enabledKinds={effectiveKinds}
          onToggleKind={toggleKind}
          allLocations={allLocations}
          enabledLocations={effectiveLocations}
          onToggleLocation={toggleLocation}
          configOpen={configOpen}
          onOpenConfig={() => {
            setConfigOpen(!configOpen);
            if (!configOpen) setSelectedSessionId(null);
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
      {!configOpen && (
        <SessionList
          sessions={sessions}
          selectedId={selectedSessionId}
          projectId={selectedProjectId ?? undefined}
          onSelect={id => {
            setSelectedSessionId(id);
            setConfigOpen(false);
          }}
          compareMode={compareMode}
          compareIds={compareIds}
          onToggleCompare={toggleCompare}
        />
      )}
      {configOpen
        ? <ConfigPanel />
        : (
          <SessionDetail
            sessionId={selectedSessionId}
            onSelectSession={id => {
              setSelectedSessionId(id);
              setConfigOpen(false);
            }}
          />
        )
      }

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
