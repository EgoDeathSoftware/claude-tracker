import { useEffect } from 'react';
import type { SessionMeta } from '@/types.ts';

type SSEHandler = (session: SessionMeta) => void;

export function useSSE(onCreated: SSEHandler, onUpdated: SSEHandler) {
  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('session-created', e => {
      onCreated(JSON.parse((e as MessageEvent<string>).data) as SessionMeta);
    });
    es.addEventListener('session-updated', e => {
      onUpdated(JSON.parse((e as MessageEvent<string>).data) as SessionMeta);
    });
    es.addEventListener('sources-changed', () => {
      window.dispatchEvent(new Event('tracker:sources-changed'));
    });

    return () => es.close();
  }, [onCreated, onUpdated]);
}
