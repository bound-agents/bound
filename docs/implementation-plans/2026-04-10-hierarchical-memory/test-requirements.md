# Hierarchical Memory Retrieval -- Test Requirements

Maps each acceptance criterion to automated tests and/or human verification steps.

---

## Summary

| AC | Automated | Human | Notes |
|----|-----------|-------|-------|
| AC1.1 | Unit | -- | Store with `--tier summary` |
| AC1.2 | Unit | -- | Store without `--tier` defaults to `default` |
| AC1.3 | Unit | -- | Pinned prefix override (no flag) |
| AC1.4 | Unit | -- | Pinned prefix override (flag overridden) |
| AC1.5 | Unit | -- | Detail preservation on update without `--tier` |
| AC1.6 | Unit | -- | Detail override on update with `--tier` |
| AC2.1 | Unit | -- | Summary forget promotes children |
| AC2.2 | Unit | -- | Summary forget tombstones summarizes edges |
| AC2.3 | Unit | -- | Summarizes connect demotes default to detail |
| AC2.4 | Unit | -- | Summarizes connect preserves pinned |
| AC2.5 | Unit | -- | Summarizes connect preserves summary |
| AC2.6 | Unit | -- | Disconnect promotes orphan to default |
| AC2.7 | Unit | -- | Disconnect preserves detail with remaining parents |
| AC2.8 | Unit | -- | Non-summarizes edges trigger no tier change |
| AC3.1 | Unit | -- | L0 dual detection (tier + prefix) |
| AC3.2 | Unit | -- | L1 loads summaries, excludes all children |
| AC3.3 | Unit | -- | L1 stale-child detection and tagging |
| AC3.4 | Unit | -- | L1 loads all stale children |
| AC3.5 | Unit | -- | L2 tier filtering and exclusion |
| AC3.6 | Unit + Integration | -- | Orphaned detail fallback to default |
| AC3.7 | Unit | -- | L3 tier filtering and exclusion |
| AC4.1 | Integration | -- | Zero summaries backward compatibility |
| AC4.2 | Integration | -- | Clean children excluded from L2/L3 |
| AC4.3 | Integration | -- | Stale children annotated at L1 |
| AC4.4 | Integration | -- | Exclusion cascade prevents double-load |
| AC4.5 | Integration | -- | maxMemory governs L2+L3 only |
| AC4.6 | Integration | -- | Output ordering L0 -> L1 -> L2 -> L3 |
| AC5.1 | Unit + Integration | -- | L3 shed under budget pressure |
| AC5.2 | Unit + Integration | -- | L2 reduced to 5 under pressure |
| AC5.3 | Unit + Integration | -- | L0+L1 never shed |
| AC5.4 | Unit + Integration | -- | Warning logged when L0+L1 exceed budget |
| AC5.5 | Unit | -- | No DB parameter on shedMemoryTiers |
| AC6.1 | Unit | -- | Idempotent ALTER TABLE on fresh and existing DBs |
| AC6.2 | Unit | -- | Prefix entries backfilled to pinned |
| AC6.3 | Unit | -- | Non-prefix entries remain default |
| AC6.4 | Unit | -- | Migration idempotent on repeated runs |
| AC6.5 | Integration | -- | Tier changes in changelog outbox |
| AC6.6 | Integration | -- | Summarizes edges in changelog outbox |

---

## AC1: memory store tier support

### AC1.1 -- `memory store key value --tier summary` creates entry with `tier = 'summary'`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Invoke `handleStore()` with args `{ key: "test-key", value: "test-value", tier: "summary" }`. Query `semantic_memory` and assert `tier = 'summary'`.
- Phase/Task: Phase 2, Task 1

---

### AC1.2 -- `memory store key value` without `--tier` creates entry with `tier = 'default'`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Invoke `handleStore()` with args `{ key: "test-key", value: "test-value" }` (no tier). Query `semantic_memory` and assert `tier = 'default'`.
- Phase/Task: Phase 2, Task 1

---

### AC1.3 -- `memory store _standing:x value` sets `tier = 'pinned'` regardless of `--tier` param

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Invoke `handleStore()` with args `{ key: "_standing:test", value: "instruction" }` (no `--tier`). Query `semantic_memory` and assert `tier = 'pinned'`.
- Phase/Task: Phase 2, Task 1

---

### AC1.4 -- `memory store _feedback:x value --tier default` overrides to `tier = 'pinned'` (prefix wins)

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Invoke `handleStore()` with args `{ key: "_feedback:review", value: "feedback", tier: "default" }`. Query `semantic_memory` and assert `tier = 'pinned'` despite the explicit `--tier default`.
- Phase/Task: Phase 2, Task 1

