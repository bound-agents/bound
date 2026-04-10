# RFC: Hierarchical Memory Retrieval

**Supplements:** `2026-03-29-memory-visibility.md` R-MV1–R-MV13; `2026-03-20-base.md` §5.5, §9.2, §13.1
**Date:** 2026-04-10
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Flat Retrieval Does Not Scale

Bound's `semantic_memory` table currently holds 723 entries totalling 1,046,776 bytes of value content. The retrieval system in `buildVolatileEnrichment()` loads entries through two mechanisms: graph-seeded retrieval (keyword extraction → depth-2 edge walk, capped at `maxMemory` = 10 via graph, 15 via recency) and recency fallback. Including pinned entries, approximately 29 entries are loaded per turn — 4% of total memory.

The remaining 96% of memory is invisible on any given turn. Whether an entry surfaces depends on keyword overlap with the current conversation and recency of modification. Entries that are semantically important but lexically dissimilar to the current input — a standing architectural decision relevant to today's bug fix, a behavioral correction filed last week, a research finding that contradicts a current assumption — are retrievable only by accident.

The problem compounds as memory grows. At 200 entries, 15% visibility per turn was adequate. At 700+, it is not. The heartbeat's consolidation pass deletes redundant entries but cannot reduce the corpus below a floor set by the breadth of topics the agent tracks — filed items, research, insights, issues, outcomes, commit logs, and operational context all accumulate legitimately. The flat retrieval window has no mechanism to prioritize a cluster of 40 curiosity entries differently from 4 standing instructions; both compete for the same 25 slots.

### 1.2 Increasing the Window Is Insufficient

The obvious response — raise `maxMemory` from 25 to 100 — does not solve the problem. At 1,447 bytes average entry size, 100 entries would inject ~141KB of memory context per turn, consuming roughly 35,000 tokens. On a 200K context model this is feasible but expensive; on smaller models it crowds out conversation history. More critically, a larger window does not introduce prioritization. The 100th entry is still chosen by keyword match or recency, not importance. Entries that happen to share vocabulary with the current message dominate, regardless of whether they contain standing instructions, behavioral corrections, or stale research on an unrelated topic.

### 1.3 Scope

This RFC introduces a tiering system for semantic memory entries and a multi-stage retrieval pipeline that loads entries in priority order. It does NOT address:

- **Embedding-based retrieval.** Bound's retrieval uses keyword extraction and graph edges, not vector similarity. This RFC preserves that approach. Embedding-based retrieval is a separate, orthogonal enhancement.
- **Cross-host memory partitioning.** Multi-user memory isolation (trust tiers, per-user collections) is deferred. This RFC assumes a single operator with full access to all entries.
- **Automated summary generation.** The heartbeat is expected to create summary entries during consolidation, but the summarization algorithm itself is not specified here. This RFC defines the schema, retrieval behavior, and lifecycle for summary entries; how summaries are generated is an implementation concern.

### 1.4 Timing

Two preconditions have recently landed. Commit `1bf4e88` added `_standing:` to the pinned prefix query, and commit `584b6b2` added `_feedback:`. These established the L0 pinned layer using key-prefix detection in `buildVolatileEnrichment()`. The present RFC formalizes and extends this into a general tiering mechanism, replacing ad-hoc prefix matching with a schema-level `tier` column while maintaining backward compatibility with the prefix convention.

The agent's memory corpus crossed 700 entries on 2026-04-08. Consolidation has reduced it from a peak of 773 but cannot sustain further reductions without losing legitimate content. The retrieval visibility problem is now the primary bottleneck in agent effectiveness — the heartbeat's self-assessment, the curiosity cron's directed research, and the synthesis cron's cross-pollination all depend on memory entries being retrievable when relevant, and all three have produced duplicate or redundant work because relevant prior entries were not in the retrieval window.

### 1.5 Design Principles

This RFC is governed by four principles, stated in priority order. Where they conflict, the higher-ranked principle wins.

**Availability over consistency.** The agent must always have its critical context — standing instructions, behavioral corrections, operational identity — regardless of system state. A migration failure, a corrupted tier column, or a missing summary must never cause the agent to operate without its core memory. This conflicts with determinism (below): maintaining a prefix-based fallback alongside the tier column means two sources of truth for pinned status, and the system may behave differently depending on which path resolves first. The inconsistency is accepted because an agent without its identity is a harder failure than an agent with a redundant detection path.

