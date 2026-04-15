import { useMemo } from 'react';
import { formatCost } from '@/lib/format.ts';
import type { CostBreakdown as CostBreakdownType } from '@/types.ts';

interface Props {
  costBreakdown: CostBreakdownType;
}

interface ToolRow {
  name: string;
  calls: number;
  cost: number;
  pct: number;
}

export function CostBreakdown({ costBreakdown }: Props) {
  const { byTool, conversationCost, toolCost, totalCost } = costBreakdown;

  const toolRows = useMemo((): ToolRow[] => {
    return Object.entries(byTool)
      .map(([name, data]) => ({
        name,
        calls: data.calls,
        cost: data.cost,
        pct: totalCost > 0 ? (data.cost / totalCost) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  }, [byTool, totalCost]);

  const conversationPct = totalCost > 0
    ? (conversationCost / totalCost) * 100
    : 0;
  const toolPct = totalCost > 0
    ? (toolCost / totalCost) * 100
    : 0;

  if (totalCost === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-gray-400">
        No cost data available
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Overview */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="text-[11px] text-gray-500 mb-2">
          Total: <strong className="text-gray-700">{formatCost(totalCost)}</strong>
        </div>
        {/* Split bar */}
        <div className="flex rounded-full overflow-hidden h-3 bg-gray-200">
          {toolPct > 0 && (
            <div
              className="bg-indigo-400 transition-all"
              style={{ width: `${toolPct}%` }}
              title={`Tool cost: ${formatCost(toolCost)}`}
            />
          )}
          {conversationPct > 0 && (
            <div
              className="bg-emerald-400 transition-all"
              style={{ width: `${conversationPct}%` }}
              title={`Conversation cost: ${formatCost(conversationCost)}`}
            />
          )}
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-gray-400">
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-indigo-400 mr-1" />
            Tools: {formatCost(toolCost)} ({toolPct.toFixed(0)}%)
          </span>
          <span>
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1" />
            Conversation: {formatCost(conversationCost)} ({conversationPct.toFixed(0)}%)
          </span>
        </div>
      </div>

      {/* Per-tool breakdown */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Cost by tool
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wide">
                <th className="py-1 font-medium">Tool</th>
                <th className="py-1 font-medium text-right w-12">Calls</th>
                <th className="py-1 font-medium text-right w-16">Cost</th>
                <th className="py-1 font-medium text-right w-12">%</th>
                <th className="py-1 font-medium w-32 pl-3">Bar</th>
              </tr>
            </thead>
            <tbody>
              {toolRows.map(row => (
                <tr key={row.name} className="border-t border-gray-50">
                  <td className="py-1.5">
                    <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium">
                      {row.name}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-gray-500 font-mono">
                    {row.calls}
                  </td>
                  <td className="py-1.5 text-right text-gray-700 font-mono">
                    {formatCost(row.cost)}
                  </td>
                  <td className="py-1.5 text-right text-gray-400 font-mono">
                    {row.pct.toFixed(0)}%
                  </td>
                  <td className="py-1.5 pl-3">
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-indigo-400 rounded-full h-2 transition-all"
                        style={{ width: `${row.pct}%`, minWidth: row.pct > 0 ? '2px' : '0' }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