---

### AC1.5 -- Updating an existing `detail` entry without `--tier` preserves `detail` tier

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Insert a memory entry with `tier = 'detail'` via `insertRow()`. Invoke `handleStore()` with the same key and a new value, without `--tier`. Query `semantic_memory` and assert `tier = 'detail'`.
- Phase/Task: Phase 2, Task 1. Also verified in Phase 6 (Task 2) as a cross-phase integration check.

---

### AC1.6 -- Updating an existing `detail` entry with `--tier default` overrides to `default`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-store.test.ts`
- Test: Insert a memory entry with `tier = 'detail'` via `insertRow()`. Invoke `handleStore()` with the same key, new value, and `tier: "default"`. Query `semantic_memory` and assert `tier = 'default'`.
- Phase/Task: Phase 2, Task 1

---

## AC2: memory forget/connect/disconnect tier transitions

### AC2.1 -- `memory forget` on a summary entry promotes all children from `detail` to `default`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-forget.test.ts`
- Test: Create summary entry S (`tier = 'summary'`). Create children C1, C2 (`tier = 'detail'`). Create `summarizes` edges S->C1, S->C2. Invoke `handleForget()` on S. Query C1 and C2 and assert both have `tier = 'default'`.
- Phase/Task: Phase 2, Task 2

---

### AC2.2 -- `memory forget` on a summary entry tombstones all outgoing `summarizes` edges

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-forget.test.ts`
- Test: Create summary S with `summarizes` edges S->C1, S->C2. Invoke `handleForget()` on S. Query `memory_edges WHERE source_key = S AND relation = 'summarizes'` and assert all have `deleted = 1`.
- Phase/Task: Phase 2, Task 2

---

### AC2.3 -- `memory connect A B --relation summarizes` sets B's tier to `detail` when B is `default`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-connect.test.ts`
- Test: Create entries A (`tier = 'summary'`) and B (`tier = 'default'`). Invoke `handleConnect()` with `relation: "summarizes"`. Query B and assert `tier = 'detail'`.
- Phase/Task: Phase 2, Task 3

---

### AC2.4 -- `memory connect A B --relation summarizes` preserves B's tier when B is `pinned`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-connect.test.ts`
- Test: Create entries A (`tier = 'summary'`) and B (`tier = 'pinned'`). Invoke `handleConnect()` with `relation: "summarizes"`. Query B and assert `tier = 'pinned'` (unchanged).
- Phase/Task: Phase 2, Task 3

---

### AC2.5 -- `memory connect A B --relation summarizes` preserves B's tier when B is `summary`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-connect.test.ts`
- Test: Create entries A (`tier = 'summary'`) and B (`tier = 'summary'`). Invoke `handleConnect()` with `relation: "summarizes"`. Query B and assert `tier = 'summary'` (unchanged).
- Phase/Task: Phase 2, Task 3

---

### AC2.6 -- `memory disconnect` of a `summarizes` edge promotes target to `default` when no remaining parents

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-disconnect.test.ts`
- Test: Create entries A and B (`tier = 'detail'`). Create single `summarizes` edge A->B. Invoke `handleDisconnect()`. Query B and assert `tier = 'default'`.
- Phase/Task: Phase 2, Task 4

---

### AC2.7 -- `memory disconnect` of a `summarizes` edge preserves `detail` when other parents remain

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-disconnect.test.ts`
- Test: Create entries A, C, and B (`tier = 'detail'`). Create `summarizes` edges A->B and C->B. Invoke `handleDisconnect()` for A->B only. Query B and assert `tier = 'detail'` (C->B still exists).
- Phase/Task: Phase 2, Task 4

---

