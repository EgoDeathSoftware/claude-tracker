import { useState, useEffect } from 'react';

interface OpenCodeAgentFile {
  name: string;
  content: string;
}

export function OpenCodeConfigPanel() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [agents, setAgents] = useState<OpenCodeAgentFile[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      fetch('/api/config/opencode').then(r => r.json()),
      fetch('/api/config/opencode/agents').then(r => r.json()),
    ]).then(([configData, agentsData]) => {
      if (cancelled) return;
      setConfig(configData);
      setAgents(agentsData);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-4 text-xs text-gray-400">
        Loading opencode configuration...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-2xl">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">
          OpenCode Configuration
        </h3>
        <p className="text-[11px] text-gray-400 mt-0.5">
          Read-only view of opencode&apos;s own configuration
          (opencode.json and agent definitions). Edit these files
          directly to make changes.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-gray-500">
          opencode.json
        </label>
        <pre className="w-full px-3 py-2 text-[11px] font-mono
          border border-gray-200 rounded bg-gray-50 overflow-x-auto
          whitespace-pre-wrap break-all">
          {JSON.stringify(config, null, 2)}
        </pre>
      </div>

      <div className="space-y-2">
        <label className="text-[11px] font-medium text-gray-500">
          Agents ({agents?.length ?? 0})
        </label>
        {agents && agents.length === 0 && (
          <div className="text-[11px] text-gray-400">
            No agent markdown files found.
          </div>
        )}
        {agents?.map(agent => (
          <details key={agent.name} className="border border-gray-200 rounded">
            <summary className="px-3 py-1.5 text-xs font-medium
              text-gray-700 cursor-pointer">
              {agent.name}
            </summary>
            <pre className="px-3 py-2 text-[11px] font-mono
              bg-gray-50 border-t border-gray-200 overflow-x-auto
              whitespace-pre-wrap break-all">
              {agent.content}
            </pre>
          </details>
        ))}
      </div>
    </div>
  );
}
