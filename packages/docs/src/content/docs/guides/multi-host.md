---
title: Configure a multi-host cluster
description: Connect a hub and one or more spokes, then verify synchronized state and host capabilities.
---

Use this guide to connect your first hub and spoke, verify the connection, and then add more
spokes.

A **host** is one Bound installation. The **hub** is the host whose `sync.json` has no `hub`
field. A **spoke** is a host whose `sync.json` sets `hub` to the reachable URL of the hub.
Model backend choices are independent of these sync roles: a hub or spoke can use any
supported backend needed on that host.

## Prerequisites

- Two or more machines
- Bound installed on every host
- Network reachability from each spoke to the hub's sync server
- A unique host name for each installation
- The hub's public key and reachable sync URL
- A supported model backend for each host that provides inference

If you haven't installed Bound yet, complete the installation step in the
[quick start](/bound/guides/quick-start/#1-install-bound) on each machine.

## 1. Initialize the hub

On the host that will be the hub, initialize Bound with a unique name. Do not use
`--with-sync` on the hub:

```bash
bound init --bedrock --region us-east-1 --name hub-host
```

This backend is only an example. Choose the backend preset appropriate for this host. The
`--with-sync` option creates a spoke template with `{ "hub": "primary-host" }`, so that
template must not be used unchanged on a hub. If the hub has a `sync.json` for other sync
settings, omit the `hub` field.

## 2. Initialize and configure the spoke

On the second host, initialize Bound with a different name and create the spoke sync
template:

```bash
bound init --ollama --with-sync --name spoke-1
```

Again, the backend is illustrative and does not determine whether the host is a hub or spoke.
Replace the generated placeholder in the spoke's `sync.json` with the full URL that this
spoke can use to reach the hub. For example:

```json
{
  "hub": "ws://hub.example.com:3000"
}
```

Use `wss://` when the sync endpoint is configured for TLS. In the spoke's `keyring.json`, add
a matching entry for that exact hub URL and the hub's public key. Neither `bound init` nor the
connection handshake discovers, adds, or repoints this entry. Follow the instructions printed
by `bound init` and the [`sync.json` configuration reference](/bound/reference/configuration/#syncjson)
for the keyring and URL fields.

## 3. Start the hub, then the spoke

On the hub, start Bound with a bind address reachable by the spoke:

```bash
BIND_HOST=0.0.0.0 bound start
```

The sync server listens on port `3000` by default. Keep the process running while you connect
the spoke.

:::danger[Protect the sync server]
A non-loopback bind makes the sync server reachable over the network. Configure the host
firewall and any network firewall to allow TCP traffic to the configured sync port only from
known peer addresses. Do not expose the port broadly to the internet.
:::

After the hub is listening, start the spoke:

```bash
bound start
```

## 4. Verify the connection

Inspect peer propagation state:

```bash
boundctl sync-status
```

Open **Network** in the web UI. Confirm that the hub and spoke are online, that the spoke is
actually connected to the intended hub, and that each expected model appears under its host.
Do not treat a configured hub name or recorded designation as proof of connectivity.

## 5. Optionally record the cluster hub designation

After the connection works, you can record the hub's host name in synchronized cluster
configuration. Run this against the local data/config context whose cluster you intend to
update:

```bash
boundctl set-hub hub-host
```

`set-hub` first attempts to drain the local relay outbox, then writes
`cluster_config.cluster_hub`. It does not configure `sync.json` or `keyring.json`, validate the
target name or URL, test reachability, or connect any peer.

Use `--wait` only when you also want to wait for registered peers' sync timestamps after the
write:

```bash
boundctl set-hub hub-host --wait
```

This wait is not a connectivity or target validation check. With zero registered peers it
succeeds immediately. If it times out, the command warns, but the new designation remains
written.

## 6. Add more spokes

For each additional spoke, repeat steps 2 through 4 with a unique host name. Configure its
full hub URL and matching hub URL/public-key entry before starting it, and verify its actual
connection before proceeding to the next host.

## Non-automatic hub replacement

Hub replacement is a coordinated maintenance procedure, not automatic failover. Schedule a
maintenance window; the commands below do not provide an atomic transition or rollback.

1. Prepare a replacement hub that is reachable from every affected spoke, including the
   required keys and state.
2. Pause or coordinate work so that tasks and writes are not assumed to move automatically.
3. From the old/current hub's data and configuration context, run:

   ```bash
   boundctl drain replacement-hub --timeout 180
   ```

   The command does not verify that it is running against the current hub. It temporarily
   sets `emergency_stop` to `drain`, waits for locally running tasks, writes
   `cluster_config.cluster_hub`, and then clears the stop. It waits for tasks; it does not
   migrate or stop them. If the timeout expires, it proceeds with the designation change and
   reports a warning.
4. Manually update every affected spoke's `sync.json` to the replacement's reachable full URL
   and update `keyring.json` with the matching URL and public key. Make any required DNS or
   network changes, then restart or otherwise reconnect each spoke.
5. Run `boundctl sync-status` and inspect **Network** to verify actual connections and expected
   synchronized state before resuming normal work.

Use `drain` only for its recorded hub-designation and local task-drain step. It does not edit
`sync.json` or `keyring.json`, change DNS, reconnect peers, or roll back the procedure on a
later failure. See the [CLI and operations reference](/bound/guides/cli-operations/) for drain,
recovery, consistency-check, and maintenance commands.

## Troubleshoot the cluster

### A spoke doesn't appear

Confirm that the hub process is running and that the configured sync port is reachable from
the spoke. Check that each host has a unique name, the spoke's `sync.json` contains the hub's
reachable full URL, and `keyring.json` has a matching URL/public-key entry. Then run
`boundctl sync-status` again.

### A host is missing synchronized data

Run `boundctl sync-status`, then `boundctl consistency-check`. Use `bound start --reseed`
only when the spoke's local replica should be replaced by a full hub snapshot and change-log
catch-up.

### A model doesn't appear under a host

Confirm that you initialized that host with the intended backend and that the host appears
online in **Network**.

### Optional: tune a slow inference relay

Keep the default relay timeouts unless a slow inference backend needs more time. To set an
inference timeout, edit the spoke's `sync.json` while preserving its full hub URL:

```json
{
  "hub": "ws://hub.example.com:3000",
  "relay": {
    "enabled": true,
    "inference_timeout_ms": 300000
  }
}
```

See the [`sync.json` reference](/bound/reference/configuration/#syncjson) for all relay and
WebSocket fields. A larger timeout changes how long the relay waits; it doesn't establish
that a failed inference request is safe to retry.

## Related concepts

- [System model](/bound/concepts/system-model/)
- [Work lifecycle](/bound/concepts/work-lifecycle/)
- [Security boundaries](/bound/concepts/security-boundaries/)
- [Sync and multi-host behavior](/bound/concepts/sync/)
