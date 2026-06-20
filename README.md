# Bound

A self-hosted personal agent that runs on your own infrastructure, maintains a persistent semantic memory graph across sessions and devices, executes autonomous work on schedules and events, and routes inference across multiple LLM backends — all replicated between hosts over a crypto-authenticated sync protocol.

## What makes it different

**Persistent semantic memory.** The agent's knowledge lives in a typed graph — not flat key-value pairs, but nodes connected by ten canonical relations (informs, supports, contrasts-with, summarizes, synthesizes, etc.) with automatic tier demotion (pinned → summary → detail) and stale-child cleanup. Memory is surfaced in context automatically and traversable by the agent.

**8-stage context assembly.** Every turn runs through a documented pipeline: retrieval → purge substitution → tool-pair sanitization → queueing → annotation → assembly → budget validation → metric recording. The assembler distinguishes a cold path (full rebuild, fixed cache marker) from a warm path (stable prefix + rolling cache marker + fresh volatile tail), applies telescope-model truncation across RECENT/MIDDLE/ANCIENT tiers, and detects orphan tool calls. Prompt cache placement is intentional, not incidental.

**Multi-host sync with Ed25519 identity.** Each host generates an Ed25519 keypair at startup; its `site_id` is derived from the public key. State replicates via a three-phase push/pull/ack protocol over XChaCha20-Poly1305-encrypted WebSocket frames, ordered by Hybrid Logical Clock. Spoke hosts delegate inference to the hub or other spokes via a relay transport that preserves context and cost attribution.

**Cluster-wide model routing.** The model router runs three phases: identify candidates across all connected hosts, qualify against capability requirements (tool_use, vision, extended_thinking, prompt_caching, max_context), and dispatch — local, remote relay, or structured error with unmet capabilities and earliest recovery time. Model selection is per-session, with tier-based fallback and same-tier failover on quota caps.

**Advisory system.** The agent can propose structured advisories (title, detail, action, impact) that appear in the operator interface. Advisories sit in a pending state until the operator approves, applies, defers, or dismisses them — giving the agent a way to surface recommendations without acting unilaterally.

**Skill injection.** Operator-defined `SKILL.md` files with frontmatter (name, description, triggers) are injected as system messages when a task payload names them, letting autonomous tasks carry specialized instructions without bloating the base prompt.

## Prerequisites

