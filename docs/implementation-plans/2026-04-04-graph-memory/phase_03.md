# Graph Memory Implementation Plan — Phase 3: Graph Traversal Queries

**Goal:** Implement recursive graph traversal functions and wire them into `traverse` and `neighbors` subcommands on the `memory` command.

**Architecture:** Three query functions are added to `graph-queries.ts`: `traverseGraph()` uses a recursive CTE with cycle prevention to walk edges from a start key, `getNeighbors()` returns one-hop connections with direction, and `graphSeededRetrieval()` combines keyword-based seed finding with traversal for context assembly (used in Phase 4). The `memory traverse` and `memory neighbors` subcommands expose the first two as agent commands.

**Design note: Traversal is outbound-only.** The recursive CTE follows edges in the `source_key → target_key` direction only, matching the design plan's CTE (`JOIN reachable r ON e.source_key = r.key`). This means if B→A exists but not A→B, traversing from A will not discover B. The `getNeighbors` function supports bidirectional queries (`"in"`, `"out"`, `"both"`). If bidirectional traversal is needed in the future, the agent should create reverse edges or the CTE can be extended with a UNION for reverse direction.

**Tech Stack:** TypeScript, bun:sqlite (recursive CTEs with `WITH RECURSIVE`), `@bound/shared` types

**Scope:** 5 phases from original design (phase 3 of 5)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### graph-memory.AC3: Graph traversal
- **graph-memory.AC3.1 Success:** `memory traverse` walks depth-2 by default, returns connected entries with values
- **graph-memory.AC3.2 Success:** Depth parameter limits traversal (1, 2, or 3)
- **graph-memory.AC3.3 Success:** Relation filter narrows traversal to specific edge type
- **graph-memory.AC3.4 Success:** `memory neighbors` returns one-hop connections with direction
- **graph-memory.AC3.5 Success:** Cycle in graph does not cause infinite recursion
- **graph-memory.AC3.6 Edge:** Traversal on key with no edges returns empty result (not error)
- **graph-memory.AC3.7 Edge:** Depth > 3 is clamped to 3

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add traverseGraph and getNeighbors to graph-queries.ts

**Verifies:** graph-memory.AC3.1, graph-memory.AC3.2, graph-memory.AC3.3, graph-memory.AC3.5, graph-memory.AC3.7

**Files:**
- Modify: `packages/agent/src/graph-queries.ts` (add interfaces and traversal functions after existing edge CRUD code)

**Implementation:**

Add the following interfaces and functions to `graph-queries.ts` after the existing `cascadeDeleteEdges` function:

