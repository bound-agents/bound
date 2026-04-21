# Edge Graph Normalization Implementation Plan — Phase 2

**Goal:** Every agent-originated write path validates the relation before the DB call, and the CLI exposes `--context` as a first-class flag with updated output formatting.

**Architecture:** `upsertEdge()` in `graph-queries.ts` gains an optional `context` parameter and a pre-flight `isCanonicalRelation()` guard that throws `InvalidRelationError` before any DB work. The memory command handler reads `args.context`, passes it through, and the existing error-mapping path surfaces the error. Output formatting for `neighbors` and `traverse` includes `context` when present.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 3 phases from original design (phase 2 of 3)

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### edge-graph-normalization.AC3: Runtime enforcement (agent-layer)
- **edge-graph-normalization.AC3.1 Failure:** `upsertEdge()` called with a non-canonical relation throws `InvalidRelationError`; no row is written; no change-log entry is emitted.

### edge-graph-normalization.AC4: CLI and agent interface
- **edge-graph-normalization.AC4.1 Success:** `memory connect <source> <target> <relation> [--weight N] [--context "phrase"]` accepts the optional `context` flag and persists it into the new column.
- **edge-graph-normalization.AC4.2 Failure:** `memory connect a b not-a-relation` returns a `commandError` whose message lists the 10 canonical relations and hints at using `--context` for bespoke phrasing.
- **edge-graph-normalization.AC4.3 Success:** `memory neighbors` and `memory traverse` output includes `context` in the line format when present.
- **edge-graph-normalization.AC4.4 Success:** Existing callers of `memory connect` that do not pass `--context` remain valid (context is optional at both the CLI and function-signature levels).

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add context parameter and relation validation to upsertEdge

**Verifies:** edge-graph-normalization.AC3.1, edge-graph-normalization.AC4.4

**Files:**
- Modify: `packages/agent/src/graph-queries.ts:1-62`

**Implementation:**

Add the import for `isCanonicalRelation` and `InvalidRelationError` at the top of `graph-queries.ts`:

```typescript
import { isCanonicalRelation, InvalidRelationError } from "@bound/core";
```

Modify the `upsertEdge` function signature to accept an optional `context` parameter. The design contract shows `context` before `siteId`, but the existing codebase already has `siteId` as the 6th parameter across all call sites. Adding `context` as the 7th (optional) parameter preserves backward compatibility — all existing callers continue to work without changes:

```typescript
export function upsertEdge(
	db: Database,
	sourceKey: string,
	targetKey: string,
	relation: string,
	weight: number,
	siteId: string,
	context?: string,
): string {
```

Add pre-flight validation as the first line of the function body, before `edgeId()`:

```typescript
if (!isCanonicalRelation(relation)) {
	throw new InvalidRelationError(relation);
}
```

Thread `context` into both the `insertRow` and `updateRow` calls:

In the `insertRow` branch (new edge), add `context` to the row object (only if defined):

```typescript
insertRow(
	db,
	"memory_edges",
	{
		id,
		source_key: sourceKey,
		target_key: targetKey,
		relation,
		weight,
		...(context !== undefined && { context }),
		created_at: now,
		modified_at: now,
		deleted: 0,
	},
	siteId,
);
```

In the `updateRow` branch (existing edge), include `context` in the updates if defined:

```typescript
updateRow(db, "memory_edges", id, {
	weight,
	deleted: 0,
	...(context !== undefined && { context }),
}, siteId);
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add context param and relation validation to upsertEdge`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add --context flag to memory connect command and update output formatting

**Verifies:** edge-graph-normalization.AC4.1, edge-graph-normalization.AC4.2, edge-graph-normalization.AC4.3

**Files:**
- Modify: `packages/agent/src/commands/memory.ts:271-314` (handleConnect)
- Modify: `packages/agent/src/commands/memory.ts:355-381` (handleTraverse output)
- Modify: `packages/agent/src/commands/memory.ts:383-407` (handleNeighbors output)
- Modify: `packages/agent/src/commands/memory.ts:409-426` (command args definition)

**Implementation:**

**Step 1: Add `context` to the command args definition (line ~420).**

Add a new arg entry after the existing `weight` arg:

```typescript
{ name: "context", required: false, description: "Free-text context for the edge relationship" },
```

**Step 2: Update `handleConnect` (line 271-314).**

Read `args.context` and pass it to `upsertEdge`:

```typescript
function handleConnect(args: Record<string, string>, ctx: CommandContext) {
	const src = args.source;
	const tgt = args.target;
	const rel = args.relation;
	const weight = args.weight ? Number.parseFloat(args.weight) : 1.0;
	const context = args.context || undefined;

	if (!src || !tgt || !rel) {
		return commandError("usage: memory connect <source> <target> <relation> [--weight N] [--context \"phrase\"]");
	}

	// ... existing weight validation unchanged ...

	// ... existing key existence checks unchanged ...

	const id = upsertEdge(ctx.db, src, tgt, rel, weight, ctx.siteId, context);

	// ... existing summarizes tier-transition logic unchanged ...

	const contextSuffix = context ? `, context="${context}"` : "";
	return commandSuccess(`Edge created: ${src} --[${rel}]--> ${tgt} (weight=${weight}${contextSuffix}, id=${id})\n`);
}
```

The `InvalidRelationError` thrown by `upsertEdge` is caught by the existing try/catch in the command handler's `switch` block (line ~448 `catch (err)`) which maps it to `commandError(err.message)`. The error message from `InvalidRelationError` already lists valid relations and hints at `--context`. No new catch block needed.

