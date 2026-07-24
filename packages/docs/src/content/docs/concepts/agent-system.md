---
title: Agent System
description: The tools the agent has, what the scheduler does, and how tasks work.
---

Bound's agent has built-in tools, a scheduler that runs tasks on your behalf, and an MCP bridge for connecting external tool servers. Every interface — web UI, Discord, boundless — talks to the same agent with the same tools and the same memory.

## Built-in tools

The agent has a set of native tools it can call during a conversation. You don't configure these — they're always available.

| Tool | What it does |
| --- | --- |
| `memory` | Store, search, and forget facts across sessions |
| `task` | Schedule tasks — deferred, recurring (cron), or event-driven |
| `query` | Run read-only SQL against the database |
| `skill` | Activate, list, read, or deactivate skills |
| `advisory` | Create and manage operational advisories |
| `notify` | Send a reminder to a thread |
| `introspect` | Ask another thread for reflection |
| `archive` | Archive old threads |
| `model_hint` | Switch the model for the current task |
| `aux` | Create and manage auxiliary agent identities |
| `connector` | Subscribe to platform events (Discord, etc.) |
| `cancel` | Cancel scheduled tasks |

MCP server tools appear alongside these as subcommand-dispatched commands — one per server, named by the server (e.g. `github`).

## Scheduler

The scheduler processes messages and runs tasks. Three trigger types:

- **Cron** — recurring tasks on a schedule (`0,30 * * * *` for every 30 minutes)
- **Deferred** — one-shot tasks with a time delay (`5m`, `2h`, `1d`)
- **Event-driven** — tasks triggered by external events (Discord messages, webhooks, RSS items)

Tasks can depend on one another — a deferred task can specify `--after` another task, and the result of the first task can be injected into the second. In a multi-host cluster, a task runs on exactly one host.

## Webhooks and RSS

Bound can receive external events and turn them into agent tasks. Two paths:

- **Webhooks** — external services POST to a URL on your bound instance; the agent processes the payload. Supports GitHub, Stripe, Slack, and raw HMAC signature formats. See [Webhooks](/bound/guides/webhooks/).
- **RSS feeds** — bound polls RSS/Atom feeds on a schedule and delivers new items to the agent. See [RSS Feeds](/bound/guides/rss-feeds/).

Both support custom prompts, model selection, and history control per feed/webhook.

## Platform connectors

Bound connects to chat platforms (Discord) via in-process MCP servers. You configure them in `platforms.json`, and the agent can send and receive messages through them. In a cluster, only the leader host runs active subscriptions, with automatic failover to standbys.

See [Multi-Host Setup](/bound/guides/multi-host/) for cluster configuration and the [Configuration Reference](/bound/reference/configuration/) for `platforms.json` fields.
