# Multi-source Claude directories

**Status:** Approved — ready for implementation planning
**Date:** 2026-04-23

## Problem

The tracker watches a single `.claude` directory (`CLAUDE_DIR` env var, default `~/.claude`). Users who run Claude Code from both Windows and WSL on the same host have two independent `.claude` directories — sessions from whichever side isn't configured are invisible. The same pattern applies to any setup with multiple accessible `.claude` dirs (e.g. mounted remote filesystems).

We need the tracker to aggregate sessions from multiple `.claude` directories and present them as a unified view, with sessions for the same underlying project folder grouped together regardless of which `.claude` dir recorded them.

## Goals

- View-only aggregation across multiple `.claude` directories.
- Easy to add/remove sources via a config file.
- Sessions for the same project folder (by basename) appear grouped, even when one ran from Windows and one from WSL.
- Per-session source is visible in the UI.
- No breaking changes to single-source setups (backward-compatible fallback).

## Non-goals

- Config-management parity across sources. The config UI (CLAUDE.md / settings.json / hooks) keeps writing to one designated source.
- Remote fetching (SSH/API). "Remote" sources are expected to be filesystem-mounted on the host.
- Runtime source management through the UI. Editing `sources.json` + restart is sufficient for v1.
- Full-path normalization across OSes. Basename-only grouping is accepted as "90% correct".

## Design

### Sources config

New file `server/config/sources.json` (gitignored):

```json
{
  "sources": [
    { "id": "wsl",     "name": "WSL",     "path": "/home/david/.claude" },
    { "id": "windows", "name": "Windows", "path": "/mnt/c/Users/david/.claude" }
  ]
}
```

- `id` — stable short key, `[a-z0-9_-]+`, used in SSE events and DB rows. Duplicate ids are a fatal config error.
- `name` — human label shown in the UI (per-session badge).
- `path` — absolute path to the `.claude` directory (the tracker appends `/projects`).

**Loader rules:**
- File missing → fall back to a single synthetic source built from `CLAUDE_DIR` env var (or `~/.claude`) with `id: "default"`, `name: "Default"`. Preserves existing behavior.
- File present but malformed JSON or schema-invalid → log error and exit. Silent empty-source startup is worse than failing loudly.
- A source's `path` doesn't exist or isn't readable on startup → log a warning and skip that source. Other sources continue.
- No hot-reload. Restart to pick up changes.

### Project identity

Project key = `basename(cwd).toLowerCase()`.

- `C:\Users\david\Projects\claude-project-tracker` → `claude-project-tracker`
- `/mnt/c/Users/david/Projects/claude-project-tracker` → `claude-project-tracker` (merges)
- `/home/sam/code/claude-project-tracker` → `claude-project-tracker` (also merges — accepted)
- Collision note: two truly different directories sharing a basename (e.g. `work/api` and `personal/api`) will merge. Accepted tradeoff.

