import type { Project } from '@/types.ts';

interface Props {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ProjectList({ projects, selectedId, onSelect }: Props) {
  return (
    <div className="w-48 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-semibold text-gray-900">Projects</div>
        <div className="text-xs text-gray-500 mt-0.5">{projects.length} projects</div>
      </div>
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
            <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5">
              {p.liveCount > 0 && (
                <span className="bg-blue-100 text-blue-700 px-1.5 rounded-full">{p.liveCount} live</span>
              )}
              <span>· {p.sessionCount} sessions</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
