import { useMemo } from 'react';
import { formatRelative } from '@/lib/format.ts';
import type { FileChangeEntry, FileOperation } from '@/types.ts';

const OP_STYLES: Record<FileOperation, { bg: string; label: string }> = {
  read: { bg: 'bg-blue-100 text-blue-700', label: 'READ' },
  write: { bg: 'bg-green-100 text-green-700', label: 'WRITE' },
  edit: { bg: 'bg-amber-100 text-amber-700', label: 'EDIT' },
};

interface GroupedFile {
  filePath: string;
  operations: FileChangeEntry[];
  reads: number;
  writes: number;
  edits: number;
}

interface Props {
  fileChanges: FileChangeEntry[];
}

export function FileTimeline({ fileChanges }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, GroupedFile>();
    for (const fc of fileChanges) {
      let group = map.get(fc.filePath);
      if (!group) {
        group = {
          filePath: fc.filePath,
          operations: [],
          reads: 0,
          writes: 0,
          edits: 0,
        };
        map.set(fc.filePath, group);
      }
      group.operations.push(fc);
      if (fc.operation === 'read') group.reads++;
      else if (fc.operation === 'write') group.writes++;
      else if (fc.operation === 'edit') group.edits++;
    }
    // Sort by most operations first
    return [...map.values()].sort(
      (a, b) => b.operations.length - a.operations.length,
    );
  }, [fileChanges]);

  if (fileChanges.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-gray-400">
        No file operations in this session
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary */}
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div className="flex gap-4 text-[11px] text-gray-500">
          <span>
            <strong className="text-gray-700">{grouped.length}</strong> files
          </span>
          <span>
            <strong className="text-gray-700">{fileChanges.length}</strong> operations
          </span>
          <span className="flex gap-2">
            <span className="text-blue-600">
              {fileChanges.filter(f => f.operation === 'read').length} reads
            </span>
            <span className="text-green-600">
              {fileChanges.filter(f => f.operation === 'write').length} writes
            </span>
            <span className="text-amber-600">
              {fileChanges.filter(f => f.operation === 'edit').length} edits
            </span>
          </span>
        </div>
      </div>

      {/* File groups */}
      <div className="flex-1 overflow-y-auto">
        {grouped.map(group => (
          <div
            key={group.filePath}
            className="border-b border-gray-100 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] font-mono text-gray-700 truncate flex-1">
                {group.filePath}
              </span>
              <div className="flex gap-1 shrink-0">
                {group.reads > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-100 text-blue-700">
                    {group.reads}R
                  </span>
                )}
                {group.writes > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-100 text-green-700">
                    {group.writes}W
                  </span>
                )}
                {group.edits > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-100 text-amber-700">
                    {group.edits}E
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {group.operations.map((op, i) => {
                const style = OP_STYLES[op.operation];
                return (
                  <span
                    key={`${op.toolUseId}-${i}`}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ${style.bg}`}
                    title={`${style.label} at ${op.timestamp}`}
                  >
                    {style.label}
                    <span className="opacity-60 font-normal">
                      {formatRelative(op.timestamp)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
