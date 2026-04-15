import { useState, useEffect, useCallback } from 'react';

interface ClaudeMdFile {
  path: string;
  name: string;
  content: string;
}

export function ClaudeMdEditor() {
  const [files, setFiles] = useState<ClaudeMdFile[]>([]);
  const [selected, setSelected] = useState<ClaudeMdFile | null>(null);
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    void fetch('/api/config/claude-md')
      .then(r => r.json())
      .then((data: ClaudeMdFile[]) => {
        setFiles(data);
        if (data.length > 0 && !selected) {
          setSelected(data[0]!);
          setContent(data[0]!.content);
        }
      });
  }, [selected]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSelect = (f: ClaudeMdFile) => {
    setSelected(f);
    setContent(f.content);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!selected) return;
    await fetch('/api/config/claude-md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected.path, content }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    refresh();
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          CLAUDE.md Files
        </h3>
      </div>

      {files.length === 0 ? (
        <div className="text-xs text-gray-400 py-4 text-center">
          No CLAUDE.md files found
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            {files.map(f => (
              <button
                key={f.path}
                onClick={() => handleSelect(f)}
                className={`px-3 py-1 text-xs rounded border
                  ${selected?.path === f.path
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
              >
                {f.name}
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div className="text-[10px] text-gray-400">
                {selected.path}
              </div>
              <textarea
                value={content}
                onChange={e => {
                  setContent(e.target.value);
                  setSaved(false);
                }}
                spellCheck={false}
                className="w-full h-[400px] font-mono text-[11px] p-3
                  border border-gray-200 rounded bg-gray-50 resize-y
                  focus:outline-none focus:ring-1
                  focus:ring-indigo-400"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  className="px-3 py-1.5 text-xs bg-indigo-500
                    text-white rounded hover:bg-indigo-600"
                >
                  Save
                </button>
                {saved && (
                  <span className="text-xs text-green-600">
                    Saved
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
