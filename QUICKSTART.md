# Quick Start

## Local Development

```bash
# Install dependencies
pnpm install

# Start both server (:3001) and client (:5173)
pnpm dev
```

## Docker

```bash
# Start with Docker Compose (builds and runs in foreground)
CLAUDE_DIR=~/.claude docker compose up --build

# Or run in the background
CLAUDE_DIR=~/.claude docker compose up --build -d

# Stop
docker compose down
```

`CLAUDE_DIR` points to your Claude session data directory — it is mounted read-only into the container.

Source files (`client/src/`, `server/src/`) are volume-mounted, so changes hot-reload without rebuilding.

## Ports

| Service | URL                    |
|---------|------------------------|
| Client  | http://localhost:5173  |
| Server  | http://localhost:3001  |

## Other Commands

```bash
pnpm build       # Production build
pnpm test        # Run server tests (vitest)
pnpm typecheck   # Type check both packages
pnpm lint        # Lint with oxlint
```
