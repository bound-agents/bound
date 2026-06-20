# Bound

A persistent personal agent that runs across multiple hosts. State — messages, memory, files, tasks — replicates between a laptop and a cloud VM (or any set of hosts) over a crypto-authenticated sync protocol, so every interface sees the same agent with the same context.

## What makes it different

**Multi-host sync.** Each host generates an Ed25519 keypair at startup. State replicates via a three-phase push/pull/ack protocol over XChaCha20-encrypted WebSocket frames, ordered by Hybrid Logical Clock. Spokes can relay inference to the hub or other spokes, with context and cost attribution preserved. The agent is the same agent everywhere, not a copy per device.

**Cluster-wide model routing.** The model router selects a backend and host based on capability requirements (tool use, vision, extended thinking, prompt caching, context window), with tier-based fallback and same-tier failover on quota caps. Inference can run locally or be relayed to a remote host transparently.

**Autonomous task scheduler.** Tasks are cron-scheduled, time-deferred, or event-driven, and can form DAG dependency chains — a task can declare predecessors, require their success, and inherit their output. The agent schedules, cancels, and reacts to tasks via tools. In a cluster, a rendezvous gate ensures singleton tasks run on exactly one host.

**Persistent memory.** The agent maintains a knowledge graph that accumulates across sessions and devices — nodes with typed relations, automatic tier demotion (pinned → summary → detail), and stale-child cleanup. Memory surfaces in context automatically and is traversable by the agent.

**Context that stays coherent.** Long conversations don't silently degrade. The context assembler distinguishes a cold path (full rebuild, fixed cache marker) from a warm path (stable prefix + rolling cache marker + fresh tail), applies tiered truncation across recent/middle/ancient message ranges, and detects orphan tool calls. Prompt cache placement is intentional.

