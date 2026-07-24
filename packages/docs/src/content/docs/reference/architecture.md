---
title: Architecture
description: How Bound is organized and how data flows through the system.
---

Bound is a Bun workspace monorepo. All state lives in a SQLite database that replicates across hosts via an encrypted sync protocol. Every interface — web UI, Discord, boundless — talks to the same agent with the same state.

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

## How a message flows

```
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

If the model is on another host, inference streams over the relay transport transparently. If a tool call targets a remote MCP server, it relays too. The agent doesn't know or care where things physically run.

## Sync

Every write to the database is recorded in a change log and pushed to peers immediately over an encrypted WebSocket. The hub is the central sync point; spokes sync to it. Conflicts resolve by timestamp (last-writer-wins) for most data, and messages are append-only (never modified, so no conflicts).

See [Sync & Multi-Host](/bound/concepts/sync/) for the concept and [Multi-Host Setup](/bound/guides/multi-host/) for configuration.

## Design principles

- **SQLite, not Postgres** — single-file database, WAL mode, no external process to manage. Sync handles distribution.
- **Event-sourced replication** — the change log is an append-only event stream. Replaying it rebuilds state.
- **Sandboxed execution** — the agent works in a virtual filesystem, not on your real disk. boundless adds OS-level write confinement on top.
- **Cluster-wide model routing** — inference goes to whichever host has the right backend, with automatic fallback.
- **One delegation path** — the agent loop always runs on the host that received the message. Only inference and tool calls are relayed, never the full context.

For the full design treatment (dependency graphs, protocol details, database schema), see the `docs/design/` directory in the repository.
