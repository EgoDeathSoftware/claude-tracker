import { useState, useEffect, useCallback } from 'react';

interface HookScript {
  name: string;
  path: string;
  content: string;
}

interface SettingsHooks {
  [event: string]: {
    matcher: string;
    hooks: { type: string; command: string }[];
  }[];
}

export function HooksManager() {
  const [scripts, setScripts] = useState<HookScript[]>([]);
  const [hookConfig, setHookConfig] = useState<SettingsHooks>({});
  const [selected, setSelected] = useState<HookScript | null>(null);
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<'scripts' | 'config'>('config');

  const refreshScripts = useCallback(() => {
    void fetch('/api/config/hooks')
      .then(r => r.json())
      .then((data: HookScript[]) => {
        setScripts(data);
        if (!selected && data.length > 0) {
          setSelected(data[0]!);
          setContent(data[0]!.content);
        }
      });
  }, [selected]);

  const refreshConfig = useCallback(() => {
    void fetch('/api/config/settings')
      .then(r => r.json())
      .then((data: { hooks?: SettingsHooks }) => {
        setHookConfig(data.hooks ?? {});
      });
  }, []);

  useEffect(() => {
    refreshScripts();
    refreshConfig();
  }, [refreshScripts, refreshConfig]);

  const handleSelect = (s: HookScript) => {
    setSelected(s);
    setContent(s.content);
    setSaved(false);
  };

  const handleSave = async () => {
    if (!selected) return;
    await fetch(`/api/config/hooks/${selected.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    refreshScripts();
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Hooks
        </h3>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setTab('config')}
          className={`px-3 py-1 text-xs rounded border
            ${tab === 'config'
              ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
        >
          Hook Config
        </button>
        <button
          onClick={() => setTab('scripts')}
          className={`px-3 py-1 text-xs rounded border
            ${tab === 'scripts'
              ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
        >
          Scripts ({scripts.length})
        </button>
      </div>

      {tab === 'config' && (
        <div className="space-y-3">
          {Object.entries(hookConfig).map(([event, groups]) => (
            <div
              key={event}
              className="border border-gray-100 rounded p-3"
            >
              <div className="text-xs font-medium text-gray-800 mb-2">
                {event}
              </div>
              {groups.map((group, i) => (
                <div
                  key={i}
                  className="ml-2 mb-2 border-l-2 border-gray-200
                    pl-3"
                >
                  <div className="text-[10px] text-indigo-600
                    font-medium mb-1">
                    matcher: {group.matcher}
                  </div>
                  {group.hooks.map((hook, j) => (
                    <div
                      key={j}
                      className="text-[10px] text-gray-600 font-mono
                        bg-gray-50 rounded px-2 py-1 mb-1 break-all"
                    >
                      {hook.command.length > 80
                        ? hook.command.slice(0, 80) + '...'
                        : hook.command}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
          {Object.keys(hookConfig).length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">
              No hooks configured in settings.json
            </div>
          )}
          <div className="text-[10px] text-gray-400">
            Edit hooks in the Settings tab for full JSON control
          </div>
        </div>
      )}

      {tab === 'scripts' && (
        <>
          <div className="flex gap-2 flex-wrap">
            {scripts.map(s => (
              <button
                key={s.name}
                onClick={() => handleSelect(s)}
                className={`px-3 py-1 text-xs rounded border
                  ${selected?.name === s.name
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
              >
                {s.name}
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
                className="w-full h-[350px] font-mono text-[11px] p-3
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

          {scripts.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">
              No hook scripts in ~/.claude/hooks/
            </div>
          )}
        </>
      )}
    </div>
  );
}