**Determinism over flexibility.** The agent's operator must be able to predict what will be in context on any given turn by inspecting tier assignments, without simulating the retrieval algorithm. Pinned entries are always present. Summaries are always present. This conflicts with availability: the prefix fallback (required for availability) makes tier behavior less predictable during migration, because an entry might appear as pinned via its prefix even if its tier column says `default`. It also conflicts with incremental improvement (below): during the transition period where some entries have been classified and others haven't, the operator cannot fully predict behavior from tier assignments alone.

**Reversibility over efficiency.** Operations that change how memory is surfaced must be undoable. Summaries demote children rather than deleting them. A bad summary can be removed and its children re-emerge. This conflicts with incremental improvement: retaining detail entries means the database doesn't shrink during consolidation — it only adds summary entries on top. The path to a clean, well-summarized corpus is slower because nothing is discarded. The storage cost and slower convergence are accepted because deletion is irreversible across synced hosts.

**Incremental improvement over correctness-at-launch.** The system must deliver value from the first deployment, with zero summaries behaving identically to the current system. There is no cutover, no flag day. This conflicts with determinism: the mixed state during migration (some entries tiered, some not, some summarized, some not) is inherently less predictable than a fully-migrated database. It also conflicts with reversibility: the gradual approach means the system carries unsummarized entries indefinitely, and the operator cannot force a clean state without running the heartbeat long enough to cover all clusters.

## 2. Proposal

### 2.1 Summary

Semantic memory entries are classified into four tiers — `pinned`, `summary`, `default`, and `detail` — stored in a new `tier` column on the `semantic_memory` table. Context assembly loads entries in tier order: pinned entries load unconditionally, summary entries load next, then graph-seeded entries from the `default` tier fill remaining slots, and recency-based entries from the `default` tier fill any remaining budget. Each tier builds an exclusion set that prevents lower tiers from double-loading the same content. Summary entries are linked to their children via `summarizes` edges in `memory_edges`; children are classified as `detail` tier and excluded from default retrieval, surfacing only when stale (modified after the parent summary) or explicitly queried via tools.

### 2.2 What This Changes

| Area | Change |
|---|---|
| `semantic_memory` schema (§5.5) | New `tier` column: `pinned`, `summary`, `default`, `detail` |
| `memory_edges` (§5.5) | New `summarizes` relation type |
| `buildVolatileEnrichment()` (R-MV11) | 4-stage pipeline replacing current 2-stage (pinned + flat delta) |
| `memory store` command | New `--tier` parameter |
| Memory delta format (R-MV1) | Entries annotated with retrieval method: `[pinned]`, `[summary]`, `[graph]`, `[recency]` |
| Consolidation (heartbeat) | Summary creation and stale summary detection |
| Budget truncation (R-MV13) | Tier-aware shedding: recency first, graph second, summaries and pinned preserved |


### 2.3 Behavioral Overview

This section describes how the system's visible behavior changes. The formal requirements in §3 specify these behaviors precisely; this section provides the narrative context.

**Retrieval becomes layered.** Today, `buildVolatileEnrichment()` runs two retrieval passes — graph-seeded and recency — against the full corpus of non-pinned entries. Both passes compete for the same `maxMemory` budget, and the only entries guaranteed to appear are the handful matching pinned key prefixes. After this RFC, retrieval proceeds in four stages with a strict priority ordering. Pinned entries load first and unconditionally — these are standing instructions, behavioral corrections, and operational identity. Summary entries load next, also unconditionally. Only after both of these tiers are in context does the system run graph-seeded retrieval, and only against entries not already loaded and not classified as `detail`. Recency fills whatever slots remain. The practical effect: an agent with 20 summaries covering 200 detail entries sees those 200 entries represented in context via their summaries on every single turn, where today it would see at most 25 of them, selected by keyword accident.

