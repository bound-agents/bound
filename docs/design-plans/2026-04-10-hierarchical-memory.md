# Hierarchical Memory Retrieval Design

## Summary

This design implements a four-tier memory hierarchy (`pinned`/`summary`/`default`/`detail`) to reduce context pollution and improve agent reasoning. The agent's semantic memory currently dumps all recent entries into every context assembly, forcing the LLM to process verbose, low-level details when high-level summaries would suffice. The new system introduces a `tier` column on the `semantic_memory` table and a 4-stage retrieval pipeline that prioritizes summaries over details. Pinned entries (standing instructions, feedback) load first (L0), then summaries with stale-detail detection (L1), followed by graph-seeded relevant context (L2), and finally recent entries (L3). Each stage builds an exclusion set to prevent double-loading. When summaries exist, their children are demoted to `detail` tier and excluded from retrieval unless they become stale (modified after the parent summary).

The approach extends the existing graph-based memory system without replacing it. Summary entries link to children via new `summarizes` edges in the existing `memory_edges` table. Budget pressure degradation becomes tier-aware: L3 sheds first, then L2 reduces to 5 entries, while L0+L1 are never shed. The migration is backward-compatible — zero summaries produces identical output to the current system, and prefix-based pinned detection remains as a fallback. Out of scope: the heartbeat consolidation logic that will actually create summaries (future work).

## Definition of Done

The infrastructure layer for hierarchical memory retrieval is complete when:

1. **Schema**: `semantic_memory` has a `tier` column (`pinned`/`summary`/`default`/`detail`) with a partial index, and an idempotent migration backfills existing prefix-keyed entries as `pinned`.

2. **Retrieval pipeline**: `buildVolatileEnrichment()` implements a 4-stage exclusion cascade (L0 Pinned → L1 Summary → L2 Graph-seeded → L3 Recency) with stale-child detection/annotation at L1 and orphaned-detail fallback to `default`.

3. **Commands**: `memory store` accepts `--tier`, `memory forget` promotes summary children, `memory connect`/`disconnect` handle `summarizes` edges with automatic tier transitions (R-HM4, R-HM5).

4. **Budget pressure**: Tier-aware degradation replaces the current uniform `maxMemory=3` — sheds L3 first, reduces L2, preserves L1+L0.

5. **Sync**: `tier` column changes propagate via the existing changelog outbox. `summarizes` edges sync via existing `memory_edges` mechanism.

6. **Backward compatibility**: Zero summaries produces identical output to the current system. Prefix-based pinned detection retained as fallback alongside the `tier` column.

**Out of scope:** Heartbeat consolidation logic (summary creation, cluster detection, stale regeneration), embedding-based retrieval, cross-host memory partitioning, index/content separation, temporal validity windows.

**RFC:** `docs/design/specs/2026-04-10-hierarchical-memory.md`

## Acceptance Criteria

### hierarchical-memory.AC1: memory store tier support
- **AC1.1 Success:** `memory store key value --tier summary` creates entry with `tier = 'summary'`
- **AC1.2 Success:** `memory store key value` without `--tier` creates entry with `tier = 'default'`
- **AC1.3 Success:** `memory store _standing:x value` sets `tier = 'pinned'` regardless of `--tier` param
- **AC1.4 Success:** `memory store _feedback:x value --tier default` overrides to `tier = 'pinned'` (prefix wins)
- **AC1.5 Success:** Updating an existing `detail` entry without `--tier` preserves `detail` tier
- **AC1.6 Success:** Updating an existing `detail` entry with `--tier default` overrides to `default`

### hierarchical-memory.AC2: memory forget/connect/disconnect tier transitions
- **AC2.1 Success:** `memory forget` on a summary entry promotes all children from `detail` to `default`
- **AC2.2 Success:** `memory forget` on a summary tombstones all outgoing `summarizes` edges
- **AC2.3 Success:** `memory connect A B --relation summarizes` sets B's tier to `detail` when B is `default`
- **AC2.4 Success:** `memory connect A B --relation summarizes` preserves B's tier when B is `pinned`
- **AC2.5 Success:** `memory connect A B --relation summarizes` preserves B's tier when B is `summary`
- **AC2.6 Success:** `memory disconnect` of a `summarizes` edge promotes target to `default` when no remaining parents
- **AC2.7 Success:** `memory disconnect` of a `summarizes` edge preserves `detail` when other parents remain
- **AC2.8 Edge:** Non-`summarizes` edges trigger no tier changes on connect or disconnect

