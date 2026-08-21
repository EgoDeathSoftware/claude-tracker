import type { SourceKind } from '@/hooks/useSources.ts';

interface Props {
  kinds: SourceKind[];
}

const kindColors: Record<SourceKind, string> = {
  'claude-code': 'text-orange-500',
  'opencode': 'text-blue-500',
};

export function SourceKindDots({ kinds }: Props) {
  const uniqueKinds = Array.from(new Set(kinds));

  return (
    <div className="flex gap-1 items-center">
      {uniqueKinds.map(kind => (
        <span key={kind} title={kind} className={`text-sm ${kindColors[kind]}`}>
          ●
        </span>
      ))}
    </div>
  );
}
