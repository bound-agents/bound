# Hierarchical Memory Retrieval Implementation Plan

**Goal:** Wire tier awareness into the `memory` command subcommands so that store, forget, connect, and disconnect respect the four-tier hierarchy.

**Architecture:** Modifies existing handler functions in `packages/agent/src/commands/memory.ts` to accept `--tier` parameter, enforce pinned prefix overrides, and perform automatic tier transitions when `summarizes` edges are created or removed. All tier updates use `updateRow()` for sync safety.

**Tech Stack:** TypeScript 6.x, bun:sqlite, `@bound/core` change-log outbox

**Scope:** 6 phases from original design (this is phase 2 of 6)

**Codebase verified:** 2026-04-10

---

## Acceptance Criteria Coverage

This phase implements and tests:

### hierarchical-memory.AC1: memory store tier support
- **hierarchical-memory.AC1.1 Success:** `memory store key value --tier summary` creates entry with `tier = 'summary'`
- **hierarchical-memory.AC1.2 Success:** `memory store key value` without `--tier` creates entry with `tier = 'default'`
- **hierarchical-memory.AC1.3 Success:** `memory store _standing:x value` sets `tier = 'pinned'` regardless of `--tier` param
- **hierarchical-memory.AC1.4 Success:** `memory store _feedback:x value --tier default` overrides to `tier = 'pinned'` (prefix wins)
- **hierarchical-memory.AC1.5 Success:** Updating an existing `detail` entry without `--tier` preserves `detail` tier
- **hierarchical-memory.AC1.6 Success:** Updating an existing `detail` entry with `--tier default` overrides to `default`

### hierarchical-memory.AC2: memory forget/connect/disconnect tier transitions
- **hierarchical-memory.AC2.1 Success:** `memory forget` on a summary entry promotes all children from `detail` to `default`
- **hierarchical-memory.AC2.2 Success:** `memory forget` on a summary entry tombstones all outgoing `summarizes` edges
- **hierarchical-memory.AC2.3 Success:** `memory connect A B --relation summarizes` sets B's tier to `detail` when B is `default`
- **hierarchical-memory.AC2.4 Success:** `memory connect A B --relation summarizes` preserves B's tier when B is `pinned`
- **hierarchical-memory.AC2.5 Success:** `memory connect A B --relation summarizes` preserves B's tier when B is `summary`
- **hierarchical-memory.AC2.6 Success:** `memory disconnect` of a `summarizes` edge promotes target to `default` when no remaining parents
- **hierarchical-memory.AC2.7 Success:** `memory disconnect` of a `summarizes` edge preserves `detail` when other parents remain
- **hierarchical-memory.AC2.8 Edge:** Non-`summarizes` edges trigger no tier changes on connect or disconnect

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add `--tier` arg to memory command definition and modify `handleStore()`

**Verifies:** hierarchical-memory.AC1.1, hierarchical-memory.AC1.2, hierarchical-memory.AC1.3, hierarchical-memory.AC1.4, hierarchical-memory.AC1.5, hierarchical-memory.AC1.6

**Files:**
- Modify: `packages/agent/src/commands/memory.ts:91-135` (handleStore function)
- Modify: `packages/agent/src/commands/memory.ts:338-352` (args array)

**Implementation:**

**Step 1:** Add `tier` to the memory command's `args` array (at line ~352, before the closing `]`):

```typescript
{ name: "tier", required: false, description: "Memory tier: pinned, summary, default, detail" },
```

**Step 2:** Modify `handleStore()` to implement tier logic. The function is at line 91. After resolving the key and value (lines 92-93), add tier resolution logic:

