# Claude Project Tracker

A local webapp that tracks Claude Code agent sessions in real-time. Browse project histories, read past conversations, and watch live sessions across every project you've worked on.

## What it does

- **Project view** — All Claude Code projects (`~/.claude/projects/*`) with session counts and live indicators
- **Session list** — Every session per project, sorted by last activity, with LIVE / WAITING / DONE status
- **Session detail** — Title, model, cost, duration, turn count, and an expandable conversation thread
- **Conversation thread** — Messages rendered as bubbles with tool calls and tool results as collapsible blocks
- **Live updates** — New and updated sessions push to the UI via SSE without refresh

## Tech Stack

- **Runtime:** Docker (Node 22, pnpm 10.4.1) — nothing installed on host
- **Backend:** Hono, Chokidar 5, TypeScript strict
- **Frontend:** React 19, Vite 6, Tailwind 4
- **Testing:** Vitest

## Prerequisites

- Docker + Docker Compose
- A `~/.claude/` directory with project session files (Claude Code installed)

## Quick Start

```bash
# 1. Copy env template and set your claude directory
cp .env.example .env
# Edit .env — set CLAUDE_DIR to your ~/.claude path

# 2. Start the app
docker compose up -d

# 3. Open the UI
open http://localhost:5173
```

The first startup builds the Docker image (~1–2 minutes). Subsequent starts are instant.

To stop:
```bash
docker compose down
```

## How it works

1. The Hono server mounts `~/.claude/` read-only inside the container
2. On startup it scans `~/.claude/projects/**/*.jsonl` and parses each session file
3. Chokidar watches the same pattern and re-parses on `add`/`change` events
4. REST endpoints (`/api/projects`, `/api/sessions`, `/api/sessions/:id`) serve the in-memory index
5. An SSE endpoint (`/api/events`) pushes `session-created` / `session-updated` events to the frontend
6. The React frontend renders the three-panel layout and auto-refreshes on SSE events

**Session status** is derived from file mtime:
- `LIVE` — modified within the last 60 seconds
- `WAITING` — last activity 1–5 minutes ago and the last message is from the user
- `DONE` — older than 5 minutes

## Project Structure

```
claude-project-tracker/
├── Dockerfile               # Multi-stage Node 22 + pnpm build
├── docker-compose.yml       # Mounts ~/.claude read-only, exposes 5173 + 3001
├── pnpm-workspace.yaml      # Workspace root: server + frontend
├── package.json             # Frontend + dev orchestration
│
├── server/                  # Hono backend
│   ├── src/
│   │   ├── types.ts         # Session, Project, ContentBlock, SessionMessage
│   │   ├── pricing.ts       # Model pricing + computeCost()
│   │   ├── parser.ts        # JSONL → Session object
│   │   ├── watcher.ts       # Chokidar file watcher + in-memory index
│   │   ├── routes.ts        # REST + SSE endpoints
│   │   └── index.ts         # Entry point
│   └── test/                # Vitest parser tests (14 tests)
│
└── src/                     # React frontend
    ├── App.tsx              # Three-panel layout + SSE wiring
    ├── types.ts             # Frontend type copy (mirrors server/src/types.ts)
    ├── components/
    │   ├── ProjectList.tsx       # Left sidebar
    │   ├── SessionList.tsx       # Middle panel
    │   ├── SessionDetail.tsx     # Right panel
    │   ├── SessionSummary.tsx    # Metadata card
    │   ├── ConversationThread.tsx # Expandable message list
    │   ├── MessageBubble.tsx     # Single message + tool call/result blocks
    │   └── StatusBadge.tsx       # LIVE / WAITING / DONE pill
    ├── hooks/
    │   ├── useProjects.ts        # Project list state + refresh
    │   ├── useSessions.ts        # Session list per project
    │   └── useSSE.ts             # Server-Sent Events subscription
    └── lib/
        └── format.ts             # Duration, cost, relative time helpers
```

## Development

Run tests:
```bash
docker compose run --rm app bash -c "cd server && pnpm build && npx vitest run"
```

### Dev Container + Python Attach Debugging

This repo now includes a Dev Container configuration that reuses the `app` service.

1. Open the project in VS Code.
2. Run: **Dev Containers: Reopen in Container**.
3. Start your Python program in the container with debugpy listening on `5678`:

```bash
python -m debugpy --listen 0.0.0.0:5678 --wait-for-client /workspaces/claude-project-tracker/path/to/your_program.py
```

4. In VS Code, start the debugger config:
    **Python: Attach (Remote Container :5678)**

Notes:
- The devcontainer forwards ports `5173`, `3001`, and `5678`.
- Python + `debugpy` are installed in the dev image.

Rebuild the image after changing dependencies or the Dockerfile:
```bash
docker compose build
```

## Configuration

`.env` overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_DIR` | *(required)* | Absolute path to your `~/.claude/` directory on the host |
| `PORT` | `3001` | Server port inside the container |

The frontend is always on `5173`; the server is on `3001`. Both ports are published by docker-compose.

## Roadmap

See [TODO.md](./TODO.md) for post-MVP features: full log viewer, tool call audit, file change timeline, settings editor, CLAUDE.md management, and multi-agent support.
