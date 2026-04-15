import { useState } from 'react';
import { SettingsEditor } from '@/components/config/SettingsEditor.tsx';
import { ClaudeMdEditor } from '@/components/config/ClaudeMdEditor.tsx';
import { McpManager } from '@/components/config/McpManager.tsx';
import { HooksManager } from '@/components/config/HooksManager.tsx';

const CONFIG_TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'claude-md', label: 'CLAUDE.md' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'hooks', label: 'Hooks' },
] as const;

type ConfigTab = (typeof CONFIG_TABS)[number]['id'];

export function ConfigPanel() {
  const [activeTab, setActiveTab] = useState<ConfigTab>('settings');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="text-sm font-semibold text-gray-900">
          Configuration
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          Manage Claude Code settings, instructions, MCP servers,
          and hooks
        </div>
      </div>

      <div className="flex border-b border-gray-200 px-2">
        {CONFIG_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2
              -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'settings' && <SettingsEditor />}
        {activeTab === 'claude-md' && <ClaudeMdEditor />}
        {activeTab === 'mcp' && <McpManager />}
        {activeTab === 'hooks' && <HooksManager />}
      </div>
    </div>
  );
}
