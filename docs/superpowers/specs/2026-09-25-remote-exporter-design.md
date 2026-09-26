# Remote log exporter

**Date:** 2026-09-25
**Status:** Design, awaiting approval

## Problem

Claude Code sessions running on other machines — VMs, bare-metal servers,
firewalled VPS boxes — are invisible to the tracker today. The tracker only
reads `.claude` directories it can see directly: local host paths, or (for
containers) a bind mount on the same host. There is no way to bring in a
machine the tracker server cannot otherwise reach.

SSH-based approaches (running `cat`/`tail`/`rsync` over SSH from the server)
were considered and rejected: shelling out to a remote host means either
constructing remote command strings (injection risk) or granting the server a
standing SSH key with read access, and either way the server needs to be able
to *reach* the remote host on some port. That last requirement is often not
satisfiable — the motivating case is a VPS whose firewall allows only inbound
port 22, sitting behind NAT with no port-forwarding available, where the
tracker server itself may also be a Docker container on a host with no public
IP.

## Goal

Surface remote-machine sessions in the dashboard, merged into the correct
project alongside host/container sessions exactly as they are today, with:

- No inbound port required on the remote machine, in any network topology.
- Mutual TLS: the remote agent verifies it's talking to the real tracker
  server, and the server verifies the agent's identity — and mutual TLS
  is the *only* thing standing between the transcript data and the network,
  so only the server (holder of its private key) can ever decrypt it, even if
  the connection is relayed through a third party like Cloudflare.
- A single install script producing a running system service, for both Linux
  (systemd) and Windows (Windows Service).
- Enrollment automated end-to-end — no manual cert copying.

## Connectivity model

The remote agent (the **exporter**) always dials out to the tracker server.
This is the one design choice that makes every topology in scope work: a
stateful firewall that only permits inbound port 22 has nothing to say about
outbound connections the box itself initiates, so an exporter behind such a
firewall reaches the server with zero firewall changes. NAT and CGNAT are
handled the same way, for the same reason.

This shifts the reachability requirement onto the *server* side: the
server needs one address:port reachable from every exporter. If the
server's own host can't have a port opened or forwarded (e.g. it's a Docker
container behind a home-network NAT), `cloudflared` in **raw TCP tunnel
mode** — not HTTP/Access mode — sits in front of it: `cloudflared` itself
dials out to Cloudflare's edge, and Cloudflare relays opaque TCP bytes back
to the server's local port. Critically, this mode never terminates TLS at
Cloudflare's edge, so the mTLS handshake and everything after it stays
end-to-end between exporter and server; Cloudflare only ever sees encrypted
bytes it can't read. (HTTP/Access mode, by contrast, would have Cloudflare
terminate TLS to inspect the request — that would make Cloudflare a party
that can read the data in transit, which fails the "only the server can
read them" requirement, so it's explicitly not used here.)

Once connected, the exporter holds one persistent stream open. The server
drives it — requesting file listings and snapshots as needed — even though
the exporter initiated the TCP connection, so the protocol gets pull-style
control (the server decides what it needs and when) without ever requiring
the server to open a connection to the exporter.

## PKI and enrollment

