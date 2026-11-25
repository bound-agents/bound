---
title: Agent tools
description: Look up native agent tools, grouped actions, and the other sources that contribute tools to a thread.
---

Bound supplies native tools to its agent loop. This page is a scan-first behavioral index:
it explains what each tool is for and leaves the request shape to the runtime, where exact
structured schemas are supplied to the model.

For lifecycle, scheduling, and connector context, see [Agent system](/bound/concepts/agent-system/).

## Native tools at a glance

| Tool | Purpose and effect |
| --- | --- |
| `memory` | Stores, retrieves, searches, and removes durable knowledge; it can also maintain relationships between memory entries. |
| `skill` | Lists, reads, activates, and deactivates reusable instruction sets for the current thread. |
| `task` | Creates and manages deferred, recurring, and event-driven scheduled work. |
| `cancel` | Cancels scheduled work. |
| `model_hint` | Changes the model selection for the current task. |
| `query` | Runs read-only SQL against Bound's database. |
| `introspect` | Asks another thread for reflection. |
| `purge` | Marks distracting or unnecessary messages for context substitution. |
| `advisory` | Creates and manages operational advisories. |
| `notify` | Sends a user-facing notification through an available interface. |
| `archive` | Archives a thread to long-term storage. |
| `hostinfo` | Displays registered-host and capability information. |
| `connector` | Manages connector access when platform connectors make it available. |
| `aux` | Defines, changes, invokes, and retires durable auxiliary-agent identities. |
| `yard` | Internally coordinates substantial, bounded, multi-stage work and retains intermediate findings during a run. It takes a requested outcome and derives the workflow itself. See [Work orchestration with Yards](/bound/guides/orchestrate-with-yard/). |

`connector` is conditionally available where configured platform connectors support it.
Native tools are distinct from the other tool sources described in [Tool sources](#tool-sources).

## Memory actions

`memory` operates on durable entries and their knowledge-graph relationships. Read
[Memory and knowledge graph](/bound/concepts/memory/) for tiers, retrieval, and graph
behavior.

| Action | Effect |
| --- | --- |
| `store` | Saves a durable fact, finding, preference, or correction. |
| `get` | Retrieves a memory entry. |
| `forget` | Removes a memory entry. |
| `batch_forget` | Removes a group of matching memory entries. |
| `search` | Finds memory entries by key or prefix. |
| `connect` | Creates a typed relationship between two memory entries. |
| `disconnect` | Removes a relationship between memory entries. |
| `traverse` | Walks relationships outward from a memory entry. |

## Skill actions

`skill` controls per-thread use of skills. A skill's body becomes part of that thread's
stable prompt context while active. See [Skills](/bound/concepts/skills/) for the model
and [Manage skills](/bound/guides/manage-skills/) to import, inspect, or delete skills;
those management operations are not `skill` tool actions.

| Action | Effect |
| --- | --- |
| `list` | Shows available skills. |
| `read` | Reads a skill's instructions. |
| `activate` | Adds a skill's instructions to the current thread. |
| `deactivate` | Removes a skill's instructions from the current thread. |

## Auxiliary-agent actions

`aux` manages identities that run bounded errands in isolated child threads and return a
result to the main agent. See [Auxiliary agents](/bound/concepts/auxiliary-agents/) for
identity, invocation, memory, and capability boundaries.

| Action | Effect |
| --- | --- |
| `define` | Creates an auxiliary-agent identity. |
| `update` | Changes an existing identity. |
| `invoke` | Assigns an errand to an identity and receives its result. |
| `retire` | Retires an identity so it is no longer active. |

## Scheduled work

Use `task` for one-time deferred work, recurring cron work, and work woken by connector,
webhook, or RSS events. Tasks can depend on earlier tasks and use their results as input. See
[Agent system](/bound/concepts/agent-system/) for scheduler behavior.

## Cross-thread delivery

`introspect` and `notify` deliver into another thread by ID. Both require the target thread to
belong to the same user as the calling thread: the tool resolves the caller's owner and the
target's owner and refuses cross-user delivery. Threads without a recorded owner are treated as
unowned and remain reachable, so single-user deployments are unaffected. This prevents one
user's thread from injecting content or triggering inference in another user's thread on
multi-user deployments.

`notify` to an aux thread reaches only an aux loop that is running on the host where `notify`
runs. That loop injects the notification as a developer message before its next model call,
including after an answer it was about to finish with. When no aux loop is running for the
target there, `notify` returns an error and queues nothing.

## Tool sources

A thread can receive tools from Bound, configured servers, a connected client, or an API
caller.

| Source | What it provides |
| --- | --- |
| Native tools | Bound's built-in agent capabilities, indexed on this page. |
| Platform connector tools | Tools supplied by available platform connectors. Event-bound threads receive scoped tools; ordinary threads receive read-only platform tools. |
| Configured MCP servers | Commands exposed by each configured Model Context Protocol (MCP) server. See [Connect MCP servers](/bound/guides/mcp-servers/). |
| Live `boundless` client | Host file and shell tools supplied for the duration of a connected terminal-client session. See [`boundless` client tools](#boundless-client-tools). |
| Responses API caller | Function definitions supplied by the caller. Bound returns function calls, and the caller executes them and sends back the results. See [Responses API](/bound/reference/responses-api/). |

## `boundless` client tools

When a `boundless` terminal client is attached to a thread, it registers these tools against the
client's working directory:

| Tool | Purpose |
| --- | --- |
| `boundless_read` | Reads files with stable line anchors. |
| `boundless_read_structure` | Lists top-level declarations from supported source files with line anchors. |
| `boundless_write` | Creates or replaces files atomically. |
| `boundless_edit` | Applies anchored edits from a prior read. |
| `boundless_search` | Searches files with regular expressions. |
| `boundless_bash` | Executes a shell command under platform write confinement. |
| `boundless_copy` | Copies a file between the host and Bound's virtual filesystem. |

Write tools refuse paths targeting Bound's system database (`bound.db` and its WAL/SHM siblings).
Shell output longer than 32 visual rows is elided in the middle, and output over 256 KiB is
offloaded before reaching the transcript.
