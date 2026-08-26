# Ingesting agent container sessions

**Date:** 2026-08-21
**Status:** Design, awaiting approval
**Depends on:** `agent-shell/docs/superpowers/specs/2026-08-21-claude-store-bind-mount-design.md`

## Problem

Claude Code sessions run inside agent containers are invisible to the tracker.
They are recorded to `/home/agent/.claude` inside the container, which today is
a named Docker volume — reachable only through the Docker daemon.

Reading them by talking to the Docker socket was considered and rejected: the
socket exposes `POST /containers/create`, so any process holding it can bind the
host root into a privileged container. Handing that to a Node service with a
large dependency tree and an HTTP listener converts a dependency compromise into
host compromise. Reading volume data off the host filesystem instead is not
possible here either, because Docker Desktop keeps `/var/lib/docker` inside its
own VM.

The companion agent-shell change moves each container's `.claude` onto the host
as an ordinary bind mount. This document specifies what the tracker does with
that layout. The tracker gains no new privilege: it reads a directory
read-only, exactly as it already reads the WSL and Windows `.claude` directories.

## Goal

Surface agent container sessions in the dashboard alongside host sessions,
merged into the correct project, with a visible indicator of where each session
came from and a filter to isolate them.

## Input layout

After the agent-shell change, the host holds:

```
$AGENT_CLAUDE_ROOT/                      mounted read-only at /claude/agents
  vercel.ai/
    .tracker-origin.json
    projects/-workspace/<session>.jsonl
  ai_browser_agent/
    .tracker-origin.json
    projects/-workspace/<session>.jsonl
  legacy-shared/
    projects/-workspace/<session>.jsonl
```

Each store directory has the same internal shape as a `.claude` directory, so
`SourceWatcher` and `parseSession` work on it without modification. What is new
is that there are many of them, they appear and disappear at runtime, and their
transcripts record a cwd that needs translating.

## The cwd problem

`ai-agent.sh` mounts the host workspace at `/workspace` and sets `-w /workspace`,
so every transcript from every container records `cwd: "/workspace"`.
`deriveProjectKey` (`server/src/project-key.ts:28-30`) keys projects on
`basenameOf(cwd).toLowerCase()`. Left alone, every container session from every
project collapses into one bogus project named `workspace`. Claude's own project
directory encoding derives from cwd too, so the `dirName` fallback is
`-workspace` and equally useless.

`.tracker-origin.json` carries `hostWorkspace` and `workspaceMount` precisely to
fix this. Rewriting `/workspace` to the real host path before the project key is
derived produces the outcome that matters: **a container session for
`~/Projects/CAT_AI/agent-shell` merges into the same project row as the WSL and
Windows sessions for that folder**, which is what the existing basename-merging
design is for.

## Design

### Where the rewrite happens

The rewrite is a post-parse transform on the `Session`, not a change to
`parseSession`. `parseSession` keeps its current signature and behaviour, and
`parser.test.ts`'s 38 tests are untouched.

New module `server/src/store-origin.ts`:

```ts
export interface StoreOrigin {
  container: string;
  image?: string | undefined;
  hostWorkspace?: string | undefined;
  workspaceMount?: string | undefined;   // defaults to '/workspace'
  host?: string | undefined;
  updatedAt?: string | undefined;
}

export function readStoreOrigin(storePath: string, storeName: string): Promise<StoreOrigin>;
export function rewriteCwd(cwd: string, origin: StoreOrigin): string;
export function applyOrigin(session: Session, origin: StoreOrigin, dirName: string): Session;
```

`rewriteCwd` replaces a leading `workspaceMount` with `hostWorkspace`, so
`/workspace` and `/workspace/sub` both map correctly, and returns `cwd`
unchanged otherwise. `applyOrigin` sets `session.cwd` to the rewritten value and
recomputes `session.projectId` via the existing `deriveProjectKey`. Nothing else
about the session changes.

**Fallback for an unusable marker.** `readStoreOrigin` never rejects; it always
resolves to a usable `StoreOrigin`. Whenever `hostWorkspace` is absent — the
file is missing, malformed, truncated, or present but without that field — it
synthesises `hostWorkspace = "/" + storeName`.

Keying the fallback on the *field* rather than the *file* matters: the
agent-shell migration script writes markers for the pre-existing volumes with
`container` set and `hostWorkspace` omitted, because the original host workspace
is not recoverable for them. Those stores must take the fallback path, not the
rewrite path.

The result is a project keyed and displayed as the store name, rather than the
whole set collapsing into `workspace`. It needs no special case anywhere
downstream and reads sensibly in the UI. It can collide with a real project of
the same basename, which is the desired behaviour anyway.

### Source expansion

`Source` gains three fields (`server/src/sources.ts`):

