import { useState } from 'react';
import type { ReactNode } from 'react';
import { formatRelative } from '@/lib/format.ts';
import type { SessionMessage, ContentBlock } from '@/types.ts';

function ToolUseBlock({ block }: { block: ContentBlock }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-1 border border-gray-200 rounded bg-white text-[11px]">
      <button
        type="button"
        className="w-full text-left px-2 py-1 flex items-center justify-between text-gray-500"
        onClick={() => setExpanded(v => !v)}
      >
        <span>🔧 {block.name}</span>
        <span className="text-gray-300">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && block.input !== undefined && (
        <pre className="px-2 pb-2 text-gray-400 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(block.input, null, 2).slice(0, 500)}
        </pre>
      )}
    </div>
  );
}

function renderToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function ToolResultBlock({ block }: { block: ContentBlock }) {
  const [expanded, setExpanded] = useState(false);
  const preview = renderToolResultContent(block.content);
  return (
    <div className="mt-1 border border-gray-200 rounded bg-green-50 text-[11px]">
      <button
        type="button"
        className="w-full text-left px-2 py-1 flex items-center justify-between text-gray-500"
        onClick={() => setExpanded(v => !v)}
      >
        <span>↳ Tool result</span>
        <span className="text-gray-300">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && preview && (
        <pre className="px-2 pb-2 text-gray-600 overflow-x-auto whitespace-pre-wrap">
          {preview.slice(0, 800)}
        </pre>
      )}
    </div>
  );
}

function renderContent(content: string | ContentBlock[]): ReactNode {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }
  return content.map((block, i) => {
    if (block.type === 'text') return <p key={i} className="whitespace-pre-wrap">{block.text}</p>;
    if (block.type === 'tool_use') return <ToolUseBlock key={i} block={block} />;
    if (block.type === 'tool_result') return <ToolResultBlock key={i} block={block} />;
    if (block.type === 'thinking') return null;
    return null;
  });
}

export function MessageBubble({ message }: { message: SessionMessage }) {
  const isUser = message.type === 'user';
  return (
    <div className="mb-4">
      <div className="text-[10px] font-semibold text-gray-400 mb-1 uppercase tracking-wide">
        {isUser ? 'You' : `Claude · ${message.model ?? ''}`}
        <span className="ml-2 font-normal normal-case">{formatRelative(message.timestamp)}</span>
      </div>
      <div className={`px-3 py-2 rounded-lg text-xs leading-relaxed ${isUser ? 'bg-gray-100 text-gray-800' : 'bg-indigo-50 text-gray-800'}`}>
        {renderContent(message.content)}
      </div>
    </div>
  );
}
