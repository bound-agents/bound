---
title: Sync & Multi-Host
description: How Bound replicates state across hosts with encrypted sync.
---

Bound runs as a hub-and-spoke cluster. Each host maintains its own SQLite database and exchanges changes with a designated hub over an encrypted WebSocket connection. Messages, memory, files, tasks, skills — everything replicates. Every interface on every host sees the same agent state.

## How it works

One host is the **hub** — the central sync point. Every other host is a **spoke** that syncs to it. Spokes never sync directly with each other; all replication flows through the hub.

Sync is encrypted end-to-end. Each host has an Ed25519 keypair generated on first startup. The WebSocket handshake is signed with the private key; subsequent frames are encrypted with XChaCha20-Poly1305. No pre-shared passwords or TLS client certificates required.

When a write happens locally (a new message, a memory entry, a file change), it's recorded in a change log and pushed to peers immediately — sync is event-driven, not polled. On reconnection, anything missed while disconnected is drained automatically.

Conflicts are resolved deterministically: most data uses last-writer-wins by timestamp. Messages are append-only (never modified), so there are no conflicts on conversation history.

## Inference relay

When a model lives on a different host than the one processing a message, inference streams over the relay transport. The requesting host sends the context; the target host runs the LLM and streams tokens back. Tool calls to remote MCP servers work the same way. This is transparent — the agent just works, regardless of which host holds which backend.

## Setting up a cluster

See [Multi-Host Setup](/bound/guides/multi-host/) for a step-by-step walkthrough.
