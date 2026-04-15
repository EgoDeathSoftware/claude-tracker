# Claude Project Tracker

A local webapp that tracks Claude Code agent sessions in real-time. Browse project histories, inspect tool calls, analyze costs, manage configuration, and watch live sessions across every project.

## Features

**Session tracking**
- Three-panel UI: projects, sessions, detail
- Live/waiting/done status detection via file mtime
- Real-time updates via Server-Sent Events

**Observability & audit**
- Raw JSONL log viewer with filtering and expandable entries
- Tool call audit log — every tool call with input, output, duration, cost
- File change timeline grouped by path with read/write/edit markers
- Cost breakdown by tool with visual bar chart
- Hook execution trace and permission event log
- Agent dispatch tree showing parent → subagent relationships

**Session management**
- Full-text search across all session content (SQLite FTS5)
- Session tagging with colored pills
- Prompt library for saving and reusing templates
- Side-by-side session comparison (metrics, tools, files)

**Configuration management**
- `settings.json` editor with JSON validation
- CLAUDE.md file editor (global + language-specific)
- MCP server manager — add, edit, remove servers
- Hooks manager — view config and edit hook scripts

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Docker · Node 22 · pnpm 10 |
| Backend | Hono 4 · Chokidar · better-sqlite3 · TypeScript strict |
| Frontend | React 19 · Vite 6 · Tailwind 4 |
| Testing | Vitest |

## Quick Start

```bash
# 1. Copy env and set your claude directory
cp .env.example .env
# Edit .env — set CLAUDE_DIR to your ~/.claude path

# 2. Start
docker compose up -d

# 3. Open
open http://localhost:5173
```

First build takes ~1-2 minutes. Subsequent starts are instant.

### Without Docker

```bash
pnpm install
pnpm dev
# Server on :3001, UI on :5173
```

## How It Works

1. The server scans `~/.claude/projects/**/*.jsonl` and parses each session file
2. Chokidar watches for new/changed files and re-parses on events
3. REST endpoints serve the in-memory session index
4. SSE pushes `session-created`/`session-updated` events to the frontend
5. SQLite stores the FTS index, tags, and prompts (persistent across restarts)

**Session status** is derived from file mtime:
- **LIVE** — modified within the last 60 seconds
- **WAITING** — 1-5 minutes ago, last message is from the user
- **DONE** — older than 5 minutes

## Project Structure

```
claude-project-tracker/
├── server/                      # Hono backend
│   ├── src/
│   │   ├── index.ts             # Entry point
│   │   ├── routes.ts            # REST + SSE + config endpoints
│   │   ├── parser.ts            # JSONL → Session object
│   │   ├── watcher.ts           # Chokidar file watcher + in-memory index
│   │   ├── db.ts                # SQLite (FTS5 search, tags, prompts)
│   │   ├── config.ts            # Read/write settings, CLAUDE.md, MCP, hooks
│   │   ├── types.ts             # Shared type definitions
│   │   └── pricing.ts           # Model pricing + cost computation
│   └── test/                    # Vitest tests (36 tests)
│
├── client/                      # React frontend
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx              # Root layout + routing
│       ├── types.ts             # Frontend types (mirrors server)
│       ├── components/
│       │   ├── ProjectList.tsx
│       │   ├── SessionList.tsx       # Search bar + tag filters
│       │   ├── SessionDetail.tsx     # Tabbed detail view
│       │   ├── SearchBar.tsx         # FTS search with results dropdown
│       │   ├── TagPills.tsx          # Inline tag management
│       │   ├── PromptLibrary.tsx     # Prompt CRUD modal
│       │   ├── SessionComparison.tsx # Side-by-side diff modal
│       │   ├── ToolAuditLog.tsx
│       │   ├── FileTimeline.tsx
│       │   ├── CostBreakdown.tsx
│       │   ├── PermissionsHooks.tsx
│       │   ├── AgentTree.tsx
│       │   ├── RawLogViewer.tsx
│       │   └── config/              # Configuration editors
│       │       ├── ConfigPanel.tsx
│       │       ├── SettingsEditor.tsx
│       │       ├── ClaudeMdEditor.tsx
│       │       ├── McpManager.tsx
│       │       └── HooksManager.tsx
│       ├── hooks/
│       │   ├── useProjects.ts
│       │   ├── useSessions.ts
│       │   ├── useSSE.ts
│       │   ├── useSearch.ts
│       │   ├── useTags.ts
│       │   ├── usePrompts.ts
│       │   └── useConfig.ts
│       └── lib/
│           └── format.ts
│
├── Dockerfile
├── docker-compose.yml
├── tsconfig.base.json           # Shared TS compiler options
└── pnpm-workspace.yaml          # Workspace: server + client
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_DIR` | `~/.claude` | Path to Claude Code data directory |
| `DATA_DIR` | `$CLAUDE_DIR/tracker` | SQLite database location |
| `PORT` | `3001` | Server port |

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| GET | `/api/sessions?projectId=&tag=` | List sessions with optional filters |
| GET | `/api/sessions/:id` | Session detail |
| GET | `/api/sessions/:id/raw?offset=&limit=` | Raw JSONL lines |
| GET | `/api/sessions/compare?a=&b=` | Compare two sessions |
| GET | `/api/search?q=&projectId=` | Full-text search |
| GET | `/api/tags` | All tags |
| GET/POST/DELETE | `/api/sessions/:id/tags` | Session tags |
| GET/POST/PUT/DELETE | `/api/prompts` | Prompt library |
| GET/PUT | `/api/config/settings` | settings.json |
| GET/PUT | `/api/config/claude-md` | CLAUDE.md files |
| GET/PUT/DELETE | `/api/config/mcp/:name` | MCP servers |
| GET/PUT | `/api/config/hooks/:name` | Hook scripts |
| GET | `/api/events` | SSE stream |
