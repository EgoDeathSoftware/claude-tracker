import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdtemp, rm, mkdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SourceWatcher } from '../src/source-watcher.ts';
import { TrackerDB } from '../src/db.ts';
import type { Source } from '../src/sources.ts';

function src(id: string, path: string): Source {
  return { id, name: id, path, kind: 'claude-code', layout: 'single', location: 'host' };
}

function makeUserLine(uuid: string, content: string, ts: string): string {
  return JSON.stringify({
    type: 'user', uuid, parentUuid: null, isSidechain: false,
    timestamp: ts, message: { role: 'user', content },
  });
}

function makeAssistantLine(
  uuid: string, parentUuid: string, ts: string,
  toolUses?: { id: string; name: string; input: unknown }[],
): string {
  const content = toolUses
    ? toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))
    : [{ type: 'text', text: 'response' }];
  return JSON.stringify({
    type: 'assistant', uuid, parentUuid, isSidechain: false,
    timestamp: ts,
    message: {
      role: 'assistant', model: 'claude-sonnet-4-6', content,
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  });
}

const watcherTmp: string[] = [];
afterEach(async () => {
  for (const d of watcherTmp.splice(0)) await rm(d, { recursive: true, force: true });
});

interface SeedSpec {
  project: string;
  session: string;
  cwd: string;
  /** When set, the file is written under <parent>/subagents/ instead. */
  subagentOf?: string | undefined;
}

async function makeClaudeDir(specs: SeedSpec[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archive-watcher-'));
  watcherTmp.push(dir);
  for (const spec of specs) {
    const projectDir = join(dir, 'projects', spec.project);
    const target = spec.subagentOf
      ? join(projectDir, spec.subagentOf, 'subagents')
      : projectDir;
    await mkdir(target, { recursive: true });
    const rec = JSON.parse(makeUserLine('u1', 'hello', '2026-09-01T10:00:00.000Z')) as
      Record<string, unknown>;
    rec['cwd'] = spec.cwd;
    await writeFile(
      join(target, `${spec.session}.jsonl`), JSON.stringify(rec), 'utf-8',
    );
  }
  return dir;
}

async function appendRecord(
  dir: string, project: string, session: string, record: unknown,
): Promise<void> {
  await appendFile(
    join(dir, 'projects', project, `${session}.jsonl`),
    `\n${JSON.stringify(record)}`, 'utf-8',
  );
}

describe('SourceWatcher subagent support', () => {
  let cleanupDir: string | null = null;

  afterEach(async () => {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true });
      cleanupDir = null;
    }
  });

  it('scans subagent files and links them to parent sessions', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    cleanupDir = claudeDir;

    const projectDir = join(claudeDir, 'projects', '-test-project');
    await mkdir(projectDir, { recursive: true });

    // Create parent session with an Agent tool call
    const parentContent = [
      makeUserLine('u1', 'run subagent', '2026-04-01T10:00:00.000Z'),
      makeAssistantLine('a1', 'u1', '2026-04-01T10:00:01.000Z', [
        { id: 'tu1', name: 'Agent', input: { description: 'explore codebase', subagent_type: 'Explore' } },
      ]),
    ].join('\n');
    await writeFile(join(projectDir, 'parent-sess.jsonl'), parentContent);

    // Create subagent file
    const subagentDir = join(projectDir, 'parent-sess', 'subagents');
    await mkdir(subagentDir, { recursive: true });
    const subContent = [
      makeUserLine('su1', 'subagent work', '2026-04-01T10:00:02.000Z'),
      makeAssistantLine('sa1', 'su1', '2026-04-01T10:00:03.000Z'),
    ].join('\n');
    await writeFile(join(subagentDir, 'agent-abc.jsonl'), subContent);

    const watcher = new SourceWatcher(src('test-source', claudeDir));
    await watcher.start();

    try {
      // Subagents should be filtered from getAllSessions
      const sessions = watcher.getAllSessions().filter(s => !s.isSubagent);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.isSubagent).toBe(false);

      // Parent should have subagent info populated
      const parent = sessions[0]!;
      expect(parent.subagents).toHaveLength(1);
      expect(parent.subagents[0]!.description).toBe('explore codebase');
      expect(parent.subagents[0]!.subagentType).toBe('Explore');
      expect(parent.subagents[0]!.turnCount).toBe(1);

      // Subagent should exist in the session map
      const sub = watcher.getAllSessions().find(
        s => s.id === parent.subagents[0]!.sessionId,
      );
      expect(sub).toBeDefined();
      expect(sub!.isSubagent).toBe(true);
      expect(sub!.parentSessionId).toBe('parent-sess');

      // Project aggregation is tested at the registry level in registry.test.ts;
      // here we just verify subagents are in the raw session map.
      const all = watcher.getAllSessions();
      expect(all.filter(s => !s.isSubagent)).toHaveLength(1);
      expect(all.filter(s => s.isSubagent)).toHaveLength(1);
    } finally {
      await watcher.stop();
    }
  });

  it('correctly derives projectId for subagent paths', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
    cleanupDir = claudeDir;

    const projectDir = join(claudeDir, 'projects', '-my-project');
    await mkdir(projectDir, { recursive: true });

    // Just a top-level session
    const content = [
      makeUserLine('u1', 'hello', '2026-04-01T10:00:00.000Z'),
    ].join('\n');
    await writeFile(join(projectDir, 'sess1.jsonl'), content);

    // A subagent in a nested path
    const subDir = join(projectDir, 'sess1', 'subagents');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'agent-x.jsonl'), content);

    const watcher = new SourceWatcher(src('test-source', claudeDir));
    await watcher.start();

    try {
      // Both should have projectId = 'test-source:-my-project'
      const all = watcher.getAllSessions();
      const nonSub = all.filter(s => !s.isSubagent);
      expect(nonSub).toHaveLength(1);
      expect(nonSub[0]!.projectId).toBe('test-source:-my-project');

      // Subagent too
      const sub = all.find(s => s.id === 'agent-x');
      expect(sub?.projectId).toBe('test-source:-my-project');
    } finally {
      await watcher.stop();
    }
  });
});

