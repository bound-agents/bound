---
title: Configure a multi-host cluster
description: Connect a hub and one or more spokes for replicated state and relayed inference.
---

This guide connects one hub and one or more spokes. After setup, state replicates through
the hub and each host can advertise its own models and tools.

## Prerequisites

- Two or more machines with network reachability to the hub
- Bound installed on every host
- Network reachability from each spoke to the hub's sync server
- A unique host name for each installation

Complete the [quick start](/bound/guides/quick-start/) on each machine before continuing.

## 1. Initialize each host

Run `bound init` with `--with-sync` and a unique `--name` on each host:

```bash
bound init --bedrock --region us-east-1 --with-sync --name hub-host

bound init --ollama --with-sync --name spoke-1
```

Choose the backend preset that belongs on each machine. The `--with-sync` option creates
the initial `sync.json`.

## 2. Expose the hub sync server

Start the hub with a non-loopback bind address:

```bash
BIND_HOST=0.0.0.0 bound start
```

The sync server listens on port `3000` by default. Restrict network access to the hosts that
should join the cluster.

## 3. Point each spoke at the hub

Set the hub host name in each spoke's `sync.json`:

```json
{
  "hub": "hub-host"
}
```

Omit the `hub` field from the hub's own file. Start each spoke after saving the change:

```bash
bound start
```

The handshake populates host public keys and URLs in `keyring.json`.

## 4. Designate the hub

From a host with access to the cluster database, run:

```bash
boundctl set-hub hub-host --wait
```

The `--wait` option waits for registered peers to confirm the designation.

## 5. Verify the cluster

Run:

```bash
boundctl sync-status
```

Then open **Network** in the web UI. Confirm that every host is online and that the expected
models appear under their hosts.

## Tune relay timeouts

The defaults suit most installations. For slow inference backends, set relay timeouts in
`sync.json`:

```json
{
  "hub": "hub-host",
  "relay": {
    "enabled": true,
    "inference_timeout_ms": 300000
  }
}
```

See the [configuration reference](/bound/reference/configuration/#syncjson) for every relay
and WebSocket field.

## Operate the cluster

```bash
boundctl stop
boundctl resume
boundctl drain replacement-hub --timeout 180
```

Use `stop` and `resume` for a cluster-wide emergency pause. Use `drain` before replacing a
hub. See the [CLI and operations reference](/bound/guides/cli-operations/) for recovery,
consistency checks, and maintenance commands.

For the replication and relay model, read
[Sync and multi-host behavior](/bound/concepts/sync/).