### AC2.8 -- Non-`summarizes` edges trigger no tier changes on connect or disconnect

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-tier-connect.test.ts`
- Test: Create entries A (`tier = 'default'`) and B (`tier = 'default'`). Invoke `handleConnect()` with `relation: "related_to"`. Query B and assert `tier = 'default'` (unchanged). Then invoke `handleDisconnect()`. Query B and assert `tier = 'default'` (still unchanged).
- Phase/Task: Phase 2, Task 3 (connect portion) and Task 4 (disconnect portion)

---

## AC3: Stage function isolation

### AC3.1 -- L0 loads entries by both `tier = 'pinned'` and prefix match (`_standing%`, etc.)

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Insert entry A with `tier = 'pinned'` and non-prefix key. Insert entry B with prefix key `_standing:x` and `tier = 'default'` (simulating pre-migration state). Call `loadPinnedEntries(db)`. Assert both A and B are returned. Assert deduplication: an entry matching both criteria (prefix key + `tier = 'pinned'`) appears exactly once.
- Phase/Task: Phase 3, Task 1

---

### AC3.2 -- L1 loads summary entries not in E0 and adds ALL children keys to exclusion set

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Create summary S and children C1, C2 with `summarizes` edges. Create exclusion set E0 (empty). Call `loadSummaryEntries(db, E0)`. Assert S is in returned entries. Assert returned `exclusionSet` contains S, C1, C2.
- Phase/Task: Phase 3, Task 2

---

### AC3.3 -- L1 detects stale children (child.modified_at > summary.modified_at) and loads them with `[stale-detail]` tag

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Create summary S with `modified_at = '2026-01-01T00:00:00Z'`. Create child C1 with `modified_at = '2026-01-02T00:00:00Z'` (newer than S). Create `summarizes` edge S->C1. Call `loadSummaryEntries(db, new Set())`. Assert C1 appears in entries with `tag === '[stale-detail]'`.
- Phase/Task: Phase 3, Task 2

---

### AC3.4 -- L1 loads ALL stale children, not just the first

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Create summary S with `modified_at = '2026-01-01T00:00:00Z'`. Create children C1 and C2, both with `modified_at` newer than S. Create `summarizes` edges S->C1, S->C2. Call `loadSummaryEntries(db, new Set())`. Assert both C1 and C2 appear in entries with `tag === '[stale-detail]'`.
- Phase/Task: Phase 3, Task 2

---

### AC3.5 -- L2 excludes keys in E1 and entries with tier `detail`, `pinned`, `summary`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Insert entries with tiers: `default` (D1, D2), `detail` (X1), `pinned` (X2), `summary` (X3). Create graph edges between D1 and D2 with a `related_to` relation. Call `loadGraphEntries(db, excludeKeys, keywords, maxSlots)` where `excludeKeys` contains X2's key. Assert only `default`-tier entries appear. Assert entries in `excludeKeys` are absent. Assert X1 (detail with a parent) is absent.
- Phase/Task: Phase 3, Task 3

---

### AC3.6 -- L2 treats orphaned detail entries (no incoming `summarizes` edge) as `default`

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test (isolation): Create entry O with `tier = 'detail'` and NO incoming `summarizes` edge. Create entry N with `tier = 'detail'` and an active `summarizes` edge. Call `loadGraphEntries()` with keywords matching both O and N. Assert O appears in results (orphan treated as default). Assert N is absent (has parent, excluded).
- Phase/Task: Phase 3, Task 3

**Automated: Integration test**
- File: `packages/agent/src/__tests__/hierarchical-memory-compat.test.ts`
- Test (pipeline): Create orphaned detail entry. Call `buildVolatileEnrichment()` with matching keywords. Assert the orphaned detail appears in L2 or L3 output. Assert a non-orphaned detail does not appear.
- Phase/Task: Phase 6, Task 2

---

### AC3.7 -- L3 excludes keys in E2 and applies same tier filter as L2

**Automated: Unit test**
- File: `packages/agent/src/__tests__/stage-functions.test.ts`
- Test: Insert entries with mixed tiers. Construct E2 from prior stage outputs. Call `loadRecencyEntries(db, E2, baseline, maxSlots)`. Assert only `default`-tier entries (plus orphaned details) appear. Assert no entries from E2 appear. Assert results are ordered by `modified_at DESC`. Assert `maxSlots` is respected.
- Phase/Task: Phase 3, Task 4

---

## AC4: Pipeline integration

### AC4.1 -- Zero summaries produces identical output to current system

**Automated: Integration test**
- File: `packages/agent/src/__tests__/hierarchical-memory-compat.test.ts`
- Test: Set up DB with `default`-tier entries, pinned entries (both via tier column and prefix keys), graph edges (non-`summarizes` relations). NO summary-tier entries. Call `buildVolatileEnrichment()`. Assert: pinned entries appear first with `[pinned]` tag, graph-seeded entries appear next, recency entries fill remaining slots, `tiers.L1` is empty, total L2+L3 respects `maxMemory`.
- Phase/Task: Phase 4, Task 2 (implementation) and Phase 6, Task 1 (dedicated backward compat test)

---

### AC4.2 -- Summaries with clean children: children excluded from L2/L3

**Automated: Integration test**
- File: `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
- Test: Create summary S with children C1, C2 (clean: `modified_at <= S.modified_at`). Create additional `default` entries D1, D2. Call `buildVolatileEnrichment()`. Assert C1, C2 do NOT appear in L2 or L3 tiers. Assert D1, D2 appear in L2 or L3.
- Phase/Task: Phase 4, Task 2

