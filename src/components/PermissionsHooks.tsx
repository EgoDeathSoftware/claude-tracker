import { useState, useMemo } from 'react';
import { formatRelative } from '@/lib/format.ts';
import type { HookEvent, PermissionEvent } from '@/types.ts';

type ViewMode = 'all' | 'hooks' | 'permissions';

interface TimelineEntry {
  timestamp: string;
  kind: 'hook' | 'permission';
  hook?: HookEvent | undefined;
  permission?: PermissionEvent | undefined;
}

const PERM_STYLES: Record<string, { bg: string; icon: string }> = {
  'mode-set': { bg: 'bg-blue-100 text-blue-700', icon: 'S' },
  'hook-block': { bg: 'bg-red-100 text-red-700', icon: 'X' },
  'hook-pass': { bg: 'bg-green-100 text-green-700', icon: 'P' },
};

interface Props {
  hookEvents: HookEvent[];
  permissionEvents: PermissionEvent[];
}

export function PermissionsHooks({ hookEvents, permissionEvents }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('all');

  const timeline = useMemo((): TimelineEntry[] => {
    const entries: TimelineEntry[] = [];

    if (viewMode !== 'permissions') {
      for (const he of hookEvents) {
        entries.push({ timestamp: he.timestamp, kind: 'hook', hook: he });
      }
    }

    if (viewMode !== 'hooks') {
      for (const pe of permissionEvents) {
        entries.push({ timestamp: pe.timestamp, kind: 'permission', permission: pe });
      }
    }

    return entries.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }, [hookEvents, permissionEvents, viewMode]);

  const total = hookEvents.length + permissionEvents.length;

  if (total === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-gray-400">
        No permission or hook events in this session
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-4 text-[11px] text-gray-500">
          <span>
            <strong className="text-gray-700">{hookEvents.length}</strong> hook events
          </span>
          <span>
            <strong className="text-gray-700">{permissionEvents.length}</strong> permission events
          </span>
        </div>
      </div>

      {/* View toggle */}
      <div className="px-4 py-2 border-b border-gray-100 flex gap-1">
        {(['all', 'hooks', 'permissions'] as ViewMode[]).map(mode => (
          <button
            key={mode}
            type="button"
            className={`px-2 py-0.5 rounded text-[10px] capitalize ${
              viewMode === mode
                ? 'bg-indigo-100 text-indigo-700'
                : 'text-gray-400 hover:text-gray-600'
            }`}
            onClick={() => setViewMode(mode)}
          >
            {mode}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        {timeline.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-gray-400">
            No events match the current filter
          </div>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-7 top-0 bottom-0 w-px bg-gray-200" />

            {timeline.map((entry, i) => (
              <div key={i} className="relative flex items-start px-4 py-2 hover:bg-gray-50">
                {/* Dot */}
                <div className="relative z-10 w-6 flex justify-center shrink-0">
                  <div className={`w-2.5 h-2.5 rounded-full mt-1 ${
                    entry.kind === 'hook' ? 'bg-yellow-400' : 'bg-indigo-400'
                  }`} />
                </div>

                {/* Content */}
                <div className="ml-3 flex-1 min-w-0">
                  {entry.kind === 'hook' && entry.hook && (
                    <HookRow hook={entry.hook} />
                  )}
                  {entry.kind === 'permission' && entry.permission && (
                    <PermissionRow permission={entry.permission} />
                  )}
                </div>

                {/* Timestamp */}
                <div className="ml-2 text-[10px] text-gray-400 shrink-0">
                  {entry.timestamp ? formatRelative(entry.timestamp) : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HookRow({ hook }: { hook: HookEvent }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-700">
          {hook.hookEvent}
        </span>
        <span className="text-[11px] text-gray-700 font-medium">
          {hook.hookName}
        </span>
        {hook.toolName && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-indigo-100 text-indigo-600">
            {hook.toolName}
          </span>
        )}
      </div>
      {hook.command && (
        <div className="mt-1 text-[10px] text-gray-400 font-mono truncate">
          $ {hook.command}
        </div>
      )}
    </div>
  );
}

function PermissionRow({ permission }: { permission: PermissionEvent }) {
  const style = PERM_STYLES[permission.type] ?? PERM_STYLES['mode-set']!;
  return (
    <div className="flex items-center gap-1.5">
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${style.bg}`}>
        {permission.type}
      </span>
      <span className="text-[11px] text-gray-600">
        {permission.detail}
      </span>
    </div>
  );
}
