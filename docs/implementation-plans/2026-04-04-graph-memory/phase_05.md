# Graph Memory Implementation Plan — Phase 5: Sync and Edge Lifecycle

**Goal:** Ensure edges sync correctly via the LWW reducer and implement cascade deletion of edges when memories are forgotten or redacted.

**Architecture:** The LWW reducer already handles `memory_edges` automatically once the table is added to `SyncedTableName` and `TABLE_REDUCER_MAP` (done in Phase 1). This phase adds cascade deletion: when a memory is soft-deleted (via `memory forget` or thread redaction), all edges referencing that key as source or target are also soft-deleted. The `cascadeDeleteEdges()` helper from `graph-queries.ts` (Phase 1) provides this functionality.

**Tech Stack:** TypeScript, bun:sqlite, `@bound/core` (softDelete), `graph-queries.ts` (cascadeDeleteEdges)

**Scope:** 5 phases from original design (phase 5 of 5)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### graph-memory.AC5: Sync and edge lifecycle
- **graph-memory.AC5.1 Success:** Edges replicate via sync (LWW reducer, change-log outbox)
- **graph-memory.AC5.2 Success:** `memory forget` cascades to soft-delete all edges referencing the key
- **graph-memory.AC5.3 Success:** Thread redaction cascades edge deletion for affected memories
- **graph-memory.AC5.4 Edge:** Forgetting a key that is target of edges also cleans up those edges

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add edge cascade to memory forget subcommand

**Verifies:** graph-memory.AC5.2, graph-memory.AC5.4

**Files:**
- Modify: `packages/agent/src/commands/memory.ts` (add cascade calls in handleForget)

**Implementation:**

Import `cascadeDeleteEdges` from graph-queries.ts (should already be importable since connect/disconnect use the same module):

```typescript
import { upsertEdge, removeEdges, cascadeDeleteEdges, traverseGraph, getNeighbors } from "../graph-queries";
```

In the `handleForget` function, add cascade deletion after each memory soft-delete.

For the **single-key path** (after `softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId)`):

```typescript
softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId);

// Cascade: soft-delete all edges referencing this key (as source or target)
const edgesCascaded = cascadeDeleteEdges(ctx.db, key, ctx.siteId);

return commandSuccess(
    `Memory deleted: ${key}${edgesCascaded > 0 ? ` (${edgesCascaded} edge(s) also removed)` : ""}\n`,
);
```

For the **prefix path** (inside the loop after `softDelete`):

```typescript
let totalEdges = 0;
for (const entry of entries) {
    softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
    totalEdges += cascadeDeleteEdges(ctx.db, entry.key, ctx.siteId);
}

return commandSuccess(
    `Deleted ${entries.length} memories with prefix: ${prefix}${totalEdges > 0 ? ` (${totalEdges} edge(s) also removed)` : ""}\n`,
);
```

**Testing:**
Tests in Task 3 verify cascade behavior.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add edge cascade deletion to memory forget`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add edge cascade to thread redaction

**Verifies:** graph-memory.AC5.3

**Files:**
- Modify: `packages/agent/src/redaction.ts:28-66` (add edge cascade after memory soft-deletion)

**Implementation:**

Import `cascadeDeleteEdges` from graph-queries.ts:

```typescript
import { cascadeDeleteEdges } from "./graph-queries";
```

In the `redactThread` function, the current code (lines 44-50) soft-deletes memories whose `source` matches the threadId. After each memory soft-delete, cascade to edges.

The current code fetches `SELECT id FROM semantic_memory WHERE source = ?`. We need the **key** as well for edge cascade. Update the query:

```typescript
// Line 44: Change SELECT to include key
const memoryRows = db
    .prepare("SELECT id, key FROM semantic_memory WHERE source = ? AND deleted = 0")
    .all(threadId) as Array<{ id: string; key: string }>;

