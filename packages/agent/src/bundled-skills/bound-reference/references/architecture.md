# Architecture Reference

A brief self-model of the system you run inside. For the authoritative,
maintained detail, read the design docs in the bound repository
(`docs/design/architecture.md` and its siblings) — this file is the orientation,
not the spec.

## The shape of bound

Bound is a Bun monorepo of focused packages. The ones that define your behavior:

- **agent** — the agent loop state machine, the 8-stage context-assembly
  pipeline, the native tools, the scheduler, and the MCP bridge.
- **core** — the SQLite database (WAL mode, STRICT tables), the change-log
  outbox that makes writes sync, and relay CRUD.
- **sync** — Ed25519-signed, XChaCha20-encrypted WebSocket sync between hosts,
  with HLC-ordered change-log reducers.
- **sandbox** — your virtual filesystem and the command framework.
- **llm** — driver shims (Bedrock, OpenAI-compatible) over the Vercel AI SDK,
  and the model router.

## The agent loop

Each turn moves through a state machine:

```
IDLE → HYDRATE_FS → ASSEMBLE_CONTEXT → LLM_CALL → PARSE_RESPONSE →
TOOL_EXECUTE → RELAY_WAIT → TOOL_PERSIST → RESPONSE_PERSIST →
FS_PERSIST → QUEUE_CHECK → IDLE
```

For remote inference, `RELAY_STREAM` replaces the `LLM_CALL → PARSE_RESPONSE`
segment.

## Context assembly

Your context is rebuilt each turn from the database, partitioned into a **stable**
half (folded into the system prompt for cross-thread cache reuse) and a
**varying** half (a tail message). The stable half carries your environment,
persona, the live database schema, and Working Knowledge bodies + Discoverable
Archive titles. The varying half carries Live State (threads, files, tasks) and
per-turn updates. This is why summaries are pointers, not ground truth — verify
load-bearing claims against the database.

## The scheduler

Fires cron, deferred, and event-driven tasks, each in its own thread with its own
context window, with DAG dependency resolution. Tasks lease rows so multiple
hosts don't double-run them. The heartbeat is a special recurring task and is
uncancellable by design.

## Sync and the cluster

State replicates between hosts over encrypted WebSocket frames. One host is the
**hub** (others connect to it); the rest are **spokes**. Writes to synced tables
go through the change-log outbox so peers learn about them; direct SQL writes do
not sync. Soft deletes only (`deleted = 0|1`) — rows are never physically removed
from synced tables. Inference can be **delegated** from a spoke to a remote host
that holds the right model and tools.

Use the `hostinfo` tool to see the live topology before reasoning about where
inference or a given MCP server lives.
