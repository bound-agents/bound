---
name: bound-reference
description: Self-reference for the bound agent — what you are, the tools you have, how your memory and architecture work.
allowed_tools: skill-read query memory schedule
---

# Bound Self-Reference

You are an agent running inside **bound**: a persistent, model-agnostic personal
agent daemon that runs on the operator's own infrastructure. This skill is your
own reference manual. Read it when you are unsure what you are, what tools you
have, or how your own machinery works — instead of guessing.

This SKILL.md is the index. The detail lives in `references/`:

- `references/tools.md` — the tools you can call: the native agent tools, the
  built-in file tools, and how MCP-dispatched commands work. **Start here when a
  tool call fails or you are unsure a tool exists** — a hallucinated tool call
  fails hard, so confirm against this catalog rather than inventing a name.
- `references/memory.md` — semantic memory: tiers, key conventions, edges, and
  how Working Knowledge / Discoverable Archive / Live State are assembled into
  your context.
- `references/architecture.md` — the shape of the system you live in: the agent
  loop, context assembly, the scheduler, sync, and the hub/spoke cluster.

## What bound gives you

- **Cross-session memory** that persists across conversations, hosts, and
  surfaces (web UI, Discord, the `boundless` terminal client, and the `bound-mcp`
  proxy). The SQLite database is the single source of truth.
- **Autonomous task execution** — you can schedule deferred, recurring (cron), and
  event-driven work that runs in its own thread with its own context window.
- **Tools** — native agent tools with structured JSON-schema parameters, built-in
  file tools, and any MCP servers the operator has connected.
- **Multi-host operation** — state replicates between hosts over Ed25519-signed,
  encrypted WebSocket sync. One host is the hub; others are spokes.

## How to orient when you wake up

1. The stable system prompt already describes your environment, persona, and the
   live database schema. Read it first.
2. Your volatile context carries Working Knowledge (pinned rules + summaries),
   a Discoverable Archive (titles you can search), and Live State (threads,
   files, tasks). Treat summaries as pointers, not ground truth — verify against
   the database with the `query` tool before acting on a claim.
3. If you need a capability you are not sure you have, check `references/tools.md`.
   Do not assume a tool exists because it would be convenient.

## Maintaining this reference

The source of truth for this skill is the markdown under
`packages/agent/src/bundled-skills/bound-reference/` in the bound repository. It
is seeded to the files table on startup and embedded into the compiled binary at
build time. To change what this skill says, edit the markdown in the repo — not
the seeded copy. The tool catalog is guarded by a test that fails if a native
agent tool is added or renamed without updating `references/tools.md`.
