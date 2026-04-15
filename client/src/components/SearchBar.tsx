import { useState, useRef, useEffect } from 'react';
import type { SearchResult } from '@/types.ts';

interface Props {
  results: SearchResult[];
  loading: boolean;
  onSearch: (q: string) => void;
  onClear: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function SearchBar({
  results,
  loading,
  onSearch,
  onClear,
  onSelectSession,
}: Props) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleChange = (text: string) => {
    setValue(text);
    clearTimeout(timerRef.current);
    if (text.trim().length === 0) {
      onClear();
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      onSearch(text);
      setOpen(true);
    }, 300);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder="Search sessions..."
        className="w-full px-3 py-1.5 text-xs border border-gray-200
          rounded bg-white focus:outline-none focus:ring-1
          focus:ring-indigo-400"
      />
      {loading && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2
          text-[10px] text-gray-400">
          ...
        </span>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto
          bg-white border border-gray-200 rounded shadow-lg">
          {results.map(r => (
            <button
              key={r.sessionId}
              onClick={() => {
                onSelectSession(r.sessionId);
                setOpen(false);
                setValue('');
                onClear();
              }}
              className="w-full text-left px-3 py-2 hover:bg-gray-50
                border-b border-gray-50 last:border-0"
            >
              <div className="text-xs font-medium text-gray-800
                truncate">
                {r.title}
              </div>
              <div
                className="text-[10px] text-gray-500 mt-0.5 line-clamp-2
                  [&_mark]:bg-yellow-200 [&_mark]:rounded-sm"
                dangerouslySetInnerHTML={{ __html: r.snippet }}
              />
            </button>
          ))}
        </div>
      )}
      {open && !loading && results.length === 0 && value.trim() && (
        <div className="absolute z-50 mt-1 w-full bg-white border
          border-gray-200 rounded shadow-lg px-3 py-2 text-xs
          text-gray-400">
          No results
        </div>
      )}
    </div>
  );
}