```typescript
export interface TraversalResult {
    key: string;
    value: string;
    depth: number;
    viaRelation: string | null;
    viaWeight: number | null;
    modifiedAt: string;
}

export interface NeighborResult {
    key: string;
    value: string;
    relation: string;
    weight: number;
    direction: "out" | "in";
}

const MAX_DEPTH = 3;

/**
 * Walk the memory graph from a starting key using a recursive CTE.
 * Returns all reachable entries up to the given depth.
 * Cycle prevention uses path-string with /key/ delimiters.
 *
 * @param depth - Max traversal depth (1-3, default 2, clamped to MAX_DEPTH)
 * @param relation - Optional filter to only follow edges of this type
 */
export function traverseGraph(
    db: Database,
    startKey: string,
    depth = 2,
    relation?: string,
): TraversalResult[] {
    const effectiveDepth = Math.min(Math.max(depth, 1), MAX_DEPTH);
    const relationParam = relation ?? null;

    const rows = db
        .prepare(
            `WITH RECURSIVE reachable(key, depth, path, via_relation, via_weight) AS (
                SELECT ?, 0, '/' || ? || '/', NULL, NULL
                UNION ALL
                SELECT e.target_key, r.depth + 1,
                       r.path || e.target_key || '/',
                       e.relation, e.weight
                FROM memory_edges e
                JOIN reachable r ON e.source_key = r.key
                WHERE r.depth < ?
                  AND e.deleted = 0
                  AND INSTR(r.path, '/' || e.target_key || '/') = 0
                  AND (? IS NULL OR e.relation = ?)
            )
            SELECT r.key, r.depth, r.via_relation, r.via_weight,
                   m.value, m.modified_at
            FROM reachable r
            JOIN semantic_memory m ON m.key = r.key AND m.deleted = 0
            WHERE r.depth > 0
            ORDER BY r.depth ASC, m.modified_at DESC`,
        )
        .all(
            startKey,
            startKey,
            effectiveDepth,
            relationParam,
            relationParam,
        ) as Array<{
            key: string;
            depth: number;
            via_relation: string | null;
            via_weight: number | null;
            value: string;
            modified_at: string;
        }>;

    return rows.map((r) => ({
        key: r.key,
        value: r.value,
        depth: r.depth,
        viaRelation: r.via_relation,
        viaWeight: r.via_weight,
        modifiedAt: r.modified_at,
    }));
}

/**
 * Return one-hop connections for a memory key.
 * Direction: "out" = edges where key is source, "in" = edges where key is target, "both" = both.
 */
export function getNeighbors(
    db: Database,
    key: string,
    direction: "out" | "in" | "both" = "both",
): NeighborResult[] {
    const results: NeighborResult[] = [];

    if (direction === "out" || direction === "both") {
        const outEdges = db
            .prepare(
                `SELECT e.target_key AS key, e.relation, e.weight, m.value
                 FROM memory_edges e
                 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
                 WHERE e.source_key = ? AND e.deleted = 0
                 ORDER BY e.weight DESC, m.modified_at DESC`,
            )
            .all(key) as Array<{
                key: string;
                relation: string;
                weight: number;
                value: string;
            }>;

        for (const e of outEdges) {
            results.push({
                key: e.key,
                value: e.value,
                relation: e.relation,
                weight: e.weight,
                direction: "out",
            });
        }
    }

    if (direction === "in" || direction === "both") {
        const inEdges = db
            .prepare(
                `SELECT e.source_key AS key, e.relation, e.weight, m.value
                 FROM memory_edges e
                 JOIN semantic_memory m ON m.key = e.source_key AND m.deleted = 0
                 WHERE e.target_key = ? AND e.deleted = 0
                 ORDER BY e.weight DESC, m.modified_at DESC`,
            )
            .all(key) as Array<{
                key: string;
                relation: string;
                weight: number;
                value: string;
            }>;

        for (const e of inEdges) {
            results.push({
                key: e.key,
                value: e.value,
                relation: e.relation,
                weight: e.weight,
                direction: "in",
            });
        }
    }

    return results;
}
```

**Testing:**
Tests in Task 3 verify traversal behavior.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add traverseGraph and getNeighbors to graph-queries`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add graphSeededRetrieval to graph-queries.ts

**Verifies:** (Used by Phase 4 — no direct AC, but enables graph-memory.AC4.1)

**Files:**
- Modify: `packages/agent/src/graph-queries.ts` (add graphSeededRetrieval function and interface)

**Implementation:**

Add the `GraphRetrievalResult` interface and `graphSeededRetrieval` function. This function combines keyword-based seed finding with graph traversal, producing results suitable for context assembly.

```typescript
export interface GraphRetrievalResult {
    key: string;
    value: string;
    source: string | null;
    modifiedAt: string;
    retrievalMethod: "seed" | "graph" | "recency";
    depth?: number;
    viaRelation?: string;
}

/**
 * Graph-seeded retrieval for context assembly.
 * 1. Find seed memories via keyword matching
 * 2. Run depth-2 traversal from each seed
 * 3. Deduplicate and cap at maxResults
 * 4. Return results tagged with retrieval method
 */