**Advisory system.** The agent can propose structured advisories (title, detail, recommended action, impact) that sit pending until the operator approves, applies, defers, or dismisses them — a channel for recommendations that don't require immediate autonomous action.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend (one of):
  - [Ollama](https://ollama.com) running locally — easiest to start
  - AWS Bedrock access
  - Any OpenAI-compatible endpoint (Cerebras, z.AI, OpenCode Go, etc.)

## Quick start

```bash
git clone https://github.com/bound-agents/bound.git
cd bound
bun install

# Pick an LLM backend
bun run packages/cli/src/bound.ts init --ollama
bun run packages/cli/src/bound.ts init --bedrock --region us-east-1
bun run packages/cli/src/bound.ts init --opencode-go

# Start
bun run packages/cli/src/bound.ts start
```

Open [http://localhost:3001](http://localhost:3001). The sync protocol listens on port 3000 (`PORT`); the web UI on port 3001 (`WEB_PORT`).

### Build a single binary

```bash
bun run build
./dist/bound init --ollama
./dist/bound start
```

### Docker

```bash
docker build -t bound . --build-arg TARGETARCH=amd64
docker run -v /app/config -v /app/data -p 3000:3000 -p 3001:3001 bound
```

### Optional init flags

```bash
bun run packages/cli/src/bound.ts init --ollama --with-sync --with-mcp --with-overlay
```

## Management (`boundctl`)

```bash
# Register a sync hub
bun run packages/cli/src/boundctl.ts set-hub my-cloud-vm

# Update the cluster-wide persona (propagates to every host on next sync)
bun run packages/cli/src/boundctl.ts set-persona --file config/persona.md
cat config/persona.md | bun run packages/cli/src/boundctl.ts set-persona

# Emergency stop — all hosts halt on next sync
bun run packages/cli/src/boundctl.ts stop
bun run packages/cli/src/boundctl.ts resume

# Point-in-time restore (soft-delete undo)
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z" --preview
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z"
```

## Boundless — terminal coding agent

`boundless` connects to a running bound server, attaches to a thread, and registers local filesystem and shell tools (plus any MCP servers in `~/.bound/less/mcp.json`) into the agent's tool set. The agent reads and edits files and runs commands in your working directory. All messages, tool calls, and memory live in bound — the web UI, Discord, and scheduled tasks all see the same state.

```bash
bun run packages/cli/src/boundless.ts          # or ./dist/boundless after a build

boundless --url http://localhost:3001          # non-default server
boundless --attach <thread-id>                 # resume an existing thread
```

Config: `~/.bound/less/config.json` (server URL, default model, injected context files, sandbox policy) and `~/.bound/less/mcp.json` (MCP servers).

### Filesystem sandbox

Shell commands run inside a write-confinement sandbox via Microsoft's [mxc](https://github.com/microsoft/mxc). The whole filesystem stays readable, but writes are confined to the working directory and `/tmp` — the agent can edit your project but can't touch `~/.ssh`, sibling checkouts, or `/etc`. No setup required on macOS (seatbelt) or Linux (bubblewrap). On Windows, mxc uses IsolationSession (BaseContainer is not yet implemented in shipping builds; boundless falls back automatically).

`.git/hooks` and `.git/config` stay read-only inside the working tree even though the rest of the tree is writable, so the agent can't plant hooks that fire on your next `git` command. Enforced on macOS and Linux, and for in-process file tools on every platform; the Windows mxc backend can't express a read-only subpath inside a writable parent, so this carve-out doesn't apply there.

The sandbox is on by default. `onUnavailable: "error"` (the default) refuses to run a command rather than silently drop write protection; set `"passthrough"` to run unsandboxed with a warning instead. Fine-grained control:

```json
{
  "sandbox": {
    "enabled": true,
    "writablePaths": ["/extra/path/to/allow/writes"],
    "network": "open",
    "onUnavailable": "error"
  }
}
```

### ACP mode

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio. ACP-compatible editors spawn it as a subprocess; bound handles inference, memory, and model routing while file and shell tools run locally with the editor's permission prompts.

Session options exposed as `configOptions` dropdowns: **model** (for new turns) and **mode** (`Ask every time` / `Accept edits` / `Bypass permissions`). MCP servers the editor passes at session init are merged with `~/.bound/less/mcp.json`; on name collision the local entry wins.

Image prompts forward through: JPEG, PNG, GIF, and WebP content blocks ride to the model as real image data (stored as `file_ref` in the `files` table; resolved at inference time).

## MCP

Bound both consumes and exposes MCP:

**Consuming** — servers in `mcp.json` (`stdio` or `http` transport) are registered as agent tools. The web server exposes a cross-host MCP proxy at `POST /api/mcp-proxy`. Servers advertising the `io.modelcontextprotocol/ui` capability render their tool results inline as interactive apps in the web UI.

**Exposing** — `bound-mcp` is a standalone stdio MCP server that exposes a `bound_chat` tool, letting any MCP client drive a bound thread.

Example `mcp.json`:
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

## Discord

The Discord connector runs as an in-process MCP server. DMs route to threads; leader election (auto/leader/standby/all roles, configurable failover threshold) ensures only one host holds active subscriptions. Configured in `platforms.json`.

## Configuration

After `bound init`, `config/` contains:

| File | Required | Description |
|------|----------|-------------|
| `allowlist.json` | Yes | Users permitted to interact; `default_web_user` + user map with display names and platform handles |
| `model_backends.json` | Yes | LLM backend definitions: routing, pricing, cache warming, extended thinking, capability overrides |
| `network.json` | No | Outbound HTTP allowlist for the sandbox, with per-URL header injection |
| `platforms.json` | No | Platform connectors (Discord token, allowed users, leadership role, failover threshold) |
| `sync.json` | No | Hub URL (on spokes), relay tuning, WebSocket backoff and backpressure settings |
| `keyring.json` | No | Per-host Ed25519 public keys and URLs (auto-populated by sync handshake) |
| `mcp.json` | No | MCP server connections |
| `overlay.json` | No | Codebase mount points (`/mnt/<name>` → real path) |
| `cron_schedules.json` | No | Recurring task definitions with schedule, payload, skill, model hint, and dependency fields |
| `memory.json` | No | Pinned-memory caps (`pinned_count_cap` default 10, `pinned_size_cap` default 2000 chars) |
| `persona.md` | No | Seed for the cluster-wide persona — loaded once into `cluster_config['persona']` on first start; edit live with `boundctl set-persona` or the web UI |

All schemas are strict — unknown keys fail loudly. Add new fields in `packages/shared/src/config-schemas.ts` before using them.

See [docs/config.md](docs/config.md) for the full per-field reference.

## Architecture

```
packages/
  shared/       Cross-cutting types, Zod config schemas, HLC, OpenTelemetry support
  core/         SQLite schema (19 STRICT tables, WAL mode), DI container, config loader, outbox
  sync/         Ed25519-signed sync, XChaCha20 encryption, LWW/append-only reducers, three-phase protocol
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), OCC persistence, command framework
  llm/          LLM drivers over Vercel AI SDK, cluster-wide model router, capability detection
  agent/        Agent loop, context pipeline, native tools, scheduler, MCP bridge
  platforms/    In-process platform connectors (Discord), leader election, intake pipeline
  web/          Hono API + Bun.serve WebSocket, Svelte 5 SPA (embedded into binary)
  client/       BoundClient: HTTP + WebSocket SDK for external consumers
  mcp-server/   Standalone stdio MCP server (bound-mcp)
  less/         Terminal coding agent client (boundless), TUI, ACP mode, filesystem sandbox
  cli/          bound init/start, boundctl, boundless, bound-mcp — compiles to four binaries
```

See [docs/design/architecture.md](docs/design/architecture.md) for the package dependency graph and data flow.

## Development

```bash
bun test --recursive    # all tests
bun run lint            # Biome lint
bun run typecheck       # tsc
bun run lint:fix        # auto-fix formatting
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for testing conventions, critical invariants, and contributor checklists.

## License

See [LICENSE](LICENSE) for details.