---

### AC4.3 -- Summaries with stale children: annotated summary + stale children loaded at L1

**Automated: Integration test**
- File: `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
- Test: Create summary S with child C1 (stale: `C1.modified_at > S.modified_at`). Call `buildVolatileEnrichment()`. Assert S appears in `tiers.L1` with `[summary]` tag. Assert C1 appears in `tiers.L1` with `[stale-detail]` tag. Assert C1 does NOT appear in `tiers.L2` or `tiers.L3`.
- Phase/Task: Phase 4, Task 2

---

### AC4.4 -- Exclusion cascade prevents same entry appearing in multiple stages

**Automated: Integration test**
- File: `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
- Test: Create a pinned entry P that also has graph edges from other entries. Call `buildVolatileEnrichment()`. Collect all keys across `tiers.L0`, `tiers.L1`, `tiers.L2`, `tiers.L3`. Assert no duplicate keys exist across tiers.
- Phase/Task: Phase 4, Task 2. Also verified in Phase 6, Task 2.

---

### AC4.5 -- `maxMemory` applies to L2+L3 combined, L0+L1 uncapped

**Automated: Integration test**
- File: `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
- Test: Set `maxMemory = 3`. Insert 2 pinned entries (L0), 1 summary (L1), 5 default entries. Call `buildVolatileEnrichment()`. Assert `tiers.L0.length === 2` and `tiers.L1.length >= 1` (uncapped). Assert `tiers.L2.length + tiers.L3.length <= 3` (capped by maxMemory).
- Phase/Task: Phase 4, Task 2

---

### AC4.6 -- Entries appear in L0 -> L1 -> L2 -> L3 order in output

**Automated: Integration test**
- File: `packages/agent/src/__tests__/pipeline-orchestrator.test.ts`
- Test: Create entries that populate all four tiers. Call `buildVolatileEnrichment()`. Iterate `memoryDeltaLines` and verify: all `[pinned]` tagged lines appear before `[summary]`/`[stale-detail]` lines, which appear before `[seed]`/`[depth ...]` lines, which appear before `[recency]` lines.
- Phase/Task: Phase 4, Task 2

---

## AC5: Budget shedding

### AC5.1 -- Under budget pressure, L3 entries shed entirely

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-shedding.test.ts`
- Test: Construct `TieredEnrichment` with L0(2 entries), L1(1 entry), L2(5 entries), L3(10 entries). Call `shedMemoryTiers()`. Assert output lines contain no entries from L3 (no `[recency]` tagged lines).
- Phase/Task: Phase 5, Task 1

**Automated: Integration test**
- File: `packages/agent/src/__tests__/context-assembly.test.ts`
- Test: Populate DB with entries across all tiers. Call `assembleContext()` with `contextWindow` small enough to trigger budget pressure. Assert `result.debug.budgetPressure === true`. Assert assembled context contains no L3 entries.
- Phase/Task: Phase 5, Task 3

---

### AC5.2 -- If still constrained after L3, L2 reduced to at most 5 entries

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-shedding.test.ts`
- Test: Construct `TieredEnrichment` with L2(8 entries). Call `shedMemoryTiers()`. Assert output contains at most 5 L2-tagged lines.
- Phase/Task: Phase 5, Task 1

**Automated: Integration test**
- File: `packages/agent/src/__tests__/context-assembly.test.ts`
- Test: Populate DB with many graph-connected default entries (L2 > 5). Trigger budget pressure via small `contextWindow`. Assert at most 5 graph-seeded entries in assembled context.
- Phase/Task: Phase 5, Task 3

---

### AC5.3 -- L1 and L0 are never shed regardless of pressure

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-shedding.test.ts`
- Test: Construct `TieredEnrichment` with L0(5 entries), L1(3 entries). Call `shedMemoryTiers()`. Assert all 8 entries present in output.
- Phase/Task: Phase 5, Task 1

**Automated: Integration test**
- File: `packages/agent/src/__tests__/context-assembly.test.ts`
- Test: Populate DB with pinned and summary entries. Trigger budget pressure. Assert all L0+L1 entries survive in assembled context.
- Phase/Task: Phase 5, Task 3

---

