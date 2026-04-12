import { StatusBadge } from '@/components/StatusBadge.tsx';
import { formatRelative } from '@/lib/format.ts';
import type { Session } from '@/types.ts';

interface Props {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  return (
    <div className="w-72 shrink-0 border-r border-gray-200 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-900">Sessions</div>
        <div className="text-xs text-gray-400">{sessions.length} total</div>
      </div>
      <div className="overflow-y-auto flex-1">
        {sessions.length === 0 && (
          <div className="px-4 py-8 text-xs text-gray-400 text-center">No sessions found</div>
        )}
        {sessions.map(s => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`w-full text-left px-4 py-3 border-b border-gray-100 ${
              selectedId === s.id ? 'bg-blue-50' : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <StatusBadge status={s.status} />
              <span className="text-[10px] text-gray-400">{formatRelative(s.lastActivityAt)}</span>
            </div>
            <div className="text-xs font-medium text-gray-800 truncate">{s.title}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">{s.turnCount} turns</div>
          </button>
        ))}
      </div>
    </div>
  );
}
