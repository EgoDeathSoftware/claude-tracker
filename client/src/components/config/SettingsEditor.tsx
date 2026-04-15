import { useState, useEffect } from 'react';
import { useConfigJson } from '@/hooks/useConfig.ts';

interface SettingsJson {
  [key: string]: unknown;
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  hooks?: Record<string, unknown[]>;
  env?: Record<string, string>;
}

export function SettingsEditor() {
  const { data, loading, save } = useConfigJson<SettingsJson>(
    '/api/config/settings',
  );
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setRaw(JSON.stringify(data, null, 2));
  }, [data]);

  const handleSave = async () => {
    try {
      const parsed = JSON.parse(raw) as SettingsJson;
      setError('');
      await save(parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError('Invalid JSON');
    }
  };

  if (loading) {
    return (
      <div className="p-4 text-xs text-gray-400">
        Loading settings...
      </div>
    );
  }

  // Extract key sections for the summary
  const permDeny = data?.permissions?.deny ?? [];
  const envVars = data?.env ?? {};
  const hookGroups = data?.hooks ?? {};

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          settings.json
        </h3>
        <span className="text-[10px] text-gray-400">
          ~/.claude/settings.json
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-[10px]">
        <div className="border border-gray-100 rounded p-2">
          <div className="font-medium text-gray-500 mb-1">
            Denied Permissions
          </div>
          <div className="text-gray-800">{permDeny.length} rules</div>
        </div>
        <div className="border border-gray-100 rounded p-2">
          <div className="font-medium text-gray-500 mb-1">
            Environment Variables
          </div>
          <div className="text-gray-800">
            {Object.keys(envVars).length} vars
          </div>
        </div>
        <div className="border border-gray-100 rounded p-2">
          <div className="font-medium text-gray-500 mb-1">
            Hook Events
          </div>
          <div className="text-gray-800">
            {Object.keys(hookGroups).length} events
          </div>
        </div>
      </div>

      <textarea
        value={raw}
        onChange={e => { setRaw(e.target.value); setError(''); }}
        spellCheck={false}
        className="w-full h-[400px] font-mono text-[11px] p-3 border
          border-gray-200 rounded bg-gray-50 resize-y
          focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />

      {error && (
        <div className="text-xs text-red-500">{error}</div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          className="px-3 py-1.5 text-xs bg-indigo-500 text-white
            rounded hover:bg-indigo-600"
        >
          Save
        </button>
        {saved && (
          <span className="text-xs text-green-600">Saved</span>
        )}
      </div>
    </div>
  );
}
