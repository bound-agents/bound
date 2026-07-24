---
title: Memory & Knowledge Graph
description: Semantic memory, tiered fidelity, pinned entries, and the typed edge graph that surfaces context automatically.
---

Bound accumulates a knowledge graph across sessions. Memory entries persist in the `semantic_memory` table (synced, LWW) and surface in context automatically — no manual retrieval needed.

## Memory tool

The agent interacts with memory through the `memory` tool:

| Action | Purpose |
| --- | --- |
| `store` | Write a durable fact, finding, preference, or correction. Use a descriptive, namespaced key (e.g. `curiosity:*`, `person:*`). |
| `forget` | Remove an entry by key, or batch-forget by prefix. |
| `search` | Retrieve entries by key or prefix. |
| `connect` | Create a typed edge between two memory keys. |
| `disconnect` | Remove an edge. |
| `traverse` | Walk the edge graph from a key, depth 1–3. |
| `neighbors` | List edges connected to a key (in, out, or both). |

## Memory tiers

Tier controls how memory surfaces in context:

| Tier | Behavior |
| --- | --- |
| `pinned` | Durable across context compaction. Full body in the stable prefix. Survives the pinned-count cap. |
| `summary` | Title-only in the Discoverable Archive; body accessed via search. |
| `default` | Same surface as summary. The historical `tier='default'` clamp on relevant-memory retrieval was removed — all tiers are now eligible as seeds. |
| `detail` | Title-only in the Discoverable Archive, grouped by summary parent. |

Tier is the single source of truth for pinning: pass `tier: "pinned"` to the `store` action to make an entry durable. Key naming never auto-pins.

## Pinned memory caps

Configured in `memory.json` (absent = defaults apply):

| Field | Default | Meaning |
| --- | --- | --- |
| `pinned_count_cap` | 10 | Max number of pinned entries. |
| `pinned_size_cap` | 2000 | Max characters per pinned entry. |

## Knowledge graph edges

`memory_edges` (synced, LWW) stores typed relations between memory keys. The `relation` field must be one of the 10 canonical relation types. Edges carry a weight (0–10) and optional context phrase.

The graph is traversed at context-assembly time: the relevant-memory pipeline runs keyword matching and graph traversal to surface conversation-relevant entries, rendered title-only and capped at a configurable limit (`BOUND_VC27_K`, default 15).

## How memory enters context

The volatile context system renders memory in three passes:

1. **Working Knowledge (stable)** — pinned entries and summary titles, full body in the system prompt. Folded into `systemPrompt` for cross-thread cache reuse.
2. **Discoverable Archive (stable)** — title-only catalog of detail-tier entries. Three-tier compression: summaries list their detail children; only titles render, bodies accessed via `memory search`.
3. **Relevant memory (varying)** — entries matched to the current turn by keyword and graph traversal. Title-only, on the `developer`-role tail message. Capped at `BOUND_VC27_K`.

This means the agent doesn't need to actively search its memory every turn — the most relevant entries are already in context, and the full archive is one search away.