The tracker server owns a private CA, generated once and stored server-side
(new `server/config/exporter-ca/` directory, gitignored — this is a secret
alongside `sources.json`'s existing pattern). Enrollment mints a short-lived,
single-use token; installing the exporter consumes it to get a signed client
certificate. After that, the token is forgotten and every future connection
authenticates with the issued certificate.

**Minting a token.** One backend action, exposed two ways:

- CLI: `pnpm --filter @claude-tracker/server exporter:enroll --name vps1
  [--dir <remote-path>]`, run on the same machine as the server (direct DB
  access, no network hop).
- Web UI: a "Remote Exporters" tab in the existing config panel, with an
  "Add" button that does the same thing over a new
  `POST /api/exporters/enroll` route.

Either path writes one row to a new `exporter_tokens` table (token stored
only as a hash, plus the proposed source name/id, an optional directory
override, and a short expiry — 15 minutes) and prints/returns a single
install command:

```
curl -fsSL https://tracker.example:8444/exporter/install.sh \
  | sh -s -- --token <token> --server tracker.example:8444 --ca-fingerprint <sha256>
```

(and the PowerShell equivalent for Windows). The CA fingerprint is embedded
directly in the command — this is what lets the exporter trust the server on
its very first connection without any ambient CA trust store, closing the
MITM gap that raw hostname/DNS trust would otherwise leave open.

**Consuming the token.** The install script downloads the prebuilt exporter
binary for the local OS/arch (served by the tracker server itself, over the
same pinned-TLS enrollment endpoint — no separate release infrastructure to
stand up) and runs it once in `enroll` mode. The exporter:

1. Generates its own ECDSA P-256 keypair locally. The private key never
   leaves the machine.
2. Builds a CSR and opens a TLS connection to the server's `/enroll`
   endpoint, verifying the server's certificate against the pinned CA
   fingerprint from the command line (not the system trust store).
3. Sends `{token, csr}`.
4. The server validates the token (unused, unexpired), signs the CSR with
   the CA key, marks the token used, and returns `{cert, caCert, sourceId}`.
5. The exporter writes `cert`/`caCert` plus its own already-local private
   key to its config directory (`/etc/claude-tracker-exporter/certs/` on
   Linux, `%ProgramData%\ClaudeTrackerExporter\certs\` on Windows; file
   permissions restricted to the service account), installs itself as a
   system service (systemd unit on Linux; Windows Service via the binary's
   own `install-service` subcommand), and starts it.

Every connection after this point presents the issued client certificate on
a dedicated `/sync` endpoint that requires mTLS; there is no second
"password" to manage.

**Revocation.** A new `exporter_certs` table records each issued cert's
serial number and a nullable `revoked_at`. The server's TLS `VerifyConnection`
callback rejects the handshake if the presented cert's serial is revoked.
Revoking is instant — `pnpm exporter:revoke <source-id>` or a "Revoke" button
per row in the same UI tab — with no need to wait for expiry, so certs can be
issued with a long validity (1 year) without that being a liability.

## Wire protocol

After the mTLS handshake on `/sync`, exporter and server exchange
newline-delimited JSON frames over the one long-lived HTTP/2 stream (chosen
over introducing gRPC/protobuf tooling into both a Go binary and this Node
server for one bidirectional channel — NDJSON over a stream is enough and
keeps both sides simpler).

Exporter → server:
- `FileList{files: [{relPath, size, mtimeUnixMs}]}` — sent on connect, and
  again every reconcile interval (default 5 min) regardless of filesystem
  events, so a missed event or a dropped connection self-heals.
- `AppendLines{relPath, fromLine, lines}` — sent when a watched file grew in
  a way consistent with an append (fsnotify write event, new size, same
  head).
- `FileSnapshot{relPath, size, mtimeUnixMs, lines}` — full file content, sent
  when the server explicitly asks for it, or when the exporter detects a
  non-append change (truncation/rewrite) itself.
- `FileRemoved{relPath}`.

Server → exporter:
- `RequestSnapshot{relPath}` — sent when an entry in an incoming `FileList`
  doesn't match what the archive already has fingerprinted for that source
  (reusing `ArchiveStore.fileFingerprint`, the exact same check
  `SourceWatcher` already does for local files).

The server-side handler feeds every `AppendLines`/`FileSnapshot` straight
into the existing `parseLines()` → `db.archive.put()` → FTS-index path — the
same pipeline every local and container session already goes through. This
transport is a new front door onto code that already exists; no parsing
logic changes.

## Server-side integration

`SourceLocation` (`server/src/sources.ts`) gains a third value, `'remote'`,
alongside `'host'` and `'container'`. `kind` stays `'claude-code'` — remote
opencode support is out of scope (see Open questions). `layout` stays
`'single'`: one exporter's whitelisted directory (default
`~/.claude/projects` / `%USERPROFILE%\.claude\projects`, overridable at
enroll time with `--dir`) is exactly the shape a `single` source already
handles — many projects live as subfolders of one root, same as any ordinary
`.claude` directory.

Unlike every existing source, a remote source is never listed in
`sources.json` — there's nothing to configure ahead of time. A new
`ExporterListener` component (owns the mTLS listener, the enrollment
endpoint, and the PKI/revocation checks) is instantiated once in `index.ts`
alongside the registry. On a new authenticated `/sync` connection, it builds
a `Source` (`location: 'remote'`, `path` set to a synthetic
`remote:<sourceId>` placeholder — there's no local filesystem path to give
it) and calls the registry's existing `addSource()`. On disconnect, it calls
`removeSource()`, which — exactly as it already does for a destroyed
container — non-destructively marks that source's sessions `archived: true`
rather than deleting anything; reconnecting clears the flag.

A new `RemoteWatcher` (`server/src/remote-watcher.ts`) implements the shared
`AgentWatcher` interface. Unlike `SourceWatcher` or `OpenCodeWatcher`, it
does no polling or filesystem watching of its own — it's purely driven by
the protocol events the listener hands it, holding the same `SessionMeta`
map shape as every other watcher.

Because the remote machine's own JSONL files carry their own real `cwd`
(e.g. `/home/user/projects/foo` on that box, exactly as any `.claude`
directory does), `deriveProjectKey`'s existing basename-merge logic needs no
special case here — a remote session merges into the same project as a host
or WSL session for that folder automatically, the same way multi-source
merging already works today.

`/api/sessions/:id/raw` (`server/src/routes.ts`) gains one more case
alongside its existing three: a `location: 'remote'` session has no local
file to tail, live or not, so it always reads through
`db.archive.getRawLines()` — the same archive rows the sync protocol is
already writing through in real time (raw lines "always append immediately"
per the existing archive design), so there's no freshness gap versus a local
live session.

## Error handling

- **Network loss:** the exporter reconnects with exponential backoff. The
  periodic `FileList` reconcile (not just the live tail) means a gap in
  connectivity never loses data — the next reconnect's reconciliation catches
  anything the tail missed.
- **Revoked certificate:** the handshake is rejected distinctly from a
  transient failure. The exporter treats this as "re-enrollment required,"
  not "try again" — it stops its automatic reconnect loop and logs an
  actionable message, rather than retrying forever against a connection that
  will never succeed.
- **Server restart:** looks like a network loss to every connected exporter;
  they all reconnect on their own backoff once the listener is back. No
  special-casing needed.

## Changes

| file | change |
|---|---|
| `exporter/` | new Go module — `enroll`, `watch` (fsnotify + fingerprint/reconcile), `sync` (NDJSON client), `service` (systemd exec target / Windows SCM wrapper) |
| `exporter/install.sh` | new — Linux install script |
| `exporter/install.ps1` | new — Windows install script |
| `server/src/exporter/pki.ts` | new — CA load/init, CSR signing |
| `server/src/exporter/enroll-store.ts` | new — token issuance/validation, cert revocation table (shares `TrackerDB`'s connection, mirrors `archive-store.ts`'s pattern) |
| `server/src/exporter/listener.ts` | new — mTLS listener: `/enroll` (server-auth only) and `/sync` (mTLS), NDJSON framing |
| `server/src/exporter/protocol.ts` | new — shared message types and frame parsing |
| `server/src/remote-watcher.ts` | new — `AgentWatcher` implementation driven by listener events |
| `server/src/exporter-routes.ts` | new — `POST /api/exporters/enroll`, `GET /api/exporters`, `DELETE /api/exporters/:sourceId`, binary download |
| `server/scripts/exporter-enroll.ts` | new — CLI wrapper around `enroll-store.ts` |
| `server/src/sources.ts` | `SourceLocation` gains `'remote'` |
| `server/src/routes.ts` | fourth raw-log branch for `location: 'remote'` |
| `server/src/index.ts` | instantiate `ExporterListener`, wire to `registry.addSource`/`removeSource`, read `EXPORTER_LISTEN_PORT`/`EXPORTER_CA_DIR` env vars |
| `server/src/db.ts` | `exporter_tokens`, `exporter_certs` tables |
| `client/src/hooks/useSources.ts` | `'remote'` location |
| `client/src/components/ProjectList.tsx` | location checkboxes generalized from a fixed Host/Containers pair to a list over whatever locations are present |
| `client/src/components/config/ExportersPanel.tsx` | new — Remote Exporters tab: add/list/revoke |
| `docker-compose.yml` / `.env.example` | exporter listener port, CA dir |
| `.github/workflows/build-exporter.yml` | new — cross-compile the Go binary for linux/amd64, linux/arm64, windows/amd64 |
| `CLAUDE.md` | architecture, file layout, testing sections |

A new server-side dependency is needed for CSR/certificate signing (Node's
built-in `crypto` doesn't cover CSR generation/signing) — the exact package
should be picked during implementation by checking current maintained
options rather than assumed here, per the project's "look up current stable
version" convention.

## Testing

`server/test/exporter/pki.test.ts` — CA init, CSR signing produces a cert
that chains to the CA, revocation check rejects a revoked serial.

`server/test/exporter/enroll-store.test.ts` — token single-use enforcement,
expiry, revocation table CRUD.

`server/test/exporter/listener.test.ts` — enroll handshake end-to-end
against a loopback TLS server; sync protocol messages feeding into
`parseLines`/archive via a fake in-process exporter client; disconnect
triggers `removeSource`.

`server/test/remote-watcher.test.ts` — `AgentWatcher` contract.

`server/test/routes.test.ts` (extend) — the `location: 'remote'` raw-log
branch; the new `/api/exporters/*` routes.

`exporter/internal/watch/watch_test.go` — fingerprint/append/reconcile
logic.

`exporter/internal/sync/client_test.go` — protocol framing.

`server/test/remote-exporter.integration.test.ts` — drives the real
listener with a fake TS exporter client (not the Go binary) through
enroll → sync → disconnect → archive, checking basename-merge with an
existing host fixture, following `multi-source.integration.test.ts`'s
fixture convention.

CI smoke test (`.github/workflows/exporter-smoke.yml`) runs each install
script on a fresh Linux and Windows runner against a throwaway local server
and confirms the service starts and enrolls.

## Rollout

1. Land the server-side PKI/listener/`RemoteWatcher` behind
   `EXPORTER_ENABLED` (default `false`), so nothing changes for existing
   deployments until explicitly turned on.
2. Land the Go exporter, install scripts, and the cross-compile CI workflow.
3. Enable on one real VPS behind a restrictive firewall, verify end-to-end,
   including the `cloudflared` path if the server host needs it.
4. Document in `CLAUDE.md`.

## Open questions

- Remote opencode sources (reading a remote `opencode.db` instead of JSONL)
  are out of scope. The exporter's protocol is directory/file-shaped by
  design, so this would mean teaching it a second sync mode later — no
  rework of this design, just not built until a real need exists.
- There's no multi-operator auth on the "Add remote source" web UI action —
  anyone who can load the config UI can mint a token. Acceptable given the
  tracker has no auth anywhere else today; would need revisiting only if
  that changes.
- Root CA rotation isn't designed here — it would mean redistributing a new
  pinned fingerprint to every enrolled exporter, effectively re-enrolling
  the whole fleet by hand. Left undesigned until the fleet is large enough
  for that to matter.
