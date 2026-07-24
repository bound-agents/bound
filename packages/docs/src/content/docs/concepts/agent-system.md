---
title: Agent System
description: The agent loop state machine, context assembly pipeline, built-in tools, scheduler, and MCP bridge.
---

The `@bound/agent` package is the runtime core of Bound. It drives the agent loop — a state machine that hydrates files, assembles context, calls the LLM, executes tools, and persists results. A scheduler manages message dispatch, deferred tasks, and autonomous execution.

## Agent loop state machine

```
IDLE → HYDRATE_FS → ASSEMBLE_CONTEXT → LLM_CALL → PARSE_RESPONSE →
  TOOL_EXECUTE → TOOL_PERSIST → RESPONSE_PERSIST → FS_PERSIST → QUEUE_CHECK → IDLE
```

`RELAY_STREAM` replaces `LLM_CALL` → `PARSE_RESPONSE` when inference is remote. `RELAY_WAIT` replaces `TOOL_EXECUTE` when a tool call targets a remote host.

| State | Description |
| --- | --- |
| `IDLE` | Initial and terminal state. |
| `HYDRATE_FS` | Loads workspace files into the sandbox VFS. |
| `ASSEMBLE_CONTEXT` | Runs the context assembly pipeline. Model resolution happens here. |
| `LLM_CALL` | Streams tokens from the LLM backend (local). |
| `RELAY_STREAM` | Polls for streaming inference chunks from a remote host. |
| `PARSE_RESPONSE` | Extracts text content and detects tool-use. |
| `TOOL_EXECUTE` | Dispatches tool calls via the sandbox. |
| `RELAY_WAIT` | Polls for a tool result from a remote host. |
| `TOOL_PERSIST` | Writes tool call and result messages to the database. |
| `RESPONSE_PERSIST` | Persists the assembled assistant message. |
| `FS_PERSIST` | Flushes workspace file mutations back to the database via OCC diff. |
| `QUEUE_CHECK` | Checks for newly queued messages before returning to idle. |

## Context assembly pipeline

An 8-stage pipeline transforms raw message history into an optimized LLM prompt:

1. **MESSAGE_RETRIEVAL** — fetch messages for the thread
2. **PURGE_SUBSTITUTION** — replace purged messages with summary markers
3. **TOOL_PAIR_SANITIZATION** — strip orphaned tool calls/results
4. **MESSAGE_QUEUEING** — order messages and apply budget
5. **ASSEMBLY** (incl. Stage 5.5 volatile enrichment) — build the system prompt and message array, including persona, orientation, database schema, pinned memory, and live state
6. **BUDGET_VALIDATION** — enforce token budget against the context window
7. **METRIC_RECORDING** — log context metrics

The output is `{ messages, systemPrompt, debug }`. The system prompt carries the stable prefix (environment, persona, orientation, volatile stable subsection). Messages contain no system-role entries — the volatile varying half rides as a `developer`-role tail message.

### Volatile context

The volatile context system partitions dynamic information into a **stable** half (folded into `systemPrompt` for cross-thread cache reuse) and a **varying** half (a `developer`-role tail message that changes per turn). Three renderers fire in fixed order:

- **Working Knowledge** — pinned memory entries and summary titles that must survive context compaction
- **Discoverable Archive** — title-only catalog of detail-tier entries; bodies accessed via memory search
- **Live State** — operational state: current model, host identity, cluster topology, file inventory

A fourth **Relevant-memory** block surfaces conversation-relevant entries matched by keyword and graph traversal, rendered title-only and capped at a configurable limit.

## Built-in tools

Bound registers native agent tools as `RegisteredTool` factories with structured JSON schemas. The LLM receives structured JSON — no string parsing.

| Tool | Purpose |
| --- | --- |
| `memory` | Store, search, forget, and connect semantic memory entries |
| `task` | Schedule deferred, recurring, or event-driven tasks |
| `query` | Read-only SELECT against the SQLite database |
| `skill` | Activate, list, read, deactivate skills |
| `advisory` | Create, list, approve, dismiss operational advisories |
| `notify` | Send a reminder to a target thread |
| `introspect` | Send a question to another thread for reflection |
| `archive` | Archive threads to long-term storage |
| `model_hint` | Set or clear the model hint for the current task |
| `aux` | Define, update, retire, list auxiliary agent identities |
| `connector` | Manage platform event subscriptions |
| `cancel` | Cancel scheduled tasks |

Tools dispatch through a unified registry. Every tool is tagged with a `kind` discriminant (`builtin`, `sandbox`, `platform`, `client`), and each kind dispatches through one uniform local-or-relay decision — no kind is execute-here-or-fail.

## Scheduler

The scheduler processes messages and tasks. It handles three trigger types:

- **Cron** — recurring tasks on a cron expression
- **Deferred** — one-shot tasks with a time delay (`5m`, `2h`, `1d`)
- **Event-driven** — tasks triggered by platform events (Discord messages, webhooks, RSS items)

Tasks can depend on one another (`--after`), with `inject_mode` controlling how a dependency's result feeds into the dependent task. In a cluster, a task runs on exactly one host.

## MCP bridge

MCP server tools are exposed as subcommand-dispatched commands through the sandbox: one `CommandDefinition` per MCP server (named by server, e.g. `github`), with a `subcommand` parameter selecting the individual tool. This reduces the LLM tool definition count and simplifies cross-host delegation tracking.

Cross-host MCP tool calls use the relay transport (`tool_call` relay kind). When an `http`/`sse` MCP server advertises the MCP Apps `io.modelcontextprotocol/ui` capability, its UI-bearing tool results render inline as interactive apps in the web UI.

## Prompt cache path

The context pipeline distinguishes **warm** and **cold** paths:

- **Warm path** — the thread's prompt cache is still valid from the previous turn. The system prompt is unchanged; only the new messages are appended. Fast.
- **Cold path** — the cache has lapsed or the system prompt changed (new volatile context, new skill activated). The full system prompt is re-sent. Slower, but cache breakpoints ensure the stable prefix is re-cached for subsequent warm hits.

Cache warming (issue #10) is an opt-in periodic "warm poke" that keeps the prompt cache hot on active threads so the next real message lands on a cache-read instead of a cache-write. Controlled per-backend via the `cache_warming` config block.
