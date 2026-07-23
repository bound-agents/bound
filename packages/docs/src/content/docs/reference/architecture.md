---
title: Architecture
description: Package layout and data flow for the Bound agent system.
---

Bound is a Bun workspace monorepo of packages under `packages/*`. The detailed
dependency graph and per-package responsibilities live in
`docs/design/architecture.md` in the repository.

## Packages

| Package | Responsibility |
| --- | --- |
| `shared` | Types, events, `Result<T,E>`, Zod config schemas, HLC |
| `core` | SQLite schema, DI container, change-log outbox, relay CRUD |
| `sync` | Ed25519 WS sync, XChaCha20 encryption, LWW/append reducers |
| `sandbox` | Virtual filesystem (InMemoryFs/ClusterFs), command framework |
| `llm` | Driver shims (Bedrock, OpenAI-compatible) over the Vercel AI SDK |
| `loop` | Reusable loop contracts, stream parsing, retry/timeout utilities |
| `agent` | Main-agent context pipeline, commands, scheduler, MCP bridge |
| `platforms` | MCP-based platform connectors (Discord), connector handles |
| `web` | Hono API + Svelte 5 SPA |
| `client` | `BoundClient` (HTTP + WS) for external consumers |
| `less` | Terminal coding agent client (boundless) |
| `cli` | `bound` / `boundctl` / `boundless` binaries |

## Data flow

Every interface talks to the same agent state. Messages, memory, files, and
tasks are persisted in SQLite and replicated between hosts over an encrypted
WebSocket sync protocol. Inference is routed cluster-wide to the appropriate
backend and host, with fallback.

For the full design treatment, see the `docs/design/` topic files in the
repository — core infrastructure, sync protocol, agent system, sandboxing,
inference backends, and web + platforms.
