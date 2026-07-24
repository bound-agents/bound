---
title: Memory & Knowledge Graph
description: How the agent remembers things across sessions, and how to use the memory tool.
---

Bound accumulates a knowledge graph across sessions. Memory entries persist in the database and replicate across hosts. The agent doesn't need to actively search its memory every turn — relevant entries surface in context automatically.

## The memory tool

The agent interacts with memory through the `memory` tool:

| Action | What it does |
| --- | --- |
| `store` | Save a durable fact, finding, preference, or correction |
| `search` | Retrieve entries by key or prefix |
| `forget` | Remove an entry by key, or batch-forget by prefix |
| `connect` | Create a typed edge between two memory keys |
| `disconnect` | Remove an edge |
| `traverse` | Walk the edge graph from a key |
| `neighbors` | List edges connected to a key |

Memory keys are namespaced — `curiosity:*` for research findings, `person:*` for people, `_standing:*` for operational rules, etc.

## Memory tiers

Each memory entry has a tier that controls how it surfaces in context:

| Tier | How it appears |
| --- | --- |
| `pinned` | Full body in the system prompt, survives context compaction. Use for rules, corrections, and critical facts. |
| `summary` | Title in the archive catalog; body retrieved via search. |
| `default` | Same as summary — title in the catalog, searchable body. |
| `detail` | Title-only, grouped under a summary parent. |

Pass `tier: "pinned"` when storing to make an entry durable. There's a cap on pinned entries (configurable in `memory.json` — default 10 entries, 2000 chars each).

## Knowledge graph edges

Memory entries can be connected with typed edges. The agent traverses these edges at context-assembly time to surface conversation-relevant entries. Edges carry a weight (0–10) and an optional context phrase.

## How memory enters context

The agent doesn't manually search its memory every turn. Three things happen automatically:

- **Pinned entries** appear in full in the system prompt
- **Archive catalog** lists all entries by title so the agent knows what's available to search
- **Relevant entries** are matched to the current conversation by keyword and graph traversal, and surfaced as titles

This means the most relevant memory is already in context when the agent responds, and the full archive is one search away.