let edgesAffected = 0;
for (const mem of memoryRows) {
    softDelete(db, "semantic_memory", mem.id, siteId);
    edgesAffected += cascadeDeleteEdges(db, mem.key, siteId);
}
```

Update the `RedactionResult` interface to include edge count (if it exists — check the interface). If not, the edge count is informational only (logged but not returned). Add `edgesAffected` to the return value if the interface supports it.

Check the `RedactionResult` type at the top of redaction.ts. If it only has `messagesRedacted` and `memoriesAffected`, add `edgesAffected` as **optional** to avoid breaking existing callers and test assertions:

```typescript
interface RedactionResult {
    messagesRedacted: number;
    memoriesAffected: number;
    edgesAffected?: number;  // NEW — optional for backward compatibility
}
```

Update existing tests for `redactThread` to optionally check for `edgesAffected` when edges are present in the test scenario. Existing tests without edges should continue to pass unchanged.

Update the return value:

```typescript
return {
    ok: true,
    value: {
        messagesRedacted: messages.length,
        memoriesAffected: memoryRows.length,
        edgesAffected,
    },
};
```

**Testing:**
Tests in Task 3 verify redaction cascade.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add edge cascade to thread redaction`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Tests for sync and edge lifecycle

**Verifies:** graph-memory.AC5.1, graph-memory.AC5.2, graph-memory.AC5.3, graph-memory.AC5.4

**Files:**
- Create: `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts`
- Modify: `packages/sync/src/__tests__/reducers.test.ts` (add LWW test for memory_edges)

**Test file 1:** `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` (unit)

**Testing (lifecycle tests):**

Use the standard test DB setup pattern. Seed memories and edges in `beforeEach`.

Tests must verify each AC:

- **graph-memory.AC5.1:** After calling `upsertEdge()`, verify a `change_log` entry exists with `table_name = 'memory_edges'`. After calling `removeEdges()`, verify another changelog entry exists. This proves edge writes generate sync-compatible changelog entries.

- **graph-memory.AC5.2:** Seed two memories (A and B) with an edge A→B. Call `handleForget` (or directly call `softDelete` + `cascadeDeleteEdges`) for memory A. Verify:
  - Memory A has `deleted = 1`
  - Edge A→B has `deleted = 1`
  - Memory B is unchanged (`deleted = 0`)

- **graph-memory.AC5.3:** Seed a thread, create a memory with `source = threadId`, create edges from that memory to other memories. Call `redactThread(db, threadId, siteId)`. Verify:
  - Messages are redacted (content = "[redacted]")
  - Memory with `source = threadId` has `deleted = 1`
  - Edges referencing that memory key have `deleted = 1`
  - Other memories and their edges are unaffected

- **graph-memory.AC5.4:** Seed memories A, B, C. Create edges A→B and C→B. Forget memory B (target of both edges). Verify:
  - Both edges (A→B and C→B) have `deleted = 1`
  - Memories A and C are unaffected

**Test file 2:** `packages/sync/src/__tests__/reducers.test.ts` — add LWW test for memory_edges

**Testing (reducer tests):**

Add a test case inside the existing `describe("applyLWWReducer")` block. Follow the pattern from lines 151-178 (basic LWW insert test).

- **graph-memory.AC5.1 (reducer):** Create a `memory_edges` table in the test DB (using FULL_SCHEMA or inline CREATE TABLE). Apply a changelog event with a memory_edges row. Verify:
  - Row is inserted into `memory_edges`
  - Apply a later event with updated weight. Verify weight is updated (LWW wins).
  - Apply an earlier event. Verify it's ignored (LWW: newer timestamp wins).

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-lifecycle.test.ts`
Expected: All tests pass

Run: `bun test packages/sync/src/__tests__/reducers.test.ts`
Expected: All tests pass including new memory_edges test

Run: `bun test packages/core packages/agent packages/sync`
Expected: All tests pass, no regressions

**Commit:** `test(agent,sync): add edge lifecycle and sync reducer tests covering graph-memory.AC5`

<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