**Summaries are a new kind of entry, not a new kind of storage.** A summary entry is a regular `semantic_memory` row with `tier = 'summary'` and outgoing `summarizes` edges to its children. It is created by the heartbeat during consolidation, not by a special-purpose system. The heartbeat identifies a cluster of related entries — say, twelve curiosity entries about CRDT architectures — writes a synopsis as a new entry, and connects it to the twelve originals via edges. The originals are then reclassified from `default` to `detail`, which removes them from graph and recency retrieval. They are not deleted; they remain in the database, editable, queryable, and available for drill-down. If the summary is later deleted, its children promote back to `default` and reappear in normal retrieval as though the summary never existed.

**Staleness surfaces automatically.** When someone (the operator, a background task, or the heartbeat itself) updates a detail entry after its parent summary was written, the summary becomes stale — its synopsis no longer reflects the current state of its children. The system does not attempt to fix this at retrieval time. Instead, when context assembly loads a summary at L1, it checks whether any children have been modified more recently. If so, it annotates the summary with `[stale — child updated]` and loads the modified children alongside it. The agent sees both the outdated summary and the fresh detail, and can reason about the discrepancy. The heartbeat detects stale summaries during its next consolidation pass and regenerates them, but the annotation ensures the agent is never silently misled between heartbeat cycles.

**Budget pressure degrades gracefully from the bottom.** When context assembly runs up against token budget limits, it does not uniformly truncate the memory section. Instead, it sheds tiers in reverse priority: recency entries drop first (they were the least intentionally selected), then graph-seeded entries are reduced to a handful, then summaries and pinned entries remain intact. The agent operating under budget pressure loses breadth (fewer tangential entries, less serendipitous recall) but retains depth (its identity, its corrections, its consolidated knowledge). Only in an extreme edge case — where pinned entries alone exceed the budget — does the system log a warning, and even then it does not truncate pinned content, because the availability principle (§1.5) takes precedence.

## 3. Requirements

### 3.1 Ubiquitous

**R-HM1.** The `semantic_memory` table shall have a `tier` column of type `TEXT` with a default value of `'default'`. Valid values are `pinned`, `summary`, `default`, and `detail`.

**R-HM2.** The `memory store` command shall accept an optional `--tier` parameter. When omitted, the entry's tier is `default`. When the entry's key matches a pinned prefix (`_standing:`, `_feedback:`, `_policy:`, `_pinned:`), the tier shall be set to `pinned` regardless of the `--tier` parameter.

**R-HM3.** The `memory_edges` table shall support a `summarizes` relation type. A `summarizes` edge from key A to key B means "A is a summary of B."

**R-HM4.** When a `summarizes` edge is created from summary S to detail D, D's tier shall be set to `detail` if it is currently `default`. If D's tier is `pinned` or `summary`, the edge is created but D's tier is not changed — pinned entries are never demoted, and multi-level summarization (summary-of-summaries) is not supported in this RFC.

**R-HM5.** When a summary entry is deleted (tombstoned), all entries connected to it via outgoing `summarizes` edges shall have their tier set to `default` (promoted) and their `modified_at` updated. The outgoing `summarizes` edges shall also be tombstoned.

### 3.2 Event-Driven

**R-HM6.** When `buildVolatileEnrichment()` assembles the volatile context, it shall load entries in four stages:
1. **L0 Pinned:** All entries where `tier = 'pinned'` OR key matches a pinned prefix. Build exclusion set E₀.
2. **L1 Summary:** All entries where `tier = 'summary'` and key NOT IN E₀. For each summary, query outgoing `summarizes` edges to identify children. Add children's keys to exclusion set. Build E₁ = E₀ ∪ {summary keys} ∪ {children keys}.
3. **L2 Graph-seeded:** Existing `graphSeededRetrieval()` with additional WHERE constraint: `key NOT IN E₁ AND tier NOT IN ('detail', 'pinned', 'summary')`. Fill up to `maxMemory` slots. Build E₂ = E₁ ∪ {graph keys}.
4. **L3 Recency:** Existing recency fallback with additional WHERE constraint: `key NOT IN E₂ AND tier NOT IN ('detail', 'pinned', 'summary')`. Fill remaining slots.

**R-HM7.** When a summary entry is loaded at L1 and any of its children have `modified_at` later than the summary's `modified_at`, the summary shall be annotated `[stale — child updated]` and each stale child shall be loaded alongside the summary. Stale children do not consume L2 or L3 slots; they are loaded as part of the L1 stage.

