# Post-MVP TODO

Features to add after the initial session tracker ships.

## Observability & Audit

- [x] **Full log viewer** — browse raw JSONL entries for a session, including attachments, hooks, permission events, and file-history snapshots (currently filtered out of the conversation view)
- [x] **Tool call audit log** — dedicated view showing every tool call Claude made in a session: tool name, input, output, timestamp, duration. Filterable by tool type (Bash, Read, Edit, Write, Agent, etc.)
- [x] **File change timeline** — show which files were read/written/edited during a session, sourced from `file-history-snapshot` and Edit/Write tool calls
- [x] **Permission event log** — surface all permission grants/denials from the session JSONL (`permission-mode`, hook results)
- [x] **Hook execution trace** — show pre/post tool hook runs, their stdout/stderr, and whether they blocked or passed
- [x] **Cost breakdown by tool** — how much of the session cost came from each tool use type vs. conversation turns
- [x] **Agent dispatch tree** — visualize subagent spawns (Agent tool calls) as a tree showing parent → child relationships

## Config Management

- [x] **settings.json editor** — GUI for editing `~/.claude/settings.json` (permissions, hooks, env vars, model, plugins)
- [x] **CLAUDE.md editor** — create and edit global and per-project CLAUDE.md instruction files
- [x] **MCP server manager** — CRUD for MCP servers in `~/.claude.json` with connection testing
- [x] **Hooks manager** — view and edit pre/post tool hooks without touching JSON directly

## Session Management

- [x] **Prompt library** — save and reuse initial prompts as templates
- [x] **Session search** — full-text search across all session histories (add SQLite FTS5 index)
- [x] **Session tagging** — manually tag sessions with labels (e.g., "auth refactor", "bug fix")
- [x] **Session comparison** — diff two sessions on the same project side by side

## Multi-Agent Support (future)

- [ ] Gemini CLI session files
- [ ] Cline / Cursor / Aider session histories