Tier resolution rules (in priority order):
1. If key matches a pinned prefix (`_standing`, `_feedback`, `_policy`, `_pinned`), tier is always `"pinned"` — regardless of `--tier` arg
2. If `--tier` is explicitly provided, use that value (validate it's a valid MemoryTier)
3. If updating an existing entry and no `--tier` provided, preserve the existing tier
4. Otherwise default to `"default"`

For the existing entry update path (currently lines 107-110 using `updateRow()`), include `tier` in the updates object only when a tier change is needed. For the new entry insert path (currently lines 115-117 using `insertRow()`), include the resolved `tier` in the row object.

Import `MemoryTier` from `@bound/shared` at the top of the file. Add a validation check for the `--tier` arg value:

```typescript
const VALID_TIERS: MemoryTier[] = ["pinned", "summary", "default", "detail"];
```

The existing query at line ~101 (`SELECT id, deleted FROM semantic_memory WHERE key = ?`) needs to also select the current `tier` value so we can implement preservation logic (AC1.5).

**Testing:**

Tests must verify each AC listed above:
- **hierarchical-memory.AC1.1:** Store with `--tier summary` → entry has `tier = 'summary'`
- **hierarchical-memory.AC1.2:** Store without `--tier` → entry has `tier = 'default'`
- **hierarchical-memory.AC1.3:** Store with `_standing:x` key → entry has `tier = 'pinned'` (no `--tier` flag)
- **hierarchical-memory.AC1.4:** Store with `_feedback:x` key and `--tier default` → entry has `tier = 'pinned'` (prefix overrides)
- **hierarchical-memory.AC1.5:** Create a `detail` entry, then update its value without `--tier` → tier remains `detail`
- **hierarchical-memory.AC1.6:** Create a `detail` entry, then update with `--tier default` → tier changes to `default`

Create test file at `packages/agent/src/__tests__/memory-tier-store.test.ts`. Use the established pattern: real SQLite database via `createDatabase()` + `applySchema()`, invoke `handleStore()` directly with constructed args and CommandContext.

**Verification:**
Run: `bun test packages/agent/src/__tests__/memory-tier-store.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): add --tier support to memory store with prefix override (AC1.1-AC1.6)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Modify `handleForget()` for summary child promotion

**Verifies:** hierarchical-memory.AC2.1, hierarchical-memory.AC2.2

**Files:**
- Modify: `packages/agent/src/commands/memory.ts:137-183` (handleForget function)

**Implementation:**

Before the existing `softDelete()` + `cascadeDeleteEdges()` calls, add summary-specific logic:

1. Query the entry being forgotten to check if it's a summary: `SELECT tier FROM semantic_memory WHERE key = ? AND deleted = 0`
2. If `tier === 'summary'`, query all outgoing `summarizes` edges: `SELECT target_key FROM memory_edges WHERE source_key = ? AND relation = 'summarizes' AND deleted = 0`
3. For each child target_key, promote from `detail` to `default` using `updateRow()`:
   - First query child's current tier: `SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0`
   - If `tier === 'detail'`, call `updateRow(db, "semantic_memory", childId, { tier: "default" }, siteId)`
4. Then proceed with existing `softDelete()` + `cascadeDeleteEdges()` as before

The `cascadeDeleteEdges()` call already handles tombstoning all edges (both `summarizes` and others). AC2.2 is satisfied by the existing behavior — `cascadeDeleteEdges` soft-deletes edges where the forgotten key is source OR target. Since summary entries are the source of `summarizes` edges, all outgoing `summarizes` edges get tombstoned.

**Testing:**

Tests must verify:
- **hierarchical-memory.AC2.1:** Create summary S with two `summarizes` edges to children C1 (tier `detail`) and C2 (tier `detail`). Forget S → both C1 and C2 promoted to `default`
- **hierarchical-memory.AC2.2:** After forgetting S, all outgoing `summarizes` edges are soft-deleted

Create test file at `packages/agent/src/__tests__/memory-tier-forget.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/memory-tier-forget.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): promote summary children on forget (AC2.1-AC2.2)`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Modify `handleConnect()` for `summarizes` edge tier transition

**Verifies:** hierarchical-memory.AC2.3, hierarchical-memory.AC2.4, hierarchical-memory.AC2.5, hierarchical-memory.AC2.8

**Files:**
- Modify: `packages/agent/src/commands/memory.ts:230-261` (handleConnect function)

**Implementation:**

After the existing `upsertEdge()` call (line ~259), add tier transition logic when the relation is `summarizes`:

```typescript
if (rel === "summarizes") {
	const target = ctx.db
		.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(tgt) as { id: string; tier: string } | null;
	if (target && target.tier === "default") {
		updateRow(ctx.db, "semantic_memory", target.id, { tier: "detail" }, ctx.siteId);
	}
	// pinned and summary targets are NOT demoted (AC2.4, AC2.5)
}
```

Non-`summarizes` edges (AC2.8) naturally trigger no tier changes because the `if (rel === "summarizes")` guard skips them.

**Testing:**

Tests must verify:
- **hierarchical-memory.AC2.3:** Connect A→B with `summarizes`, B is `default` → B becomes `detail`
- **hierarchical-memory.AC2.4:** Connect A→B with `summarizes`, B is `pinned` → B stays `pinned`
- **hierarchical-memory.AC2.5:** Connect A→B with `summarizes`, B is `summary` → B stays `summary`
- **hierarchical-memory.AC2.8:** Connect A→B with `related_to` → B's tier unchanged (regardless of current tier)

Create test file at `packages/agent/src/__tests__/memory-tier-connect.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/memory-tier-connect.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): demote target to detail on summarizes connect (AC2.3-AC2.5, AC2.8)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Modify `handleDisconnect()` for orphan promotion

**Verifies:** hierarchical-memory.AC2.6, hierarchical-memory.AC2.7

**Files:**
- Modify: `packages/agent/src/commands/memory.ts:263-280` (handleDisconnect function)

**Implementation:**

After the existing `removeEdges()` call (line ~272), add orphan promotion logic when the removed edge was a `summarizes` relation:

```typescript
// Check if relation is summarizes (either explicitly or we need to check what was removed)
if (rel === "summarizes" || !rel) {
	// Check if target has any remaining incoming summarizes edges
	const remaining = ctx.db
		.prepare(
			"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
		)
		.get(tgt) as { cnt: number };

	if (remaining.cnt === 0) {
		const target = ctx.db
			.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
			.get(tgt) as { id: string; tier: string } | null;
		if (target && target.tier === "detail") {
			updateRow(ctx.db, "semantic_memory", target.id, { tier: "default" }, ctx.siteId);
		}
	}
}
```

**Ordering is intentional:** `removeEdges()` is called BEFORE the orphan promotion check. This is correct because `removeEdges()` calls `softDelete()` which sets `deleted = 1` on the edge. The subsequent `COUNT(*)` query filters `deleted = 0`, so the just-removed edge is automatically excluded from the remaining-parents count. Do NOT reorder these operations.

Note: When `rel` is undefined, `removeEdges()` removes ALL edges between source→target. We need to check if any of those were `summarizes` edges. The simplest approach: always check for remaining `summarizes` parents after any disconnect, since the query is cheap and a no-op if none existed.

**Testing:**

Tests must verify:
- **hierarchical-memory.AC2.6:** A→B `summarizes` is the only parent. Disconnect → B promoted from `detail` to `default`
- **hierarchical-memory.AC2.7:** A→B and C→B are both `summarizes`. Disconnect A→B → B stays `detail` (C→B still exists)

Create test file at `packages/agent/src/__tests__/memory-tier-disconnect.test.ts`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/memory-tier-disconnect.test.ts`
Expected: All tests pass

Run: `bun test packages/agent`
Expected: All existing agent tests still pass

**Commit:** `feat(agent): promote orphaned details on summarizes disconnect (AC2.6-AC2.7)`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
