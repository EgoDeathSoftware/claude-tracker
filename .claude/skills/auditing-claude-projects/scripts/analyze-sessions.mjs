#!/usr/bin/env node
// Dependency-free fallback for the auditing-claude-projects skill. Aggregates cost, cache
// efficiency, tool failure rate, hook friction, and skill usage directly from raw Claude Code
// session JSONL files. Used when the claude-project-tracker API isn't reachable.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const PRICING = {
  'claude-opus-4-6': { input: 15 / 1e6, cacheWrite: 18.75 / 1e6, cacheRead: 1.5 / 1e6, output: 75 / 1e6 },
  'claude-sonnet-4-6': { input: 3 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6, output: 15 / 1e6 },
  'claude-haiku-4-5-20251001': { input: 0.8 / 1e6, cacheWrite: 1 / 1e6, cacheRead: 0.08 / 1e6, output: 4 / 1e6 },
};
const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];
const warnedModels = new Set();

function computeCost(usage, model) {
  if (!PRICING[model] && !warnedModels.has(model)) {
    warnedModels.add(model);
    console.error(`[pricing] Unknown model "${model}", using default (sonnet) pricing — cost estimate may be off`);
  }
  const rates = PRICING[model] ?? DEFAULT_PRICING;
  return (
    (usage.input_tokens ?? 0) * rates.input +
    (usage.cache_creation_input_tokens ?? 0) * rates.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * rates.cacheRead +
    (usage.output_tokens ?? 0) * rates.output
  );
}

async function tryReadJsonl(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => join(dir, e.name));
  } catch {
    return [];
  }
}

async function findSessionFiles(dir) {
  const files = await tryReadJsonl(dir);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subagentFiles = await tryReadJsonl(join(dir, entry.name, 'subagents'));
    files.push(...subagentFiles);
  }
  return files;
}

function emptyStats() {
  return {
    sessions: 0,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    costByModel: new Map(),
    costByTool: new Map(),
    toolErrors: new Map(),
    hookBlocks: 0,
    hookPasses: 0,
    skillsInvoked: new Set(),
    modelsUsed: new Set(),
  };
}

function addCost(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function recordToolResult(stats, toolName, isError) {
  const entry = stats.toolErrors.get(toolName) ?? { errors: 0, total: 0 };
  entry.total++;
  if (isError) entry.errors++;
  stats.toolErrors.set(toolName, entry);
}

function processAssistant(record, stats, toolUseIdToName) {
  const message = record.message;
  if (!message) return;
  if (message.model) stats.modelsUsed.add(message.model);

  let msgCost = 0;
  if (message.usage) {
    msgCost = computeCost(message.usage, message.model);
    stats.costUsd += msgCost;
    stats.inputTokens += message.usage.input_tokens ?? 0;
    stats.outputTokens += message.usage.output_tokens ?? 0;
    stats.cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;
    stats.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    addCost(stats.costByModel, message.model ?? 'unknown', msgCost);
  }

  const toolBlocks = (message.content ?? []).filter(b => b.type === 'tool_use' && b.id && b.name);
  const costPerTool = toolBlocks.length > 0 ? msgCost / toolBlocks.length : 0;
  for (const block of toolBlocks) {
    toolUseIdToName.set(block.id, block.name);
    addCost(stats.costByTool, block.name, costPerTool);
    if (block.name === 'Skill' && block.input?.skill) {
      stats.skillsInvoked.add(block.input.skill);
    }
  }
}

function processUser(record, stats, toolUseIdToName) {
  if (record.isSidechain) return;
  const content = record.message?.content;
  if (typeof content === 'string') {
    if (content.trim()) stats.turnCount++;
    return;
  }
  if (!Array.isArray(content)) return;

  let hasText = false;
  for (const block of content) {
    if (block.type === 'text' && block.text?.trim()) hasText = true;
    if (block.type === 'tool_result' && block.tool_use_id) {
      const toolName = toolUseIdToName.get(block.tool_use_id) ?? 'unknown';
      recordToolResult(stats, toolName, block.is_error === true);
    }
  }
  if (hasText) stats.turnCount++;
}

function processAttachment(record, stats) {
  const type = record.attachment?.type;
  if (type === 'hook_error') stats.hookBlocks++;
  if (type === 'hook_success') stats.hookPasses++;
}

function processRecord(record, stats, toolUseIdToName) {
  if (record.type === 'assistant') processAssistant(record, stats, toolUseIdToName);
  else if (record.type === 'user') processUser(record, stats, toolUseIdToName);
  else if (record.type === 'attachment') processAttachment(record, stats);
}

async function parseSessionFile(filePath, stats) {
  const toolUseIdToName = new Map();
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.type !== 'string') continue;
    processRecord(record, stats, toolUseIdToName);
  }
  stats.sessions++;
}

function fmtUsd(n) {
  return `$${n.toFixed(4)}`;
}

function printTopN(map, formatValue) {
  const rows = [...map].sort((a, b) => b[1] - a[1]);
  for (const [key, value] of rows) {
    console.log(`  ${key}: ${formatValue(value)}`);
  }
}

function printReport(stats, dir, fileCount) {
  const cacheEligible = stats.cacheCreationTokens + stats.inputTokens + stats.cacheReadTokens;
  const cacheHitRatio = cacheEligible > 0 ? (stats.cacheReadTokens / cacheEligible) * 100 : 0;

  console.log(`Session directory: ${dir}`);
  console.log(`Files analyzed: ${fileCount} (${stats.sessions} sessions)`);
  console.log(`Turns: ${stats.turnCount}`);
  console.log('');
  console.log(`Total cost: ${fmtUsd(stats.costUsd)}`);
  console.log(`Models used: ${[...stats.modelsUsed].join(', ') || 'none'}`);
  console.log('Cost by model:');
  printTopN(stats.costByModel, fmtUsd);
  console.log('Cost by tool:');
  printTopN(stats.costByTool, fmtUsd);
  console.log('');
  console.log(`Input tokens: ${stats.inputTokens}`);
  console.log(`Output tokens: ${stats.outputTokens}`);
  console.log(`Cache creation tokens: ${stats.cacheCreationTokens}`);
  console.log(`Cache read tokens: ${stats.cacheReadTokens}`);
  console.log(`Cache hit ratio: ${cacheHitRatio.toFixed(1)}%`);
  console.log('');
  console.log('Tool error rates:');
  const errorRows = [...stats.toolErrors].sort((a, b) => b[1].errors - a[1].errors);
  for (const [tool, { errors, total }] of errorRows) {
    const rate = total > 0 ? (errors / total) * 100 : 0;
    console.log(`  ${tool}: ${errors}/${total} failed (${rate.toFixed(1)}%)`);
  }
  console.log('');
  console.log(`Hook blocks: ${stats.hookBlocks}`);
  console.log(`Hook passes: ${stats.hookPasses}`);
  console.log('');
  console.log(`Skills invoked: ${[...stats.skillsInvoked].join(', ') || 'none'}`);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: analyze-sessions.mjs <path-to-session-dir>');
    process.exitCode = 2;
    return;
  }

  const files = await findSessionFiles(dir);
  if (files.length === 0) {
    console.error(`No .jsonl session files found under ${dir}`);
    process.exitCode = 1;
    return;
  }

  const stats = emptyStats();
  for (const file of files) {
    await parseSessionFile(file, stats);
  }
  printReport(stats, dir, files.length);
}

main();
