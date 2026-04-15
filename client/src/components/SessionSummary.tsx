import { StatusBadge } from '@/components/StatusBadge.tsx';
import { formatDuration, formatCost, formatRelative } from '@/lib/format.ts';
import type { Session } from '@/types.ts';

export function SessionSummary({ session }: { session: Session }) {
  return (
    <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Summary</div>
      <div className="text-xs text-gray-700 leading-relaxed mb-3">{session.title}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400 items-center">
        <StatusBadge status={session.status} />
        <span>Model: {session.model}</span>
        <span>{formatCost(session.costUsd)}</span>
        <span>{session.turnCount} turns</span>
        {session.durationMs > 0 && <span>{formatDuration(session.durationMs)}</span>}
        <span>{formatRelative(session.startedAt)}</span>
      </div>
      {session.cwd && (
        <div className="mt-2 text-[10px] text-gray-400 font-mono truncate">{session.cwd}</div>
      )}
    </div>
  );
}