```ts
export type SourceLocation = 'host' | 'container';
export type SourceLayout = 'single' | 'store-set';

export interface Source {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  configPath?: string | undefined;
  layout: SourceLayout;              // default 'single'
  location: SourceLocation;          // default 'host'
  origin?: StoreOrigin | undefined;  // container sources only
  parentId?: string | undefined;     // set on synthesised children
}
```

`sources.json` gains one entry:

```json
{ "id": "agents", "name": "Agent Containers",
  "kind": "claude-code", "layout": "store-set", "path": "/claude/agents" }
```

`loadSources` validates `layout` the same way it validates `kind`, and defaults
both new fields so every existing config keeps working untouched.

A `store-set` source is not watched directly. `StoreSetWatcher`
(`server/src/store-set-watcher.ts`) scans its path for subdirectories and, for
each one, synthesises a child `Source`:

- `id`: `<parentId>:<storeName>` — e.g. `agents:vercel.ai`
- `name`: the store name
- `path`: the store directory
- `kind`: inherited from the parent
- `location`: `'container'`
- `origin`: read from the marker, or synthesised
- `parentId`: the parent's id

Each child gets an ordinary `SourceWatcher`, with `applyOrigin` wired in as a
session transform. `SourceWatcher` gains one optional options argument for that
transform and for the watch toggle described below; its existing three-argument
call sites and tests are unaffected.

### Runtime source churn

`SessionRegistry.start()` (`server/src/registry.ts:39-72`) builds its watcher
list once and never changes it. Containers are created and destroyed constantly,
so the registry gains:

```ts
async addSource(source: Source): Promise<void>;
async removeSource(id: string): Promise<void>;
```

`addSource` creates and starts a watcher, ingests its sessions, subscribes to its
events, and emits `sources-changed`. `removeSource` stops the watcher, drops that
source's sessions from the map, and emits the same event. `kindBySourceId` gains
a `locationBySourceId` sibling, both maintained by these methods.

`StoreSetWatcher` drives them: it watches its root directory for subdirectory
creation and removal and calls into the registry. `sources-changed` is
re-emitted over the existing SSE channel so the client refetches `/api/sources`.

### Bounding the watcher count

Stores are permanent and accumulate — one per container ever launched. Attaching
a chokidar watcher to each would leave dozens of pollers stat-ing dead trees
every second, since `SourceWatcher` runs `usePolling: true, interval: 1000`
(`server/src/source-watcher.ts:144-150`).

Sessions from every store are always parsed and served. Only the *live watch* is
rationed:

- A store is **active** if its newest transcript mtime is within
  `STORE_ACTIVE_DAYS` (env, default 14). Active stores get a chokidar watcher.
- Inactive stores are scanned once at startup and then left alone. Their history
  is fully browsable; it just will not update live, which is correct, because
  nothing is writing to them.
- Reactivation is detected through the marker file. `ai-agent.sh` rewrites
  `.tracker-origin.json` on every launch, so `StoreSetWatcher` polling each
  store's marker mtime every 30s — one `stat` per store, trivial at any
  plausible store count — catches a relaunch and promotes the store to watched.
- The same 30s pass demotes a store back to unwatched once its newest transcript
  ages past the threshold, so promotion and demotion share one timer.

This bounds live watchers by *recently active* store count rather than total
store count, which is the number that actually stays small.

### Filtering and provenance

`location` is a new dimension orthogonal to `kind`. A container runs
`claude-code`, so it must not be modelled as a kind.

The two existing filter parameters converge on one shape. `getProjects` and
`getSessions` take a filter object rather than growing a third positional
parameter:

```ts
interface SessionFilter {
  kinds?: SourceKind[] | undefined;
  locations?: SourceLocation[] | undefined;
}
```

`GET /api/projects` and `GET /api/sessions` accept `?locations=host,container`
alongside the existing `?kinds=`, parsed by the same helper
(`server/src/routes.ts:68-70`). `GET /api/sources` returns the synthesised child
sources with their `location`, `origin`, and `parentId`.

Client changes:

- `client/src/hooks/useSources.ts` — mirror the new fields, export
  `SourceLocation`.
- `client/src/App.tsx` — `enabledLocations` state alongside `enabledKinds`.
- `client/src/components/ProjectList.tsx` — a Host / Containers checkbox pair
  below the existing kind checkboxes, shown only when a container source exists.
- `client/src/components/SessionList.tsx` — the per-session source badge shows
  the container name for container sources.
- `client/src/components/SessionDetail.tsx` — the header shows full provenance
  for a container session: container name, image, and originating host
  workspace.

Both checkbox groups follow the existing convention of appearing only when there
is something to choose between.

### What does not change

`parseSession`, `deriveProjectKey`, `db.indexSession`, and the SSE contract are
untouched. `/api/sessions/:id/raw` works unmodified because `session.filePath`
points at a real local file — the bind mount means there is no mirror, no
synthesised transcript, and no second code path. Live latency matches host
sessions exactly, since chokidar sees container writes directly.