**Basename extraction:** split on both `/` and `\`, drop empty trailing segments, take the last non-empty segment. Handles WSL paths and Windows paths uniformly without depending on Node's `path` module (which is OS-specific).

**Display name** = the basename from the most-recently-active session, preserving its original casing.

**Fallback:** if a session's JSONL has no `cwd`, project key = `<sourceId>:<dirName>` (the legacy encoded directory name, scoped to the source). These sessions won't merge across sources; that's fine because they have no `cwd` to match on.

### Data model

`Session` type (`server/src/types.ts`) — add:
```ts
sourceId: string;
```

`projectId` field keeps its name but its semantics change: now a basename slug (e.g. `claude-project-tracker`) instead of the encoded directory name (e.g. `-mnt-c-Users-david-Projects-claude-project-tracker`).

`Project` type — add:
```ts
sources: string[];  // source ids that contributed sessions; ordered by first-seen
```

`cwd` stays as the raw path from the JSONL (used for per-session display).

### API surface

No URL shape changes:
- `GET /api/projects` — grouping key swaps to basename slug.
- `GET /api/sessions?projectId=<slug>` — filter by slug.
- `GET /api/sessions/:id` — unchanged.
- `GET /api/search?q=...&projectId=<slug>` — unchanged.
- Config routes (`/api/config/*`) — unchanged; target the first source in the config list.

New endpoint:
- `GET /api/sources` — returns `Array<{ id: string; name: string; path: string }>`. Lets the client render per-session badges and show which source the config UI is editing.

### Watcher architecture

Three modules:

- **`server/src/sources.ts`** (new) — loads and validates `sources.json`, exposes `loadSources(): Source[]`. Owns the env-var fallback.
- **`server/src/source-watcher.ts`** (new) — one instance per source. Responsible for scan + chokidar watch + subagent linking within that source. Emits typed events with `sourceId` attached. Most of today's `watcher.ts` logic moves here.
- **`server/src/registry.ts`** (new) — owns the merged `Map<sessionId, Session>` and cross-source grouping. Subscribes to each `SourceWatcher`, re-emits SSE events, exposes `getProjects() / getSessions() / getSession()`.

`server/src/watcher.ts` is deleted (no compat shim — the registry is the new entry point used by `index.ts` and `routes.ts`).

**Subagent linking** stays scoped per-source — subagents are stored under their parent session's directory on the same filesystem. No cross-source linking.

**Session ID collisions** (across sources): UUIDs are practically unique. If a collision occurs, log a warning and keep the most recently modified file's parse result.

**Startup resilience:** each `SourceWatcher.start()` is awaited in parallel via `Promise.allSettled`. Failures are logged and skipped; `registry.start()` always completes. An empty registry (zero sources configured or all failed) is a valid state — the server starts and serves empty projects/sessions lists.

### Database

SQLite FTS table is derived data. On startup, check a `schema_version` row; if it doesn't match the current version, drop and recreate the FTS table, then re-index all known sessions. One-shot, no incremental migration.

`project_id` column now stores basename slugs. FTS search by `projectId` continues to work with no schema change.

### UI

- Session rows render a small source badge using the source `name` (e.g. "WSL", "Windows"). Source info comes from `GET /api/sources`.
- Config panel header shows "Editing: `<source.name>`" next to its title, so multi-source users know which `.claude` dir they're writing to.
- Project list: unchanged shape. A project that has sessions from multiple sources shows combined counts naturally.

## Error handling

- Missing `sources.json` → fall back to env var (info log).
- Malformed `sources.json` → log error, exit 1.
- Duplicate source ids → log error, exit 1.
- Source path missing/unreadable → warn, skip that source, continue.
- Source path exists but `<path>/projects` doesn't → scan yields empty, chokidar still watches (directory may appear later). No warning required.
- Session with no `cwd` → fallback project key as described; no error.

## Testing

Unit tests in `server/test/`:

- **`sources.test.ts`** (new)
  - Valid config loads.
  - Missing file falls back to env var.
  - Missing path → warning + skip.
  - Duplicate ids → throws.
  - Malformed JSON → throws with a clear message.

- **`registry.test.ts`** (new)
  - Two sessions from different sources, same basename cwd → one project, two sessions, `sources: ['wsl', 'windows']`.
  - Two sessions from same source, same basename → one project, one source.
  - Session with no `cwd` → fallback key, doesn't merge.
  - Basename case differences → merged (lowercase key).
  - `getSessions(projectId)` returns from all contributing sources sorted by `lastActivityAt`.
  - Session ID collision across sources → later-modified wins, warning logged.

- **`source-watcher.test.ts`** — renamed from `watcher.test.ts`. Existing subagent linking tests stay.

- **`parser.test.ts`** — unchanged.

**Fixtures:** `server/test/fixtures/sources/{wsl,windows}/projects/<encoded-dir>/<uuid>.jsonl` — small pair exercising the cross-source merge.

## Out of scope for this spec

- Hot-reloading `sources.json`.
- Per-source config management (writing CLAUDE.md / settings.json to a chosen source).
- A UI for adding/removing sources.
- Full cwd-path normalization across OSes.
- Remote session fetching.
