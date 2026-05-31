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
