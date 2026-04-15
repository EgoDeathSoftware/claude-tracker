import { useState, useEffect, useCallback } from 'react';
import type { Tag } from '@/types.ts';

export function useSessionTags(sessionId: string | null) {
  const [tags, setTags] = useState<Tag[]>([]);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    void fetch(`/api/sessions/${sessionId}/tags`)
      .then(r => r.json())
      .then(setTags);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setTags([]);
      return;
    }
    refresh();
  }, [sessionId, refresh]);

  const addTag = useCallback(
    async (name: string) => {
      if (!sessionId) return;
      await fetch(`/api/sessions/${sessionId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      refresh();
    },
    [sessionId, refresh],
  );

  const removeTag = useCallback(
    async (tagId: number) => {
      if (!sessionId) return;
      await fetch(`/api/sessions/${sessionId}/tags/${tagId}`, {
        method: 'DELETE',
      });
      refresh();
    },
    [sessionId, refresh],
  );

  return { tags, addTag, removeTag };
}

export function useAllTags() {
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    void fetch('/api/tags').then(r => r.json()).then(setTags);
  }, []);

  return tags;
}