**R-HM8.** When a `detail` entry is modified (via `memory store` updating an existing key), if the entry has an incoming `summarizes` edge, no automatic action is taken on the parent summary. The staleness is detected at retrieval time (R-HM7) and at consolidation time by the heartbeat.

### 3.3 State-Driven

**R-HM9.** While the context budget (§13.1 Stage 7) is critically constrained (remaining headroom below 2,000 tokens after history and response reservation), the retrieval pipeline shall degrade gracefully:
- L3 (recency) entries are shed entirely.
- L2 (graph-seeded) entries are reduced to at most 5.
- L1 (summary) entries are preserved in full.
- L0 (pinned) entries are never shed.
If pinned entries alone exceed the budget, the assembler logs a warning but does not crash or truncate pinned content.
\If L0+L1 together exceed the budget (which requires a large number of summaries), the same rule applies — log a warning, do not truncate. Controlling the number of summaries is a deployment and consolidation concern, not a retrieval concern; the heartbeat should avoid creating so many summaries that they crowd out L2 and L3.

**R-HM10.** While an entry has `tier = 'detail'` and no incoming `summarizes` edge exists (orphaned detail), the entry shall be treated as `tier = 'default'` for retrieval purposes. This handles the case where a summary was deleted but the tier promotion (R-HM5) failed or was interrupted.

### 3.4 Optional / Deferred

**R-HM11 (deferred).** Index/content separation — storing a lightweight index (key + first 200 characters) separately from full content, with full content loaded only for selected entries. This optimization is compatible with the tiering system but not required for initial deployment. The current approach of loading full `value` content for all retrieved entries is retained.

**R-HM12 (deferred).** Temporal validity windows — entries with explicit "valid from" and "valid until" timestamps. The current staleness caveat system (entries >24h get "(may have changed)") is a simpler approximation. Formal temporal validity is deferred.

**R-HM13 (deferred).** Automated summary generation algorithm. The heartbeat is expected to create summaries, but the specific clustering and summarization approach is not specified. The choice is left to implementation.

### 3.5 Sync

**R-HM14.** The `tier` column shall be included in the `change_log` outbox for cross-host sync. A tier change generates a changelog entry with the same semantics as a value change. Sync receivers apply tier values from the changelog; conflicts resolve by `modified_at` recency.

**R-HM15.** The `summarizes` relation type shall sync via the existing `memory_edges` changelog mechanism. No new sync protocol is introduced.

### 3.6 Unwanted Behavior

**R-HM16.** The system shall not load the same entry twice in a single volatile context assembly. The exclusion cascade (R-HM6) prevents this.

**R-HM17.** The system shall not delete detail entries when creating a summary. Summary creation demotes children to `detail` tier (R-HM4) but does not tombstone them.

**R-HM18.** The system shall not automatically regenerate stale summaries at retrieval time. Stale detection (R-HM7) is passive. Regeneration is performed by the heartbeat during consolidation, not by the context assembler.

**R-HM19.** When `memory store` updates an existing entry whose tier is `detail`, the tier shall remain `detail` unless the `--tier` parameter explicitly overrides it. The `summarizes` edge from the parent summary remains valid; staleness is handled by R-HM7 and R-HM8.

## 4. Data Model Changes

### 4.1 Schema

**`semantic_memory` table — new column:**

```sql
ALTER TABLE semantic_memory ADD COLUMN tier TEXT DEFAULT 'default';
CREATE INDEX idx_memory_tier ON semantic_memory(tier) WHERE deleted = 0;
```

Valid values: `pinned`, `summary`, `default`, `detail`. Validation is enforced at the application layer in `memory store`.

**`memory_edges` table — new relation type:**

No schema change required. The `relation` column already accepts arbitrary text. The new value `summarizes` is introduced by convention.

### 4.2 Migration

On first startup after deployment:

1. Entries with keys matching `_standing:%`, `_feedback:%`, `_policy:%`, `_pinned:%` are set to `tier = 'pinned'`.
2. All other entries remain `tier = 'default'`.
3. No entries are set to `summary` or `detail` — these tiers are populated by subsequent heartbeat consolidation.