### AC5.4 -- L0+L1 exceeding budget logs warning but does not truncate

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-shedding.test.ts`
- Test: Construct `TieredEnrichment` with L0(15 entries), L1(10 entries). Provide a mock logger. Call `shedMemoryTiers()`. Assert all 25 entries present in output. Assert `logger.warn` was called with a message about exceeding budget.
- Phase/Task: Phase 5, Task 1

**Automated: Integration test**
- File: `packages/agent/src/__tests__/context-assembly.test.ts`
- Test: Populate DB with 15+ pinned and 10+ summary entries. Trigger budget pressure with small `contextWindow`. Assert warning is logged (mock logger). Assert all L0+L1 entries survive.
- Phase/Task: Phase 5, Task 3

---

### AC5.5 -- Shedding operates on structured tier data (no second DB call)

**Automated: Unit test**
- File: `packages/agent/src/__tests__/memory-shedding.test.ts`
- Test: Verify the `shedMemoryTiers()` function signature accepts `TieredEnrichment` and does not accept a `Database` parameter. This is a compile-time guarantee verified by the type signature, but the test confirms operational behavior: call `shedMemoryTiers()` with constructed tier data (no DB involved) and assert it produces valid output.
- Phase/Task: Phase 5, Task 1

---

## AC6: Backward compatibility & migration

### AC6.1 -- Idempotent ALTER TABLE succeeds on fresh and existing databases

**Automated: Unit test**
- File: `packages/core/src/__tests__/tier-migration.test.ts`
- Test (fresh): Create a new database, call `applySchema()`. Assert `semantic_memory` table has `tier` column (query `PRAGMA table_info(semantic_memory)` and check for `tier` column).
- Test (existing): Create a database, call `applySchema()` once. Call `applySchema()` again. Assert no error thrown and `tier` column still exists.
- Phase/Task: Phase 1, Task 3

---

### AC6.2 -- Prefix-keyed entries backfilled to `pinned` after migration

**Automated: Unit test**
- File: `packages/core/src/__tests__/tier-migration.test.ts`
- Test: Create database with schema (without tier column, simulating pre-migration). Insert rows with keys `_standing:x`, `_feedback:y`, `_policy:z`, `_pinned:w` (all with default tier). Run `applySchema()` to trigger migration. Query all four entries and assert `tier = 'pinned'`.
- Phase/Task: Phase 1, Task 3

---

### AC6.3 -- Non-prefix entries remain `default` after migration

**Automated: Unit test**
- File: `packages/core/src/__tests__/tier-migration.test.ts`
- Test: Insert rows with non-prefix keys (e.g., `project-notes`, `user-preference`). Run `applySchema()`. Query entries and assert `tier = 'default'`.
- Phase/Task: Phase 1, Task 3

---

### AC6.4 -- Running migration twice produces same result

**Automated: Unit test**
- File: `packages/core/src/__tests__/tier-migration.test.ts`
- Test: Insert mixed prefix and non-prefix entries. Call `applySchema()` twice. Query all entries and assert tiers match expected values (prefix entries are `pinned`, non-prefix are `default`). Assert no errors on second run. Also verify: an entry already set to `tier = 'summary'` is NOT overwritten to `pinned` by the backfill (the WHERE clause includes `tier = 'default'`). Also verify: soft-deleted prefix entries (`deleted = 1`) are NOT backfilled to `pinned`.
- Phase/Task: Phase 1, Task 3

---

### AC6.5 -- `tier` column changes propagate via changelog outbox

**Automated: Integration test**
- File: `packages/agent/src/__tests__/hierarchical-memory-sync.test.ts`
- Test: Create a `semantic_memory` entry via `insertRow()` with `tier = 'default'`. Query `change_log` and parse `row_data` JSON -- assert `"tier": "default"` is present. Update the entry's tier to `'pinned'` via `updateRow()`. Query the new `change_log` entry and parse `row_data` -- assert `"tier": "pinned"`.
- Phase/Task: Phase 6, Task 3

---

### AC6.6 -- `summarizes` edges sync via existing `memory_edges` mechanism

**Automated: Integration test**
- File: `packages/agent/src/__tests__/hierarchical-memory-sync.test.ts`
- Test: Create a `summarizes` edge via `upsertEdge()`. Query `change_log` for `memory_edges` table entry -- assert it contains `"relation": "summarizes"`. Soft-delete the edge via `removeEdges()`. Query the new `change_log` entry -- assert `"deleted": 1`.
- Phase/Task: Phase 6, Task 3
