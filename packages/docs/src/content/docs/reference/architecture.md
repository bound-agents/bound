---
title: Architecture
description: Current package boundaries, runtime composition, persistence, sync, and relay behavior in Bound.
---

This implementation reference maps Bound's packages to their runtime roles and summarizes
how those parts compose on a host. These details describe the implementation, not stable
product guarantees. For the product-level model, see [System
model](/bound/concepts/system-model/).

## Package map

Bound is a Bun workspace with these package responsibilities:

| Package | Current responsibility |
| --- | --- |
| `shared` | Types, events, and configuration schemas |
| `core` | SQLite schema, database layer, and change-log outbox |
| `sync` | Ed25519 identity, encrypted WebSocket sync, and conflict resolution |
| `sandbox` | In-memory virtual filesystem and command framework |
| `llm` | Large language model (LLM) driver shims for Bedrock, Anthropic, OpenAI-compatible providers, and others |
| `loop` | Agent-loop contracts, stream parsing, retries, and timeouts |
| `agent` | Context pipeline, tools, scheduler, and Model Context Protocol (MCP) bridge |
| `platforms` | Platform connectors such as Discord, webhooks, and RSS |
| `web` | Hono-based API and Svelte single-page application |
| `client` | `BoundClient` for external consumers |
| `less` | Terminal-client implementation used by `boundless` |
| `cli` | Binary entry points for `bound`, `boundctl`, and `boundless` |

## Runtime composition

A host composes the persistence, sync, inference, agent, platform, and interface packages.
A message moves through those parts as follows:

```text
User sends message (web UI / Discord / boundless / webhook / RSS)
  ↓
Agent loop activates:
  1. Load files into the virtual filesystem
  2. Assemble context (persona, memory, skills, history → LLM prompt)
  3. Call the LLM (local backend or relayed to a remote host)
  4. Parse response — text or tool calls
  5. Execute tools (local, relayed to a remote host, or via boundless)
  6. Persist results (messages, files, memory)
  7. Check for more queued messages → loop or idle
```

See [Work lifecycle](/bound/concepts/work-lifecycle/) for the lifecycle semantics behind
this sequence.

## Persistence and replication

Each host uses SQLite in write-ahead logging (WAL) mode. Writes to synced tables produce
change-log outbox entries in the same transaction. After commit, the sync transport pushes
those changes through the hub, the host that coordinates replication. Most tables use
last-writer-wins reduction; append-only tables deduplicate inserts.

This page records the mechanisms used by the implementation. See
[Sync and multi-host behavior](/bound/concepts/sync/) for how replication affects users and
operators, and [Configure a multi-host cluster](/bound/guides/multi-host/) for setup.

## Routing and execution boundaries

The implementation has these runtime boundaries:

- **Loop ownership:** The trigger host assembles context and runs the loop. Only inference
  and tool calls relay.
- **Inference routing:** A model can execute on the loop-owning host or on another host.
- **Tool routing:** A tool can execute locally, on another host, or through the
  `boundless` terminal client.
- **Built-in file operations:** These operations use an in-memory virtual filesystem.
- **Host commands:** `boundless` adds operating-system-level confinement.

These are current composition and dispatch properties rather than promises that package or
process boundaries will remain unchanged. See
[Security boundaries](/bound/concepts/security-boundaries/) for the trust and confinement
model.

Contributors can find internal design references—including dependency graphs, protocol
notes, and the database schema—in the repository's `docs/design/` directory.