describe('SourceWatcher options', () => {
  it('applies transformSession to scanned sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-transform-'));
    const projectDir = join(dir, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'a.jsonl'), [
      JSON.stringify({
        type: 'user', uuid: 'u1', timestamp: '2026-08-21T10:00:00Z',
        cwd: '/workspace', sessionId: 'sess-a',
        message: { role: 'user', content: 'hi' },
      }),
    ].join('\n'), 'utf-8');

    const watcher = new SourceWatcher(src('agents:demo', dir), undefined, {
      watch: false,
      transformSession: s => ({ ...s, cwd: '/host/demo', projectId: 'demo' }),
    });
    await watcher.start();
    await watcher.stop();

    const sessions = watcher.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cwd).toBe('/host/demo');
    expect(sessions[0]?.projectId).toBe('demo');
  });

  it('starts no filesystem watcher when watch is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-nowatch-'));
    await mkdir(join(dir, 'projects'), { recursive: true });
    const watcher = new SourceWatcher(src('agents:quiet', dir), undefined, { watch: false });
    await watcher.start();

    const events: string[] = [];
    watcher.on('session-created', () => events.push('created'));

    const projectDir = join(dir, 'projects', '-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'late.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u9', timestamp: '2026-08-21T11:00:00Z',
      cwd: '/workspace', sessionId: 'sess-late',
      message: { role: 'user', content: 'later' },
    }), 'utf-8');
    await new Promise(r => setTimeout(r, 1500));
    await watcher.stop();

    expect(events).toEqual([]);
  });

  // chokidar's polling backend (fs.watchFile) occasionally misses the very
  // first change detected by a freshly created watcher when another polling
  // watcher was just torn down in the same process — a timing quirk in
  // Node's stat-polling internals, reproducible even with two bare
  // SourceWatcher instances and no application logic involved. retry
  // absorbs that instead of flaking the suite.
  //
  // This same race can recur in production once StoreSetWatcher (plan Task
  // 9) starts creating/tearing down many SourceWatcher-backed watchers in
  // one process for container churn. If it does, it needs a real mitigation
  // there (e.g. a defensive re-scan a few seconds after 'ready'), not just a
  // test retry.
  it('watches by default when no options are given', { timeout: 10_000, retry: 4 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-default-'));
    await mkdir(join(dir, 'projects', '-workspace'), { recursive: true });
    const watcher = new SourceWatcher(src('agents:loud', dir));
    await watcher.start();

    const seen = new Promise<void>(resolve => {
      watcher.on('session-created', () => resolve());
    });
    await writeFile(join(dir, 'projects', '-workspace', 'new.jsonl'), JSON.stringify({
      type: 'user', uuid: 'u10', timestamp: '2026-08-21T11:00:00Z',
      cwd: '/workspace', sessionId: 'sess-new',
      message: { role: 'user', content: 'new' },
    }), 'utf-8');

    await seen;
    await watcher.stop();
  });
});

describe('SourceWatcher archive write-through', () => {
  it('archives every session found in the initial scan, with its raw lines', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const summaries = db.archive.loadSummaries();
    expect(summaries.map(s => s.id)).toContain('a1');
    expect(db.archive.getRawLines('a1', 0, 10).total).toBeGreaterThan(0);
    expect(db.archive.getBody('a1')!.messages.length).toBeGreaterThan(0);
    await watcher.stop();
  });

  it('archives the source snapshot, not just the source id', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const meta = db.archive.loadSummaries().find(s => s.id === 'a1')!;
    expect(meta.sourceName).toBe('wsl');
    expect(meta.sourceKind).toBe('claude-code');
    expect(meta.sourceLocation).toBe('host');
    await watcher.stop();
  });

  it('archives subagent sessions too', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'parent', cwd: '/workspace' },
      { project: '-workspace', session: 'agent-1', cwd: '/workspace',
        subagentOf: 'parent' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, { watch: false });
    await watcher.start();

    const ids = db.archive.loadSummaries().map(s => s.id);
    expect(ids).toContain('parent');
    expect(ids).toContain('agent-1');
    await watcher.stop();
  });

  it('applies transformSession before archiving', async () => {
    const dir = await makeClaudeDir([
      { project: '-workspace', session: 'a1', cwd: '/workspace' },
    ]);
    const db = new TrackerDB(':memory:');
    const watcher = new SourceWatcher(src('wsl', dir), db, {
      watch: false,
      transformSession: s => ({ ...s, cwd: '/host/workspace' }),
    });
    await watcher.start();

    expect(db.archive.loadSummaries().find(s => s.id === 'a1')!.cwd)
      .toBe('/host/workspace');
    await watcher.stop();
  });
});
