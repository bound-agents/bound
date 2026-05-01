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

Open [http://localhost:3000](http://localhost:3000) in your browser.

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

# Emergency stop (all hosts halt on next sync)
bun run packages/cli/src/boundctl.ts stop

# Resume operations
bun run packages/cli/src/boundctl.ts resume

# Point-in-time restore
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z" --preview
```

## Project structure

```
packages/
  shared/       Cross-cutting types, events, config schemas (Zod)
  core/         SQLite database (WAL mode, STRICT tables), DI container, config loader, outbox
  sync/         Ed25519-signed WebSocket sync with XChaCha20 encryption, LWW/append-only reducers
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), OCC persistence, command framework
  llm/          LLM drivers (Bedrock, OpenAI-compatible) over the Vercel AI SDK, model router
  agent/        Agent loop state machine, 8-stage context pipeline, 14 native tools, scheduler, MCP bridge
  platforms/    PlatformConnector framework (Discord, webhook)
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
| `model_backends.json` | Yes | LLM backend configuration |
| `platforms.json` | No | Platform connector config (Discord bot token, webhook stubs) |
| `sync.json` | No | Hub URL, sync interval, relay and WS settings |
| `keyring.json` | No | Per-host identity keys (auto-populated) |
| `mcp.json` | No | MCP server connections (stdio or http transport) |
| `overlay.json` | No | Codebase mount points |
| `cron_schedules.json` | No | Recurring task definitions |
| `persona.md` | No | Custom system prompt personality |

All config schemas are **strict** — unknown keys fail parse. Declare new fields in the Zod schema (`packages/shared/src/config-schemas.ts`) before using them.

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
- **14 native agent tools** with structured JSON schemas (`schedule`, `query`, `memory`, `cache`, `skill`, `advisory`, `emit`, `cancel`, `purge`, `notify`, `archive`, `model_hint`, `hostinfo`, `await_event`). Tools receive typed parameters directly from the LLM, eliminating argument-parsing bugs.
- **MCP integration** auto-generates one command per connected MCP server (stdio or http transport), dispatched via a `subcommand` parameter. Tools are available during chat and via a cross-host MCP proxy.
- **Web UI** is built as a Svelte 5 SPA and embedded into the compiled binary for zero external dependencies.

## License

See [LICENSE](LICENSE) for details.
