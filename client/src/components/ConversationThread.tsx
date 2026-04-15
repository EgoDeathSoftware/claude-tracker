import { useState } from 'react';
import { MessageBubble } from '@/components/MessageBubble.tsx';
import type { SessionMessage } from '@/types.ts';

export function ConversationThread({ messages }: { messages: SessionMessage[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-gray-200">
      <button
        type="button"
        className="w-full px-4 py-2 flex items-center justify-between text-[10px] font-semibold text-gray-400 uppercase tracking-wide hover:bg-gray-50"
        onClick={() => setExpanded(v => !v)}
      >
        <span>{expanded ? '▼' : '▶'} Conversation ({messages.length} messages)</span>
        <span className="text-gray-300 normal-case">{expanded ? 'collapse' : 'expand'}</span>
      </button>
      {expanded && (
        <div className="px-4 py-3">
          {messages.map(m => <MessageBubble key={m.uuid} message={m} />)}
        </div>
      )}
    </div>
  );
}
