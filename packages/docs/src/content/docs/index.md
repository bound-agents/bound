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

- **Stateful across hosts** — SQLite database replicates via event-sourced sync with Ed25519 identity and XChaCha20 encryption
- **Model-agnostic** — Ollama, Anthropic, Bedrock, Cerebras, z.AI, umans, any OpenAI-compatible endpoint
- **Cluster-wide inference routing** — capability-aware model resolution with automatic fallback across hosts
- **Multiple interfaces** — web UI (Svelte 5 SPA), Discord, boundless terminal client, ACP for editor integration
- **Persistent memory** — tiered knowledge graph that surfaces relevant context automatically per turn
- **Task scheduler** — cron, deferred, and event-driven tasks with dependency chains
- **MCP integration** — connect external tool servers; UI-bearing tools render inline in the web UI
- **Sandboxed execution** — in-memory VFS for the agent; OS-level write confinement for boundless

## Next steps

- **[Quick Start](/bound/guides/quick-start/)** — get a local instance running against your LLM backend of choice.
- **[Architecture](/bound/reference/architecture/)** — package layout, data flow, and core design decisions.
- **[Configuration](/bound/reference/configuration/)** — per-field reference for every config file.
- **[Boundless](/bound/guides/boundless/)** — terminal coding-agent client with filesystem and shell tools.
- **[Multi-Host Setup](/bound/guides/multi-host/)** — configure a hub-and-spoke cluster with encrypted sync.