### hierarchical-memory.AC3: Stage function isolation
- **AC3.1 Success:** L0 loads entries by both `tier = 'pinned'` and prefix match (`_standing%`, etc.)
- **AC3.2 Success:** L1 loads summary entries not in E₀ and adds ALL children keys to exclusion set
- **AC3.3 Success:** L1 detects stale children (child.modified_at > summary.modified_at) and loads them with `[stale-detail]` tag
- **AC3.4 Success:** L1 loads ALL stale children, not just the first
- **AC3.5 Success:** L2 excludes keys in E₁ and entries with tier `detail`, `pinned`, `summary`
- **AC3.6 Success:** L2 treats orphaned detail entries (no incoming `summarizes` edge) as `default`
- **AC3.7 Success:** L3 excludes keys in E₂ and applies same tier filter as L2

### hierarchical-memory.AC4: Pipeline integration
- **AC4.1 Success:** Zero summaries produces identical output to current system
- **AC4.2 Success:** Summaries with clean children: children excluded from L2/L3
- **AC4.3 Success:** Summaries with stale children: annotated summary + stale children loaded at L1
- **AC4.4 Success:** Exclusion cascade prevents same entry appearing in multiple stages
- **AC4.5 Success:** `maxMemory` applies to L2+L3 combined, L0+L1 uncapped
- **AC4.6 Success:** Entries appear in L0→L1→L2→L3 order in output

### hierarchical-memory.AC5: Budget shedding
- **AC5.1 Success:** Under budget pressure, L3 entries shed entirely
- **AC5.2 Success:** If still constrained after L3, L2 reduced to at most 5 entries
- **AC5.3 Success:** L1 and L0 are never shed regardless of pressure
- **AC5.4 Edge:** L0+L1 exceeding budget logs warning but does not truncate
- **AC5.5 Success:** Shedding operates on structured tier data (no second DB call)

### hierarchical-memory.AC6: Backward compatibility & migration
- **AC6.1 Success:** Idempotent ALTER TABLE succeeds on fresh and existing databases
- **AC6.2 Success:** Prefix-keyed entries backfilled to `pinned` after migration
- **AC6.3 Success:** Non-prefix entries remain `default` after migration
- **AC6.4 Success:** Running migration twice produces same result
- **AC6.5 Success:** `tier` column changes propagate via changelog outbox
- **AC6.6 Success:** `summarizes` edges sync via existing `memory_edges` mechanism

## Glossary

- **Tier**: Classification level for semantic memory entries (`pinned`, `summary`, `default`, `detail`) that determines retrieval priority and budget shedding order.
- **Exclusion set**: Set of memory keys loaded by earlier pipeline stages, used to prevent later stages from double-loading the same content.
- **Stale child**: A detail entry whose `modified_at` timestamp is newer than its parent summary, indicating the summary is outdated and the detail should be resurfaced.
- **Orphaned detail**: A detail entry with no incoming `summarizes` edges, treated as `default` tier during retrieval as a recovery mechanism.
- **Graph-seeded retrieval**: Existing keyword-based retrieval that finds seed memories via text matching, then traverses the memory graph via edges to find related entries.
- **L0/L1/L2/L3**: The four retrieval stages (Pinned, Summary, Graph-seeded, Recency) in the hierarchical memory pipeline, executed in order.
- **Budget pressure**: State when context assembly headroom < 2,000 tokens, triggering tier-aware memory shedding to fit within the model's context window.
- **Volatile enrichment**: Dynamic per-turn context injected during Stage 5.5 of context assembly (memories, tasks, skill index, advisories), rebuilt each turn.
- **Change-log outbox**: Sync pattern requiring all writes to synced tables to use `insertRow()`/`updateRow()`/`softDelete()` wrappers that atomically write both the row and a changelog entry.
- **LWW (Last-Write-Wins)**: Conflict resolution strategy for synced tables that uses `modified_at` timestamps to determine which version wins during merge.
- **Prompt caching**: Anthropic and Bedrock feature that caches message prefixes to reduce token costs; L0+L1 stability improves cache hit rates.
- **`summarizes` edge**: New relation type in the `memory_edges` table linking summary entries to their children, with automatic tier transition (child → `detail`).
- **Idempotent migration**: Database migration that can safely run multiple times without side effects, using `ALTER TABLE` with `try/catch` and conditional UPDATE.
- **Prefix-based pinned detection**: Backward-compatible fallback that identifies pinned entries via key prefixes (`_standing%`, `_feedback%`, `_policy%`, `_pinned%`).
- **Partial index**: SQLite index with a WHERE clause (`WHERE deleted = 0`) that only indexes rows matching the condition, reducing index size.

