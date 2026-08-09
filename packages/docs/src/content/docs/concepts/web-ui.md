---
title: Web UI reference
description: Find conversations, tasks, hosts, connections, files, metrics, and persona settings.
---

The Bound web UI runs on the web server, which defaults to
`http://localhost:3001`. Its top navigation contains eight primary views; individual
threads open in the Line view.

## System Map

Use **System Map** to search threads, inspect live activity, create a thread, and open an
existing thread in the Line view.

The page also provides an interactive memory graph.

## Timetable

Use **Timetable** to inspect cron, deferred, event-driven, and heartbeat tasks. You can
filter by status and expand a task for scheduling and execution details.

## Network

Use **Network** to inspect hosts, synchronization state, connectivity, and advertised
models.

## Advisories

Use **Advisories** to review operational findings. Advisories move through `proposed`,
`approved`, and `applied`, or end as `dismissed` or `deferred`. State changes require a
note.

## Files

Use **Files** to browse and preview the agent's replicated virtual filesystem.

## Connections

**Connections** contains five sections:

### Webhooks

Create webhook endpoints, inspect deliveries, rotate secrets, and control the cluster-wide
unauthenticated-webhook switch.

See [Webhooks](/bound/guides/webhooks/) for details.

### RSS feeds

Create RSS or Atom subscriptions and configure their polling and task behavior.

See [RSS Feeds](/bound/guides/rss-feeds/) for details.

### Connector bindings

Inspect platform event subscriptions, their backing tasks, and their model settings. Detach
a binding to stop receiving its events.

### Skills

Import, inspect, and delete skills. See [Skills](/bound/concepts/skills/) for activation
behavior.

### MCP servers

Inspect MCP servers, their tools, and the host that owns each connection.

## Metrics

Use **Metrics** to inspect:

- **Cost timeline** — spending over time, per model
- **Token charts** — input, output, cache-read, cache-write tokens
- **Cache hit timeline** — prompt cache hit rate over time
- **Latency** — per-model response latency
- **Relay cycles** — cross-host relay timing and success rates

The page refreshes automatically when the selected range includes the current time.

## Persona

Use **Persona** to edit the cluster-wide Markdown persona. Changes replicate to every host
and apply on the next turn. The value is capped at 64 KB.

You can also set the persona from the CLI: `boundctl set-persona --file my-persona.md`.
