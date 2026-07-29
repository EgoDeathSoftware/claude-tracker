import { useState, useEffect } from 'react';
import { useConfigJson } from '@/hooks/useConfig.ts';

export interface LlmConfig {
  provider: 'ollama' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  autoSummarize: boolean;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; models: string[] }
  | { status: 'error'; error: string };

export function LlmConfigPanel() {
  const { data, loading, save } = useConfigJson<LlmConfig>(
    '/api/llm/config',
  );
  const [form, setForm] = useState<LlmConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const update = (patch: Partial<LlmConfig>) => {
    setForm(prev => (prev ? { ...prev, ...patch } : prev));
  };

  const handleSave = async () => {
    if (!form) return;
    await save(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    if (!form) return;
    setTest({ status: 'testing' });
    // Test against whatever is currently saved on the server, so save first.
    await save(form);
    const res = await fetch('/api/llm/test', { method: 'POST' });
    const body = await res.json() as { ok: boolean; models?: string[]; error?: string };
    setTest(
      body.ok
        ? { status: 'ok', models: body.models ?? [] }
        : { status: 'error', error: body.error ?? 'unknown error' },
    );
  };

  if (loading || !form) {
    return (
      <div className="p-4 text-xs text-gray-400">
        Loading AI summary settings...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">
          AI Summaries
        </h3>
        <p className="text-[11px] text-gray-400 mt-0.5">
          Configure an Ollama or OpenAI-compatible endpoint used to
          generate session summaries. Claude's own recap (when present
          in the session log) is always shown for free, regardless of
          this configuration.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-gray-500">
          Provider
        </label>
        <select
          value={form.provider}
          onChange={e => update({
            provider: e.target.value as LlmConfig['provider'],
          })}
          className="w-full px-3 py-1.5 text-xs border border-gray-200
            rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          <option value="ollama">Ollama</option>
          <option value="openai">OpenAI</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-gray-500">
          Base URL
        </label>
        <input
          value={form.baseUrl}
          onChange={e => update({ baseUrl: e.target.value })}
          placeholder="http://localhost:11434/v1"
          className="w-full px-3 py-1.5 text-xs font-mono border
            border-gray-200 rounded focus:outline-none focus:ring-1
            focus:ring-indigo-400"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-gray-500">
          API Key {form.provider === 'ollama' && '(usually not required)'}
        </label>
        <input
          type="password"
          value={form.apiKey}
          onChange={e => update({ apiKey: e.target.value })}
          placeholder="sk-..."
          className="w-full px-3 py-1.5 text-xs font-mono border
            border-gray-200 rounded focus:outline-none focus:ring-1
            focus:ring-indigo-400"
        />
      </div>

      <div className="space-y-1">
        <label className="text-[11px] font-medium text-gray-500">
          Model
        </label>
        <input
          value={form.model}
          onChange={e => update({ model: e.target.value })}
          placeholder="llama3.1"
          list="llm-models"
          className="w-full px-3 py-1.5 text-xs font-mono border
            border-gray-200 rounded focus:outline-none focus:ring-1
            focus:ring-indigo-400"
        />
        {test.status === 'ok' && (
          <datalist id="llm-models">
            {test.models.map(m => <option key={m} value={m} />)}
          </datalist>
        )}
      </div>

      <label className="flex items-start gap-2 text-[11px] text-gray-600">
        <input
          type="checkbox"
          checked={form.autoSummarize}
          onChange={e => update({ autoSummarize: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          Auto-generate a summary the first time a session goes idle
          (live &rarr; waiting/done). Off by default — you can always
          summarize on demand from the session view.
        </span>
      </label>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleSave}
          className="px-3 py-1.5 text-xs bg-indigo-500 text-white
            rounded hover:bg-indigo-600"
        >
          Save
        </button>
        <button
          onClick={handleTest}
          disabled={test.status === 'testing'}
          className="px-3 py-1.5 text-xs border border-gray-200
            rounded text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {test.status === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>

      {test.status === 'ok' && (
        <div className="text-xs text-green-600">
          Connected — {test.models.length} model
          {test.models.length === 1 ? '' : 's'} available
          {test.models.length > 0 && `: ${test.models.join(', ')}`}
        </div>
      )}
      {test.status === 'error' && (
        <div className="text-xs text-red-500">{test.error}</div>
      )}
    </div>
  );
}
