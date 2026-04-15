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
  session: Session | null;
}

export function SessionDetail({ session }: Props) {
  const [fullSession, setFullSession] = useState<Session | null>(null);
  const [activeTab, setActiveTab] = useState('conversation');
  const { tags, addTag, removeTag } = useSessionTags(
    session?.id ?? null,
  );

  useEffect(() => {
    if (!session) {
      setFullSession(null);
      return;
    }
    void fetch(`/api/sessions/${session.id}`)
      .then(r => r.json())
      .then(setFullSession);
  }, [session?.id]);

  useEffect(() => {
    setActiveTab('conversation');
  }, [session?.id]);

  if (!fullSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm
        text-gray-400">
        {session ? 'Loading...' : 'Select a session to view details'}
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
        <div className="text-sm font-semibold text-gray-900 truncate">
          {fullSession.title}
        </div>
        <div className="text-xs text-gray-400 mt-0.5">
          {formatMeta(fullSession)}
        </div>
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
