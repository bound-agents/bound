---
title: Sync and multi-host behavior
description: How Bound replicates state and relays inference and tools between hosts.
---

Each Bound host owns a local SQLite database. In a cluster, hosts exchange selected state
through a designated hub while continuing to execute agent loops locally.

## Replication topology

One host is the hub. Each spoke maintains one WebSocket sync connection to that hub; spokes
do not replicate directly with one another.

Each host has an Ed25519 identity. The signed handshake establishes host identity, and sync
frames use XChaCha20-Poly1305 encryption.

Writes to synced tables create change-log entries. The transport pushes new entries after
commit and drains missed entries after reconnection.

Most tables use last-writer-wins resolution based on a hybrid logical clock. Append-only
tables, including messages, deduplicate inserts by identifier.

## Inference relay

The host that receives a trigger owns the agent loop and assembles its context. If the
selected model is remote, that host sends context segments to the inference host and
receives a streamed response. The remote host does not rebuild context from its replica.

## Tool relay

Any tool kind can execute locally or through relay. MCP calls route to the host that owns
the server, and client-tool calls route to the host that owns the live client session.

Placement is an optimization rather than a correctness requirement: the loop remains on
the trigger host, while inference and individual tool calls move when needed.

Follow [Configure a multi-host cluster](/bound/guides/multi-host/) for setup steps.
