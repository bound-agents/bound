---
title: CLI & Operations
description: The bound, boundctl, and boundless command-line interfaces, bootstrap sequence, and build pipeline.
---

This guide covers the command-line interfaces for the Bound agent system —
initialization, operation, management, and the single-binary build pipeline. For the
per-field config-file reference, see [Configuration Reference](/bound/reference/configuration/).

The Bound system provides three command-line interfaces:

- **`bound`** — initializes configuration and starts the Bound orchestrator.
- **`boundctl`** — manages running orchestrators, including cluster hub configuration,
  emergency operations, and point-in-time recovery.
- **`boundless`** — a terminal coding-agent client that attaches to a running server.

`bound` and `boundctl` expect a configuration directory (default `config/`) containing
JSON config files. Configuration is loaded and validated during startup before any
services are initialized.

---

## `bound init`

Initializes the configuration directory with required config files. The command creates
`allowlist.json` (user whitelist and defaults) and `model_backends.json` (LLM backend
configuration) based on the specified provider preset.

```
bound init [PRESET] [OPTIONS]
```

### Presets

Exactly one preset must be selected.

| Preset | Flag | Notes |
|--------|------|-------|
| Ollama | `--ollama` | Local Ollama at `http://localhost:11434`, model `llama3`, no API key. |
| Anthropic | `--anthropic` | Reads `ANTHROPIC_API_KEY`; model `claude-3-5-sonnet-20241022`. |
| Bedrock | `--bedrock --region <region>` | AWS Bedrock; credentials from the AWS SDK chain. Defaults `--region` to `us-east-1`. |
| Cerebras | `--cerebras` | Reads `CEREBRAS_API_KEY`; base URL `https://api.cerebras.ai/v1`. |
| z.AI | `--zai` | Reads `ZAI_API_KEY`; base URL `https://api.z.ai/api/coding/paas/v4`. |
| umans | `--umans` | Reads `UMANS_API_KEY`; self-configuring (see the config reference). |
| Hub | `--hub` | Relay hub: no local backends; relays inference to spokes. |

When an API-key preset's environment variable is unset, initialization continues but the
`api_key` field is omitted from the generated config.

### Options

| Option | Description |
|--------|-------------|
| `--name <name>` | Operator name. Defaults to `$USER` or `operator`. Used as the default web user and to generate deterministic UUIDs. |
| `--with-sync` | Creates a `sync.json` template for multi-host operation. |
| `--with-mcp` | Creates an `mcp.json` template for MCP server connections. |
| `--force` | Overwrites existing config files (otherwise init exits if config exists). |
| `--config-dir <dir>` | Config directory. Defaults to `config/`. |

### Examples

```bash
bound init --ollama
bound init --anthropic --with-sync --with-mcp
bound init --bedrock --region eu-west-1 --name alice
bound init --ollama --force
```

Exit code 0 on success, 1 on error.

---

## `bound start`

Starts the Bound orchestrator and executes the bootstrap sequence.

```
bound start [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--config-dir <dir>` | Config directory. Defaults to `config/`. |

The startup process is non-interactive. It loads configuration, initializes all services,
seeds the database, and starts the web server. Progress is reported to stdout. If any
initialization step fails, startup exits with code 1 and does not continue.

The process responds to SIGINT (Ctrl+C) and SIGTERM for graceful shutdown. On successful
startup the web UI is available at `http://localhost:3001`.

---

## `boundctl`

Manages a running cluster.

### `boundctl set-hub`

Designates a cluster host as the hub (central synchronization point). Hub election is
typically the first operation after initializing multiple hosts.

```
boundctl set-hub <host-name> [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--wait` | Blocks until all peers confirm the hub change. Otherwise returns immediately after writing the designation. |
| `--config-dir <dir>` | Config directory. Defaults to `config/`. |

Writes the `cluster_hub` key to the `cluster_config` table. Hosts sync this configuration
on their next sync cycle and recognize the new hub. With `--wait`, the command polls
`sync_state` until all registered peers confirm.

### `boundctl stop` / `boundctl resume`

`stop` triggers a cluster-wide emergency stop — it writes the `emergency_stop` key (with an
ISO 8601 timestamp) to `cluster_config`. On the next sync cycle every host suspends
autonomous operations; the web interface and manual commands remain available. `resume`
deletes the `emergency_stop` key and autonomous operations resume cluster-wide.

```bash
boundctl stop
boundctl resume
```

### `boundctl restore`

Performs point-in-time recovery, reverting synced database state to before a timestamp.

```
boundctl restore --before <timestamp> [OPTIONS]
```

| Argument / Option | Description |
|-------------------|-------------|
| `--before <timestamp>` (required) | ISO 8601 timestamp (e.g. `2024-01-01T12:00:00Z`). Reverts all synced rows to their state before this moment. Local-only rows are unaffected. |
| `--preview` | Shows what would change without executing. |
| `--tables <t1> <t2> …` | Restrict recovery to the named tables. |
| `--config-dir <dir>` | Config directory. Defaults to `config/`. |