This migration is idempotent.

### 4.3 Affected Commands

**`memory store`** — accepts `--tier` parameter. Default: `default`. Pinned prefix keys override to `pinned` regardless of parameter.

**`memory forget`** — when forgetting a summary entry, promotes children per R-HM5.

**`memory connect`** — when creating a `summarizes` edge, sets the target's tier to `detail` per R-HM4.

**`memory disconnect`** — when removing a `summarizes` edge, checks if the target has remaining incoming `summarizes` edges. If none, promotes to `default`.

## 5. Behavioral Descriptions

### 5.1 Context Assembly (buildVolatileEnrichment)

Context assembly builds the volatile memory section that is injected into the system prompt on every inference turn. Today this is a flat list of entries selected by graph proximity and recency. After this RFC, assembly proceeds in four stages, each building an exclusion set that prevents subsequent stages from duplicating content.

**Stage 1 — L0 Pinned.** Query all entries where `tier = 'pinned'` OR key matches a pinned prefix pattern (`_standing%`, `_feedback%`, `_policy%`, `_pinned%`), AND `deleted = 0`. Format each entry with a `[pinned]` tag. Build the exclusion set E₀ containing all loaded keys. These entries are loaded regardless of the conversation topic, budget pressure, or any other factor.

**Stage 2 — L1 Summary.** Query all entries where `tier = 'summary'` AND `key NOT IN E₀` AND `deleted = 0`. For each summary S, query `memory_edges` for outgoing `summarizes` edges to identify S's children. Add every child's key to the exclusion set, whether or not the child is loaded — this is what prevents detail entries from appearing in later stages. Then check for staleness: for each child C, compare `C.modified_at` against `S.modified_at`. If any child has been modified more recently than the summary, annotate S with `[stale — child updated]` and load each stale child alongside S, formatted with a `[stale-detail]` tag. Build E₁ = E₀ ∪ {summary keys} ∪ {all children keys}. Format summaries with `[summary]` tag.

**Stage 3 — L2 Graph-seeded.** Run the existing `graphSeededRetrieval()` with an additional WHERE constraint: `AND m.key NOT IN E₁ AND m.tier NOT IN ('detail', 'pinned', 'summary')`. This ensures that entries already loaded at L0 or L1, plus all detail entries covered by summaries, are excluded. Cap results at `maxMemory` slots. Build E₂ = E₁ ∪ {graph result keys}. Format with `[graph]` tag.

**Stage 4 — L3 Recency.** Run the existing recency fallback query with the same exclusion: `AND m.key NOT IN E₂ AND m.tier NOT IN ('detail', 'pinned', 'summary')`. Fill whatever slots remain after L0, L1, and L2. Format with `[recency]` tag.

Concatenate all formatted entries in stage order — L0 first, then L1, then L2, then L3 — and return as `memoryDeltaLines`.

**Worked example.** Suppose the database contains:

- 4 pinned entries: `_standing:outcomes_log`, `_standing:notify_command_authorized`, `_feedback:correction:cron-notify-spam`, `_feedback:correction:repo-watch-dedup`
- 2 summary entries: `_summary:crdt-research` (summarizing 8 curiosity entries about CRDTs) and `_summary:security-patterns` (summarizing 5 entries about agent security)
- 13 detail entries: the 8 CRDT entries + 5 security entries, all with `tier = 'detail'`
- 400 default entries: everything else

The user asks about "sync conflict resolution." Assembly proceeds:

1. **L0:** Loads the 4 pinned entries unconditionally. E₀ = {4 keys}.
2. **L1:** Loads both summaries. For `_summary:crdt-research`, queries `summarizes` edges and finds 8 children. Checks staleness — one child (`curiosity:loro-crdt:2026-04-08`) was updated yesterday, after the summary was written. Annotates the summary `[stale — child updated]` and loads the stale child alongside it. For `_summary:security-patterns`, all 5 children are older than the summary — no staleness. Adds all 13 children to the exclusion set. E₁ = {4 pinned + 2 summaries + 13 children = 19 keys}.
3. **L2:** Runs graph-seeded retrieval. The keyword "sync" matches several default entries about sync encryption, conflict resolution, and changelog protocol. "conflict" seeds edges to CRDT-related entries — but those are in E₁ (they're detail children of the CRDT summary), so they're excluded. Returns 10 default entries about sync. E₂ = {19 + 10 = 29 keys}.
4. **L3:** Recency fills remaining slots. The 13 detail entries and 2 summaries are excluded. Returns 5 recently-modified default entries.

Final volatile context: 4 pinned + 2 summaries (one with a stale child loaded) + 10 graph-seeded + 5 recency = 22 entries, representing knowledge across 4 standing instructions + 13 summarized entries + 15 directly loaded entries = 32 entries worth of coverage in 22 slots. Under the current system, this same query would have loaded 4 pinned + 25 entries from the undifferentiated pool of 413, with no guarantee that the CRDT or security research would appear at all.

### 5.2 Summary Creation (Heartbeat Consolidation)

The heartbeat creates summaries during its regular consolidation pass. Summary creation is not a batch migration — it happens incrementally, one cluster at a time, as the heartbeat identifies opportunities.

**Identifying clusters.** The heartbeat scans for groups of ≥3 entries that share a relationship. The simplest signal is a shared key prefix: twelve entries keyed `curiosity:crdt-*` are an obvious cluster. Graph edges provide a second signal: entries connected by `related_to` edges form a cluster even if their keys differ. Content similarity is a third, weaker signal — entries whose values mention the same terms without sharing prefixes or edges. The heartbeat prioritizes prefix clusters (cheapest to detect), then edge clusters, then content clusters.

**Generating the synopsis.** For a cluster of N entries, the heartbeat reads all N values and produces a human-readable synopsis that captures the key themes, findings, and connections across the cluster. The synopsis is a standalone entry — readable without consulting the children. It is not a concatenation or a bullet-point list of children; it is a narrative summary that a reader can use to decide whether the full detail entries are worth consulting.

**Storing and linking.** The heartbeat stores the synopsis as a new entry:

```
memory store _summary:crdt-research "8 research entries on CRDT architectures. Key findings: Loro uses
shallow snapshots for multi-resolution storage, Yjs and Automerge diverge on encoding strategy, Diamond
Types achieves near-linear merge performance via..." --tier summary
```

Then, for each child in the cluster:

```
memory connect _summary:crdt-research curiosity:loro-crdt:2026-04-08 --relation summarizes
memory connect _summary:crdt-research curiosity:yjs-encoding:2026-04-07 --relation summarizes
...
```

Each `memory connect` with a `summarizes` relation sets the child's tier to `detail` (R-HM4), removing it from graph and recency retrieval. The child still exists, still has its full content, and is still editable — it is simply no longer competing for retrieval slots.

**Worked example.** The heartbeat's consolidation pass scans entries with the prefix `curiosity:` and finds 12 entries about agent security topics: MCP vulnerabilities, Tirith execution protection, tiered trust patterns, FirePass authentication, Claude Code RCE audit, and OpenCode agent profiles. These share the prefix `curiosity:` but more specifically, 5 of them are connected by `related_to` edges around the theme "agent trust boundaries."

The heartbeat generates a synopsis covering the 5 connected entries and stores it as `_summary:agent-trust-boundaries`. The 5 children become `detail` tier. The remaining 7 security-adjacent entries that weren't connected by edges stay as `default` — they'll be picked up in a future consolidation pass once more edges form, or once the heartbeat identifies them by content similarity.

### 5.3 Stale Summary Regeneration

A summary becomes stale when any of its children is modified after the summary was written. This happens naturally — someone updates a research entry with new findings, the heartbeat corrects a factual error in a curiosity entry, or an operator stores new content under an existing key.

**Detection.** During its consolidation pass, the heartbeat queries for stale summaries:

```sql
SELECT DISTINCT s.key, s.modified_at
FROM semantic_memory s
JOIN memory_edges e ON e.source_key = s.key AND e.relation = 'summarizes' AND e.deleted = 0
JOIN semantic_memory c ON c.key = e.target_key AND c.deleted = 0
WHERE s.tier = 'summary' AND s.deleted = 0
  AND c.modified_at > s.modified_at
```

For each stale summary, the heartbeat reads all children's current values (not just the stale ones — the entire cluster may have shifted), generates a fresh synopsis, and stores it via `memory store`, which updates the summary's `modified_at`. The existing `summarizes` edges remain valid — the same children are still covered; only the synopsis text has changed.

**Between heartbeat cycles.** Between the moment a child is modified and the next heartbeat consolidation pass (10–30 minutes), the stale summary is still loaded at L1. Context assembly detects the staleness at retrieval time (R-HM7) and annotates the summary, loading the modified child alongside it. The agent sees both and can reason about the discrepancy. This is passive detection — no LLM call, no regeneration, just annotation and supplementary loading.

**Worked example.** The summary `_summary:crdt-research` was written at 14:00 with a synopsis covering 8 CRDT entries. At 14:45, a background task updates `curiosity:loro-crdt:2026-04-08` with new findings about Loro's shallow snapshot performance. At 14:50, the user asks about CRDT merge strategies. Context assembly loads the CRDT summary at L1, detects that `curiosity:loro-crdt` has `modified_at` of 14:45 (newer than the summary's 14:00), and annotates the summary `[stale — child updated]`. The Loro entry loads alongside it with a `[stale-detail]` tag. The agent sees the original summary plus the updated Loro findings, and can synthesize both. At 15:00, the heartbeat runs consolidation, detects the stale summary, reads all 8 children, generates a new synopsis incorporating the Loro update, and stores it. The summary's `modified_at` becomes 15:00, and subsequent turns load the fresh summary without staleness annotation.