## Architecture

Semantic memory entries are classified into four tiers — `pinned`, `summary`, `default`, `detail` — stored in a new `tier` column on the `semantic_memory` table. A 4-stage retrieval pipeline in `buildVolatileEnrichment()` loads entries in tier priority order, with each stage building an exclusion set that prevents subsequent stages from double-loading content. Summary entries link to children via `summarizes` edges in `memory_edges`; children are demoted to `detail` tier and excluded from default retrieval, resurfacing only when stale or explicitly queried.

### Retrieval Pipeline

The pipeline is structured as four standalone stage functions chained by an orchestrator. Each stage returns a `StageResult` containing loaded entries and an accumulated exclusion set of keys.

```typescript
type MemoryTier = "pinned" | "summary" | "default" | "detail";

interface StageResult {
	entries: EnrichedEntry[];
	exclusionSet: Set<string>;
}

interface TieredEnrichment {
	L0: EnrichedEntry[];
	L1: EnrichedEntry[];
	L2: EnrichedEntry[];
	L3: EnrichedEntry[];
}

interface VolatileEnrichment {
	memoryDeltaLines: string[];
	taskDigestLines: string[];
	tiers: TieredEnrichment;
	graphCount?: number;
	recencyCount?: number;
}
```

**L0 Pinned** (`loadPinnedEntries`) — loads all entries where `tier = 'pinned'` OR key matches a pinned prefix (`_standing%`, `_feedback%`, `_policy%`, `_pinned%`). Dual detection for backward compatibility. Unconditional, no budget cap. Returns exclusion set E₀.

**L1 Summary** (`loadSummaryEntries`) — loads all entries where `tier = 'summary'` and key not in E₀. For each summary, queries outgoing `summarizes` edges to identify children. All children keys (stale or not) are added to the exclusion set. Stale children (modified after parent summary) are loaded alongside the summary with `[stale-detail]` annotation. Returns E₁ = E₀ ∪ {summary keys} ∪ {all children keys}.

**L2 Graph-seeded** (`loadGraphEntries`) — calls existing `graphSeededRetrieval()` with additional exclusion/tier filters: `key NOT IN E₁ AND tier NOT IN ('detail', 'pinned', 'summary')`. Orphaned detail entries (no incoming `summarizes` edge) are treated as `default` via a NOT EXISTS subquery. Capped at `maxMemory` slots. Returns E₂.

**L3 Recency** (`loadRecencyEntries`) — existing recency fallback with the same exclusion/tier filters. Fills remaining slots from `maxMemory - L2.entries.length`. Returns final exclusion set.

The orchestrator (`buildVolatileEnrichment`) chains stages, concatenates results in L0→L1→L2→L3 order, and returns both the formatted `memoryDeltaLines` and the structured `tiers` field for budget shedding.

`maxMemory` governs L2+L3 combined. L0 and L1 are uncapped.

### Budget Shedding

Context-assembly Stage 7 (BUDGET_VALIDATION) operates on the structured `tiers` field from the enrichment result, eliminating the current second-call pattern:

```typescript
function shedMemoryTiers(tiers: TieredEnrichment, headerTemplate: string): string[];
```

Degradation sequence when headroom < 2,000 tokens:
1. Shed L3 entirely
2. Reduce L2 to at most 5 entries (preserving graph proximity ordering)
3. L1 and L0 are never shed
4. If L0+L1 alone exceed budget, log warning but do not truncate

The splice logic in context-assembly (enrichmentStartIdx/enrichmentEndIdx into allVolatileLines) remains — the shedded lines are swapped into the same position.

### Schema Changes

**`semantic_memory` table — new column:**
```sql
ALTER TABLE semantic_memory ADD COLUMN tier TEXT DEFAULT 'default';
CREATE INDEX idx_memory_tier ON semantic_memory(tier) WHERE deleted = 0;
```

Valid values enforced at application layer: `pinned`, `summary`, `default`, `detail`.

**Migration backfill** (idempotent, runs after ALTER TABLE):
```sql
UPDATE semantic_memory SET tier = 'pinned'
WHERE (key LIKE '\_standing%' OR key LIKE '\_feedback%'
    OR key LIKE '\_policy%' OR key LIKE '\_pinned%') ESCAPE '\'
  AND tier = 'default' AND deleted = 0;
```

