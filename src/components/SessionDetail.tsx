import type { Session } from '@/types.ts';

interface Props {
  session: Session | null;
}

export function SessionDetail({ session }: Props) {
  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        Select a session to view details
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-semibold text-gray-900">{session.title}</div>
        <div className="text-xs text-gray-400 mt-0.5">{session.id}</div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 text-xs text-gray-500">
        <pre className="whitespace-pre-wrap">{JSON.stringify(session, null, 2).slice(0, 500)}</pre>
      </div>
    </div>
  );
}
