import { useEffect } from 'react';
import type { Session } from '@/types.ts';

type SSEHandler = (session: Session) => void;

export function useSSE(onCreated: SSEHandler, onUpdated: SSEHandler) {
  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('session-created', e => {
      onCreated(JSON.parse((e as MessageEvent<string>).data) as Session);
    });
    es.addEventListener('session-updated', e => {
      onUpdated(JSON.parse((e as MessageEvent<string>).data) as Session);
    });

    return () => es.close();
  }, [onCreated, onUpdated]);
}
