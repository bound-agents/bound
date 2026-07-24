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

## Key features

- **Stateful across hosts** — SQLite database replicates via encrypted sync with Ed25519 identity
- **Model-agnostic** — Ollama, Anthropic, Bedrock, Cerebras, z.AI, umans, any OpenAI-compatible endpoint
- **Cluster-wide inference routing** — capability-aware model resolution with automatic fallback
- **Multiple interfaces** — web UI, Discord, boundless terminal client, ACP for editor integration
- **Persistent memory** — tiered knowledge graph that surfaces relevant context automatically
- **Task scheduler** — cron, deferred, and event-driven tasks with dependency chains
- **Webhooks & RSS** — receive external events and poll feeds; custom prompts and model hints per source
- **MCP integration** — connect external tool servers; UI-bearing tools render inline in the web UI
- **Sandboxed execution** — in-memory VFS for the agent; OS-level write confinement for boundless

## Next steps

- **[Quick Start](/bound/guides/quick-start/)** — get a local instance running
- **[Web UI Tour](/bound/concepts/web-ui/)** — the eight tabs of the web interface
- **[Boundless](/bound/guides/boundless/)** — terminal coding-agent client
- **[Multi-Host Setup](/bound/guides/multi-host/)** — configure a cluster with encrypted sync
- **[Webhooks](/bound/guides/webhooks/)** — receive external events via HTTP
- **[RSS Feeds](/bound/guides/rss-feeds/)** — poll RSS/Atom feeds and deliver to the agent
- **[Configuration](/bound/reference/configuration/)** — per-field reference for every config file