### 5.4 Budget-Constrained Assembly

When the context window is tight — long conversation histories, large system prompts, or smaller models — the volatile memory section may exceed its allocated token budget. The current system truncates uniformly. This RFC introduces tier-aware degradation that preserves the most important context.

Budget evaluation happens after all four stages have run, as part of Stage 7 (BUDGET_VALIDATION) in the context assembly pipeline. The assembler counts the tokens consumed by the volatile memory section and compares against the remaining headroom.

**Degradation sequence:**

1. **Shed L3 (recency).** If headroom is below 2,000 tokens after history and response reservation, remove all L3 entries. These are the least intentionally selected — they appeared because they were recently modified, not because they matched the conversation. Recheck headroom.

2. **Reduce L2 (graph-seeded).** If still constrained, reduce L2 to at most 5 entries, keeping those with the highest graph proximity scores. These entries matched the conversation topic but are less critical than summaries. Recheck headroom.

3. **Preserve L1 and L0.** Summaries and pinned entries are not shed. If the remaining headroom is still insufficient, the assembler logs a warning: "Memory budget critically constrained — {N} pinned + {M} summary entries consume {T} tokens." The assembly continues with L0 and L1 intact.

4. **L0 overflow (edge case).** If pinned entries alone exceed the budget — which would require an unusually large number of pinned entries or an unusually small model — the assembler logs an error but does not truncate. The availability principle (§1.5) takes precedence: the agent must have its identity and corrections, even at the cost of exceeding the ideal budget.

**Worked example.** A conversation on a 32K-context model has consumed 28,000 tokens of history. The response reservation is 2,000 tokens, leaving 2,000 for the volatile memory section. L0 (4 pinned entries) consumes 400 tokens. L1 (3 summaries) consumes 600 tokens. L2 (10 graph-seeded entries) consumes 1,400 tokens. L3 (5 recency entries) consumes 700 tokens. Total: 3,100 tokens, exceeding the 2,000 budget by 1,100.

The assembler sheds L3 entirely (−700 tokens → 2,400, still over). Reduces L2 from 10 to 5 entries (−700 tokens → 1,700, now under budget). The final volatile section contains 4 pinned + 3 summaries + 5 graph entries = 12 entries at 1,700 tokens. The agent retains its identity, its consolidated knowledge, and the five most relevant graph-seeded entries for the current topic.

### 5.5 Summary Deletion and Child Promotion

When a summary is deleted — either explicitly via `memory forget` or tombstoned during sync — its children must be promoted back to `default` tier so they reappear in normal retrieval.

1. `memory forget _summary:crdt-research` tombstones the summary entry.
2. The handler queries `memory_edges` for all outgoing `summarizes` edges from `_summary:crdt-research`.
3. For each child, sets `tier = 'default'` and updates `modified_at`.
4. Tombstones the `summarizes` edges.