- [Bun](https://bun.sh) 1.2+
- An LLM backend (one of):
  - [Ollama](https://ollama.com) running locally — easiest to start
  - [Anthropic](https://www.anthropic.com) API key
  - AWS Bedrock access
  - Any OpenAI-compatible endpoint (Cerebras, z.AI, OpenCode Go, etc.)

## Quick start

```bash
git clone https://github.com/bound-agents/bound.git
cd bound
bun install

# Pick an LLM backend
bun run packages/cli/src/bound.ts init --ollama        # local Ollama
bun run packages/cli/src/bound.ts init --anthropic     # Anthropic API
bun run packages/cli/src/bound.ts init --bedrock --region us-east-1
bun run packages/cli/src/bound.ts init --opencode-go   # OpenCode Go

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
# Add optional feature config files at init time
bun run packages/cli/src/bound.ts init --ollama --with-sync --with-mcp --with-overlay
```

## Management (`boundctl`)

```bash
# Register a sync hub (multi-host setup)
bun run packages/cli/src/boundctl.ts set-hub my-cloud-vm

# Set the cluster-wide persona (propagates to every host on next sync)
bun run packages/cli/src/boundctl.ts set-persona --file config/persona.md
cat config/persona.md | bun run packages/cli/src/boundctl.ts set-persona

# Emergency stop — all hosts halt on next sync
bun run packages/cli/src/boundctl.ts stop
bun run packages/cli/src/boundctl.ts resume

# Point-in-time restore (soft-delete undo)
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z" --preview
bun run packages/cli/src/boundctl.ts restore --before "2026-03-20T10:00:00Z"
```

## LLM backends

Bound supports four driver families, all over the Vercel AI SDK with a unified streaming interface (`StreamChunk`: text, thinking, tool_use_start/_args/_end, done, error):

| Backend | Provider key | Notes |
|---------|-------------|-------|
| Ollama | `ollama` | NDJSON streaming, local or remote |
| Anthropic | `anthropic` | SSE streaming, prompt caching, extended thinking |
| AWS Bedrock | `bedrock` | SigV4 auth, converse API, cross-account ARN routing, reasoning effort levels (low/medium/high/xhigh/max) |
| OpenAI-compatible | `openai` | stdio or HTTP, custom headers, `cerebras`/`zai`/`opencode-go` shims |

Tool IDs and names are sanitized to `[a-zA-Z0-9_-]{1,64}` at streaming and read boundaries for cross-provider portability. Extended-thinking signatures are enforced on replay to Anthropic and Bedrock; blocks with missing signatures are dropped rather than forwarded.

Per-backend config (in `model_backends.json`) supports: `context_window`, `tier`, pricing fields, `thinking`, `effort`, `max_output_tokens`, `cache_ttl` (`"5m"` | `"1h"`), `capabilities` overrides, `connect_timeout_ms`, `additional_headers`, and `cache_warming`.

## Autonomous tasks

The scheduler runs three task types with DAG dependency resolution:

- **cron** — standard 5-field cron expressions
- **delay** — relative offsets (`5m`, `2h`, `1d`)
- **on_event** — triggered by named events emitted from tools or external webhooks

Tasks carry optional `payload` (JSON), `skill` (injected system message), `model_hint`, `after` (predecessor task IDs), `require_success`, and `inject_mode` (results/all/file). Alert thresholds trigger advisories after consecutive failures. In a cluster, a leaderless rendezvous gate ensures singleton tasks run on exactly one host.

The agent schedules and cancels tasks via the `task` tool, emits events with `emit`, and blocks on event sets with `await_event`.

## Agent tools

Bound ships 15 native tools with typed JSON schemas — no argument-parsing bugs, no shell injection surface:

| Tool | Actions |
|------|---------|
| `memory` | store, forget, search, connect, disconnect, traverse, neighbors |
| `task` | schedule, update |
| `skill` | activate, list, read, retire |
| `cache` | warm, pin, unpin, evict |
| `advisory` | title, detail, action, impact, list, approve, apply, dismiss, defer |
| `query` | read-only SQL (SELECT + safe PRAGMA whitelist, auto-LIMIT 1000) |
| `cancel` | by task_id or payload match |
| `emit` | name + JSON payload, broadcast to all cluster hosts |
| `await_event` | block on task_ids + timeout |
| `purge` | exclude message_ids or last_n from future context |
| `notify` | inject developer-role context into a thread |
| `introspect` | execute on a remote host and stream output back |
| `archive` | soft-delete messages older than a threshold |
| `model_hint` | set model preference for the next turn |
| `hostinfo` | cluster topology, sync state, active sessions, advisories |

MCP servers connected via `mcp.json` are auto-registered as additional tools — one command per server, dispatched by `subcommand`.

## Boundless — terminal coding agent

`boundless` connects to a running bound server, attaches to a thread, and registers local filesystem and shell tools (plus any MCP servers in `~/.bound/less/mcp.json`) into the agent's tool set. The agent can read and edit files and run commands in your working directory. All messages, tool calls, and memory live in bound — the web UI, Discord, and scheduled tasks all see the same state.

```bash
bun run packages/cli/src/boundless.ts          # or ./dist/boundless after a build

boundless --url http://localhost:3001          # non-default server
boundless --attach <thread-id>                 # resume an existing thread
```

Config: `~/.bound/less/config.json` (server URL, default model, injected context files, shell override, sandbox policy) and `~/.bound/less/mcp.json` (MCP servers).

### Filesystem sandbox

Shell commands run inside a write-confinement sandbox via Microsoft's [mxc](https://github.com/microsoft/mxc): the whole filesystem stays readable, but writes are confined to the working directory and `/tmp`. The agent can edit your project but can't touch `~/.ssh`, sibling checkouts, or `/etc`. Network is unrestricted.

| Platform | Backend |
|----------|---------|
| macOS | seatbelt — no setup required |
| Linux | bubblewrap — no setup required |
| Windows | IsolationSession (BaseContainer `E_NOTIMPL` on current builds; falls back automatically) |

`.git/hooks` and `.git/config` inside the working tree stay read-only even though the rest of the tree is writable — a run can't plant a hook that fires on your next `git` command. Enforced on macOS and Linux, and for in-process file tools on every platform; Windows cannot express the read-only subpath constraint in the current mxc backend (tracked upstream).

The sandbox is on by default. `onUnavailable: "error"` (default) refuses to run a command rather than silently drop write protection; `"passthrough"` runs unsandboxed with a warning. Fine-grained control:

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

### Editor integration (ACP)

`boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio. ACP-compatible editors (Zed and others) spawn it as a subprocess; bound provides inference, memory, and model routing while file and shell tools run locally. Tool calls are gated through the editor's permission prompts.

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

ACP session options exposed as `configOptions` dropdowns: **model** (for new turns) and **mode** (`Ask every time` / `Accept edits` / `Bypass permissions`). MCP servers the editor passes at init/resume are merged alongside `~/.bound/less/mcp.json`; on name collision the local entry wins.

Image prompts forward through: `image/jpeg`, `image/png`, `image/gif`, and `image/webp` content blocks ride to the model as real image data (stored as `file_ref` in the `files` table; resolved at inference time). Unsupported types and audio are elided with a labeled text note.

## MCP integration

Bound both consumes and exposes MCP:

**Consuming** — servers in `mcp.json` (`stdio` or `http` transport) are registered as agent tools. The web server exposes a cross-host MCP proxy at `POST /api/mcp-proxy`. MCP Apps (servers advertising the `io.modelcontextprotocol/ui` capability) render their tool results inline as interactive apps in the web UI.

**Exposing** — `bound-mcp` is a standalone stdio MCP server that exposes a `bound_chat` tool, letting any MCP-compatible client drive a bound thread.

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

The Discord connector runs as an in-process MCP server. DMs are routed to threads; leader election (auto/leader/standby/all roles, configurable failover threshold) ensures only one host holds active subscriptions. Outbound delivery via `discord_send_message`; inbound via webhook or polling. Configured in `platforms.json`.

## Configuration

After `bound init`, `config/` contains:

| File | Required | Description |
|------|----------|-------------|
| `allowlist.json` | Yes | Users permitted to interact; `default_web_user` + user map with display_name and platform handles |
| `model_backends.json` | Yes | LLM backend definitions; per-backend routing, pricing, cache warming, extended thinking, and capability overrides |
| `network.json` | No | Outbound HTTP allowlist for the sandbox, with per-URL header injection |
| `platforms.json` | No | Platform connectors (Discord token, allowed users, leadership role, failover threshold) |
| `sync.json` | No | Hub URL (on spokes), relay tuning, WebSocket backoff and backpressure settings |
| `keyring.json` | No | Per-host Ed25519 public keys and URLs (auto-populated by sync handshake) |
| `mcp.json` | No | MCP server connections; `io.modelcontextprotocol/ui` tools render inline in the web UI |
| `overlay.json` | No | Codebase mount points (`/mnt/<name>` → real path) |
| `cron_schedules.json` | No | Recurring task definitions with schedule, payload, skill, model hint, and dependency fields |
| `memory.json` | No | Pinned-memory caps (`pinned_count_cap` default 10, `pinned_size_cap` default 2000 chars) |
| `persona.md` | No | Seed for the cluster-wide persona — loaded once into `cluster_config['persona']` on first start; edit live with `boundctl set-persona` or the web UI |

All schemas are **strict** — unknown keys fail loudly. Add new fields in `packages/shared/src/config-schemas.ts` before using them.

See [docs/config.md](docs/config.md) for the full per-field reference.

## Architecture

```
packages/
  shared/       Cross-cutting types, Zod config schemas, HLC, OpenTelemetry support
  core/         SQLite schema (19 STRICT tables, WAL mode), DI container, config loader, outbox
  sync/         Ed25519-signed sync, XChaCha20 encryption, LWW/append-only reducers, three-phase protocol
  sandbox/      Virtual filesystem (InMemoryFs/ClusterFs), OCC persistence, command framework
  llm/          4 LLM drivers over Vercel AI SDK, cluster-wide model router, capability detection
  agent/        Agent loop state machine, 8-stage context pipeline, 15 native tools, scheduler, MCP bridge
  platforms/    In-process platform connectors (Discord), leader election, intake pipeline
  web/          Hono API + Bun.serve WebSocket, Svelte 5 SPA (embedded into binary)
  client/       BoundClient: HTTP + WebSocket SDK for external consumers
  mcp-server/   Standalone stdio MCP server (bound-mcp, exposes bound_chat tool)
  less/         Terminal coding agent client (boundless), TUI, ACP mode, filesystem sandbox
  cli/          bound init/start, boundctl, boundless, bound-mcp — compiles to four binaries
```

**Agent loop states:** IDLE → HYDRATE_FS → ASSEMBLE_CONTEXT → LLM_CALL → PARSE_RESPONSE → TOOL_EXECUTE → TOOL_PERSIST → RESPONSE_PERSIST → FS_PERSIST → QUEUE_CHECK (→ RELAY_WAIT / RELAY_STREAM for remote inference) → back to IDLE or ERROR_PERSIST.

**Sync protocol:** push (spoke sends events) → pull (fetch hub's events) → ack (confirm receipt). Relay kinds include tool_call, inference, intake, platform_deliver, event_broadcast, and their response counterparts. State is never hard-deleted; all synced tables use soft deletes and LWW conflict resolution by `modified_at`.

**Virtual filesystem:** the agent's working directory is an in-memory overlay. Writes flush to SQLite via optimistic concurrency control (pre/post SHA-256 snapshot, `BEGIN IMMEDIATE`). The `ClusterFs` routes `/mnt/<name>` to overlay mounts on real host paths.

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
