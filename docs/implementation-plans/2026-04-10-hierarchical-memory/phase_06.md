# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Verify zero-regression behavior and handle edge cases. Ensure backward compatibility (zero summaries produces identical output), sync propagation of tier changes, and robustness of orphaned detail and exclusion cascade handling.

**Architecture:** This phase is primarily a testing and verification phase. It adds comprehensive integration tests that exercise the full pipeline with various edge case scenarios, verifies sync propagation of the new `tier` column and `summarizes` edges, and confirms backward compatibility by comparing output with and without summary entries.

**Tech Stack:** TypeScript 6.x, bun:sqlite, bun:test

**Scope:** 6 phases from original design (this is phase 6 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC6: Backward compatibility & migration (remaining items)
- **hierarchical-memory.AC6.5 Success:** `tier` column changes propagate via changelog outbox
- **hierarchical-memory.AC6.6 Success:** `summarizes` edges sync via existing `memory_edges` mechanism

### hierarchical-memory.AC4: Pipeline integration (backward compat subset)
- **hierarchical-memory.AC4.1 Success:** Zero summaries produces identical output to current system

### hierarchical-memory.AC3: Stage function isolation (edge case subset)
- **hierarchical-memory.AC3.6 Success:** L2 treats orphaned detail entries (no incoming `summarizes` edge) as `default`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Backward compatibility test — zero summaries produces identical output

**Verifies:** hierarchical-memory.AC4.1

**Files:**
- Create: `packages/agent/src/__tests__/hierarchical-memory-compat.test.ts`

**Implementation:**

This test captures a "golden" baseline by verifying that the refactored `buildVolatileEnrichment()` produces functionally equivalent output when no summary-tier entries exist. The memory landscape should be:

1. Several `default` tier entries with varied `modified_at` timestamps
2. Several pinned entries (both via `tier = 'pinned'` and via prefix keys like `_standing:x`)
3. Graph edges between default entries (non-`summarizes` relations like `related_to`)
4. NO summary-tier entries

Then call `buildVolatileEnrichment()` and verify:
- Pinned entries appear first with `[pinned]` tag
- Graph-seeded entries appear next (if keywords match) with `[seed]`/`[depth N, relation]` tags
- Recency entries fill remaining slots with `[recency]` tag
- The header line format matches: `Memory: N entries (M via graph, K via recency)`
- Value truncation at 200 chars works
- Source resolution (task name, thread title, fallback) still works
- The `tiers` field has empty L1 (no summaries)

**Testing:**

- **hierarchical-memory.AC4.1:** Set up DB with default+pinned entries and graph edges (no summaries). Call `buildVolatileEnrichment()`. Verify `memoryDeltaLines` matches expected format. Verify `tiers.L1` is empty. Verify `tiers.L0` contains all pinned entries. Verify total L2+L3 entries respect `maxMemory`.

Follow existing test patterns from `packages/agent/src/__tests__/volatile-enrichment.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/hierarchical-memory-compat.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add backward compatibility test for zero-summary pipeline (AC4.1)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Edge case tests — orphaned details, exclusion cascade, detail preservation

**Verifies:** hierarchical-memory.AC3.6

**Files:**
- Modify: `packages/agent/src/__tests__/hierarchical-memory-compat.test.ts` (add describe blocks)

**Implementation:**

Add test cases for the following edge cases:

**Orphaned detail recovery (AC3.6):**
- Create an entry with `tier = 'detail'` but NO incoming `summarizes` edge (orphan)
- Call `buildVolatileEnrichment()` with keywords matching the orphaned entry
- Verify the orphaned detail appears in L2 or L3 (treated as `default` for retrieval)
- Verify a non-orphaned detail (with active `summarizes` edge) does NOT appear in L2/L3

**Double-load prevention (exclusion cascade):**
- Create a pinned entry that also has graph edges from other entries
- Verify it appears only in L0, not also in L2 via graph traversal
- Create a summary with a child that's also graph-connected to seed entries
- Verify the child appears only once (either in L1 as stale-detail if stale, or excluded entirely if clean)

**Detail preservation on update:**
- Create an entry, set its tier to `detail` via `updateRow()`
- Call `handleStore()` to update the entry's value WITHOUT passing `--tier`
- Verify the entry retains `tier = 'detail'` (not reset to `default`)
- This is a cross-phase concern verifying AC1.5 in the full pipeline context

**Testing:**

Create multiple `describe` blocks within the test file. Each block sets up its own DB state.

**Verification:**
Run: `bun test packages/agent/src/__tests__/hierarchical-memory-compat.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add edge case tests for orphaned details, exclusion cascade, detail preservation (AC3.6)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Sync propagation verification — tier changes and summarizes edges

**Verifies:** hierarchical-memory.AC6.5, hierarchical-memory.AC6.6

**Files:**
- Create: `packages/agent/src/__tests__/hierarchical-memory-sync.test.ts`

**Implementation:**

These tests verify that tier changes and `summarizes` edges produce changelog entries that would sync correctly between hosts.

**Tier changelog propagation (AC6.5):**
- Create a semantic_memory entry via `insertRow()` with `tier = 'default'`
- Read the `change_log` entry → verify `row_data` JSON includes `"tier": "default"`
- Update the entry's tier to `'pinned'` via `updateRow()`
- Read the new `change_log` entry → verify `row_data` JSON includes `"tier": "pinned"`
- This proves the tier column is captured in changelog snapshots automatically (since `updateRow` does `SELECT *` after update)

**Summarizes edge sync (AC6.6):**
- Create a `summarizes` edge via `upsertEdge()` with `relation = 'summarizes'`
- Read the `change_log` entry for `memory_edges` table → verify it contains the edge with `"relation": "summarizes"`
- Soft-delete the edge via `removeEdges()`
- Read the new `change_log` entry → verify `"deleted": 1`
- This proves `summarizes` edges sync via the existing `memory_edges` changelog mechanism

**Testing:**

Tests must verify:
- **hierarchical-memory.AC6.5:** Tier changes on semantic_memory entries produce changelog entries with the `tier` field in `row_data`.
- **hierarchical-memory.AC6.6:** `summarizes` edges in `memory_edges` produce changelog entries via `insertRow()`/`softDelete()`.

Follow the established changelog verification pattern: query `change_log` table, parse `row_data` JSON, check for expected fields.

**Verification:**
Run: `bun test packages/agent/src/__tests__/hierarchical-memory-sync.test.ts`
Expected: All tests pass

Run: `bun test packages/agent packages/core`
Expected: All existing tests still pass

**Commit:** `test(agent): verify tier changelog propagation and summarizes edge sync (AC6.5-AC6.6)`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
