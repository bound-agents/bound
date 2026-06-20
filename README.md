# Bound

A persistent personal agent that runs across multiple hosts. State — messages, memory, files, tasks — replicates between a laptop and a cloud VM (or any set of hosts) over a crypto-authenticated sync protocol, so every interface sees the same agent with the same context.

## What makes it different

**Multi-host sync.** Each host generates an Ed25519 keypair at startup. State replicates via a three-phase push/pull/ack protocol over XChaCha20-encrypted frames, ordered by Hybrid Logical Clock. Spokes can relay inference to the hub or other spokes, with context and cost attribution preserved.

**Cluster-wide model routing.** The model router selects a backend and host based on capability requirements (tool use, vision, extended thinking, prompt caching, context window), with tier-based fallback and same-tier failover on quota caps. Inference can run locally or be relayed to a remote host transparently.

**Autonomous task scheduler.** Tasks are cron-scheduled, time-deferred, or event-driven, and can form DAG dependency chains — a task can declare predecessors, require their success, and inherit their output. In a cluster, a rendezvous gate ensures singleton tasks run on exactly one host.

**Persistent memory.** The agent maintains a knowledge graph that accumulates across sessions and devices — nodes with typed relations, automatic tier demotion, and stale-child cleanup. Memory surfaces in context automatically and is traversable by the agent.

**Context that stays coherent.** Long conversations don't silently degrade. The context assembler tracks a stable prefix across turns, applies tiered truncation across recent/middle/ancient message ranges, and places prompt cache markers intentionally.

**Advisory system.** The agent can propose structured advisories (title, detail, recommended action, impact) that sit pending until the operator approves, applies, defers, or dismisses them.

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

# Pick a backend
bun run packages/cli/src/bound.ts init --ollama
bun run packages/cli/src/bound.ts init --bedrock --region us-east-1
bun run packages/cli/src/bound.ts init --opencode-go

bun run packages/cli/src/bound.ts start
```

Open [http://localhost:3001](http://localhost:3001). The sync protocol listens on port 3000 (`PORT`); the web UI on port 3001 (`WEB_PORT`).

Build a single binary instead: `bun run build`, then `./dist/bound init --ollama && ./dist/bound start`.

## Boundless — terminal coding agent

`boundless` connects to a running bound server and registers local filesystem and shell tools into the agent's tool set. The agent reads and edits files and runs commands in your working directory; all messages, memory, and tool calls live in bound, so every other interface sees the same state.

```bash
bun run packages/cli/src/boundless.ts    # or ./dist/boundless after a build
boundless --url http://localhost:3001    # non-default server
boundless --attach <thread-id>           # resume an existing thread
```

Shell commands run in a write-confinement sandbox (seatbelt on macOS, bubblewrap on Linux, IsolationSession on Windows): the whole filesystem is readable but writes are confined to the working directory and `/tmp`. `boundless --acp` runs as an [Agent Client Protocol](https://agentclientprotocol.com) agent over stdio for ACP-compatible editors.

## Config files

After `bound init`, `config/` contains:

| File | Required | Description |
|------|----------|-------------|
| `allowlist.json` | Yes | Users permitted to interact; `default_web_user` + user map with display names and platform handles |
| `model_backends.json` | Yes | LLM backends: routing, pricing, cache warming, extended thinking, capability overrides |
| `network.json` | No | Outbound HTTP allowlist for the sandbox, with per-URL header injection |
| `platforms.json` | No | Platform connectors (Discord token, allowed users, leadership role, failover threshold) |
| `sync.json` | No | Hub URL (on spokes), relay tuning, WebSocket settings |
| `keyring.json` | No | Per-host Ed25519 public keys and URLs (auto-populated by sync handshake) |
| `mcp.json` | No | MCP server connections (`stdio` or `http`; `io.modelcontextprotocol/ui` tools render inline in the web UI) |
| `overlay.json` | No | Codebase mount points (`/mnt/<name>` → real path) |
| `cron_schedules.json` | No | Recurring task definitions with schedule, payload, skill, model hint, and dependency fields |
| `memory.json` | No | Pinned-memory caps (`pinned_count_cap` default 10, `pinned_size_cap` default 2000 chars) |
| `persona.md` | No | Seed for the cluster-wide persona — loaded once on first start; edit live with `boundctl set-persona` or the web UI |

All schemas are strict — unknown keys fail loudly. See [docs/config.md](docs/config.md) for the per-field reference.

## Further reading

- [docs/cli-operations.md](docs/cli-operations.md) — `bound init/start`, `boundctl`, `boundless`, build pipeline
- [docs/config.md](docs/config.md) — per-field reference for every config file
- [docs/design/architecture.md](docs/design/architecture.md) — package dependency graph and data flow
- [CONTRIBUTING.md](CONTRIBUTING.md) — testing conventions, critical invariants, contributor checklist

## License

See [LICENSE](LICENSE) for details.
