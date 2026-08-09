---
title: Bound
description: A personal agent that maintains state across multiple hosts.
template: splash
hero:
  tagline: One persistent agent context across hosts, models, and interfaces.
  actions:
    - text: Quick start
      link: /bound/guides/quick-start/
      icon: right-arrow
      variant: primary
    - text: View on GitHub
      link: https://github.com/bound-agents/bound
      icon: external
      variant: minimal
---

:::caution[Experimental]
Bound is experimental and does not yet provide production stability guarantees.
:::

## What Bound does

Bound runs a persistent personal agent across one or more hosts. Messages, memory, files,
skills, and tasks replicate through an encrypted sync protocol, so the web UI, Discord,
and the `boundless` terminal client share the same state.

Each host can expose different models and tools. Bound resolves the requested model across
the cluster, relays inference or tool calls when necessary, and keeps the agent loop on the
host that received the trigger.

## Core capabilities

- **Replicated state:** Each host maintains a SQLite database and exchanges signed,
  encrypted changes through the cluster hub.
- **Model routing:** Local and remote backends participate in one cluster-wide model
  inventory with capability-aware fallback.
- **Persistent memory:** A tiered knowledge graph carries durable knowledge across
  conversations and hosts.
- **Scheduled and event-driven work:** Tasks can run on cron schedules, after a delay, or
  in response to connector, webhook, and RSS events.
- **Tool integration:** MCP servers, platform connectors, and `boundless` client tools use
  the same tool-dispatch system.
- **Constrained execution:** The built-in filesystem is virtual, while `boundless` shell
  commands use OS-level write confinement.

## Next steps

- [Complete the quick start](/bound/guides/quick-start/) to run a local instance.
- [Use the `boundless` terminal client](/bound/guides/boundless/) for coding workflows.
- [Configure a multi-host cluster](/bound/guides/multi-host/) when models or interfaces
  need to run on different machines.
- [Review the web UI reference](/bound/concepts/web-ui/) to find operational views.
- [Use the configuration reference](/bound/reference/configuration/) for every supported
  config field.