Reads the changelog to identify rows modified after the timestamp and reverts each to its
prior recorded state (tombstoning rows created after the cutoff). Append-only tables
(`messages`) are skipped. The restore runs inside a single `BEGIN IMMEDIATE` transaction:
if any step fails, it rolls back and the original state is preserved.

```bash
boundctl restore --before "2024-01-15T10:00:00Z" --preview
boundctl restore --before "2024-01-15T10:00:00Z"
```

### `boundctl set-persona`

Sets the cluster-wide operator persona (free-form Markdown, capped at 64 KB) from a file or
stdin. See the [persona section of the config reference](/bound/reference/configuration/#persona).

```bash
boundctl set-persona --file my-persona.md
cat my-persona.md | boundctl set-persona
```

---

## `boundless`

`boundless` is a terminal coding-agent client. It connects to a running bound server over
the client-tool WebSocket interface, attaches to one thread, and registers host-side
filesystem and shell tools (plus optional MCP servers) into that thread's tool set. Session
messages, tool calls, and memory operations are written to bound, so other surfaces observe
the work.

Configuration lives in `~/.bound/less/` (`config.json` for server URL, default model,
injected context files, and shell override; `mcp.json` for MCP servers).

```
boundless [--url <server-url>] [--attach <thread-id>] [--acp]
```

| Option | Description |
|--------|-------------|
| `--url <url>` | Override the configured server URL for this run (not persisted). Default `http://localhost:3001`. |
| `--attach <thread-id>` | Attach to an existing thread instead of creating a new one. |
| `--acp` | Run as an ACP agent server over stdio instead of rendering the terminal UI. |

Shell commands run in a write-confinement sandbox (seatbelt on macOS, bubblewrap on Linux,
IsolationSession on Windows): the whole filesystem is readable but writes are confined to
the working directory and `/tmp`.

### ACP mode (`--acp`)

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent
over stdio, letting ACP-compatible editors (Zed and others) drive bound as their backend
agent. The editor spawns `boundless --acp` as a subprocess and speaks JSON-RPC over
stdin/stdout. bound provides inference, memory, and model routing; the filesystem and shell
tools execute locally in the editor's workspace, gated through the editor's permission
prompts. Existing bound threads can be resumed via the protocol's `session/load`.

In this mode stdout is the JSON-RPC channel — boundless writes nothing else to stdout, and
diagnostics go to the file logger at `~/.bound/less/logs/` and to stderr for fatal startup
errors. `--attach` is ignored in ACP mode; ACP clients open sessions via `session/new` and
`session/load`. A running bound server (`bound start`) is required.

Example Zed configuration (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "bound": {
      "type": "custom",
      "command": "boundless",
      "args": ["--acp"],
      "env": {}
    }
  }
}
```

---

## Bootstrap sequence

`bound start` executes a strictly ordered bootstrap sequence. All steps must complete for
startup to proceed; if any step fails, startup halts with code 1.

1. **Load and validate all config files** — required `allowlist.json` and
   `model_backends.json`; optional `sync.json`, `keyring.json`, `mcp.json`, `network.json`,
   `platforms.json`.
2. **Initialize cryptography** — ensures an Ed25519 keypair exists (`data/host.key`
   private, `data/host.pub` public), used for cluster sync signing and host identity.
3. **Initialize database** — creates/opens `data/bound.db` (SQLite), runs migrations,
   establishes WAL mode.
4. **Set up services** — creates the `AppContext` (database, event bus, logger, config).
5. **Seed users from allowlist** — deterministic UUIDs via `deterministicUUID(BOUND_NAMESPACE, username)`.
6. **Register host** — inserts/updates the `hosts` row.
7. **Scan for crash recovery** — replays interrupted agent loops.
8. **Initialize MCP servers** — reads `mcp.json`, connects, registers discovered tools.
9. **Set up sandbox** — creates ClusterFs and defines available commands.
10. **Load persona** — reads the synced `cluster_config['persona']` row if present.
11. **Initialize LLM** — builds the model router from `model_backends.json`.
12. **Start web and sync servers** — web on `http://localhost:3001` (`WEB_PORT`/`WEB_BIND_HOST`),
    sync on `http://localhost:3000` (`PORT`/`BIND_HOST`); serves the embedded Svelte SPA.
13. **Initialize platform connectors** — reads `platforms.json`, starts the connector
    registry with leader election.
14. **Initialize sync loop** — reads `sync.json`, starts the WebSocket transport for
    push-on-write changelog replication.
15. **Start scheduler** — begins processing messages and tasks and autonomous execution.

Bootstrap is driven by file presence: absent `sync.json` skips step 14 (single-host mode);
absent `mcp.json` skips step 8; absent `platforms.json` skips step 13; an absent persona row
uses the model's default behavior.

