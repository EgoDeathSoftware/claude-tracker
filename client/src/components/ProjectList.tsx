import type { Project } from '@/types.ts';
import type { SourceKind, SourceLocation } from '@/hooks/useSources.ts';
import { SourceKindDots } from '@/components/SourceKindDots.tsx';
import { useSources } from '@/hooks/useSources.ts';

const KIND_LABELS: Record<SourceKind, string> = {
  'claude-code': 'Claude Code',
  'opencode': 'OpenCode',
};

const LOCATION_LABELS: Record<SourceLocation, string> = {
  host: 'Host',
  container: 'Containers',
};

interface Props {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  allKinds: SourceKind[];
  enabledKinds: SourceKind[];
  onToggleKind: (kind: SourceKind) => void;
  allLocations: SourceLocation[];
  enabledLocations: SourceLocation[];
  onToggleLocation: (location: SourceLocation) => void;
  configOpen: boolean;
  onOpenConfig: () => void;
}

export function ProjectList({
  projects, selectedId, onSelect,
  allKinds, enabledKinds, onToggleKind,
  allLocations, enabledLocations, onToggleLocation,
  configOpen, onOpenConfig,
}: Props) {
  const sources = useSources();
  const sourceKindById = new Map(sources.map(s => [s.id, s.kind]));

  const getProjectKinds = (project: Project): SourceKind[] =>
    project.sources
      .map(id => sourceKindById.get(id))
      .filter((k): k is SourceKind => k !== undefined);

  return (
    <div className="w-full border-r border-gray-200 bg-gray-50 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-900">Projects</div>
          <div className="text-xs text-gray-500 mt-0.5">{projects.length} projects</div>
        </div>
        <button
          onClick={onOpenConfig}
          title="Configuration"
          aria-label="Configuration"
          className={`shrink-0 p-1 rounded ${
            configOpen
              ? 'bg-indigo-50 text-indigo-600'
              : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
          }`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            className="w-4 h-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.164.397.505.71.93.78l.893.15c.543.09.94.559.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.766.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.272-.806.107-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.558-.94-1.108v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.164-.398.142-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
            />
          </svg>
        </button>
      </div>
      {allKinds.length > 1 && (
        <div className="flex gap-3 px-4 py-1.5 border-b border-gray-100 text-[11px]">
          {allKinds.map(kind => (
            <label key={kind} className="flex items-center gap-1 text-gray-600">
              <input
                type="checkbox"
                checked={enabledKinds.includes(kind)}
                onChange={() => onToggleKind(kind)}
              />
              {KIND_LABELS[kind]}
            </label>
          ))}
        </div>
      )}
      {allLocations.length > 1 && (
        <div className="flex gap-3 px-4 py-1.5 border-b border-gray-100 text-[11px]">
          {allLocations.map(location => (
            <label key={location} className="flex items-center gap-1 text-gray-600">
              <input
                type="checkbox"
                checked={enabledLocations.includes(location)}
                onChange={() => onToggleLocation(location)}
              />
              {LOCATION_LABELS[location]}
            </label>
          ))}
        </div>
      )}
      <div className="overflow-y-auto flex-1">
        <button
          onClick={() => onSelect(null)}
          className={`w-full text-left px-4 py-2 text-xs font-medium border-b border-gray-100 ${
            selectedId === null ? 'text-indigo-600 bg-white' : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          ≡ All Sessions
        </button>
        {projects.map(p => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`w-full text-left px-4 py-2 border-b border-gray-100 ${
              selectedId === p.id ? 'bg-white border-l-2 border-l-indigo-500' : 'hover:bg-gray-100'
            }`}
          >
            <div className="text-xs font-medium text-gray-800 truncate">{p.name}</div>
            <div className="text-[11px] text-gray-400 mt-0.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {p.liveCount > 0 && (
                  <span className="bg-blue-100 text-blue-700 px-1.5 rounded-full">{p.liveCount} live</span>
                )}
                <span>· {p.sessionCount} sessions</span>
              </div>
              <SourceKindDots kinds={getProjectKinds(p)} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