export function graphSeededRetrieval(
    db: Database,
    keywords: string[],
    maxResults: number,
    depth = 2,
): GraphRetrievalResult[] {
    if (keywords.length === 0) return [];

    // Step 1: Find seed memories via keyword matching
    const likeConditions = keywords.map(
        () => "(LOWER(key) LIKE '%' || ? || '%' OR LOWER(value) LIKE '%' || ? || '%')",
    );
    const params = keywords.flatMap((kw) => [kw, kw]);

    const seeds = db
        .prepare(
            `SELECT key, value, source, modified_at
             FROM semantic_memory
             WHERE deleted = 0
               AND key NOT LIKE '_policy%' AND key NOT LIKE '_pinned%'
               AND (${likeConditions.join(" OR ")})
             ORDER BY modified_at DESC
             LIMIT 10`,
        )
        .all(...params) as Array<{
            key: string;
            value: string;
            source: string | null;
            modified_at: string;
        }>;

    if (seeds.length === 0) return [];

    // Build result set with dedup
    const seen = new Set<string>();
    const results: GraphRetrievalResult[] = [];

    // Add seeds first
    for (const seed of seeds) {
        if (seen.has(seed.key)) continue;
        seen.add(seed.key);
        results.push({
            key: seed.key,
            value: seed.value,
            source: seed.source,
            modifiedAt: seed.modified_at,
            retrievalMethod: "seed",
        });
    }

    // Step 2: Traverse from each seed
    for (const seed of seeds) {
        if (results.length >= maxResults) break;

        const traversed = traverseGraph(db, seed.key, depth);
        for (const t of traversed) {
            if (seen.has(t.key)) continue;
            seen.add(t.key);

            // Look up source for the traversed entry
            const entry = db
                .prepare("SELECT source FROM semantic_memory WHERE key = ? AND deleted = 0")
                .get(t.key) as { source: string | null } | null;

            results.push({
                key: t.key,
                value: t.value,
                source: entry?.source ?? null,
                modifiedAt: t.modifiedAt,
                retrievalMethod: "graph",
                depth: t.depth,
                viaRelation: t.viaRelation ?? undefined,
            });

            if (results.length >= maxResults) break;
        }
    }

    return results.slice(0, maxResults);
}
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add graphSeededRetrieval for context assembly`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Add traverse and neighbors subcommands to memory.ts

**Verifies:** graph-memory.AC3.1, graph-memory.AC3.4, graph-memory.AC3.6

**Files:**
- Modify: `packages/agent/src/commands/memory.ts` (add traverse and neighbors handlers, update switch and args)

**Implementation:**

Import traversal functions from graph-queries.ts:

```typescript
import { upsertEdge, removeEdges, traverseGraph, getNeighbors } from "../graph-queries";
```

Add `handleTraverse` function:

```typescript
function handleTraverse(args: Record<string, string>, ctx: CommandContext) {
    const key = args.source; // first positional arg
    if (!key) {
        return commandError("usage: memory traverse <key> [--depth N] [--relation R]");
    }

    const depth = args.depth ? Number.parseInt(args.depth, 10) : 2;
    const relation = args.relation || undefined;

    if (Number.isNaN(depth) || depth < 1) {
        return commandError("depth must be a positive integer (1-3)");
    }

    const results = traverseGraph(ctx.db, key, depth, relation);

    if (results.length === 0) {
        return commandSuccess(`No connected entries found from: ${key}\n`);
    }

    const lines = results.map(
        (r) =>
            `${"  ".repeat(r.depth)}${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [depth ${r.depth}, ${r.viaRelation}]`,
    );
    return commandSuccess(
        `Graph traversal from ${key} (depth=${Math.min(depth, 3)}, ${results.length} entries):\n${lines.join("\n")}\n`,
    );
}
```

Add `handleNeighbors` function:

```typescript
function handleNeighbors(args: Record<string, string>, ctx: CommandContext) {
    const key = args.source; // first positional arg
    if (!key) {
        return commandError("usage: memory neighbors <key> [--dir out|in|both]");
    }

    const dir = (args.dir as "out" | "in" | "both") || "both";
    if (!["out", "in", "both"].includes(dir)) {
        return commandError("dir must be one of: out, in, both");
    }

    const results = getNeighbors(ctx.db, key, dir);

    if (results.length === 0) {
        return commandSuccess(`No neighbors found for: ${key}\n`);
    }

    const lines = results.map(
        (r) =>
            `  ${r.direction === "out" ? "-->" : "<--"} ${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [${r.relation}, w=${r.weight}]`,
    );
    return commandSuccess(
        `Neighbors of ${key} (${results.length} connections):\n${lines.join("\n")}\n`,
    );
}
```

Add `"traverse"` and `"neighbors"` cases to the switch statement:

```typescript
case "traverse":
    return handleTraverse(args, ctx);