**`memory_edges`** — no schema change. New `summarizes` relation type by convention.

### Command Tier Logic

**`memory store`** — accepts optional `--tier` parameter. Pinned prefix keys override to `pinned` regardless. Updating an existing `detail` entry preserves `detail` unless `--tier` explicitly overrides.

**`memory forget`** — when forgetting a summary entry: queries outgoing `summarizes` edges, promotes each child to `default` via `updateRow()`, tombstones the edges, then tombstones the summary.

**`memory connect`** — when `relation === 'summarizes'`: reads target's current tier, sets to `detail` if currently `default`. Pinned and summary targets are not demoted.

**`memory disconnect`** — when removing a `summarizes` edge: checks if target has remaining incoming `summarizes` edges. If none, promotes target to `default`.

### graphSeededRetrieval Contract Change

`graphSeededRetrieval()` in `packages/agent/src/graph-queries.ts` gains an optional `excludeKeys` parameter. The seed query and traversal JOIN both add exclusion/tier filters. The orphan fallback subquery ensures `detail` entries with no parent summary are retrievable:

```typescript
function graphSeededRetrieval(
	db: Database,
	keywords: string[],
	maxResults: number,
	depth?: number,
	excludeKeys?: Set<string>,
): GraphRetrievalResult[];
```

### Sync

The `tier` column is included in `insertRow()`/`updateRow()` calls on `semantic_memory` — changelog entries are generated automatically. Tier changes sync via LWW by `modified_at` recency. The `summarizes` relation syncs via the existing `memory_edges` changelog mechanism. No new sync protocol.

## Existing Patterns

Investigation found these established patterns that this design follows:

**Idempotent ALTER TABLE migration** — `packages/core/src/schema.ts` uses `try { db.run("ALTER TABLE ...") } catch { /* already exists */ }` for column additions (stream_id, platforms, origin_thread_id, exit_code, etc.). The `tier` column follows this pattern.

**Prefix-based pinned detection** — `packages/agent/src/summary-extraction.ts` lines 427-453 use `LIKE` queries with `ESCAPE '\'` for `_standing%`, `_feedback%`, `_policy%`, `_pinned%`. L0 retains this as backward-compatible fallback alongside the tier column.

**Stage function composition** — the existing `buildVolatileEnrichment()` already separates graph-seeded and recency paths into distinct code sections. This design formalizes the separation into standalone functions with explicit exclusion set threading.

**`cascadeDeleteEdges()`** in `packages/agent/src/graph-queries.ts` lines 106-116 already handles edge cleanup on memory deletion. The new summary-child promotion in `memory forget` extends this pattern.

**Change-log outbox for all synced writes** — all tier transitions use `updateRow()` from `@bound/core`, consistent with the project invariant that synced table writes go through the outbox.

**No divergence from existing patterns.** The `MemoryTier` type is new but follows the project's convention of string literal unions in `@bound/shared`.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema & Types
**Goal:** Add `tier` column to `semantic_memory` and define shared types

**Components:**
- `MemoryTier` type in `packages/shared/src/types.ts`
- Idempotent ALTER TABLE + index in `packages/core/src/schema.ts`
- Idempotent prefix-based backfill migration in `packages/core/src/schema.ts`

**Dependencies:** None

**Done when:** Schema migration runs idempotently on fresh and existing databases, `MemoryTier` type is importable from `@bound/shared`, existing prefix-keyed entries have `tier = 'pinned'` after migration
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Command Tier Support
**Goal:** Wire tier awareness into the `memory` command subcommands

**Components:**
- `handleStore()` in `packages/agent/src/commands/memory.ts` — `--tier` arg, pinned prefix override, detail preservation on update
- `handleForget()` in `packages/agent/src/commands/memory.ts` — summary child promotion before tombstoning
- `handleConnect()` in `packages/agent/src/commands/memory.ts` — `summarizes` edge tier transition (target → detail)
- `handleDisconnect()` in `packages/agent/src/commands/memory.ts` — orphan promotion (target → default when no remaining summarizes parents)

**Dependencies:** Phase 1 (tier column exists)

**Done when:** Tests verify: store with `--tier`, pinned prefix override, detail preservation, summary forget promotes children, connect summarizes demotes to detail, disconnect promotes orphans, pinned targets are never demoted

