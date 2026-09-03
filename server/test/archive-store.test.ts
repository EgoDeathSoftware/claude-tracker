import { describe, it, expect } from 'vitest';
import { TrackerDB } from '../src/db.js';
import { decorateSession } from '../src/session-shape.js';
import type { ParsedSession, Session } from '../src/types.js';
import type { Source } from '../src/sources.js';

const hostSource: Source = {
  id: 'wsl', name: 'WSL', path: '/claude/wsl',
  kind: 'claude-code', layout: 'single', location: 'host',
};

const containerSource: Source = {
  id: 'agents:vercel.ai', name: 'vercel.ai', path: '/claude/agents/vercel.ai',
  kind: 'claude-code', layout: 'single', location: 'container',
  parentId: 'agents',
  origin: { container: 'vercel.ai', image: 'agent:latest',
    hostWorkspace: '/home/david/code/vercel.ai', workspaceMount: '/workspace' },
};

function makeParsed(id: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id,
    sourceId: 'wsl',
    projectId: 'workspace',
    filePath: `/claude/wsl/projects/-workspace/${id}.jsonl`,
    slug: id,
    title: `Session ${id}`,
    status: 'done',
    turnCount: 3,
    costUsd: 1.25,
    model: 'claude-opus-5',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-01T10:05:00Z',
    durationMs: 300_000,
    cwd: '/workspace',
    messages: [{
      uuid: `${id}-u1`, type: 'user', content: 'hello archive',
      timestamp: '2026-09-01T10:00:00Z',
    }],
    logEntries: [{ lineNumber: 1, type: 'user', summary: 'hello archive' }],
    toolCalls: [{
      toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' },
      timestamp: '2026-09-01T10:01:00Z',
    }],
    fileChanges: [{
      filePath: '/workspace/a.ts', operation: 'edit',
      timestamp: '2026-09-01T10:02:00Z', toolUseId: 't2',
    }],
    costBreakdown: {
      byTool: { Bash: { calls: 1, cost: 0.25 } },
      conversationCost: 1, toolCost: 0.25, totalCost: 1.25,
    },
    hookEvents: [],
    permissionEvents: [],
    subagents: [],
    isSubagent: false,
    recaps: [],
    ...overrides,
  };
}

function make(id: string, source = hostSource, overrides: Partial<ParsedSession> = {}): Session {
  return decorateSession(makeParsed(id, overrides), source);
}

