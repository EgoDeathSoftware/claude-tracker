import type { SessionStatus } from '@/types.ts';

const CONFIG: Record<SessionStatus, { label: string; classes: string }> = {
  live:    { label: '● LIVE',    classes: 'bg-blue-100 text-blue-700 font-semibold animate-pulse' },
  waiting: { label: '⏸ WAITING', classes: 'bg-amber-100 text-amber-700 font-semibold' },
  done:    { label: '✓ DONE',    classes: 'bg-green-100 text-green-700 font-semibold' },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const { label, classes } = CONFIG[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] ${classes}`}>
      {label}
    </span>
  );
}
