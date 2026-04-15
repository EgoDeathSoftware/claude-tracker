import { useState, useEffect, useMemo } from 'react';
import { formatRelative } from '@/lib/format.ts';
import type { RawLogEntry } from '@/types.ts';

interface RawLine {
  lineNumber: number;
  content: unknown;
}

const RECORD_TYPES = [
  'user', 'assistant', 'progress', 'file-history-snapshot',
  'permission-mode', 'attachment', 'system', 'agent-name',
  'custom-title', 'last-prompt', 'queue-operation',
] as const;

const TYPE_COLORS: Record<string, string> = {
  user: 'bg-gray-100 text-gray-700',
  assistant: 'bg-indigo-100 text-indigo-700',
  progress: 'bg-yellow-100 text-yellow-700',
  'file-history-snapshot': 'bg-cyan-100 text-cyan-700',
  'permission-mode': 'bg-red-100 text-red-700',
  attachment: 'bg-green-100 text-green-700',
  system: 'bg-purple-100 text-purple-700',
};

function TypeBadge({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${color}`}>
      {type}
    </span>
  );
}

interface Props {
  sessionId: string;
  logEntries: RawLogEntry[];
}

export function RawLogViewer({ sessionId, logEntries }: Props) {
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    () => new Set(RECORD_TYPES),
  );
  const [expandedLine, setExpandedLine] = useState<number | null>(null);
  const [rawContent, setRawContent] = useState<unknown>(null);
  const [showFilters, setShowFilters] = useState(false);

  const filtered = useMemo(
    () => logEntries.filter(e => activeFilters.has(e.type)),
    [logEntries, activeFilters],
  );

  useEffect(() => {
    setExpandedLine(null);
    setRawContent(null);
  }, [sessionId]);

  useEffect(() => {
    if (expandedLine === null) {
      setRawContent(null);
      return;
    }
    const offset = expandedLine - 1;
    void fetch(`/api/sessions/${sessionId}/raw?offset=${offset}&limit=1`)
      .then(r => r.json())
      .then((data: { lines: RawLine[] }) => {
        const line = data.lines[0];
        if (line) setRawContent(line.content);
      });
  }, [sessionId, expandedLine]);

  function toggleFilter(type: string) {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function selectAll() {
    setActiveFilters(new Set(RECORD_TYPES));
  }

  function selectNone() {
    setActiveFilters(new Set());
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="px-4 py-2 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-[10px] font-medium text-gray-500 hover:text-gray-700"
            onClick={() => setShowFilters(v => !v)}
          >
            {showFilters ? '▼' : '▶'} Filter by type
            <span className="ml-1 text-gray-400">
              ({filtered.length} / {logEntries.length})
            </span>
          </button>
          {showFilters && (
            <div className="flex gap-2 text-[10px]">
              <button
                type="button"
                className="text-indigo-500 hover:text-indigo-700"
                onClick={selectAll}
              >
                All
              </button>
              <button
                type="button"
                className="text-indigo-500 hover:text-indigo-700"
                onClick={selectNone}
              >
                None
              </button>
            </div>
          )}
        </div>
        {showFilters && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {RECORD_TYPES.map(type => (
              <button
                key={type}
                type="button"
                className={`px-2 py-0.5 rounded text-[10px] border transition-opacity ${
                  activeFilters.has(type)
                    ? 'border-gray-300 opacity-100'
                    : 'border-gray-200 opacity-40'
                }`}
                onClick={() => toggleFilter(type)}
              >
                <TypeBadge type={type} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-gray-400">
            No entries match the current filters
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <th className="px-4 py-1.5 font-medium w-10">#</th>
                <th className="px-2 py-1.5 font-medium w-24">Type</th>
                <th className="px-2 py-1.5 font-medium w-20">Time</th>
                <th className="px-2 py-1.5 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(entry => {
                const isExpanded = expandedLine === entry.lineNumber;
                return (
                  <tr
                    key={entry.lineNumber}
                    className="group"
                  >
                    <td colSpan={4} className="p-0">
                      <button
                        type="button"
                        className={`w-full text-left flex items-start px-0 py-0 hover:bg-gray-50 ${
                          isExpanded ? 'bg-indigo-50' : ''
                        }`}
                        onClick={() =>
                          setExpandedLine(
                            isExpanded ? null : entry.lineNumber,
                          )
                        }
                      >
                        <span className="px-4 py-1.5 text-gray-300 w-10 shrink-0 font-mono">
                          {entry.lineNumber}
                        </span>
                        <span className="px-2 py-1.5 w-24 shrink-0">
                          <TypeBadge type={entry.type} />
                        </span>
                        <span className="px-2 py-1.5 text-gray-400 w-20 shrink-0">
                          {entry.timestamp
                            ? formatRelative(entry.timestamp)
                            : ''}
                        </span>
                        <span className="px-2 py-1.5 text-gray-600 truncate">
                          {entry.summary}
                        </span>
                      </button>
                      {isExpanded && rawContent !== null && (
                        <div className="mx-4 mb-2 p-3 bg-gray-900 text-green-400 rounded text-[11px] font-mono overflow-x-auto">
                          <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(rawContent, null, 2)}
                          </pre>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