Graceful shutdown reverses the order: stop scheduler, stop sync loop, close MCP connections,
shut down the web server, close the database, clear cryptographic material, exit 0.

---

## Web server and API

`bound start` initializes two HTTP servers: a web server on `http://localhost:3001`
(default; `WEB_PORT`) and a sync server on `http://localhost:3000` (default; `PORT`) for
hub-spoke replication.

- **WebSocket:** `GET /ws` (chat + event streaming, web server), `GET /sync/ws` (cluster
  sync transport, sync server).
- **API:** `POST /api/threads`, `POST /api/threads/:id/messages`, plus routes under
  `/api/files`, `/api/memory`, `/api/status`, `/api/tasks`, `/api/advisories`, `/api/mcp`.
  Cross-host MCP tool calls are relayed through the sync transport, not a dedicated HTTP
  proxy endpoint.
- **Web UI:** an embedded Svelte SPA (real-time chat, thread management, task-scheduler
  visualization, model/backend selection). Fully self-contained in the binary.

---

## Build pipeline

The Bound CLIs are built as standalone binaries via `bun build --compile`, eliminating
runtime dependency on Node.js or Bun. The pipeline is defined in `scripts/build.ts`:

1. **Generate build metadata** (`scripts/generate-build-info.ts`) — commit hash + timestamp.
2. **Build web assets** — `cd packages/web && bun run build`, then embed via
   `scripts/embed-assets.ts`.
3. **Compile binaries** — three standalone executables:

```bash
bun build --compile packages/cli/src/bound.ts --outfile dist/bound
bun build --compile packages/cli/src/boundctl.ts --outfile dist/boundctl
bun build --compile packages/less/src/boundless.tsx --outfile dist/boundless
```

Run the whole pipeline with:

```bash
bun scripts/build.ts
```

Each binary embeds the CLI/server code, all compiled dependencies, the web assets (in
`bound`), and the Bun runtime — no external runtime or static file hosting required.
Binaries are single-file, self-contained, ~45–50 MB, and platform-native (ELF / Mach-O /
PE). Built on one platform, deployable to the same OS/architecture.

### Development alternative

If binary compilation isn't available, run directly with Bun:

```bash
bun packages/cli/src/bound.ts --help
bun packages/cli/src/bound.ts init --ollama
bun packages/cli/src/bound.ts start
bun packages/cli/src/boundctl.ts set-hub primary-host
```

---

## Usage workflows

### Single-host setup

```bash
bound init --ollama --name operator
cat config/allowlist.json config/model_backends.json   # review
bound start                                             # open http://localhost:3001
```

### Multi-host cluster setup

```bash
# On each host (different --name):
bound init --anthropic --with-sync --name alice
bound start
# Then designate the hub:
boundctl set-hub hub-host --wait
```

Peer hosts discover the hub via `sync.json` on first sync; `boundctl set-hub` establishes
the authoritative designation.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic Claude models. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` | AWS Bedrock credentials (standard AWS SDK vars). |
| `CEREBRAS_API_KEY` | Cerebras Cloud preset. |
| `ZAI_API_KEY` | z.AI (GLM) preset. |
| `UMANS_API_KEY` | umans.ai preset. |
| `USER` | Fallback operator name if `--name` not provided (else `operator`). |
| `PORT` | Sync server port (default `3000`). |
| `BIND_HOST` | Sync server bind host (default `localhost`; set `0.0.0.0` on hubs so spokes can connect). |
| `WEB_PORT` | Web UI port (default `3001`). |
| `WEB_BIND_HOST` | Web UI bind host (default `localhost`). |
| `BOUND_ALLOW_UNSAFE_WEB_BIND` | Set to `1` to permit binding the web server to a non-loopback host. The web server refuses to start on a non-loopback `WEB_BIND_HOST` without this, because it exposes unauthenticated endpoints (`/api/sandbox/file` arbitrary cluster-FS read/write and `/ws` agent control) that assume a loopback-only trust boundary. Only set this if those endpoints are protected by an external network boundary. |

---

## Exit codes

All CLI commands use standard exit codes: `0` success, `1` error (invalid arguments,
initialization failure, database error, etc.).

---

## Troubleshooting

- **Configuration loading fails** — validate the required files:
  `jq . config/allowlist.json` and `jq . config/model_backends.json`.
- **Database connection fails** — ensure `data/bound.db` exists and is writable
  (`ls -la data/bound.db`); run `bound start` to initialize it.
- **Anthropic API key missing** — `export ANTHROPIC_API_KEY="sk-ant-..."` before init.
- **Bedrock authentication fails** — verify credentials with `aws sts get-caller-identity`
  and ensure the region supports Claude models.
- **Binary compilation fails** — expected without native build tools; use the development
  runner (`bun packages/cli/src/bound.ts start`).