describe('ArchiveStore summary and body storage', () => {
  it('roundtrips a session through put and loadSummaries', () => {
    const db = new TrackerDB(':memory:');
    const session = make('s1');
    db.archive.put(session);

    const summaries = db.archive.loadSummaries();
    expect(summaries).toHaveLength(1);
    const meta = summaries[0]!;
    expect(meta.id).toBe('s1');
    expect(meta.title).toBe('Session s1');
    expect(meta.turnCount).toBe(3);
    expect(meta.costUsd).toBe(1.25);
    expect(meta.cwd).toBe('/workspace');
    expect(meta.costBreakdown.byTool['Bash']).toEqual({ calls: 1, cost: 0.25 });
    expect(meta.subagents).toEqual([]);
  });

  it('marks every loaded summary archived', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    expect(db.archive.loadSummaries()[0]!.archived).toBe(true);
  });

  it('coerces a live status to done on load, since there may be no file', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1', hostSource, { status: 'live' }));
    expect(db.archive.loadSummaries()[0]!.status).toBe('done');
  });

  it('preserves the source snapshot including a container origin', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1', containerSource));
    const meta = db.archive.loadSummaries()[0]!;
    expect(meta.sourceName).toBe('vercel.ai');
    expect(meta.sourceLocation).toBe('container');
    expect(meta.origin?.container).toBe('vercel.ai');
    expect(meta.origin?.hostWorkspace).toBe('/home/david/code/vercel.ai');
  });

  it('omits origin rather than storing undefined for a host session', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    expect('origin' in db.archive.loadSummaries()[0]!).toBe(false);
  });

  it('omits parentSessionId for a non-subagent and keeps it for a subagent', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s2', hostSource, {
      isSubagent: true, parentSessionId: 's1',
    }));
    const byId = new Map(db.archive.loadSummaries().map(m => [m.id, m]));
    expect('parentSessionId' in byId.get('s1')!).toBe(false);
    expect(byId.get('s2')!.parentSessionId).toBe('s1');
    expect(byId.get('s2')!.isSubagent).toBe(true);
  });

  it('includes subagent sessions in loadSummaries', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('sub', hostSource, { isSubagent: true, parentSessionId: 's1' }));
    expect(db.archive.loadSummaries()).toHaveLength(2);
  });

  it('returns the body separately from the summary', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    const body = db.archive.getBody('s1')!;
    expect(body.messages).toHaveLength(1);
    expect(body.toolCalls[0]!.toolName).toBe('Bash');
    expect(body.fileChanges[0]!.filePath).toBe('/workspace/a.ts');
    expect(body.logEntries).toHaveLength(1);
  });

  it('returns null for an unknown body', () => {
    const db = new TrackerDB(':memory:');
    expect(db.archive.getBody('nope')).toBeNull();
  });

  it('replaces an existing session on re-put rather than duplicating it', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s1', hostSource, { title: 'Renamed', turnCount: 9 }));
    const summaries = db.archive.loadSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.title).toBe('Renamed');
    expect(summaries[0]!.turnCount).toBe(9);
  });

  it('keeps first_seen_at from the original put', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    const first = db.archive.firstSeenAt('s1');
    db.archive.put(make('s1', hostSource, { title: 'Renamed' }));
    expect(db.archive.firstSeenAt('s1')).toBe(first);
  });

  it('hasSession reflects presence', () => {
    const db = new TrackerDB(':memory:');
    expect(db.archive.hasSession('s1')).toBe(false);
    db.archive.put(make('s1'));
    expect(db.archive.hasSession('s1')).toBe(true);
  });

  it('deleteSession removes the row and its body', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.deleteSession('s1');
    expect(db.archive.loadSummaries()).toHaveLength(0);
    expect(db.archive.getBody('s1')).toBeNull();
  });

  it('deleting an unknown session does not throw', () => {
    const db = new TrackerDB(':memory:');
    expect(() => db.archive.deleteSession('nope')).not.toThrow();
  });

  it('reports stats', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.archive.put(make('s2'));
    const stats = db.archive.stats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.rawLineCount).toBe(0);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('orders summaries newest first', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('old', hostSource, { lastActivityAt: '2026-08-01T00:00:00Z' }));
    db.archive.put(make('new', hostSource, { lastActivityAt: '2026-09-01T00:00:00Z' }));
    expect(db.archive.loadSummaries().map(m => m.id)).toEqual(['new', 'old']);
  });
});

describe('archive survives an FTS rebuild', () => {
  it('keeps archive rows when maybeRebuildFts drops the FTS table', () => {
    const db = new TrackerDB(':memory:');
    db.archive.put(make('s1'));
    db.markSchemaVersion(0);
    expect(db.maybeRebuildFts()).toBe(true);
    expect(db.archive.loadSummaries()).toHaveLength(1);
    expect(db.archive.getBody('s1')).not.toBeNull();
  });
});


