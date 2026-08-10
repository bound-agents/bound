---
title: State, consistency, and multi-host operation
description: How Bound separates replicated state from relayed work across a hub-and-spoke cluster.
---

Each Bound host owns a local SQLite database and can run agent loops. In a multi-host
cluster, hosts exchange selected durable state through a hub and relay operations to the
host that owns a required capability. These are related mechanisms, but they solve
different problems.

## Hub-and-spoke topology

One host acts as the hub. Each spoke maintains a WebSocket sync connection to the hub, and
spokes do not synchronize directly with one another. The hub forwards replicated changes;
it does not become the only host allowed to run loops, inference, or tools.

Each host has an Ed25519 identity. A signed handshake establishes host identity, and sync
frames use XChaCha20-Poly1305 encryption. These transport protections are one part of the
cluster boundary. See [Security boundaries](/bound/concepts/security-boundaries/) for the
broader trust model.

## Replication is state movement

Writes to synchronized tables create change-log entries. Connected hosts exchange new
entries, and reconnection lets a host drain entries it missed while disconnected. As a
result, cluster-wide views should be understood as converging views of replicated state,
not as a claim that every host observes every write at the same instant.

Conflict handling depends on the kind of table. Most synchronized tables use
last-writer-wins resolution based on a hybrid logical clock. Append-only tables, including
messages, deduplicate inserts by identifier. These mechanisms describe how replicated
records converge; they do not turn unrelated multi-step operations into one cluster-wide
transaction.

## Relay is operation movement

Relay sends a specific operation to another host without moving ownership of the whole
agent turn:

- **Inference relay** sends assembled context to a host that can serve the selected model
  and streams the response back.
- **Tool relay** sends a tool call to the host that owns the relevant MCP server or live
  client session.

The receiving host performs the relayed operation. Replication may later carry durable
results as state, but relay itself is not database synchronization.

## Host roles during a turn

The roles can reside on one host or be split across several hosts:

| Role | Responsibility |
| --- | --- |
| Hub host | Exchanges synchronized state between spokes |
| Loop host | Receives the trigger, assembles context, and coordinates the agent turn |
| Inference host | Serves the selected model and streams its output |
| Tool host | Owns and executes a tool required by the turn |

The trigger host remains the loop host while inference and individual tools can run
remotely. A remote inference host receives the context assembled by the loop host rather
than rebuilding it from its local replica.

## Consistency and availability boundaries

Synchronization makes selected state available across the cluster after changes have been
exchanged and resolved. Disconnection, relay availability, and concurrent writes can affect
what a host can observe or execute at a particular moment. Avoid treating a cluster-wide
label as a guarantee of instantaneous visibility or uninterrupted execution.

For how these roles fit into the product, see the [system
model](/bound/concepts/system-model/). For interruption, claiming, and recovery behavior,
see the [work lifecycle](/bound/concepts/work-lifecycle/). Follow [Configure a multi-host
cluster](/bound/guides/multi-host/) for setup steps.
