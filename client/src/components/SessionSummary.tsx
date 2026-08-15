import { useState, useEffect } from 'react';
import { StatusBadge } from '@/components/StatusBadge.tsx';
import { formatDuration, formatCost, formatRelative } from '@/lib/format.ts';
import type { Session, AiSummary } from '@/types.ts';

type GenerateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'error'; error: string };

export function SessionSummary({ session }: { session: Session }) {
  const [aiSummary, setAiSummary] = useState<AiSummary | undefined>(
    session.aiSummary,
  );
  const [state, setState] = useState<GenerateState>({ status: 'idle' });

  useEffect(() => {
    setAiSummary(session.aiSummary);
    setState({ status: 'idle' });
  }, [session.id, session.aiSummary]);

  const generate = async () => {
    setState({ status: 'generating' });
    try {
      const res = await fetch(`/api/sessions/${session.id}/summarize`, {
        method: 'POST',
      });
      const body = await res.json() as AiSummary & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'failed to generate summary');
      setAiSummary(body);
      setState({ status: 'idle' });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const latestRecap = session.recaps.at(-1);
  const isStale = aiSummary
    && new Date(session.lastActivityAt).getTime()
      > new Date(aiSummary.sourceLastActivityAt).getTime();

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

      {latestRecap && (
        <div className="mt-3 border border-indigo-100 bg-indigo-50/60 rounded p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-indigo-500 uppercase tracking-wide mb-1">
            <span>Claude recap</span>
            <span className="font-normal normal-case text-indigo-300">
              · {formatRelative(latestRecap.timestamp)}
            </span>
          </div>
          <div className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
            {latestRecap.content}
          </div>
        </div>
      )}

      <div className="mt-3 border border-gray-200 rounded p-2.5">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
            AI Summary
          </div>
          <button
            onClick={generate}
            disabled={state.status === 'generating'}
            className="text-[10px] text-indigo-500 hover:text-indigo-700
              disabled:opacity-50"
          >
            {state.status === 'generating'
              ? 'Summarizing...'
              : aiSummary ? 'Regenerate' : 'Summarize'}
          </button>
        </div>

        {aiSummary && (
          <>
            <div className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
              {aiSummary.content}
            </div>
            <div className="mt-1.5 text-[10px] text-gray-400">
              {aiSummary.model} · {formatRelative(aiSummary.generatedAt)}
              {isStale && (
                <span className="text-amber-500">
                  {' '}· session has new activity since this summary
                </span>
              )}
            </div>
          </>
        )}

        {!aiSummary && state.status !== 'error' && (
          <div className="text-xs text-gray-400">
            No summary yet — click Summarize to generate one.
          </div>
        )}

        {state.status === 'error' && (
          <div className="text-xs text-red-500">{state.error}</div>
        )}
      </div>
    </div>
  );
}
