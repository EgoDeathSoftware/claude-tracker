import { useState, useEffect, useCallback } from 'react';
import type { Prompt } from '@/types.ts';

export function usePrompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);

  const refresh = useCallback(() => {
    void fetch('/api/prompts').then(r => r.json()).then(setPrompts);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(
    async (name: string, content: string) => {
      await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      refresh();
    },
    [refresh],
  );

  const update = useCallback(
    async (id: number, name: string, content: string) => {
      await fetch(`/api/prompts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: number) => {
      await fetch(`/api/prompts/${id}`, { method: 'DELETE' });
      refresh();
    },
    [refresh],
  );

  return { prompts, create, update, remove };
}
