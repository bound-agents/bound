---
title: Agent system
description: How Bound coordinates conversations, built-in tools, scheduled work, and event intake.
---

Bound presents one persistent agent across threads and interfaces. The agent loop assembles
context, calls a model, executes tools, persists the result, and checks for queued work
before returning to idle.

## Built-in tools

The native tools are always registered:

| Tool | What it does |
| --- | --- |
| `memory` | Store, search, and forget facts across sessions |
| `task` | Schedule or update deferred, recurring, and event-driven tasks |
| `cancel` | Cancel a scheduled task |
| `query` | Run read-only SQL against the database |
| `purge` | Mark distracting or unnecessary messages for context substitution |
| `skill` | Activate, list, read, or deactivate skills |
| `advisory` | Create and manage operational advisories |
| `notify` | Send a reminder to a thread |
| `introspect` | Ask another thread for reflection |
| `archive` | Archive old threads |
| `model_hint` | Switch the model for the current task |
| `hostinfo` | Inspect hosts, topology, and host capabilities |
| `aux` | Create and manage auxiliary agent identities |

Platform connectors add the `connector` tool where it is available. MCP servers and
`boundless` sessions contribute additional tools through the unified registry.

## Scheduled work

The scheduler supports:

- **Cron tasks:** Recurring work described by a cron expression.
- **Deferred tasks:** One-time work scheduled after a delay.
- **Event tasks:** Work woken by connector, webhook, or RSS intake.

Tasks can depend on earlier tasks and receive the earlier result as input. In a multi-host
cluster, task claiming ensures that one host runs a given task.

## Event intake

External events use the same scheduler wakeup path:

- [Webhooks](/bound/guides/webhooks/) accept pushed HTTP events.
- [RSS feeds](/bound/guides/rss-feeds/) poll for new feed items.
- Platform connectors subscribe to events such as Discord messages.

The scheduler folds each intake envelope into the task wakeup context.

## Platform connectors

Platform connectors are in-process MCP servers managed by Bound. Event-bound threads
receive the connector's scoped tools, while ordinary threads receive read-only platform
tools and the connector-management tool.

Only the elected connector leader maintains active subscriptions. Synced connector handles
allow another host to reconnect them after failover.
