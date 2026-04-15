import { useState, useMemo } from 'react';
import { formatRelative, formatDuration } from '@/lib/format.ts';
import type { ToolCallEntry } from '@/types.ts';

type SortKey = 'timestamp' | 'duration' | 'tool';

interface Props {
  toolCalls: ToolCallEntry[];
}

export function ToolAuditLog({ toolCalls }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterTools, setFilterTools] = useState<Set<string> | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [showFilters, setShowFilters] = useState(false);

  const uniqueTools = useMemo(
    () => [...new Set(toolCalls.map(t => t.toolName))].sort(),
    [toolCalls],
  );

  const filtered = useMemo(() => {
    let result = filterTools
      ? toolCalls.filter(t => filterTools.has(t.toolName))
      : toolCalls;

    if (sortKey === 'duration') {
      result = [...result].sort(
        (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
      );
    } else if (sortKey === 'tool') {
      result = [...result].sort(
        (a, b) => a.toolName.localeCompare(b.toolName),
      );
    }
    return result;
  }, [toolCalls, filterTools, sortKey]);

  const totalDuration = useMemo(
    () => toolCalls.reduce((s, t) => s + (t.durationMs ?? 0), 0),
    [toolCalls],
  );

  const avgDuration = toolCalls.length > 0
    ? Math.round(totalDuration / toolCalls.length)
    : 0;

  if (toolCalls.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-gray-400">
        No tool calls in this session
      </div>
    );
  }

  function toggleTool(name: string) {
    setFilterTools(prev => {
      const current = prev ?? new Set(uniqueTools);
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next.size === uniqueTools.length ? null : next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-4 text-[11px] text-gray-500">
          <span><strong className="text-gray-700">{toolCalls.length}</strong> tool calls</span>
          <span><strong className="text-gray-700">{uniqueTools.length}</strong> unique tools</span>
          <span>Avg: <strong className="text-gray-700">{formatDuration(avgDuration)}</strong></span>
        </div>
      </div>

      {/* Filter + sort bar */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
        <button
          type="button"
          className="text-[10px] font-medium text-gray-500 hover:text-gray-700"
          onClick={() => setShowFilters(v => !v)}
        >
          {showFilters ? '▼' : '▶'} Filter tools
          {filterTools && (
            <span className="ml-1 text-gray-400">({filterTools.size} selected)</span>
          )}
        </button>
        <div className="flex gap-1">
          {(['timestamp', 'duration', 'tool'] as SortKey[]).map(key => (
            <button
              key={key}
              type="button"
              className={`px-2 py-0.5 rounded text-[10px] ${
                sortKey === key
                  ? 'bg-indigo-100 text-indigo-700'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
              onClick={() => setSortKey(key)}
            >
              {key}
            </button>
          ))}
        </div>
      </div>
      {showFilters && (
        <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-1.5">
          {uniqueTools.map(name => {
            const active = !filterTools || filterTools.has(name);
            return (
              <button
                key={name}
                type="button"
                className={`px-2 py-0.5 rounded text-[10px] border transition-opacity ${
                  active
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 opacity-100'
                    : 'border-gray-200 text-gray-400 opacity-50'
                }`}
                onClick={() => toggleTool(name)}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      {/* Tool call list */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
              <th className="px-4 py-1.5 font-medium w-20">Time</th>
              <th className="px-2 py-1.5 font-medium w-24">Tool</th>
              <th className="px-2 py-1.5 font-medium w-16 text-right">Duration</th>
              <th className="px-2 py-1.5 font-medium">Input</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(tc => {
              const isExpanded = expandedId === tc.toolUseId;
              return (
                <tr key={tc.toolUseId} className="group">
                  <td colSpan={4} className="p-0">
                    <button
                      type="button"
                      className={`w-full text-left flex items-start hover:bg-gray-50 ${
                        isExpanded ? 'bg-indigo-50' : ''
                      }`}
                      onClick={() => setExpandedId(isExpanded ? null : tc.toolUseId)}
                    >
                      <span className="px-4 py-1.5 text-gray-400 w-20 shrink-0">
                        {formatRelative(tc.timestamp)}
                      </span>
                      <span className="px-2 py-1.5 w-24 shrink-0">
                        <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium">
                          {tc.toolName}
                        </span>
                      </span>
                      <span className="px-2 py-1.5 text-gray-400 w-16 shrink-0 text-right font-mono">
                        {tc.durationMs !== undefined ? formatDuration(tc.durationMs) : '-'}
                      </span>
                      <span className="px-2 py-1.5 text-gray-600 truncate">
                        {summarizeInput(tc.toolName, tc.input)}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="mx-4 mb-2 space-y-2">
                        <div>
                          <div className="text-[10px] font-medium text-gray-400 uppercase mb-1">Input</div>
                          <pre className="p-2 bg-gray-900 text-green-400 rounded text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                            {JSON.stringify(tc.input, null, 2)}
                          </pre>
                        </div>
                        {tc.output !== undefined && (
                          <div>
                            <div className="text-[10px] font-medium text-gray-400 uppercase mb-1">Output</div>
                            <pre className="p-2 bg-gray-900 text-blue-400 rounded text-[11px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                              {tc.output}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function summarizeInput(toolName: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'Bash':
      return typeof obj['command'] === 'string' ? obj['command'] : '';
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof obj['file_path'] === 'string' ? obj['file_path'] : '';
    case 'Glob':
      return typeof obj['pattern'] === 'string' ? obj['pattern'] : '';
    case 'Grep':
      return typeof obj['pattern'] === 'string' ? obj['pattern'] : '';
    case 'Agent':
      return typeof obj['description'] === 'string' ? obj['description'] : '';
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}
