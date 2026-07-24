---
title: Sync & Multi-Host
description: How Bound replicates state across hosts with Ed25519 identity, encrypted WebSocket sync, and a store-and-forward relay.
---

Bound runs as a hub-and-spoke cluster. Each instance maintains a local SQLite database and exchanges changesets with a designated hub over a persistent, encrypted WebSocket connection. Messages, memory, files, tasks, advisories, and skills all replicate — every interface on every host sees the same agent state.

## Topology

One host is the **hub** — the central synchronization point. Every other host is a **spoke** that syncs to it. The hub is designated with `boundctl set-hub`; hosts discover it via `sync.json` on first connection.

```
  Spoke A          Spoke B          Spoke C
     |                |                |
     +-------+--------+--------+-------+
                    |
                   Hub
```

Spokes never sync directly with each other — all replication flows through the hub. The hub is also the relay router for cross-host inference and tool calls.

## Cryptographic identity

Each host has exactly one Ed25519 keypair, generated on first startup and stored at `data/host.key` (mode 0600) and `data/host.pub`. The host's **site ID** — its stable network identifier — is derived from the public key (first 16 bytes of SHA-256, hex).

The WebSocket upgrade request is signed with the private key. The receiving side verifies the signature against the caller's public key, which it retrieves from the shared `keyring.json` (auto-populated by the sync handshake — you usually don't hand-edit it). No pre-shared passwords or TLS client certificates required; identity is entirely key-based.

Once the WS upgrade succeeds, subsequent frames are encrypted with XChaCha20-Poly1305 using a per-peer symmetric key derived via ECDH. No per-message signatures after the handshake.

## Event-sourced replication

Every write to a synced table also writes to `change_log` — the transactional outbox. The change log is an append-only event stream at the SQLite level; rows are never mutated in the log itself.

Sync is **event-driven**, not polled. When a local change log entry is written, a `changelog:written` event triggers the transport to coalesce recent entries and push them to peers. Four frame kinds move in both directions:

- **`changelog_push`** — sender transmits change log entries the peer hasn't seen (with echo suppression: entries originating from the destination peer are filtered out)
- **`changelog_ack`** — receiver confirms the highest HLC it has applied, allowing the sender to advance its cursor and prune
- **`relay_send` / `relay_deliver`** — cross-host relay messages (tool calls, inference requests, broadcast events)
- **`relay_ack`** — acknowledges delivery of relay entries

On reconnection, the transport drains anything missed while disconnected, then resumes event-driven replication.

## Conflict resolution

Reducers apply log entries to the live application tables using one of two strategies:

- **LWW (last-writer-wins)** — most tables. Conflicts resolved by `modified_at` HLC timestamp. The later write wins, deterministically.
- **Append-only** — `messages` table. Inserts only, never updates. Dedup by message ID.

The change log accumulates until a pruning pass removes entries that all known peers have confirmed receiving.

## Relay transport

Cross-host operations use a store-and-forward relay piggybacked on the sync cycle. The requesting host writes a message to `relay_outbox`; the sync cycle routes it to the target's `relay_inbox`; the target processes it and writes a response back the same way.

Relay message kinds:

| Category | Kinds |
| --- | --- |
| Sync requests | `tool_call`, `resource_read`, `prompt_invoke`, `cache_warm`, `platform_request` |
| Async requests | `client_tool`, `cancel`, `inference`, `intake` |
| Passive (scheduler-owned) | `webhook_intake`, `rss_intake` |
| Responses | `result`, `error`, `client_result`, `stream_chunk`, `stream_end`, `status_forward`, `trace_data` |

### Inference relay

Remote LLM inference streams over the relay transport. The requesting host writes an `inference` relay message; the target streams `stream_chunk`/`stream_end` responses back. The agent loop enters `RELAY_STREAM` state, polling for chunks with monotonic `seq` reordering. Failover retries on the next eligible host after a configurable per-host timeout (`sync.relay.inference_timeout_ms`, default 300s).

### Tool call relay

MCP tools that live on a remote host are relayed via the `tool_call` kind. The requesting host writes the request, the target executes it and writes back a `result`. Client tools (boundless filesystem/shell) relay as `client_tool` → `client_result` through the WS session host.

## Setting up multi-host

```bash
# On each host (different --name):
bound init --anthropic --with-sync --name alice
bound start

# Then designate the hub:
boundctl set-hub hub-host --wait
```

Peer hosts discover the hub via `sync.json` on first sync. `boundctl set-hub` establishes the authoritative designation; `--wait` blocks until all peers confirm.

Hubs must bind the sync server to a non-loopback address so spokes can connect:

```bash
BIND_HOST=0.0.0.0 bound start    # on the hub
```

See [Configuration Reference](/bound/reference/configuration/) for `sync.json` fields including relay tuning and WebSocket settings.
