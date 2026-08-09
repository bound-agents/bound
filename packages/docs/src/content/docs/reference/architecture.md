---
title: Architecture
description: How Bound's packages, agent loop, persistence, sync, and relay layers fit together.
---

Bound is a Bun workspace whose packages separate persistence, sync, inference, agent
execution, platform integration, and user interfaces.

## Packages

| Package | What it does |
| --- | --- |
| `shared` | Types, events, config schemas |
| `core` | SQLite schema, database layer, change-log outbox |
| `sync` | Ed25519 identity, encrypted WebSocket sync, conflict resolution |
| `sandbox` | In-memory virtual filesystem, command framework |
| `llm` | LLM driver shims (Bedrock, Anthropic, OpenAI-compatible, etc.) |
| `loop` | Agent loop contracts, stream parsing, retry/timeout |
| `agent` | Context pipeline, tools, scheduler, MCP bridge |
| `platforms` | Platform connectors (Discord), webhooks, RSS |
| `web` | Hono API + Svelte 5 SPA |
| `client` | BoundClient for external consumers |
| `less` | boundless terminal client |
| `cli` | `bound` / `boundctl` / `boundless` binaries |

## Message flow

```text
User sends message (web UI / Discord / boundless / webhook / RSS)
  ↓
Agent loop activates:
  1. Load files into the virtual filesystem
  2. Assemble context (persona, memory, skills, history → LLM prompt)
  3. Call the LLM (local backend or relayed to a remote host)
  4. Parse response — text or tool calls
  5. Execute tools (local, relayed to remote host, or via boundless)
  6. Persist results (messages, files, memory)
  7. Check for more queued messages → loop or idle
```

The trigger host owns the loop and assembles context. Model resolution and tool dispatch
can relay individual operations without moving the loop.

## Sync

Writes to synced tables use the change-log outbox. After commit, the sync transport pushes
changes through the hub. Most tables use last-writer-wins reduction; append-only tables
deduplicate inserts.

See [Sync and multi-host behavior](/bound/concepts/sync/) for the concept and
[Configure a multi-host cluster](/bound/guides/multi-host/) for setup.

## Design principles

- **Local-first state:** Each host uses SQLite in WAL mode.
- **Outbox replication:** Synced writes produce change-log entries in the same transaction.
- **Constrained execution:** Built-in file operations use a virtual filesystem;
  `boundless` adds OS-level confinement for host commands.
- **Cluster-wide routing:** Models and tools can execute on a different host.
- **One loop owner:** The trigger host assembles context and runs the loop; only inference
  and tool calls relay.

For the full design treatment (dependency graphs, protocol details, database schema), see the `docs/design/` directory in the repository.