`Session` and `Project` are unchanged, so the `server/src/types.ts` ↔
`client/src/types.ts` mirror needs no edit — the new fields live on `Source`,
which is declared in `sources.ts` server-side and `useSources.ts` client-side.

`/api/config/*` targets the first configured source
(`server/src/routes.ts`) and container sources are appended after the existing
ones, so config management is unaffected. Editing a container's config through
the tracker is explicitly out of scope.

## Changes

| file | change |
|---|---|
| `server/src/store-origin.ts` | new — `StoreOrigin`, `readStoreOrigin`, `rewriteCwd`, `applyOrigin` |
| `server/src/store-set-watcher.ts` | new — expands a `store-set` source, drives registry add/remove, manages watch promotion |
| `server/src/sources.ts` | `layout`, `location`, `origin`, `parentId` fields plus validation and defaults |
| `server/src/source-watcher.ts` | optional options argument: session transform, watch toggle |
| `server/src/registry.ts` | `addSource`/`removeSource`, `locationBySourceId`, filter object on `getProjects`/`getSessions`, `sources-changed` |
| `server/src/routes.ts` | `?locations=` parsing, `sources-changed` over SSE |
| `client/src/hooks/useSources.ts` | new fields, `SourceLocation`, `StoreOrigin` |
| `client/src/App.tsx` | `enabledLocations` |
| `client/src/components/ProjectList.tsx` | location filter checkboxes |
| `client/src/components/SessionList.tsx` | container badge |
| `client/src/components/SessionDetail.tsx` | provenance in header |
| `docker-compose.yml` | `${AGENT_CLAUDE_ROOT}:/claude/agents:ro` |
| `.env.example` | `AGENT_CLAUDE_ROOT` |
| `server/config/sources.example.json` | the `agents` entry |
| `CLAUDE.md` | architecture, file layout, and testing sections |

## Testing

New test files, following the existing per-module convention in `server/test/`:

`store-origin.test.ts`
- `/workspace` and `/workspace/sub` rewrite against a marker; unrelated cwd
  passes through untouched
- a custom `workspaceMount` is honoured
- Windows-style `hostWorkspace` (`C:\Users\...`) produces the right project key,
  since `basenameOf` already handles drive letters
  (`server/src/project-key.ts:6-16`)
- a missing marker synthesises `/<storeName>` rather than collapsing to
  `workspace`
- a marker present but lacking `hostWorkspace` — what the agent-shell migration
  writes for legacy volumes — takes the same fallback path
- malformed and truncated marker JSON falls back instead of throwing
- `applyOrigin` recomputes `projectId` and changes nothing else on the session

`store-set-watcher.test.ts`
- expands subdirectories into child sources with the expected ids
- a store appearing at runtime triggers `addSource`; a store disappearing
  triggers `removeSource`
- a store with no `projects/` directory is tolerated — containers that have
  never run Claude are the common case
- active/inactive classification against `STORE_ACTIVE_DAYS`
- a marker mtime bump promotes an inactive store to watched

`registry.test.ts` (extend the existing 7)
- `addSource`/`removeSource` add and drop sessions and emit `sources-changed`
- `locations` filtering, and `kinds` + `locations` combined

`routes.test.ts` (extend the existing 6)
- `?locations=` filtering on both endpoints
- `/api/sources` exposes `location`, `origin`, and `parentId`

`container-ingestion.integration.test.ts`
- a committed fixture under `server/test/fixtures/agent-stores/` holding two
  stores with markers pointing at different host workspaces
- the decisive assertion: a container session whose marker names the same folder
  as an existing WSL fixture session merges into **one** project, with both
  sources listed on it
- a third store without a marker forms its own project rather than joining the
  others

Per the existing note in `CLAUDE.md`, test files need relative imports and the
`check-imports.sh` hook blocks those in Write/Edit, so they are written with
`Bash` and `cat >`.

## Rollout

1. agent-shell change lands and is verified; migration script run against the
   three existing volumes.
2. Tracker compose file gains the read-only mount; `sources.json` gains the
   `agents` entry.
3. Ingestion lands behind nothing — an absent or empty `/claude/agents`
   directory yields zero child sources and changes no existing behaviour, so
   this is safe to ship before any container has been relaunched.

## Open question

Agent containers can also run opencode, and agent-shell seeds an opencode config
(`agent-shell/opencode/opencode.json`). Those sessions live in a SQLite database
at a different path and are not covered here. The `store-set` layout is
kind-agnostic by construction, so extending it later means pointing a
`kind: 'opencode'` store-set at the right subdirectory — no rework of this
design. Out of scope until container opencode sessions actually exist.
