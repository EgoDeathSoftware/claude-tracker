import { useState, useEffect, useCallback } from 'react';

interface McpServer {
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export function McpManager() {
  const [servers, setServers] = useState<Record<string, McpServer>>(
    {},
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [editJson, setEditJson] = useState('');
  const [addName, setAddName] = useState('');
  const [addJson, setAddJson] = useState(
    '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}',
  );
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(() => {
    void fetch('/api/config/mcp')
      .then(r => r.json())
      .then(setServers);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const startEdit = (name: string) => {
    setEditing(name);
    setEditJson(JSON.stringify(servers[name], null, 2));
    setError('');
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const parsed = JSON.parse(editJson) as McpServer;
      setError('');
      await fetch(`/api/config/mcp/${editing}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setEditing(null);
      refresh();
    } catch {
      setError('Invalid JSON');
    }
  };

  const remove = async (name: string) => {
    await fetch(`/api/config/mcp/${name}`, { method: 'DELETE' });
    setEditing(null);
    refresh();
  };

  const addServer = async () => {
    if (!addName.trim()) { setError('Name required'); return; }
    try {
      const parsed = JSON.parse(addJson) as McpServer;
      setError('');
      await fetch(`/api/config/mcp/${addName.trim()}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      setAddName('');
      setAddJson(
        '{\n  "type": "stdio",\n  "command": "",\n  "args": []\n}',
      );
      setShowAdd(false);
      refresh();
    } catch {
      setError('Invalid JSON');
    }
  };

  const names = Object.keys(servers).sort();

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          MCP Servers
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-indigo-500 hover:text-indigo-700"
        >
          {showAdd ? 'Cancel' : '+ Add Server'}
        </button>
      </div>

      {showAdd && (
        <div className="border border-indigo-200 rounded p-3
          bg-indigo-50/50 space-y-2">
          <input
            value={addName}
            onChange={e => setAddName(e.target.value)}
            placeholder="Server name (e.g. my-server)"
            className="w-full px-3 py-1.5 text-xs border
              border-gray-200 rounded focus:outline-none focus:ring-1
              focus:ring-indigo-400"
          />
          <textarea
            value={addJson}
            onChange={e => setAddJson(e.target.value)}
            spellCheck={false}
            rows={5}
            className="w-full font-mono text-[11px] p-2 border
              border-gray-200 rounded bg-white resize-none
              focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
          <button
            onClick={addServer}
            className="px-3 py-1.5 text-xs bg-indigo-500 text-white
              rounded hover:bg-indigo-600"
          >
            Add
          </button>
        </div>
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      <div className="space-y-2">
        {names.map(name => {
          const srv = servers[name]!;
          const isEditing = editing === name;

          return (
            <div
              key={name}
              className="border border-gray-100 rounded p-3"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-800">
                    {name}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5
                    rounded-full ${
                    srv.type === 'stdio'
                      ? 'bg-blue-50 text-blue-600'
                      : 'bg-amber-50 text-amber-600'
                  }`}>
                    {srv.type}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      isEditing
                        ? setEditing(null)
                        : startEdit(name);
                    }}
                    className="text-[10px] text-gray-400
                      hover:text-indigo-500"
                  >
                    {isEditing ? 'cancel' : 'edit'}
                  </button>
                  <button
                    onClick={() => remove(name)}
                    className="text-[10px] text-gray-400
                      hover:text-red-500"
                  >
                    remove
                  </button>
                </div>
              </div>

              {!isEditing && (
                <div className="text-[10px] text-gray-500 font-mono">
                  {srv.command && (
                    <span>
                      {srv.command}
                      {srv.args?.length
                        ? ` ${srv.args.join(' ')}`
                        : ''}
                    </span>
                  )}
                  {srv.url && <span>{srv.url}</span>}
                </div>
              )}

              {isEditing && (
                <div className="mt-2 space-y-2">
                  <textarea
                    value={editJson}
                    onChange={e => setEditJson(e.target.value)}
                    spellCheck={false}
                    rows={6}
                    className="w-full font-mono text-[11px] p-2 border
                      border-gray-200 rounded bg-gray-50 resize-none
                      focus:outline-none focus:ring-1
                      focus:ring-indigo-400"
                  />
                  <button
                    onClick={saveEdit}
                    className="px-3 py-1 text-xs bg-indigo-500
                      text-white rounded hover:bg-indigo-600"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {names.length === 0 && (
        <div className="text-xs text-gray-400 text-center py-4">
          No MCP servers configured
        </div>
      )}
    </div>
  );
}