The children are now visible to graph-seeded and recency retrieval again, as though the summary never existed. No content has been lost.

**Error case — interrupted promotion.** If the process crashes between tombstoning the summary and promoting all children, some children may remain as `detail` tier with no parent summary. R-HM10 handles this: an entry with `tier = 'detail'` and no incoming `summarizes` edge is treated as `default` for retrieval purposes. The next heartbeat cycle can detect and clean up these orphans.

## 6. Interaction with Existing Specifications

**`2026-03-29-memory-visibility.md`** — R-MV1 (delta format): extended with tier annotations. R-MV2 (memory delta cap): the existing cap applies to L2+L3 combined. L0 and L1 entries are not counted against it. R-MV11 (Stage 5.5): implementation modified, position and interface unchanged. R-MV13 (budget truncation): replaced with tier-aware shedding (R-HM9).

**`2026-03-20-base.md` §5.5** — Adds `tier` column to `semantic_memory`. Existing columns unchanged.

**`2026-03-20-base.md` §9.2** — Volatile context block grows with tier annotations. L0+L1 entries are stable across turns, improving prompt cache hit rates.

**`2026-04-04-graph-memory.md`** — `summarizes` edge type added. `summarizes` edge type added to the graph. `graphSeededRetrieval()` encounters `summarizes` edges during its depth-2 walk but does not load `detail`-tier targets — drill-down from summary to non-stale children is deferred (see R-HM11). The graph walk can still seed OTHER entries connected to a summary via non-`summarizes` edges.

## 7. Retrieval Design Choices

### 7.1 Why a Tier Column over Extended Prefix Conventions

Extending prefix conventions to summaries and details (`_summary:`, `_detail:`) forces keys to encode retrieval metadata. Keys should describe content, not retrieval priority. A `tier` column separates concerns. Prefix detection is retained as backward-compatible fallback for pinned entries only.

### 7.2 Why Exclusion Cascades over Scoring

A scoring model (composite of tier, graph proximity, recency, keyword relevance → top N) is more flexible but less predictable. An entry's presence depends on what else is in the corpus. Exclusion cascades are deterministic: pinned entries always appear, summaries always appear, and remaining budget goes to graph and recency results guaranteed not to duplicate higher-tier content.

### 7.3 Why Detail Entries Persist over Deletion

Tombstoning children when creating a summary is irreversible, loses original data if the summary is poor, and generates sync changelog entries. Tier demotion is reversible, preserves drill-down access, and produces a lighter sync footprint.

### 7.4 Why Passive Stale Detection over Eager Regeneration

Eager regeneration requires an LLM call during context assembly, adding latency to every turn with a stale summary. Passive detection annotates the summary and loads the fresh child, giving the agent accurate information without blocking. Regeneration runs asynchronously in the heartbeat.

## 8. Testing Strategy

**Unit tests:**
- `memory store --tier summary` creates entry with `tier = 'summary'`
- `memory connect --relation summarizes` sets target tier to `detail`
- `memory connect --relation summarizes` on pinned target preserves pinned tier
- `memory disconnect summarizes` with no remaining parents promotes to `default`
- `memory forget` on summary promotes all children to `default`
- Tier migration classifies prefix entries as `pinned`, others as `default`

**Integration tests:**
- `buildVolatileEnrichment()` with zero summaries: identical output to current system
- `buildVolatileEnrichment()` with summaries: children excluded from L2/L3
- `buildVolatileEnrichment()` with stale summary: annotated, stale children loaded
\- `buildVolatileEnrichment()` with multiple stale children: all stale children loaded at L1, not just the first
- `buildVolatileEnrichment()` with orphaned detail entry (no parent summary): treated as default, appears in L2/L3
- `memory store` on a detail-tier entry preserves tier, does not promote to default
- Exclusion cascade prevents double-loading across all four stages
- Budget-constrained assembly sheds L3 → L2 → preserves L1/L0

**Compatibility tests:**
- Entries without `tier` column default to `default` after migration
- Prefix-based pinned detection works for unmigrated entries
- `graphSeededRetrieval()` follows `summarizes` edges
- Tier changes sync via changelog
