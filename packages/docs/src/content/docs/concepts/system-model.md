---
title: How Bound fits together
description: How Bound places durable state, agent work, models, tools, and live clients across a cluster.
---

Bound coordinates one persistent agent across one or more hosts. This page names the
parts of that system and explains which state is shared, local, scoped to a conversation,
or available only while a client is connected.

## Relationship model

```text
                         Bound cluster
+----------------------------------------------------------------+
|  hub <---------------- sync ----------------> spoke host       |
|   |                                               |            |
|   |  selected durable state                        |            |
|   +-----------------------------------------------+            |
|                                                                |
|  trigger host                                                   |
|  +----------------------------------------------------------+  |
|  | persistent agent -> thread -> task -> agent loop         |  |
|  |                         |                                |  |
|  |                    client session                         |  |
|  +-------------------------+--------------------------------+  |
|                            |                                   |
|                    inference or tool relay                      |
|                            v                                   |
|                backend/model, tool server, or live client      |
+----------------------------------------------------------------+
```

The **trigger host** is the host that receives a trigger and owns the resulting agent
loop.

A **cluster** is the set of Bound hosts that share selected state. A **host** is one
running Bound instance with its own local database, configuration, and capabilities. In
a multi-host cluster, one host is the **hub** and the others are **spokes**: each spoke
syncs with the hub rather than directly with every other spoke.

A **persistent agent** is the durable Bound identity that serves conversations and work.
A **thread** is one ongoing conversation or work context for that agent. A **task** is
durable work for a thread. A **client session** is a live connection, such as a web or
terminal client, that can attach ephemerally to a thread; it is not durable thread-scoped
state.

## Scope and availability

| Scope | Examples | What it means |
| --- | --- | --- |
| Replicated durable state | Selected thread records and messages, tasks, memories, skills | Hosts exchange selected state so it can be used across the cluster. |
| Host-local configuration and capabilities | Backend credentials, configured model backends, MCP servers, host workspace access | These remain owned by the host that configures or provides them. Other hosts may know about them, but that does not make them universally available. |
| Thread-scoped state | Conversation history, active skills, task context | This state belongs to one conversation or its work, rather than to every thread. |
| Live or ephemeral capabilities | Connected client sessions and tools, streamed inference, active connector subscriptions | These exist while their owning process or client is live and can disappear when it disconnects. |

A **memory** is durable knowledge the agent can store and retrieve across sessions. A
**skill** is a reusable instruction set with supporting files; activating it adds its
instructions to a particular thread. A **virtual filesystem** is Bound-managed file
space. A **host workspace** is file space owned by a particular host or exposed by a
live client, rather than shared across every host.

A **tool** is an action the agent can call, such as memory management, scheduling, a
connector operation, or a client-provided file action. Tools may be native to Bound,
provided by an MCP server, or supplied by a live client. Their availability depends on
the thread and on the host or session that owns the capability.

## Placement and routing

The trigger host assembles context, selects the next action, records results, and
continues the thread. The loop does not move merely because another host can provide a
model or tool.

A **backend** is a configured route to an inference provider or service; a **model** is
the specific model selected through that backend. When the selected model is on another
host, the trigger host can relay the assembled inference request and receive the result.
Likewise, a tool call can relay to the host that owns an MCP server or to the host with
the live client session. Placement can therefore vary per inference or tool call while
the trigger host remains responsible for the loop.

## Interface boundary

The **Responses API** provides stateless model routing rather than a persistent-agent
interface: it accepts a request and routes it to a compatible model backend, but does not
itself own a persistent agent, thread history, task scheduling, memory, tools, skills, or
a client session.

## Related concepts

- [Agent system](/bound/concepts/agent-system/) explains the agent loop, built-in tools,
  and task types.
- [Work lifecycle](/bound/concepts/work-lifecycle/) explains how work enters, runs, and
  completes.
- [Sync and multi-host behavior](/bound/concepts/sync/) explains hub-and-spoke state
  replication and relays.
- [Security boundaries](/bound/concepts/security-boundaries/) explains capability and
  trust boundaries.
- [Architecture reference](/bound/reference/architecture/) maps these concepts to Bound
  components.