Covers: `hierarchical-memory.AC1.*`, `hierarchical-memory.AC2.*`
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Stage Functions
**Goal:** Implement the four retrieval stage functions as standalone, testable units

**Components:**
- `loadPinnedEntries()` in `packages/agent/src/summary-extraction.ts` — L0 with dual prefix+tier detection
- `loadSummaryEntries()` in `packages/agent/src/summary-extraction.ts` — L1 with stale-child detection and annotation
- `loadGraphEntries()` in `packages/agent/src/summary-extraction.ts` — L2 wrapper around `graphSeededRetrieval()` with exclusion/tier filters
- `loadRecencyEntries()` in `packages/agent/src/summary-extraction.ts` — L3 with exclusion/tier filters and keyword boost
- `graphSeededRetrieval()` in `packages/agent/src/graph-queries.ts` — new `excludeKeys` parameter, orphan detail subquery

**Dependencies:** Phase 1 (tier column), Phase 2 (summarizes edges can exist)

**Done when:** Each stage function works in isolation with controlled DB state. Tests verify: exclusion set propagation, tier filtering, stale child detection/annotation, orphaned detail fallback, L2 exclusion of detail/pinned/summary tiers

Covers: `hierarchical-memory.AC3.*`
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Pipeline Orchestrator
**Goal:** Rewrite `buildVolatileEnrichment()` to chain the four stage functions and return structured tier data

**Components:**
- Orchestrator in `packages/agent/src/summary-extraction.ts` — chains L0→L1→L2→L3, computes slot allocation, returns `VolatileEnrichment` with `tiers` field
- `maxMemory` semantics change — governs L2+L3 combined, L0+L1 uncapped

**Dependencies:** Phase 3 (stage functions exist)

**Done when:** Full pipeline integration tests pass: zero-summary backward compatibility (identical output to current system), summaries with clean children, summaries with stale children, orphaned details, mixed tiers, exclusion cascade prevents double-loading

Covers: `hierarchical-memory.AC4.*`
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Budget Shedding
**Goal:** Replace uniform `maxMemory=3` budget pressure with tier-aware degradation

**Components:**
- `shedMemoryTiers()` helper in `packages/agent/src/summary-extraction.ts` or `packages/agent/src/context-assembly.ts`
- Stage 7 (BUDGET_VALIDATION) in `packages/agent/src/context-assembly.ts` — uses `tiers` field from enrichment result instead of re-calling `buildVolatileEnrichment()`

**Dependencies:** Phase 4 (structured tiers in enrichment result)

**Done when:** Tests verify: L3 shed first, L2 reduced to 5, L1+L0 preserved, warning logged when L0+L1 exceed budget, splice logic works with shedded content

Covers: `hierarchical-memory.AC5.*`
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Backward Compatibility & Edge Cases
**Goal:** Verify zero-regression behavior and handle edge cases

**Components:**
- Backward compatibility assertion: zero-summary pipeline produces identical `memoryDeltaLines` to current system
- Orphaned detail entries (R-HM10): detail with no incoming summarizes edge treated as default
- Double-load prevention (R-HM16): exclusion cascade tested across all four stages
- Detail preservation on update (R-HM19): store on detail entry preserves tier

**Dependencies:** Phase 5 (full system operational)

**Done when:** Compatibility tests pass against current production DB snapshot. All edge cases from RFC §3 verified. Migration test confirms idempotent backfill on existing data.

Covers: `hierarchical-memory.AC6.*`
<!-- END_PHASE_6 -->

## Additional Considerations

**Orphan recovery.** If summary deletion is interrupted between tombstoning the summary and promoting all children, some children may remain as `detail` with no parent. The orphan fallback (R-HM10) in L2/L3 queries handles this at retrieval time via a NOT EXISTS subquery. The heartbeat (future work) can detect and clean up orphans during consolidation.

**Summary count growth.** L1 loads all summaries unconditionally. If the heartbeat creates too many summaries, L1 could crowd out L2/L3 slots under budget pressure. This is a deployment concern — the heartbeat should manage summary count as part of its consolidation strategy. The budget shedding warning (logged when L0+L1 exceed budget) provides an early signal.

**Prompt cache stability.** L0 and L1 entries are stable across turns (same pinned entries, same summaries unless modified), which improves prompt cache hit rates for Anthropic and Bedrock drivers. The volatile portion (L2+L3) changes per turn based on conversation keywords.
