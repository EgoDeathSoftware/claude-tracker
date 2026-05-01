import { useState } from 'react';
import { StatusBadge } from '@/components/StatusBadge.tsx';
import { SearchBar } from '@/components/SearchBar.tsx';
import { formatRelative } from '@/lib/format.ts';
import { useSearch } from '@/hooks/useSearch.ts';
import { useAllTags } from '@/hooks/useTags.ts';
import { useSources } from '@/hooks/useSources.ts';
import type { Session } from '@/types.ts';

interface Props {
  sessions: Session[];
  selectedId: string | null;
  projectId?: string | undefined;
  onSelect: (id: string) => void;
  compareMode?: boolean | undefined;
  compareIds?: string[] | undefined;
  onToggleCompare?: ((id: string) => void) | undefined;
}

export function SessionList({
  sessions,
  selectedId,
  projectId,
  onSelect,
  compareMode,
  compareIds,
  onToggleCompare,
}: Props) {
  const { results, loading, search, clear } = useSearch(projectId);
  const allTags = useAllTags();
  const sources = useSources();
  const sourceNameById = new Map(sources.map(s => [s.id, s.name]));
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const displayed = filterTag
    ? sessions.filter(() => true) // tag filtering is done server-side
    : sessions;

  return (
    <div className="w-72 shrink-0 border-r border-gray-200 flex flex-col">
      <div className="px-3 py-2 border-b border-gray-200 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-gray-900">
            Sessions
          </div>
          <div className="text-xs text-gray-400">
            {sessions.length} total
          </div>
        </div>
        <SearchBar
          results={results}
          loading={loading}
          onSearch={search}
          onClear={clear}
          onSelectSession={onSelect}
        />
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setFilterTag(null)}
              className={`px-2 py-0.5 rounded-full text-[10px]
                ${!filterTag
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
            >
              all
            </button>
            {allTags.map(t => (
              <button
                key={t.id}
                onClick={() => setFilterTag(
                  filterTag === t.name ? null : t.name,
                )}
                className={`px-2 py-0.5 rounded-full text-[10px]
                  ${filterTag === t.name
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="overflow-y-auto flex-1">
        {displayed.length === 0 && (
          <div className="px-4 py-8 text-xs text-gray-400 text-center">
            No sessions found
          </div>
        )}
        {displayed.map(s => (
          <button
            key={s.id}
            onClick={() => {
              if (compareMode && onToggleCompare) {
                onToggleCompare(s.id);
              } else {
                onSelect(s.id);
              }
            }}
            className={`w-full text-left px-4 py-3 border-b
              border-gray-100 ${
              selectedId === s.id ? 'bg-blue-50' : 'hover:bg-gray-50'
            } ${
              compareMode && compareIds?.includes(s.id)
                ? 'ring-2 ring-inset ring-indigo-400'
                : ''
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <StatusBadge status={s.status} />
                {sources.length > 1 && sourceNameById.has(s.sourceId) && (
                  <span className="px-1.5 py-0.5 rounded text-[9px]
                    font-medium bg-gray-100 text-gray-600 uppercase
                    tracking-wide">
                    {sourceNameById.get(s.sourceId)}
                  </span>
                )}
              </div>
              <span className="text-[10px] text-gray-400">
                {formatRelative(s.lastActivityAt)}
              </span>
            </div>
            <div className="text-xs font-medium text-gray-800 truncate">
              {s.title}
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {s.turnCount} turns
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
