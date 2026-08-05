---
title: Multi-Host Setup
description: Configure a hub-and-spoke cluster with encrypted sync, relay inference, and platform connectors across multiple hosts.
---

Bound runs as a hub-and-spoke cluster. One host is the hub (central sync point); every other host is a spoke that syncs to it. Messages, memory, files, tasks, and skills replicate across all hosts. Inference and tool calls relay through the hub to whichever host holds the right backend or session.

## Prerequisites

- Two or more machines with network reachability to the hub
- Bound installed and initialized on each host (see [Quick Start](/bound/guides/quick-start/))
- The hub must bind its sync server to a non-loopback address

## Step 1: Initialize each host

On each host, run `bound init` with `--with-sync` and a unique `--name`:

```bash
# On the hub host:
bound init --anthropic --with-sync --name hub-host
bound start

# On each spoke:
bound init --ollama --with-sync --name spoke-1
bound start
```

`--with-sync` creates a `sync.json` template. Each host gets its own Ed25519 keypair at `data/host.key` and `data/host.pub` on first startup.

## Step 2: Designate the hub

From any host, designate the hub:

```bash
boundctl set-hub hub-host --wait
```

This writes the `cluster_hub` key to `cluster_config` (a synced table). All hosts pick it up on their next sync cycle. `--wait` blocks until all registered peers confirm.

## Step 3: Configure the hub's bind address

The hub must accept inbound WebSocket connections from spokes. Set `BIND_HOST` to `0.0.0.0`:

```bash
# On the hub:
BIND_HOST=0.0.0.0 bound start
```

Spokes connect to the hub's sync URL (configured in `sync.json`). The default sync port is 3000.

## Step 4: Configure sync.json

On each spoke, point `sync.json` at the hub:

```json
{
  "hub": "hub-host"
}
```

On the hub itself, omit the `hub` field — the hub doesn't sync to itself.

Keyring entries (host public keys and URLs) are auto-populated by the sync handshake. You usually don't hand-edit `keyring.json`.

## Relay tuning

The relay transport carries inference and tool calls between hosts. Tune it in `sync.json` under the `relay` block:

```json
{
  "hub": "hub-host",
  "relay": {
    "enabled": true,
    "inference_timeout_ms": 300000,
    "max_payload_bytes": 2097152
  }
}
```

| Field | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Relay inference between hosts. |
| `max_payload_bytes` | 2 MiB | Max relay frame size. |
| `inference_timeout_ms` | 300000 (5m) | Per-host inference-streaming timeout. Must cover sync-delivery latency + LLM time. |
| `request_timeout_ms` | 30000 | Non-inference relay request timeout. |
| `prune_interval_seconds` | 60 | How often to prune relay tables. |
| `prune_retention_seconds` | 300 | How long delivered relay rows are retained. |
| `drain_timeout_seconds` | 120 | Graceful-drain budget on shutdown. |

## WebSocket sync tuning

Under the `ws` block:

```json
{
  "ws": {
    "backfill_interval": 300,
    "backpressure_limit": 2097152,
    "idle_timeout": 120,
    "reconnect_max_interval": 60,
    "receive_timeout_ms": 300000,
    "handshake_timeout_ms": 20000
  }
}
```

## How sync works

Sync is event-driven, not polled. When a local write hits the change log, a `changelog:written` event triggers the transport to push entries to peers. On reconnection, the transport drains anything missed while disconnected, then resumes event-driven replication.

Conflict resolution is deterministic: most tables use last-writer-wins (LWW) by HLC timestamp. The `messages` table is append-only (insert, never update) with dedup by ID.

See [Sync & Multi-Host](/bound/concepts/sync/) for the full protocol details.

## Emergency operations

```bash
# Cluster-wide emergency stop (suspends autonomous operations):
boundctl stop

# Resume:
boundctl resume
```

`stop` writes the `emergency_stop` key to `cluster_config`. On the next sync cycle, every host suspends autonomous operations. The web interface and manual commands remain available.

## Point-in-time recovery

```bash
# Preview what would change:
boundctl restore --before "2026-01-15T10:00:00Z" --preview

# Execute:
boundctl restore --before "2026-01-15T10:00:00Z"
```

Reverts synced rows to their state before the timestamp. Append-only tables (`messages`) are skipped. Local-only rows are unaffected. The restore runs inside a single `BEGIN IMMEDIATE` transaction — if any step fails, it rolls back.
