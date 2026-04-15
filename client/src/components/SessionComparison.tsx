import { useEffect, useState } from 'react';
import { formatDuration, formatCost } from '@/lib/format.ts';
import type { SessionComparison as CompareData } from '@/types.ts';

interface Props {
  sessionA: string;
  sessionB: string;
  onClose: () => void;
}

export function SessionComparison({
  sessionA,
  sessionB,
  onClose,
}: Props) {
  const [data, setData] = useState<{
    a: CompareData;
    b: CompareData;
  } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ a: sessionA, b: sessionB });
    void fetch(`/api/sessions/compare?${params}`)
      .then(r => r.json())
      .then(setData);
  }, [sessionA, sessionB]);

  if (!data) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center
        bg-black/30">
        <div className="bg-white rounded-lg shadow-xl p-8 text-sm
          text-gray-400">
          Loading comparison...
        </div>
      </div>
    );
  }

  const rows: { label: string; a: string; b: string }[] = [
    { label: 'Title', a: data.a.title, b: data.b.title },
    { label: 'Model', a: data.a.model, b: data.b.model },
    { label: 'Status', a: data.a.status, b: data.b.status },
    {
      label: 'Turns',
      a: String(data.a.turnCount),
      b: String(data.b.turnCount),
    },
    {
      label: 'Cost',
      a: formatCost(data.a.costUsd),
      b: formatCost(data.b.costUsd),
    },
    {
      label: 'Duration',
      a: formatDuration(data.a.durationMs),
      b: formatDuration(data.b.durationMs),
    },
    {
      label: 'Tool Calls',
      a: String(data.a.toolCallCount),
      b: String(data.b.toolCallCount),
    },
    {
      label: 'Files',
      a: String(data.a.filesCount),
      b: String(data.b.filesCount),
    },
    {
      label: 'Started',
      a: new Date(data.a.startedAt).toLocaleString(),
      b: new Date(data.b.startedAt).toLocaleString(),
    },
  ];

  const allTools = [
    ...new Set([...data.a.toolNames, ...data.b.toolNames]),
  ].sort();
  const allFiles = [
    ...new Set([...data.a.filesPaths, ...data.b.filesPaths]),
  ].sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center
      bg-black/30">
      <div className="bg-white rounded-lg shadow-xl w-[700px]
        max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex
          items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            Session Comparison
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg
              leading-none"
          >
            x
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 pr-4 text-gray-500
                  font-medium w-24">
                  Metric
                </th>
                <th className="text-left py-2 px-2 text-indigo-600
                  font-medium">
                  Session A
                </th>
                <th className="text-left py-2 px-2 text-emerald-600
                  font-medium">
                  Session B
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.label} className="border-b border-gray-50">
                  <td className="py-1.5 pr-4 text-gray-500
                    font-medium">
                    {r.label}
                  </td>
                  <td className="py-1.5 px-2 text-gray-800">{r.a}</td>
                  <td className="py-1.5 px-2 text-gray-800">{r.b}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4">
            <h3 className="text-xs font-medium text-gray-500 mb-2">
              Tools Used
            </h3>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className="space-y-0.5">
                {allTools.map(t => (
                  <div
                    key={t}
                    className={
                      data.a.toolNames.includes(t)
                        ? 'text-gray-700'
                        : 'text-gray-300'
                    }
                  >
                    {t}
                  </div>
                ))}
              </div>
              <div className="space-y-0.5">
                {allTools.map(t => (
                  <div
                    key={t}
                    className={
                      data.b.toolNames.includes(t)
                        ? 'text-gray-700'
                        : 'text-gray-300'
                    }
                  >
                    {t}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {allFiles.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-medium text-gray-500 mb-2">
                Files Touched
              </h3>
              <div className="grid grid-cols-2 gap-2 text-[10px]
                font-mono">
                <div className="space-y-0.5">
                  {allFiles.map(f => (
                    <div
                      key={f}
                      className={
                        data.a.filesPaths.includes(f)
                          ? 'text-gray-700'
                          : 'text-gray-300'
                      }
                    >
                      {f.split('/').pop()}
                    </div>
                  ))}
                </div>
                <div className="space-y-0.5">
                  {allFiles.map(f => (
                    <div
                      key={f}
                      className={
                        data.b.filesPaths.includes(f)
                          ? 'text-gray-700'
                          : 'text-gray-300'
                      }
                    >
                      {f.split('/').pop()}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
