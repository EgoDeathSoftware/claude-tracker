import { useEffect, useState } from 'react';
import { SessionSummary } from '@/components/SessionSummary.tsx';
import { ConversationThread } from '@/components/ConversationThread.tsx';
import type { Session } from '@/types.ts';

interface Props {
  session: Session | null;
}

export function SessionDetail({ session }: Props) {
  const [fullSession, setFullSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!session) {
      setFullSession(null);
      return;
    }
    void fetch(`/api/sessions/${session.id}`)
      .then(r => r.json())
      .then(setFullSession);
  }, [session?.id]);

  if (!fullSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        {session ? 'Loading…' : 'Select a session to view details'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-semibold text-gray-900 truncate">{fullSession.title}</div>
        <div className="text-xs text-gray-400 mt-0.5">{formatMeta(fullSession)}</div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <SessionSummary session={fullSession} />
        <ConversationThread messages={fullSession.messages} />
      </div>
    </div>
  );
}

function formatMeta(s: Session): string {
  return `${s.slug || s.id} · started ${new Date(s.startedAt).toLocaleString()}`;
}
