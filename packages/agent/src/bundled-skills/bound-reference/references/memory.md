# Memory Reference

Your memory is rows in the `semantic_memory` table, plus typed edges in
`memory_edges`. It persists across conversations, hosts, and surfaces. Operate on
it with the `memory` tool.

## Tiers

`memory.store` takes a `tier`. Tier — not key naming — is the single source of
truth for how an entry is treated:

- **`pinned`** — durable across context compaction. Use for operational rules,
  feedback corrections, policy pointers, and explicit pins. Pinned entries render
  in Working Knowledge every turn.
- **`summary`** — a parent that summarizes child detail entries. Connecting a
  `summarizes` edge auto-demotes the child.
- **`default`** — ordinary entries; surfaced by recency and graph proximity.
- **`detail`** — low-priority detail; titles appear in the Discoverable Archive
  and bodies are fetched on demand via `memory search`.

The historical `_standing:` / `_feedback:` / `_policy:` key shorthand no longer
auto-pins anything — pass `tier: "pinned"` explicitly.

## Pinned-memory caps

Pinned memory is a deliberately limited resource. `memory.store` enforces two
caps on pinned entries (configurable via `memory.json`, defaulting to **10**
pinned entries of **2000** characters each):

- **Count cap** — creating a new pinned entry or promoting a non-pinned entry to
  pinned fails once the cap is reached. Updating an entry that is *already*
  pinned does not consume additional budget.
- **Size cap** — a pinned entry whose value exceeds the per-entry character cap
  is rejected. The size cap applies only to pinned entries.

**Demotion is always allowed**, even when over the caps — re-storing a pinned
entry at a lower tier (or omitting `tier`) never fails. This is the escape hatch:
when you hit a cap, consolidate, rewrite more concisely, demote, or forget an
existing pinned entry to make room. System memories (e.g. the heartbeat standing
instructions) are exempt from the count cap but still obey the size cap.

## Key conventions

Keys are free-form, but consistent prefixes make the graph navigable. Common
ones in use: `_standing:*` (operating rules), `_feedback:correction:*` (logged
corrections), `_outcome:*` (action outcomes), `curiosity:*` and `research:*`
(investigations), `_summary:*` (summary parents), `person:*` (per-person
preferences), `bound_issue:*` (filed bound issues).

## Edges

`memory.connect` creates a typed edge between two entries. The relation must be
one of the canonical set (enforced by SQLite triggers):

`related_to, informs, supports, extends, complements, contrasts-with,
competes-with, cites, summarizes, synthesizes`

Do not encode findings in the relation string — put bespoke phrasing in the
`context` field. Create 1–2 lateral edges when you store a new entry so it is
reachable by graph traversal, rather than leaving it orphaned.

## How memory reaches your context

Context assembly renders memory in tiered fidelity:

- **Working Knowledge** — pinned entries (full bodies) plus summary entries, on
  the stable (cached) side of the prompt.
- **Discoverable Archive** — `detail`-tier titles only; search the key to pull a
  body.
- **Recent memory** — `default`-tier entries surfaced by graph-seed and recency
  on the varying side.

Treat rendered summaries as **pointers, not ground truth**. When a claim is
load-bearing, verify it against the database with `query` before acting.
