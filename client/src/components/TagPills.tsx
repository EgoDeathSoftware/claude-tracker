import { useState } from 'react';
import type { Tag } from '@/types.ts';

interface Props {
  tags: Tag[];
  onAdd: (name: string) => void;
  onRemove: (tagId: number) => void;
  compact?: boolean | undefined;
}

export function TagPills({ tags, onAdd, onRemove, compact }: Props) {
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');

  const submit = () => {
    const name = input.trim();
    if (name) {
      onAdd(name);
      setInput('');
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map(t => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 px-2 py-0.5
            bg-indigo-50 text-indigo-700 rounded-full text-[10px]
            font-medium"
        >
          {t.name}
          <button
            onClick={() => onRemove(t.id)}
            className="hover:text-red-500 text-indigo-400 font-bold
              leading-none"
          >
            x
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') { setAdding(false); setInput(''); }
          }}
          onBlur={submit}
          placeholder="tag name"
          className="px-2 py-0.5 text-[10px] border border-gray-200
            rounded-full w-20 focus:outline-none focus:ring-1
            focus:ring-indigo-300"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className={`text-gray-400 hover:text-indigo-500
            ${compact ? 'text-[10px]' : 'text-xs'}`}
        >
          + tag
        </button>
      )}
    </div>
  );
}
