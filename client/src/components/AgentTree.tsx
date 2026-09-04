import { formatDuration, formatCost, formatRelative } from '@/lib/format.ts';
import type { SubagentInfo, ToolCallEntry } from '@/types.ts';

interface Props {
  subagents: SubagentInfo[];
  agentToolCalls: ToolCallEntry[];
  sessionTitle: string;
  onSelectSubagent: (sessionId: string) => void;
}

export function AgentTree({ subagents, agentToolCalls, sessionTitle, onSelectSubagent }: Props) {
  if (subagents.length === 0 && agentToolCalls.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-gray-400">
        No subagent activity in this session
      </div>
    );
  }

  const totalSubagentCost = subagents.reduce(
    (sum, s) => sum + s.costUsd,
    0,
  );
  const totalSubagentTurns = subagents.reduce(
    (sum, s) => sum + s.turnCount,
    0,
  );

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-4 text-[11px] text-gray-500">
          <span>
            <strong className="text-gray-700">{agentToolCalls.length}</strong> Agent calls
          </span>
          <span>
            <strong className="text-gray-700">{subagents.length}</strong> subagents found
          </span>
          {totalSubagentCost > 0 && (
            <span>
              Subagent cost: <strong className="text-gray-700">{formatCost(totalSubagentCost)}</strong>
            </span>
          )}
          {totalSubagentTurns > 0 && (
            <span>
              <strong className="text-gray-700">{totalSubagentTurns}</strong> subagent turns
            </span>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Root node (parent session) */}
        <div className="flex items-center gap-2 mb-3">
          <span className="w-5 h-5 rounded-full bg-indigo-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            P
          </span>
          <span className="text-[11px] font-medium text-gray-800 truncate">
            {sessionTitle}
          </span>
        </div>

        {/* Agent tool calls with linked subagents */}
        {agentToolCalls.map((tc, i) => {
          const input = tc.input as
            | { description?: string; subagent_type?: string; prompt?: string }
            | null;
          const linked = subagents[i];

          return (
            <div key={tc.toolUseId} className="ml-5 mb-3">
              {/* Connector */}
              <div className="flex items-stretch">
                <div className="w-5 flex flex-col items-center shrink-0">
                  <div className="w-px flex-1 bg-gray-300" />
                  <div className="w-2 h-2 rounded-full bg-yellow-400 shrink-0 my-0.5" />
                  <div className="w-px flex-1 bg-gray-300" />
                </div>

                <div className="ml-2 flex-1 min-w-0 border border-gray-200 rounded-lg p-2.5">
                  {/* Agent call header */}
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-700">
                      Agent
                    </span>
                    {input?.subagent_type && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-700">
                        {input.subagent_type}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-400">
                      {formatRelative(tc.timestamp)}
                    </span>
                    {tc.durationMs !== undefined && (
                      <span className="text-[10px] text-gray-400 font-mono">
                        {formatDuration(tc.durationMs)}
                      </span>
                    )}
                  </div>

                  {/* Description */}
                  {input?.description && (
                    <div className="text-[11px] text-gray-700 mb-1.5">
                      {input.description}
                    </div>
                  )}

                  {/* Prompt preview */}
                  {input?.prompt && (
                    <div className="text-[10px] text-gray-400 truncate mb-1.5">
                      {input.prompt.slice(0, 120)}
                      {input.prompt.length > 120 ? '...' : ''}
                    </div>
                  )}

                  {/* Linked subagent info */}
                  {linked ? (
                    <button
                      onClick={() => onSelectSubagent(linked.sessionId)}
                      className="mt-1.5 p-2 bg-gray-50 rounded border border-gray-100
                        w-full text-left hover:bg-gray-100 hover:border-gray-200"
                    >
                      <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-500">
                        <span className="w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                          S
                        </span>
                        <span className="font-medium text-gray-700">
                          {linked.sessionId.slice(0, 12)}...
                        </span>
                        <span>{linked.turnCount} turns</span>
                        <span>{formatCost(linked.costUsd)}</span>
                        <span>{linked.model}</span>
                        {linked.durationMs > 0 && (
                          <span>{formatDuration(linked.durationMs)}</span>
                        )}
                      </div>
                    </button>
                  ) : (
                    <div className="mt-1.5 text-[10px] text-gray-400 italic">
                      No subagent file found
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Orphan subagents (not matched to an Agent tool call) */}
        {subagents.slice(agentToolCalls.length).map(sub => (
          <div key={sub.sessionId} className="ml-5 mb-3">
            <div className="flex items-stretch">
              <div className="w-5 flex flex-col items-center shrink-0">
                <div className="w-px flex-1 bg-gray-300" />
                <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 my-0.5" />
                <div className="w-px flex-1 bg-gray-300" />
              </div>
              <button
                onClick={() => onSelectSubagent(sub.sessionId)}
                className="ml-2 flex-1 min-w-0 border border-gray-200 rounded-lg p-2.5
                  text-left hover:bg-gray-50 hover:border-gray-300"
              >
                <div className="flex items-center gap-2 flex-wrap text-[10px] text-gray-500">
                  <span className="w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                    S
                  </span>
                  <span className="font-medium text-gray-700">
                    {sub.sessionId.slice(0, 12)}...
                  </span>
                  <span>{sub.turnCount} turns</span>
                  <span>{formatCost(sub.costUsd)}</span>
                  <span>{sub.model}</span>
                  {sub.durationMs > 0 && (
                    <span>{formatDuration(sub.durationMs)}</span>
                  )}
                </div>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