describe("ArchiveStore raw lines", () => {
  const line = (n: number): string => JSON.stringify({ type: "user", n });

  it("stores lines and paginates them like readRawLines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2), line(3)] });

    const page = db.archive.getRawLines("s1", 0, 2);
    expect(page.total).toBe(3);
    expect(page.lines).toEqual([
      { lineNumber: 1, content: { type: "user", n: 1 } },
      { lineNumber: 2, content: { type: "user", n: 2 } },
    ]);
  });

  it("returns the raw string when a line is not valid JSON", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: ["{not json"] });
    expect(db.archive.getRawLines("s1", 0, 10).lines[0]!.content).toBe("{not json");
  });

  it("clamps the page to the available lines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    const page = db.archive.getRawLines("s1", 1, 500);
    expect(page.lines).toHaveLength(1);
    expect(page.lines[0]!.lineNumber).toBe(2);
  });

  it("returns an empty page for a session with no lines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"));
    expect(db.archive.getRawLines("s1", 0, 10)).toEqual({ lines: [], total: 0 });
  });

  it("appends only the new lines when the file grows", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    db.archive.put(make("s1"), { lines: [line(1), line(2), line(3)] });

    const page = db.archive.getRawLines("s1", 0, 10);
    expect(page.total).toBe(3);
    expect(page.lines.map(l => l.lineNumber)).toEqual([1, 2, 3]);
    expect(db.archive.fileFingerprint("s1")!.lineCount).toBe(3);
  });

  it("replaces every line when the head changes (file rewritten)", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2), line(3)] });
    db.archive.put(make("s1"), { lines: [line(9)] });

    const page = db.archive.getRawLines("s1", 0, 10);
    expect(page.total).toBe(1);
    expect(page.lines[0]!.content).toEqual({ type: "user", n: 9 });
  });

  it("replaces every line when the file is truncated to fewer lines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2), line(3)] });
    db.archive.put(make("s1"), { lines: [line(1)] });
    expect(db.archive.getRawLines("s1", 0, 10).total).toBe(1);
  });

  it("leaves stored lines untouched when a put carries no lines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    db.archive.put(make("s1"));
    expect(db.archive.getRawLines("s1", 0, 10).total).toBe(2);
  });

  it("records the file fingerprint", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), {
      lines: [line(1)], fileSize: 4096, fileMtimeMs: 1_756_000_000_000,
    });
    const fp = db.archive.fileFingerprint("s1")!;
    expect(fp.size).toBe(4096);
    expect(fp.mtimeMs).toBe(1_756_000_000_000);
    expect(fp.lineCount).toBe(1);
    expect(fp.headHash).toHaveLength(64);
  });

  it("returns null fingerprint for an unknown session", () => {
    const db = new TrackerDB(":memory:");
    expect(db.archive.fileFingerprint("nope")).toBeNull();
  });

  it("rawLineStrings returns the verbatim lines in order", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    expect(db.archive.rawLineStrings("s1")).toEqual([line(1), line(2)]);
  });

  it("deleteSession cascades to the raw lines", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    db.archive.deleteSession("s1");
    expect(db.archive.getRawLines("s1", 0, 10).total).toBe(0);
    expect(db.archive.stats().rawLineCount).toBe(0);
  });

  it("counts raw lines in stats", () => {
    const db = new TrackerDB(":memory:");
    db.archive.put(make("s1"), { lines: [line(1), line(2)] });
    expect(db.archive.stats().rawLineCount).toBe(2);
  });
});

describe('ArchiveStore live-write coalescing', () => {
  const line = (n: number): string => JSON.stringify({ type: 'user', n });

  function liveDb(clock: { ms: number }) {
    return new TrackerDB(':memory:', {
      flushMs: 15_000, now: () => clock.ms,
    });
  }

  it('defers a body rewrite for a live session inside the flush window', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 2 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(1);
  });

  it('still appends raw lines during a deferred write', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live' }), { lines: [line(1)] });

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live' }),
      { lines: [line(1), line(2)] });

    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(2);
  });

  it('writes through once the flush window has elapsed', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 20_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 7 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(7);
  });

  it('never defers a non-live session', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));

    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'done', turnCount: 4 }));

    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(4);
  });

  it('never defers the very first write of a session', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));
    expect(db.archive.loadSummaries()).toHaveLength(1);
  });

  it('flushAll writes every deferred body', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 1 }));
    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live', turnCount: 5 }));

    db.archive.flushAll();
    expect(db.archive.loadSummaries()[0]!.turnCount).toBe(5);
  });

  it('flushAll is a no-op when nothing is pending', () => {
    const db = liveDb({ ms: 1_000 });
    db.archive.put(make('s1'));
    expect(() => db.archive.flushAll()).not.toThrow();
    expect(db.archive.loadSummaries()).toHaveLength(1);
  });

  it('a flush does not clobber the raw line count written while deferred', () => {
    const clock = { ms: 1_000 };
    const db = liveDb(clock);
    db.archive.put(make('s1', hostSource, { status: 'live' }), { lines: [line(1)] });
    clock.ms += 1_000;
    db.archive.put(make('s1', hostSource, { status: 'live' }),
      { lines: [line(1), line(2), line(3)] });

    db.archive.flushAll();
    expect(db.archive.getRawLines('s1', 0, 10).total).toBe(3);
    expect(db.archive.fileFingerprint('s1')!.lineCount).toBe(3);
  });
});
