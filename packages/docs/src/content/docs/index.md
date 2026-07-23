---
title: Bound
description: A personal agent that maintains state across multiple hosts.
template: splash
hero:
  tagline: A personal agent that maintains state across multiple hosts — one agent, one context, every interface.
  actions:
    - text: Quick Start
      link: /bound/guides/quick-start/
      icon: right-arrow
      variant: primary
    - text: View on GitHub
      link: https://github.com/bound-agents/bound
      icon: external
      variant: minimal
---

:::caution[Experimental]
Bound is still very experimental and has approximately negative stability
guarantees. You're free to play with it, but relying on it in production is not
yet advised.
:::

## What is Bound?

Bound is a personal agent that maintains state across multiple hosts. Messages,
memory, files, and tasks replicate between a laptop and a cloud VM over an
encrypted sync protocol, so every interface sees the same agent with the same
context. Model selection is cluster-wide — inference is routed to the right
backend and host automatically, with fallback. The scheduler runs tasks on cron
schedules, time delays, or events, and the agent accumulates a knowledge graph
across sessions that surfaces in context automatically.

## Next steps

- **[Quick Start](/bound/guides/quick-start/)** — get a local instance running against
  your LLM backend of choice.
- **[Architecture](/bound/reference/architecture/)** — understand the package layout
  and data flow.
