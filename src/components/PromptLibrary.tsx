import { useState } from 'react';
import { usePrompts } from '@/hooks/usePrompts.ts';
import type { Prompt } from '@/types.ts';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function PromptLibrary({ open, onClose }: Props) {
  const { prompts, create, update, remove } = usePrompts();
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');

  if (!open) return null;

  const startCreate = () => {
    setEditing(null);
    setName('');
    setContent('');
  };

  const startEdit = (p: Prompt) => {
    setEditing(p);
    setName(p.name);
    setContent(p.content);
  };

  const save = async () => {
    if (!name.trim() || !content.trim()) return;
    if (editing) {
      await update(editing.id, name, content);
    } else {
      await create(name, content);
    }
    setName('');
    setContent('');
    setEditing(null);
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center
      bg-black/30">
      <div className="bg-white rounded-lg shadow-xl w-[600px] max-h-[80vh]
        flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex
          items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            Prompt Library
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg
              leading-none"
          >
            x
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {prompts.map(p => (
            <div
              key={p.id}
              className="border border-gray-100 rounded p-3
                hover:border-gray-200"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-800">
                  {p.name}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => copyToClipboard(p.content)}
                    className="text-[10px] text-gray-400
                      hover:text-indigo-500"
                  >
                    copy
                  </button>
                  <button
                    onClick={() => startEdit(p)}
                    className="text-[10px] text-gray-400
                      hover:text-indigo-500"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => remove(p.id)}
                    className="text-[10px] text-gray-400
                      hover:text-red-500"
                  >
                    delete
                  </button>
                </div>
              </div>
              <pre className="text-[11px] text-gray-600 whitespace-pre-wrap
                max-h-24 overflow-y-auto">
                {p.content}
              </pre>
            </div>
          ))}

          {prompts.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-6">
              No prompts yet. Create one below.
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 p-4 space-y-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Prompt name"
            className="w-full px-3 py-1.5 text-xs border border-gray-200
              rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder="Prompt content..."
            rows={3}
            className="w-full px-3 py-1.5 text-xs border border-gray-200
              rounded resize-none focus:outline-none focus:ring-1
              focus:ring-indigo-400"
          />
          <div className="flex justify-end gap-2">
            {editing && (
              <button
                onClick={startCreate}
                className="px-3 py-1 text-xs text-gray-500
                  hover:text-gray-700"
              >
                Cancel edit
              </button>
            )}
            <button
              onClick={save}
              disabled={!name.trim() || !content.trim()}
              className="px-3 py-1.5 text-xs bg-indigo-500 text-white
                rounded hover:bg-indigo-600 disabled:opacity-40"
            >
              {editing ? 'Update' : 'Save'} Prompt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
