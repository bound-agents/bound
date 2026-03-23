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
  shared/     Cross-cutting types, events, config schemas (Zod)
  core/       SQLite database (13 tables, WAL mode), DI container, config loader
  sync/       Ed25519-signed HTTP sync protocol, LWW/append-only reducers
  sandbox/    Virtual filesystem (ClusterFs), OCC persistence, command framework
  llm/        LLM drivers (Ollama, Anthropic, Bedrock, OpenAI), model router
  agent/      Agent loop state machine, 14 commands, scheduler, MCP bridge
  web/        Hono API server, WebSocket, Svelte 5 metro-themed UI
  discord/    Discord bot for DM-based agent interaction
  cli/        CLI commands (init, start, boundctl)
```

## Development

```bash
# Run all tests
bun test packages/shared packages/core packages/sync packages/sandbox packages/llm packages/agent packages/web packages/discord

# Lint
bun run lint

# Type check
bun run typecheck

# Fix formatting
bun run lint:fix
```

### Config files

After `bound init`, the `config/` directory contains:

| File | Required | Description |
|------|----------|-------------|
| `allowlist.json` | Yes | Users allowed to interact with the agent |
| `model_backends.json` | Yes | LLM backend configuration |
| `discord.json` | No | Discord bot token and host assignment |
| `sync.json` | No | Hub URL and sync interval for multi-host |
| `mcp.json` | No | MCP server connections (stdio or http transport) |
| `overlay.json` | No | Codebase mount points |
| `cron_schedules.json` | No | Recurring task definitions |
| `persona.md` | No | Custom system prompt personality |

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
- **Sync protocol** replicates state between hosts via a three-phase push/pull/ack cycle with Ed25519 authentication. Keypair is auto-generated and stored in `data/host.key` and `data/host.pub`
- **14 built-in commands** available to the agent: `query`, `memorize`, `forget`, `schedule`, `await`, `cancel`, `emit`, `purge`, `cache-warm`, `cache-pin`, `cache-unpin`, `cache-evict`, `model-hint`, `archive`
- **MCP integration** auto-generates commands from connected MCP servers (stdio or http transport). Tools are available to the agent during chat and accessible via the MCP proxy for cross-host scenarios
- **Web UI** is built as a Svelte SPA and embedded into the compiled binary for zero external dependencies

## License

See [LICENSE](LICENSE) for details.
