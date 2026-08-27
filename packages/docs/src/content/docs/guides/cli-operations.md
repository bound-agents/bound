---
title: CLI and operations
description: Command reference for initializing, running, inspecting, and maintaining Bound.
---

This reference covers the commands and network environment variables for Bound's three
binaries. It describes command scope and effects for lookup; use the linked guides for
procedures. Some operations change synchronized cluster state or rewrite local data, so
review command-specific safety notes and use preview modes where provided.

| Binary | Scope |
| --- | --- |
| `bound` | Initialize configuration and run one Bound server |
| `boundctl` | Perform cluster and data operations |
| `boundless` | Connect a terminal or Agent Client Protocol (ACP) editor to a running server |

Run any binary with `--help` for the command list built into that version.

For where these processes and their state run, see
[System model](/bound/concepts/system-model/). For task and agent-turn semantics, see
[Work lifecycle](/bound/concepts/work-lifecycle/).

## `bound`

### `bound init`

Create a configuration directory from one backend preset:

```text
bound init (--ollama | --bedrock --region REGION | --cerebras | --zai | --opencode-go | --umans | --hub) [OPTIONS]
```

Choose exactly one backend preset flag.

| Preset flag | Purpose |
| --- | --- |
| `--ollama` | Local Ollama backend |
| `--bedrock --region REGION` | AWS Bedrock through the AWS SDK credential chain |
| `--cerebras` | Cerebras Cloud using `CEREBRAS_API_KEY` |
| `--zai` | z.AI using `ZAI_API_KEY` |
| `--opencode-go` | OpenCode Go |
| `--umans` | Self-configuring umans.ai backend using `UMANS_API_KEY` |
| `--hub` | Relay hub with no local inference backend |

Common options:

| Option | Purpose |
| --- | --- |
| `--name NAME` | Set the operator or host name |
| `--with-sync` | Create a spoke-oriented `sync.json` template |
| `--with-mcp` | Create an `mcp.json` template |
| `--force` | Replace existing generated config files |
| `--config-dir DIR` | Use a config directory other than `config/` |

Examples:

```bash
bound init --ollama
bound init --bedrock --region us-west-2 --name workstation
bound init --hub --name hub-node
```

### `bound start`

Start the server:

```text
bound start [--config-dir DIR] [--reseed]
```

`--reseed` removes the local replica, requests a full snapshot from the hub, and catches up
through the change log. Use it to repair a spoke whose replica should be replaced.

The process handles `SIGINT` and `SIGTERM` with graceful shutdown.

Before using `boundctl`, note that a **host** is a running Bound instance, the **hub** is the
host that coordinates replication, and other synchronized hosts are **spokes**.

## `boundctl`

Unless a command says otherwise, `boundctl` operates on `config/` and `data/` in the
current directory. Cluster-wide commands take effect through synchronized state as noted
below; consult [System model](/bound/concepts/system-model/) for the underlying host and
state boundaries.

### `boundctl set-hub`

```text
boundctl set-hub HOST [--wait] [--timeout SECONDS]
```

The command records `HOST` as synchronized cluster state; it does not configure peer URLs,
keys, or connections, and it does not validate that the named host is reachable. Before using
it, configure the physical topology separately.

`--wait` polls the local synchronization records until every currently registered peer has a
sync timestamp newer than the designation. With no registered peers it returns immediately.
A timeout produces a warning and leaves the new designation in place.

### `boundctl set-persona`

Read Markdown from a file:

```bash
boundctl set-persona --file persona.md
```

Or read it from standard input:

```bash
cat persona.md | boundctl set-persona
```

The persona is cluster-wide, applies on the next agent turn, and is capped at 64 KB.

### `boundctl stop` and `boundctl resume`

```bash
boundctl stop
boundctl resume
```

`stop` sets the cluster-wide emergency flag. Hosts stop autonomous task execution after
receiving the synced change; the web UI and manual commands remain available.

### `boundctl restore`

Preview a point-in-time restore:

```text
boundctl restore --before TIMESTAMP --preview
```

Replace `TIMESTAMP` with the point-in-time cutoff you want to inspect. After reviewing the
preview, apply the restore with the same timestamp and table selection:

```text
boundctl restore --before TIMESTAMP
```

Use `--tables TABLE...` to limit the operation. Restore reverts synchronized rows using
change-log history, skips append-only tables such as `messages`, and leaves local-only
tables unchanged.

:::danger[Review before applying]
A non-preview restore changes synchronized cluster state. Run `--preview` first and verify
the selected timestamp and tables.
:::

