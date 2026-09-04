import { useEffect, useState } from 'react';
import { DetailTabs } from '@/components/DetailTabs.tsx';
import { SessionSummary } from '@/components/SessionSummary.tsx';
import { ConversationThread } from '@/components/ConversationThread.tsx';
import { RawLogViewer } from '@/components/RawLogViewer.tsx';
import { ToolAuditLog } from '@/components/ToolAuditLog.tsx';
import { FileTimeline } from '@/components/FileTimeline.tsx';
import { CostBreakdown } from '@/components/CostBreakdown.tsx';
import { PermissionsHooks } from '@/components/PermissionsHooks.tsx';
import { AgentTree } from '@/components/AgentTree.tsx';
import { TagPills } from '@/components/TagPills.tsx';
import { useSessionTags } from '@/hooks/useTags.ts';
import type { Session } from '@/types.ts';

interface Props {
  sessionId: string | null;
  onSelectSession: (id: string) => void;
}

export function SessionDetail({ sessionId, onSelectSession }: Props) {
  const [fullSession, setFullSession] = useState<Session | null>(null);
  const [activeTab, setActiveTab] = useState('conversation');
  const { tags, addTag, removeTag } = useSessionTags(sessionId);

  useEffect(() => {
    if (!sessionId) {
      setFullSession(null);
      return;
    }
    void fetch(`/api/sessions/${sessionId}`)
      .then(r => r.json())
      .then(setFullSession);
  }, [sessionId]);

  useEffect(() => {
    setActiveTab('conversation');
  }, [sessionId]);

  if (!fullSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm
        text-gray-400">
        {sessionId ? 'Loading...' : 'Select a session to view details'}
      </div>
    );
  }

  const tabs = [
    {
      id: 'conversation',
      label: 'Conversation',
      count: fullSession.messages.length,
    },
    {
      id: 'tools',
      label: 'Tools',
      count: fullSession.toolCalls.length,
    },
    {
      id: 'files',
      label: 'Files',
      count: fullSession.fileChanges.length,
    },
    {
      id: 'costs',
      label: 'Costs',
    },
    {
      id: 'permissions',
      label: 'Hooks',
      count:
        fullSession.hookEvents.length
        + fullSession.permissionEvents.length,
    },
    {
      id: 'agents',
      label: 'Agents',
      count: fullSession.subagents.length,
    },
    {
      id: 'raw-log',
      label: 'Raw Log',
      count: fullSession.logEntries.length,
    },
  ];

  const agentToolCalls = fullSession.toolCalls.filter(
    tc => tc.toolName === 'Agent',
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        {fullSession.isSubagent && fullSession.parentSessionId && (
          <button
            onClick={() => onSelectSession(fullSession.parentSessionId!)}
            className="text-[11px] text-indigo-600 hover:underline mb-1"
          >
            ← Back to parent session
          </button>
        )}
        <div className="text-sm font-semibold text-gray-900 truncate">
          {fullSession.title}
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          {formatMeta(fullSession)}
        </div>
        {fullSession.sourceLocation === 'container' && (
          <div className="text-[11px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>container: {fullSession.origin?.container ?? fullSession.sourceName}</span>
            {fullSession.origin?.image && <span>· {fullSession.origin.image}</span>}
            {fullSession.origin?.hostWorkspace && (
              <span className="truncate">· {fullSession.origin.hostWorkspace}</span>
            )}
          </div>
        )}
        {fullSession.archived && (
          <div className="text-[11px] text-amber-700 mt-0.5">
            Archived — {fullSession.sourceName} is no longer connected.
            Served from the tracker database.
          </div>
        )}
        <div className="mt-1.5">
          <TagPills
            tags={tags}
            onAdd={addTag}
            onRemove={removeTag}
            compact
          />
        </div>
      </div>
      <DetailTabs
        tabs={tabs}
        activeTab={activeTab}
        onSelect={setActiveTab}
      />
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'conversation' && (
          <>
            <SessionSummary session={fullSession} />
            <ConversationThread messages={fullSession.messages} />
          </>
        )}
        {activeTab === 'tools' && (
          <ToolAuditLog toolCalls={fullSession.toolCalls} />
        )}
        {activeTab === 'files' && (
          <FileTimeline fileChanges={fullSession.fileChanges} />
        )}
        {activeTab === 'costs' && (
          <CostBreakdown costBreakdown={fullSession.costBreakdown} />
        )}
        {activeTab === 'permissions' && (
          <PermissionsHooks
            hookEvents={fullSession.hookEvents}
            permissionEvents={fullSession.permissionEvents}
          />
        )}
        {activeTab === 'agents' && (
          <AgentTree
            subagents={fullSession.subagents}
            agentToolCalls={agentToolCalls}
            sessionTitle={fullSession.title}
            onSelectSubagent={onSelectSession}
          />
        )}
        {activeTab === 'raw-log' && (
          <RawLogViewer
            sessionId={fullSession.id}
            logEntries={fullSession.logEntries}
          />
        )}
      </div>
    </div>
  );
}

function formatMeta(s: Session): string {
  return `${s.slug || s.id} · started ${new Date(s.startedAt).toLocaleString()}`;
}
