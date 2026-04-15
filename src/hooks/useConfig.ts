import { useState, useEffect, useCallback } from 'react';

export function useConfigJson<T>(endpoint: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    void fetch(endpoint)
      .then(r => r.json())
      .then((d: T) => { setData(d); setLoading(false); });
  }, [endpoint]);

  useEffect(() => { refresh(); }, [refresh]);

  const save = useCallback(
    async (value: T) => {
      await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      setData(value);
    },
    [endpoint],
  );

  return { data, loading, refresh, save };
}