### Reload MCP configuration

```bash
boundctl config reload mcp
```

This reconnects MCP servers without restarting the Bound process.

### Inspect synchronization

Show peer propagation state:

```bash
boundctl sync-status
```

Compare synchronized row sets with a hub:

```text
boundctl consistency-check [--spoke-url URL] [--tables T1,T2] [--verbose]
```

### Drain scheduled work before changing a hub designation

Run this from the current hub's configuration and data context after preparing the replacement
host and updating the physical topology separately:

```bash
boundctl drain NEW_HUB [--timeout SECONDS]
```

The command temporarily pauses new scheduled work, waits for running tasks in the local
database, records `NEW_HUB` as the synchronized hub designation, and clears the pause. It
does not migrate running tasks or update `sync.json`, `keyring.json`, DNS, or peer
connections. The default timeout is 120 seconds; on timeout, the command warns and proceeds
with the designation change. Treat hub replacement as a maintenance procedure rather than an
atomic failover operation.

### Manage skills

```text
boundctl skill list [--verbose]
boundctl skill view NAME
boundctl skill import PATH
boundctl skill delete NAME [--reason TEXT]
```

Import expects a directory containing `SKILL.md`. Delete removes the replicated skill and
files and creates advisories for tasks that still reference it.

### Manage webhooks

```text
boundctl webhook list
boundctl webhook create --name NAME [OPTIONS]
boundctl webhook update --name NAME [OPTIONS]
boundctl webhook rotate-secret NAME
boundctl webhook delete NAME
boundctl webhook allow-unauthenticated
boundctl webhook disallow-unauthenticated
```

Create and update options include `--format`, `--description`, `--prompt`, `--model`,
`--no-history`, and `--history` where applicable. The `none` signature format is rejected
unless unauthenticated webhooks are enabled cluster-wide.

### Update a task

```text
boundctl task update ID [--no-history|--history] [--model ID] [--alert-threshold N]
```

An empty `--model ""` value returns the task to the system default. Scheduling and lifecycle
fields are not mutable through this command.

### Reclaim database space

```bash
boundctl db vacuum
```

This runs a full SQLite `VACUUM` against `data/` in the current directory, the default
`boundctl` data directory.

## `boundless`

```text
boundless [--url URL] [--attach THREAD_ID] [--acp]
```

| Option | Purpose |
| --- | --- |
| `--url URL` | Override the configured web API and UI server URL for this run |
| `--attach THREAD_ID` | Attach to an existing thread |
| `--acp` | Run as an ACP server over standard input and output |

See [Use the `boundless` terminal client](/bound/guides/boundless/) for filesystem access,
status output, and editor configuration.

## Network environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Sync server port | `3000` |
| `BIND_HOST` | Sync server bind host | `localhost` |
| `WEB_PORT` | Web API and UI port | `3001` |
| `WEB_BIND_HOST` | Web API and UI server bind host | `localhost` |
| `BOUND_ALLOW_UNSAFE_WEB_BIND` | Permit a non-loopback web API and UI server bind | Unset |

:::danger[Non-loopback web binding]
The web API includes control and filesystem endpoints that assume a loopback trust
boundary. Set `BOUND_ALLOW_UNSAFE_WEB_BIND=1` only when an external network boundary
protects the web server.
:::

## Troubleshooting

### Configuration fails to load

Validate the JSON syntax, then compare each field with the
[configuration reference](/bound/reference/configuration/). Bound rejects unknown fields.

### A spoke is missing data

Run `boundctl sync-status`, then `boundctl consistency-check`. Use `bound start --reseed`
only when the local replica should be replaced from a hub snapshot.

### A binary does not start

Confirm that the downloaded binary matches the host platform and is executable. Current
binaries are available on the [GitHub releases page](https://github.com/bound-agents/bound/releases).

## Docker image runtime ABI

Release images use Ubuntu 24.04 and install `libstdc++6` explicitly. This matches the
native Linux build environment and supplies the C++ ABI required by Bun-embedded native
addons such as the structure reader's tree-sitter parser. Do not replace the runtime
check with an ELF dependency scan: embedded addons are loaded by Bun and are not visible
through the executable's `DT_NEEDED` entries.

Every release architecture runs the image smoke test after publishing its platform image.
It starts `bound`, which imports `bms_read_structure` and loads the embedded tree-sitter
addon. The test needs Docker, so local development without Docker validates the static
Dockerfile/workflow contract; the runtime image check runs in release CI.
