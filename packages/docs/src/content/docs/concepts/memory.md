---
title: Memory and knowledge graph
description: How Bound organizes durable knowledge and selects a limited memory view for each turn.
---

Bound stores durable memory entries in a replicated knowledge graph. The graph is larger
than any one model prompt, so Bound selects a limited view of it when preparing each turn.
That context model keeps durable knowledge available without loading every stored entry body
into every prompt.

## Entries and keys

A memory entry contains a key, content, and a tier. Descriptive key namespaces such as
`curiosity:*` or `person:*` help organize entries, but a key's spelling does not determine
how prominently the entry appears. The tier is the pinning and context-selection signal.

The agent can create, retrieve, remove, and connect entries through its memory tool. See
[Agent tools](/bound/reference/agent-tools/) for action names and parameters.

## Memory tiers

Each tier gives an entry a different role in context:

| Tier | Context role |
| --- | --- |
| `pinned` | Supplies a full body to working knowledge for durable rules and corrections |
| `summary` | Supplies condensed working knowledge when selected within the summary budget |
| `default` | Remains searchable and eligible for relevance retrieval |
| `detail` | Remains archive detail, normally represented by its title until retrieved |

Pinned and summary material consume prompt space, so Bound applies configured budgets
rather than treating a tier as unlimited storage. See the [configuration
reference](/bound/reference/configuration/) for current memory limits and defaults.

## Knowledge graph

Typed edges connect memory keys. Each edge uses a standardized relationship label, a weight
from 0 through 10, and optional context. The graph lets related knowledge contribute to
retrieval even when two entries do not share the same keywords.

Keyword matching and graph traversal are complementary signals. They identify potentially
relevant entries, while the tier controls how those entries can appear in the assembled
context.

## Context model

The selected memory view appears through four context sections. Some content is kept steady
across turns so the agent retains its working knowledge; other content varies with recent
changes and the current turn:

- **Working Knowledge** contains pinned bodies and selected summaries that usually stay the
  same across turns.
- **Working Knowledge updates** contains entries that changed since that steady context was
  prepared.
- **Discoverable Archive** contains compressed titles that tell the agent what it can
  retrieve.
- **Relevant memory** contains titles selected for the current turn through keyword and
  graph matching.

A title or pointer is not the complete memory body. The agent retrieves full content when a
turn needs it, which keeps the default prompt smaller while retaining access to the archive.

## Live State is not durable knowledge

Each turn also includes Live State: short-lived operational pointers such as cross-thread
activity, task runs, file changes, and recently applied advisories. Live State helps the
agent notice current activity, while memory preserves durable knowledge that later turns can
retrieve.

Memory is one input to the broader [agent loop](/bound/concepts/agent-system/). In a
multi-host deployment, memory replication follows the [state and consistency
model](/bound/concepts/sync/).
