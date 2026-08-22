import { useState } from 'react';
import { SettingsEditor } from '@/components/config/SettingsEditor.tsx';
import { ClaudeMdEditor } from '@/components/config/ClaudeMdEditor.tsx';
import { McpManager } from '@/components/config/McpManager.tsx';
import { HooksManager } from '@/components/config/HooksManager.tsx';
import { LlmConfigPanel } from '@/components/config/LlmConfigPanel.tsx';
import { OpenCodeConfigPanel } from '@/components/config/OpenCodeConfigPanel.tsx';
import { useSources } from '@/hooks/useSources.ts';

const BASE_CONFIG_TABS = [
  { id: 'settings', label: 'Settings' },
  { id: 'claude-md', label: 'CLAUDE.md' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'ai-summaries', label: 'AI Summaries' },
] as const;

const OPENCODE_TAB = { id: 'opencode', label: 'OpenCode' } as const;

type ConfigTab = (typeof BASE_CONFIG_TABS)[number]['id'] | typeof OPENCODE_TAB.id;

export function ConfigPanel() {
  const [activeTab, setActiveTab] = useState<ConfigTab>('settings');
  const sources = useSources();
  const primary = sources[0];
  const hasOpenCodeConfig = sources.some(
    s => s.kind === 'opencode' && s.configPath,
  );
  const tabs = hasOpenCodeConfig
    ? [...BASE_CONFIG_TABS, OPENCODE_TAB]
    : BASE_CONFIG_TABS;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <div className="flex items-center">
          <div className="text-sm font-semibold text-gray-900">
            Configuration
          </div>
          {primary && (
            <span className="ml-2 text-[10px] font-normal text-gray-500">
              Editing: {primary.name}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          Manage Claude Code settings, instructions, MCP servers,
          and hooks
        </div>
      </div>

      <div className="flex border-b border-gray-200 px-2">
        {tabs.map(tab => (
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
        {activeTab === 'ai-summaries' && <LlmConfigPanel />}
        {activeTab === 'opencode' && <OpenCodeConfigPanel />}
      </div>
    </div>
  );
}
