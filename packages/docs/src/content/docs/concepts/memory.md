---
title: Memory and knowledge graph
description: How durable memory is stored, connected, and selected for each agent turn.
---

Bound stores durable memory entries in a replicated knowledge graph. Context assembly
combines stable working knowledge, an archive catalog, live state, and turn-relevant memory
without loading every entry body.

## The memory tool

The agent uses the `memory` tool to manage entries:

| Action | What it does |
| --- | --- |
| `store` | Save a durable fact, finding, preference, or correction |
| `search` | Retrieve entries by key or prefix |
| `forget` | Remove an entry by key, or batch-forget by prefix |
| `connect` | Create a typed edge between two memory keys |
| `disconnect` | Remove an edge |
| `traverse` | Walk the edge graph from a key |
| `neighbors` | List edges connected to a key |

Keys can use descriptive namespaces such as `curiosity:*` or `person:*`. Key names do not
control pinning; the `tier` field is the only pinning signal.

## Memory tiers

Each memory entry has a tier that controls how it surfaces in context:

| Tier | How it appears |
| --- | --- |
| `pinned` | Full body in working knowledge; intended for durable rules and corrections |
| `summary` | Condensed working knowledge when selected within the summary budget |
| `default` | Searchable memory eligible for relevance retrieval |
| `detail` | Archive detail, normally represented by title until retrieved |

Pinned space is capped by `memory.json`, with defaults of 10 entries and 2,000 characters
per entry. Ask the agent to remember a rule permanently when it should use the pinned tier.

## Knowledge graph edges

Edges use canonical relation types, a weight from 0 through 10, and optional context.
Keyword matching and graph traversal can both contribute turn-relevant entries.

## Context tiers

Memory appears through four context sections:

- **Working Knowledge:** Pinned bodies and selected summaries in the stable prompt prefix.
- **Working Knowledge updates:** Changed entries on the varying side of context.
- **Discoverable Archive:** Compressed titles that tell the agent what it can retrieve.
- **Relevant memory:** Titles selected for the current turn by keyword and graph matching.

The agent can call `memory search` when it needs an entry's full body.

## Live State pointers

Each assembled turn also carries a Live State block for short-lived operational pointers:
cross-thread activity, task runs, file changes, and recently applied advisories.

Thread and advisory entries include their canonical database `id`, so the agent can retrieve the
backing row with `query` instead of treating the rendered pointer as authoritative. A thread with
an attached web or boundless client renders nested session metadata naming the host and whether
that session is live; the thread's `local` attribute carries the locality verdict for the attachment.
