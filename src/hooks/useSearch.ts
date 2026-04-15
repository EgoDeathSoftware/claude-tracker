import { useState, useCallback } from 'react';
import type { SearchResult } from '@/types.ts';

export function useSearch(projectId?: string) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const search = useCallback(
    async (q: string) => {
      setQuery(q);
      if (q.trim().length === 0) {
        setResults([]);
        return;
      }
      setLoading(true);
      const params = new URLSearchParams({ q });
      if (projectId) params.set('projectId', projectId);
      const res = await fetch(`/api/search?${params}`);
      const data = (await res.json()) as SearchResult[];
      setResults(data);
      setLoading(false);
    },
    [projectId],
  );

  const clear = useCallback(() => {
    setQuery('');
    setResults([]);
  }, []);

  return { results, loading, query, search, clear };
}