**Step 3: Update `handleTraverse` output (line 374-380).**

The traversal query currently does not SELECT `context` from `memory_edges`. The `traverseGraph` function uses a CTE that joins `memory_edges` but only returns `relation` and `weight` from edges, not `context`. For Phase 2, add `context` to the output when it is available.

Modify `TraversalResult` interface in `graph-queries.ts` to include `context`:

```typescript
export interface TraversalResult {
	key: string;
	value: string;
	depth: number;
	viaRelation: string | null;
	viaWeight: number | null;
	viaContext: string | null;  // NEW
	modifiedAt: string;
	source: string | null;
	tier?: string;
}
```

Update the `traverseGraph` CTE to select `e.context` and thread it through. In the recursive CTE, add `e.context` as an additional column (`via_context`):

```sql
WITH RECURSIVE reachable(key, depth, path, via_relation, via_weight, via_context) AS (
	SELECT ?, 0, '/' || ? || '/', NULL, NULL, NULL
	UNION ALL
	SELECT e.target_key, r.depth + 1,
		   r.path || e.target_key || '/',
		   e.relation, e.weight, e.context
	FROM memory_edges e
	JOIN reachable r ON e.source_key = r.key
	WHERE r.depth < ?
	  AND e.deleted = 0
	  AND INSTR(r.path, '/' || e.target_key || '/') = 0
	  AND (? IS NULL OR e.relation = ?)
)
SELECT r.key, r.depth, r.via_relation, r.via_weight, r.via_context,
	   m.value, m.modified_at, m.source, m.tier
FROM reachable r
JOIN semantic_memory m ON m.key = r.key AND m.deleted = 0
WHERE r.depth > 0
ORDER BY r.depth ASC, m.modified_at DESC
```

Map `via_context` in the result building and the dedup logic.

Update the traverse output format in `handleTraverse` (line 374-380) to include context when present:

```typescript
const lines = results.map(
	(r) => {
		const ctx_suffix = r.viaContext ? ` (${r.viaContext})` : "";
		return `${"  ".repeat(r.depth)}${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [depth ${r.depth}, ${r.viaRelation}${ctx_suffix}]`;
	},
);
```

**Step 4: Update `handleNeighbors` output (line 400-403).**

Similarly, `getNeighbors` in `graph-queries.ts` needs to select `e.context` from the edges and include it in `NeighborResult`:

Add `context` to `NeighborResult`:

```typescript
export interface NeighborResult {
	key: string;
	value: string;
	relation: string;
	weight: number;
	direction: "out" | "in";
	context: string | null;  // NEW
}
```

Update both the outEdges and inEdges queries in `getNeighbors` to `SELECT e.context` and include it in the result objects.

Update the neighbors output format in `handleNeighbors`:

```typescript
const lines = results.map(
	(r) => {
		const ctx_suffix = r.context ? ` (${r.context})` : "";
		return `  ${r.direction === "out" ? "-->" : "<--"} ${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [${r.relation}, w=${r.weight}${ctx_suffix}]`;
	},
);
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add --context flag and update output formatting for memory edges`

<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for upsertEdge validation, CLI context flag, and output formatting

**Verifies:** edge-graph-normalization.AC3.1, edge-graph-normalization.AC4.1, edge-graph-normalization.AC4.2, edge-graph-normalization.AC4.3, edge-graph-normalization.AC4.4

**Files:**
- Modify: `packages/agent/src/__tests__/graph-memory-edges.test.ts` (add new describe blocks)

**Testing:**

Add new test blocks to the existing `graph-memory-edges.test.ts` file, following its established patterns (beforeEach creates DB + seeds semantic_memory entries, afterEach cleans up).

Tests must verify each AC listed above:

- **edge-graph-normalization.AC3.1:** Call `upsertEdge(db, src, tgt, "not-a-relation", 1.0, siteId)`. Verify it throws `InvalidRelationError`. Then verify no row was written to `memory_edges` (SELECT by the deterministic ID returns null). Then verify no change_log entry was emitted for that row_id.

- **edge-graph-normalization.AC4.1:** Call `memory.handler({ subcommand: "connect", source: "scheduler_v3", target: "cron_rescheduling", relation: "related_to", context: "both handle recurring work" }, ctx)`. Verify exitCode 0. Query the edge row directly and verify `context = "both handle recurring work"`.

- **edge-graph-normalization.AC4.2:** Call `memory.handler({ subcommand: "connect", source: "scheduler_v3", target: "cron_rescheduling", relation: "not-a-relation" }, ctx)`. Verify exitCode 1. Verify stderr contains the list of canonical relations (at least check for `"related_to"` and `"synthesizes"` in the message). Verify stderr contains `"--context"` or `"context"` as a hint.

- **edge-graph-normalization.AC4.3:** Create edges with and without context, then call `memory.handler({ subcommand: "neighbors", source: "scheduler_v3" }, ctx)`. Verify stdout includes the context string for the edge that has one, and does not include a context parenthetical for the edge without one. Similarly test traverse output.

- **edge-graph-normalization.AC4.4:** Call `memory.handler({ subcommand: "connect", source: "scheduler_v3", target: "cron_rescheduling", relation: "related_to" }, ctx)` WITHOUT passing context. Verify exitCode 0 and the edge exists with `context IS NULL`.

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-edges.test.ts`
Expected: All tests pass (new and existing)

**Commit:** `test(agent): add tests for relation validation, context flag, and output formatting`

<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