case "neighbors":
    return handleNeighbors(args, ctx);
```

Add `depth` and `dir` to the args array:

```typescript
{ name: "depth", required: false, description: "Traversal depth (1-3, default 2)" },
{ name: "dir", required: false, description: "Neighbor direction: out, in, or both" },
```

Update the default error message to include all 7 subcommands:

```typescript
default:
    return commandError(
        `unknown subcommand: ${args.subcommand}. Available: store, forget, search, connect, disconnect, traverse, neighbors`,
    );
```

**Testing:**
Tests in Task 4 verify these subcommands.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add traverse and neighbors subcommands to memory command`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for graph traversal

**Verifies:** graph-memory.AC3.1, graph-memory.AC3.2, graph-memory.AC3.3, graph-memory.AC3.4, graph-memory.AC3.5, graph-memory.AC3.6, graph-memory.AC3.7

**Files:**
- Create: `packages/agent/src/__tests__/graph-memory-traversal.test.ts`

**Test file:** `packages/agent/src/__tests__/graph-memory-traversal.test.ts` (unit)

**Testing:**

Use the standard test DB setup pattern. In `beforeEach`, seed a small memory graph:
- 5 semantic_memory entries: `"A"`, `"B"`, `"C"`, `"D"`, `"E"` with descriptive values
- Edges: A→B (relates_to), B→C (relates_to), C→D (governs), A→D (part_of), D→B (derived_from, creates cycle)
- Use `insertRow()` for memories and the Phase 1 `upsertEdge()` for edges

Tests must verify each AC:

- **graph-memory.AC3.1:** Call `traverseGraph(db, "A")` (default depth=2). Verify returns B (depth 1), C (depth 1 via A→B→... wait, depth 2), and D (depth 1 via A→D, depth 2 via B→C isn't governs). Verify each result has `key`, `value`, `depth`, `viaRelation`, `modifiedAt`. Verify depth-2 default works correctly by checking B is at depth 1 and C is at depth 2.

- **graph-memory.AC3.2:** Call `traverseGraph(db, "A", 1)`. Verify only depth-1 nodes returned (B and D, which are directly connected from A). Call `traverseGraph(db, "A", 3)`. Verify depth-3 nodes are included.

- **graph-memory.AC3.3:** Call `traverseGraph(db, "A", 3, "relates_to")`. Verify only edges with `relation = "relates_to"` are followed (A→B→C but not A→D since A→D is `part_of`, and not C→D since that's `governs`).

- **graph-memory.AC3.4:** Call `getNeighbors(db, "B", "out")`. Verify only outbound edges from B (B→C). Call `getNeighbors(db, "B", "in")`. Verify inbound edges to B (A→B, D→B). Call `getNeighbors(db, "B", "both")`. Verify all. Each result must have `key`, `value`, `relation`, `weight`, `direction`.

- **graph-memory.AC3.5:** The test graph has a cycle: A→B, B→C, C→D, D→B. Call `traverseGraph(db, "A", 3)`. Verify it terminates (does not hang). Verify B appears only once even though D→B creates a cycle back.

- **graph-memory.AC3.6:** Call `traverseGraph(db, "E")` where E has no edges. Verify returns empty array (not an error). Call `getNeighbors(db, "E")`. Verify returns empty array.

- **graph-memory.AC3.7:** Call `traverseGraph(db, "A", 10)`. Verify effective depth is clamped to 3 (should return same results as depth 3).

Also test `graphSeededRetrieval`:
- Seed memories with keyword-matchable values. Call `graphSeededRetrieval(db, ["scheduler"], 10)`. Verify seeds are returned with `retrievalMethod: "seed"`, traversed entries with `retrievalMethod: "graph"`.
- Call with empty keywords. Verify returns empty array.
- Call with keywords matching nothing. Verify returns empty array.

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-traversal.test.ts`
Expected: All tests pass

Run: `bun test packages/core packages/agent`
Expected: All tests pass, no regressions

**Commit:** `test(agent): add graph traversal tests covering graph-memory.AC3`

<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
