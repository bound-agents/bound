# Bound

A persistent, model-agnostic personal agent that runs on your own infrastructure. It maintains memory across conversations and hosts, reads codebases via overlay mounts, uses external services through MCP tools, and performs autonomous work on schedules or in response to events.

## What it does

- **Autonomous task execution** with full conversational context -- schedule checks, post updates, file issues, send reminders
- **Cross-session memory** that persists across conversations, devices, and interfaces (web, Discord)
- **Multi-host sync** -- run on a laptop and a cloud VM, with state replicating via Ed25519-signed HTTP
- **Model-agnostic** -- switch between Ollama, Anthropic Claude, AWS Bedrock, and OpenAI-compatible endpoints per session
- **Your infrastructure, your data** -- runs locally, no external dependencies beyond the LLM backend you choose

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend (one of):
  - [Ollama](https://ollama.com) running locally (easiest to start)
  - Anthropic API key
  - AWS Bedrock access
  - Any OpenAI-compatible endpoint

## Quick start

```bash
# Clone and install
git clone https://github.com/karashiiro/bound.git
cd bound
bun install

# Initialize config (pick your LLM backend)
bun run packages/cli/src/bound.ts init --ollama

# Start the system
bun run packages/cli/src/bound.ts start
```

Open [http://localhost:3001](http://localhost:3001) in your browser. (The web UI listens on `WEB_PORT`, default 3001; the sync protocol uses `PORT`, default 3000.)

### Other LLM backends

```bash
# Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-... bun run packages/cli/src/bound.ts init --anthropic

# AWS Bedrock
bun run packages/cli/src/bound.ts init --bedrock --region us-east-1

# With optional features
bun run packages/cli/src/bound.ts init --ollama --with-sync --with-mcp --with-overlay
```

## Build a single binary

```bash
bun run build
./dist/bound init --ollama
./dist/bound start
```

## Management commands

```bash
# Set a sync hub (multi-host)
bun run packages/cli/src/boundctl.ts set-hub my-cloud-vm

# Set the cluster-wide persona (propagates to every host on next sync)
bun run packages/cli/src/boundctl.ts set-persona --file config/persona.md
cat config/persona.md | bun run packages/cli/src/boundctl.ts set-persona

# Emergency stop (all hosts halt on next sync)
bun run packages/cli/src/boundctl.ts stop

# Resume operations
bun run packages/cli/src/boundctl.ts resume

# Point-in-time restore
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z" --preview
```

## Coding agent (boundless)

`boundless` is a terminal coding-agent client for bound. It connects to a running
bound server, attaches to a thread, and registers host-side filesystem and shell
tools (plus any MCP servers you configure) into the agent's tool set — so the agent
can read and edit files and run commands in your working directory. The session's
messages, tool calls, and memory all live in bound, so other surfaces (web, Discord,
scheduled tasks) see the work too.

```bash
# Run the terminal UI in your project directory
bun run packages/cli/src/boundless.ts          # or ./dist/boundless after a build

# Point at a non-default server, or resume an existing thread
boundless --url http://localhost:3001
boundless --attach <thread-id>
```

Config lives at `~/.bound/less/config.json` (server URL, default model, injected
context files, shell override, filesystem sandbox) and `~/.bound/less/mcp.json` (MCP servers).

By default, shell commands run inside a filesystem sandbox (Microsoft's
[mxc](https://github.com/microsoft/mxc), cross-platform via seatbelt on macOS and
bubblewrap on Linux): the whole filesystem stays readable, but writes are confined to
the working directory and the system temp dir — so the agent can edit your project but
can't clobber `~/.ssh`, a sibling checkout, or `/etc`. Network is unrestricted. It's
opt-out — set `"sandbox": false` to disable, or use the object form for finer control:

```json
{
  "sandbox": {
    "enabled": true,
    "writablePaths": ["/extra/path/to/allow/writes"],
    "network": "open",
    "onUnavailable": "passthrough"
  }
}
```

On a platform where mxc can't sandbox, `onUnavailable` decides the posture:
`"passthrough"` (default) runs the command unsandboxed with a warning rather than break
the shell; `"error"` refuses to run it.

### Editor integration (ACP)

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com)
agent over stdio, so ACP-compatible editors (Zed and others) can drive bound as their
backend agent. The editor spawns `boundless --acp` as a subprocess and speaks JSON-RPC
over stdin/stdout; bound provides the inference, memory, and model routing, while the
file and shell tools run locally in the editor's workspace. Tool calls are gated
through the editor's permission prompts, and existing bound threads can be resumed.

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

Pass `--url` after `--acp` to target a non-default server. Requires a running bound
server (`bound start`).

MCP servers the editor passes at session init/resume (Zed's `mcp_servers`) are merged
into the agent's tool set alongside any servers in `~/.bound/less/mcp.json`. `stdio` and
`http` transports map through (including `http` request headers); `sse` and nested-`acp`
transports are skipped with a log
warning. On a name collision the local `mcp.json` entry wins, so a session param can't
silently shadow an operator-configured server (which may carry secrets in `env`).

Two session-level selectors ride alongside the conversation as ACP `configOptions` (the
editor renders them as dropdowns): the **model** for new turns, and the **mode** — the
permission posture for tool calls. Modes are `Ask every time` (prompt before each call,
the default), `Accept edits` (auto-approve file reads and edits, still prompt before
running commands), and `Bypass permissions` (auto-approve everything). The default mode
is byte-identical to per-call prompting; a non-default mode is opt-in per session.

Image prompts are forwarded: a prompt that includes an image content block (a pasted or
attached `image/jpeg`, `image/png`, `image/gif`, or `image/webp`) rides through to the
model as a real image rather than being flattened to a placeholder. The bytes are
persisted as a `file_ref` into the `files` table so `messages.content` stays light, and
resolved back to image data at inference time. Unsupported image media types and audio
are still elided with a labeled text note.

## Project structure

```
packages/
  shared/       Cross-cutting types, events, config schemas (Zod)
  core/         SQLite database (WAL mode, STRICT tables), DI container, config loader, outbox
  sync/         Ed25519-signed WebSocket sync with XChaCha20 encryption, LWW/append-only reducers
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), OCC persistence, command framework
  llm/          LLM drivers (Bedrock, OpenAI-compatible) over the Vercel AI SDK, model router
  agent/        Agent loop state machine, 8-stage context pipeline, 12 native tools, scheduler, MCP bridge
  platforms/    MCP-based platform connectors (Discord), connector handles, connector tool
  web/          Hono API server, WebSocket, Svelte 5 UI
  client/       BoundClient: unified HTTP + WebSocket client for external consumers
  mcp-server/   Standalone MCP stdio server (bound-mcp)
  less/         Terminal coding agent client (boundless)
  cli/          CLI commands (bound init/start, boundctl); compiles to four binaries
```

See [docs/design/architecture.md](docs/design/architecture.md) for the package dependency graph and data flow, and [CONTRIBUTING.md](CONTRIBUTING.md) for developer-facing setup, testing conventions, and invariants.

## Development

```bash
# Run all tests
bun test --recursive

# Lint
bun run lint

# Type check
bun run typecheck

# Fix formatting
bun run lint:fix
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for testing conventions, critical invariants, and contributor checklists.

### Config files

After `bound init`, the `config/` directory contains:

| File | Required | Description |
|------|----------|-------------|
| `allowlist.json` | Yes | Users allowed to interact with the agent |
| `model_backends.json` | Yes | LLM backend configuration (per-backend model routing, pricing, and optional cache warming) |
| `platforms.json` | No | Platform connector config (Discord bot token, MCP server settings) |
| `sync.json` | No | Hub URL, sync interval, relay and WS settings |
| `keyring.json` | No | Per-host identity keys (auto-populated) |
| `mcp.json` | No | MCP server connections (stdio or http transport). UI-bearing tools on an http/sse server (per the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) `io.modelcontextprotocol/ui` capability) render inline as interactive apps in the web UI. |
| `overlay.json` | No | Codebase mount points |
| `cron_schedules.json` | No | Recurring task definitions |
| `memory.json` | No | Pinned-memory caps (`pinned_count_cap`, default 10; `pinned_size_cap`, default 2000 chars) |
| `persona.md` | No | Seed for the cluster-wide persona. On first start it is loaded into the synced `cluster_config['persona']` row; after that the row is source of truth and the file is inert. Edit the live persona with `boundctl set-persona` or the web UI. |

All config schemas are **strict** — unknown keys fail parse. Declare new fields in the Zod schema (`packages/shared/src/config-schemas.ts`) before using them.

See [docs/config.md](docs/config.md) for the per-field reference for every config file.

### MCP Server Configuration

MCP servers are configured in `mcp.json` with either `stdio` or `http` transport. Tools from connected servers are automatically registered as commands available to the agent during chat.

Example with stdio transport:
```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  ]
}
```

The web server also exposes a cross-host MCP proxy at `POST /api/mcp-proxy` for accessing tools from connected servers in a distributed setup.

## Architecture

The system uses an event-sourced architecture with SQLite as the storage layer:

- **Agent loop** processes messages through a state machine: hydrate filesystem, assemble context, call LLM, execute tools, persist results
- **Scheduler** fires cron, deferred, and event-driven tasks with DAG dependency resolution
- **Sync protocol** replicates state between hosts over encrypted WebSocket frames (Ed25519 identity, XChaCha20-Poly1305 at frame level, HLC-ordered change log). Keypair is auto-generated at `data/host.key` / `data/host.pub`.
- **12 native agent tools** with structured JSON schemas (`task`, `query`, `memory`, `skill`, `advisory`, `cancel`, `purge`, `notify`, `introspect`, `archive`, `model_hint`, `hostinfo`). Tools receive typed parameters directly from the LLM, eliminating argument-parsing bugs.
- **MCP integration** auto-generates one command per connected MCP server (stdio or http transport), dispatched via a `subcommand` parameter. Tools are available during chat and via a cross-host MCP proxy.
- **Platform connectors** (Discord, etc.) are implemented as in-process MCP servers. A unified connector tool manages event subscriptions (connector handles), and platform tools are scoped per-thread through annotation-based filtering. Leader election ensures only one host runs active subscriptions.
- **Web UI** is built as a Svelte 5 SPA and embedded into the compiled binary for zero external dependencies.

## License

See [LICENSE](LICENSE) for details.
