# Graph Memory Implementation Plan — Phase 1: Schema and Edge CRUD

**Goal:** Add the `memory_edges` synced table and implement `connect`/`disconnect` subcommands for creating and removing graph edges between semantic memory entries.

**Architecture:** A new `memory_edges` SQLite table stores typed, weighted relationships between existing `semantic_memory` rows. Edges use deterministic UUIDs computed from the `(source_key, target_key, relation)` triple. All writes go through the change-log outbox pattern for sync. A new `memory` command with subcommand dispatch hosts `connect` and `disconnect` handlers.

**Tech Stack:** TypeScript, bun:sqlite (STRICT tables, WAL mode), `@bound/shared` (deterministicUUID, types), `@bound/core` (insertRow/updateRow/softDelete, change-log outbox)

**Scope:** 5 phases from original design (phase 1 of 5)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### graph-memory.AC1: Edge CRUD
- **graph-memory.AC1.1 Success:** `memory connect` creates edge with correct deterministic UUID
- **graph-memory.AC1.2 Success:** `memory connect` with weight parameter sets non-default weight
- **graph-memory.AC1.3 Success:** Reconnecting existing edge updates weight and modified_at
- **graph-memory.AC1.4 Success:** `memory disconnect` soft-deletes specific edge by relation
- **graph-memory.AC1.5 Success:** `memory disconnect` without relation soft-deletes all edges between keys
- **graph-memory.AC1.6 Failure:** `memory connect` with nonexistent source or target key returns error
- **graph-memory.AC1.7 Edge:** Soft-deleted edge can be restored by reconnecting same triple
- **graph-memory.AC1.8 Success:** Edge writes generate change-log entries for sync

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add memory_edges table to schema and types

**Files:**
- Modify: `packages/core/src/schema.ts` (add table after skills block ending at line 228, before change_log at line 230)
- Modify: `packages/shared/src/types.ts` (add to SyncedTableName union after `"skills"`, add MemoryEdge interface after Skill interface, add to TABLE_REDUCER_MAP)

**Note on `change-log.ts`:** The design lists adding `memory_edges: "id"` to `TABLE_PK_COLUMN` in `packages/core/src/change-log.ts`. However, `getTablePkColumn()` (line 15-17) already defaults to `"id"` for any table not explicitly listed. Since `memory_edges` uses `id` as its PK, no entry is needed. The explicit entry is omitted to avoid redundancy — only exceptions (`hosts: "site_id"`, `cluster_config: "key"`) are listed in the map.

**Implementation:**

In `packages/core/src/schema.ts`, add after the skills table and its index (after `idx_skills_name` index, before `// 12. change_log`). Renumber change_log to 13:

```typescript
// 12. memory_edges (synced)
db.run(`
    CREATE TABLE IF NOT EXISTS memory_edges (
        id          TEXT PRIMARY KEY,
        source_key  TEXT NOT NULL,
        target_key  TEXT NOT NULL,
        relation    TEXT NOT NULL,
        weight      REAL DEFAULT 1.0,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        deleted     INTEGER DEFAULT 0
    ) STRICT
`);

db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple
    ON memory_edges(source_key, target_key, relation) WHERE deleted = 0
`);
db.run(`
    CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_key) WHERE deleted = 0
`);
db.run(`
    CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_key) WHERE deleted = 0
`);
```

Also update the comment for change_log from `// 12. change_log` to `// 13. change_log`.

In `packages/shared/src/types.ts`, add `"memory_edges"` to the `SyncedTableName` union (after `"skills"`):

```typescript
export type SyncedTableName =
    | "users"
    | "threads"
    | "messages"
    | "semantic_memory"
    | "tasks"
    | "files"
    | "hosts"
    | "overlay_index"
    | "cluster_config"
    | "advisories"
    | "skills"
    | "memory_edges";
```

Add `MemoryEdge` interface after the `Skill` interface (after the closing `}` of the Skill interface):

```typescript
export interface MemoryEdge {
    id: string;
    source_key: string;
    target_key: string;
    relation: string;
    weight: number;
    created_at: string;
    modified_at: string;
    deleted: number;
}
```

Add `memory_edges: "lww"` to `TABLE_REDUCER_MAP` (after `skills: "lww"`, last entry before closing `}`):

```typescript
export const TABLE_REDUCER_MAP: Record<SyncedTableName, ReducerType> = {
    users: "lww",
    threads: "lww",
    messages: "append-only",
    semantic_memory: "lww",
    tasks: "lww",
    files: "lww",
    hosts: "lww",
    overlay_index: "lww",
    cluster_config: "lww",
    advisories: "lww",
    skills: "lww",
    memory_edges: "lww",
};
```

**Verification:**
Run: `tsc -p packages/shared --noEmit && tsc -p packages/core --noEmit`
Expected: No type errors

Run: `bun test packages/core/src/__tests__/schema.test.ts`
Expected: Existing schema tests still pass

**Commit:** `feat(core): add memory_edges synced table and MemoryEdge type`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update test-harness FULL_SCHEMA for integration tests

**Files:**
- Modify: `packages/sync/src/__tests__/test-harness.ts:34-258` (add memory_edges to FULL_SCHEMA)

**Implementation:**

In `packages/sync/src/__tests__/test-harness.ts`, add the `memory_edges` table to the `FULL_SCHEMA` constant. Insert after the `advisories` table definition (after approximately line 202) and before the `change_log` table (line 204):

```sql
CREATE TABLE memory_edges (
    id          TEXT PRIMARY KEY,
    source_key  TEXT NOT NULL,
    target_key  TEXT NOT NULL,
    relation    TEXT NOT NULL,
    weight      REAL DEFAULT 1.0,
    created_at  TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted     INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX idx_edges_triple
    ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
CREATE INDEX idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
CREATE INDEX idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;
```

**Verification:**
Run: `bun test packages/sync`
Expected: Existing sync tests still pass (FULL_SCHEMA is additive)

**Commit:** `test(sync): add memory_edges to FULL_SCHEMA test harness`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: Create graph-queries.ts with edge CRUD helpers

**Verifies:** graph-memory.AC1.1, graph-memory.AC1.3, graph-memory.AC1.7

**Files:**
- Create: `packages/agent/src/graph-queries.ts`

**Implementation:**

Create `packages/agent/src/graph-queries.ts` exporting edge CRUD helper functions. This module provides the data access layer for edge operations; command handlers call these functions.

```typescript
import type { Database } from "bun:sqlite";
import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { MemoryEdge } from "@bound/shared";

/**
 * Compute the deterministic edge ID from the (source, target, relation) triple.
 * Uses the same deterministicUUID pattern as semantic_memory keys.
 */
export function edgeId(sourceKey: string, targetKey: string, relation: string): string {
    return deterministicUUID(BOUND_NAMESPACE, `${sourceKey}|${targetKey}|${relation}`);
}

/**
 * Create or restore a graph edge between two memory keys.
 *
 * If a soft-deleted edge with the same triple exists, restores it
 * with the new weight. If an active edge exists, updates its weight
 * and modified_at. Otherwise creates a new edge.
 *
 * Returns the edge ID.
 */
export function upsertEdge(
    db: Database,
    sourceKey: string,
    targetKey: string,
    relation: string,
    weight: number,
    siteId: string,
): string {
    const id = edgeId(sourceKey, targetKey, relation);
    const now = new Date().toISOString();

    // Check for existing edge (including soft-deleted) by deterministic ID
    const existing = db
        .prepare("SELECT id, deleted FROM memory_edges WHERE id = ?")
        .get(id) as { id: string; deleted: number } | null;

    if (existing) {
        // Update existing (active or soft-deleted) — restores if deleted
        updateRow(db, "memory_edges", id, { weight, deleted: 0 }, siteId);
    } else {
        // Create new edge
        insertRow(
            db,
            "memory_edges",
            {
                id,
                source_key: sourceKey,
                target_key: targetKey,
                relation,
                weight,
                created_at: now,
                modified_at: now,
                deleted: 0,
            },
            siteId,
        );
    }

    return id;
}

/**
 * Soft-delete edges between two keys.
 * If relation is provided, deletes only that specific edge.
 * If relation is omitted, deletes ALL edges between the two keys (both directions).
 */
export function removeEdges(
    db: Database,
    sourceKey: string,
    targetKey: string,
    relation: string | undefined,
    siteId: string,
): number {
    if (relation) {
        // Delete specific edge by triple
        const id = edgeId(sourceKey, targetKey, relation);
        const existing = db
            .prepare("SELECT id FROM memory_edges WHERE id = ? AND deleted = 0")
            .get(id) as { id: string } | null;
        if (existing) {
            softDelete(db, "memory_edges", id, siteId);
            return 1;
        }
        return 0;
    }

    // Delete all edges between the two keys (source->target direction only,
    // matching the design: disconnect <src> <tgt>)
    const edges = db
        .prepare(
            "SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0",
        )
        .all(sourceKey, targetKey) as Array<{ id: string }>;

    for (const edge of edges) {
        softDelete(db, "memory_edges", edge.id, siteId);
    }

    return edges.length;
}

/**
 * Soft-delete ALL edges referencing a memory key (as source OR target).
 * Used when a memory entry is forgotten — prevents dangling edges.
 */
export function cascadeDeleteEdges(db: Database, memoryKey: string, siteId: string): number {
    const edges = db
        .prepare(
            "SELECT id FROM memory_edges WHERE (source_key = ? OR target_key = ?) AND deleted = 0",
        )
        .all(memoryKey, memoryKey) as Array<{ id: string }>;

    for (const edge of edges) {
        softDelete(db, "memory_edges", edge.id, siteId);
    }

    return edges.length;
}
```

**Testing:**
Tests in Task 5 verify:
- graph-memory.AC1.1: `edgeId()` produces correct deterministic UUID; `upsertEdge()` creates edge row with correct fields
- graph-memory.AC1.3: Calling `upsertEdge()` on existing active edge updates weight and modified_at
- graph-memory.AC1.7: Calling `upsertEdge()` on soft-deleted edge restores it (sets `deleted = 0`)

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add graph-queries module with edge CRUD helpers`

<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Create memory command with connect and disconnect subcommands

**Verifies:** graph-memory.AC1.1, graph-memory.AC1.2, graph-memory.AC1.4, graph-memory.AC1.5, graph-memory.AC1.6

**Files:**
- Create: `packages/agent/src/commands/memory.ts`

**Implementation:**

Create `packages/agent/src/commands/memory.ts` with subcommand dispatch for `connect` and `disconnect`. Follows the same pattern as existing commands (see `memorize.ts` for reference). Additional subcommands (store, forget, search, traverse, neighbors) are added in Phase 2 and Phase 3.

```typescript
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { upsertEdge, removeEdges } from "../graph-queries";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

// Positional arg mapping for the memory command:
// - connect:    source=src_key, target=tgt_key, relation=relation_type
// - disconnect: source=src_key, target=tgt_key, relation=optional_filter

function handleConnect(args: Record<string, string>, ctx: CommandContext) {
    const src = args.source;
    const tgt = args.target;
    const rel = args.relation;
    const weight = args.weight ? Number.parseFloat(args.weight) : 1.0;

    if (!src || !tgt || !rel) {
        return commandError("usage: memory connect <source> <target> <relation> [--weight N]");
    }

    if (Number.isNaN(weight) || weight < 0 || weight > 10) {
        return commandError("weight must be a number between 0 and 10");
    }

    // Validate both memory keys exist (active, not soft-deleted)
    const srcExists = ctx.db
        .prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
        .get(src);
    if (!srcExists) {
        return commandError(`source memory not found: ${src}`);
    }

    const tgtExists = ctx.db
        .prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
        .get(tgt);
    if (!tgtExists) {
        return commandError(`target memory not found: ${tgt}`);
    }

    const id = upsertEdge(ctx.db, src, tgt, rel, weight, ctx.siteId);
    return commandSuccess(`Edge created: ${src} --[${rel}]--> ${tgt} (weight=${weight}, id=${id})\n`);
}

function handleDisconnect(args: Record<string, string>, ctx: CommandContext) {
    const src = args.source;
    const tgt = args.target;
    const rel = args.relation || undefined;

    if (!src || !tgt) {
        return commandError("usage: memory disconnect <source> <target> [relation]");
    }

    const count = removeEdges(ctx.db, src, tgt, rel, ctx.siteId);
    if (count === 0) {
        return commandError(`no edges found between ${src} and ${tgt}${rel ? ` with relation ${rel}` : ""}`);
    }

    return commandSuccess(`Removed ${count} edge(s) between ${src} and ${tgt}\n`);
}

export const memory: CommandDefinition = {
    name: "memory",
    args: [
        { name: "subcommand", required: true, description: "Subcommand: connect, disconnect" },
        { name: "source", required: false, description: "Source memory key" },
        { name: "target", required: false, description: "Target memory key" },
        { name: "relation", required: false, description: "Relation type" },
        { name: "weight", required: false, description: "Edge weight (0-10, default 1.0)" },
    ],
    handler: async (args: Record<string, string>, ctx: CommandContext) => {
        try {
            switch (args.subcommand) {
                case "connect":
                    return handleConnect(args, ctx);
                case "disconnect":
                    return handleDisconnect(args, ctx);
                default:
                    return commandError(
                        `unknown subcommand: ${args.subcommand}. Available: connect, disconnect`,
                    );
            }
        } catch (error) {
            return handleCommandError(error);
        }
    },
};
```

**Testing:**
Tests in Task 5 verify:
- graph-memory.AC1.1: `memory connect` creates edge with correct deterministic UUID
- graph-memory.AC1.2: `memory connect --weight 0.5` sets non-default weight
- graph-memory.AC1.4: `memory disconnect src tgt relation` soft-deletes the specific edge
- graph-memory.AC1.5: `memory disconnect src tgt` (no relation) soft-deletes all edges between keys
- graph-memory.AC1.6: `memory connect` with nonexistent source or target returns error

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add memory command with connect/disconnect subcommands`

<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Register memory command in commands/index.ts

**Files:**
- Modify: `packages/agent/src/commands/index.ts:1-88` (add memory import and registration)

**Implementation:**

Add import for the new memory command and include it in `getAllCommands()`. Do NOT remove `memorize` or `forget` yet — that happens in Phase 2 (Command Consolidation).

Add import after line 13 (after the `memorize` import):

```typescript
import { memory } from "./memory";
```

Add `memory` to the return array in `getAllCommands()` (after `forget` on line 34):

```typescript
return [
    help,
    query,
    advisory,
    memorize,
    forget,
    memory,  // <-- add here
    schedule,
    // ... rest unchanged
];
```

Add `memory` to the named exports block at the bottom (after `forget` on line 72):

```typescript
export {
    advisory,
    query,
    memorize,
    forget,
    memory,  // <-- add here
    schedule,
    // ... rest unchanged
};
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: Existing tests pass (no behavior changes to existing commands)

**Commit:** `feat(agent): register memory command in command index`

<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6) -->

<!-- START_TASK_6 -->
### Task 6: Tests for edge CRUD operations

**Verifies:** graph-memory.AC1.1, graph-memory.AC1.2, graph-memory.AC1.3, graph-memory.AC1.4, graph-memory.AC1.5, graph-memory.AC1.6, graph-memory.AC1.7, graph-memory.AC1.8

**Files:**
- Create: `packages/agent/src/__tests__/graph-memory-edges.test.ts`

**Test file:** `packages/agent/src/__tests__/graph-memory-edges.test.ts` (unit)

**Testing:**

Follow the project's test patterns: use `bun:test` (describe/it/expect), create a real temp SQLite database per test via `randomBytes(4).toString("hex")`, call `createDatabase()` and `applySchema()` from `@bound/core` in `beforeEach`, clean up in `afterEach`. Reference existing test setup pattern from `packages/core/src/__tests__/change-log.test.ts:21-38`.

Seed two `semantic_memory` entries via `insertRow()` before each test (e.g., keys `"scheduler_v3"` and `"cron_rescheduling"`) so that connect/disconnect have valid targets.

Tests must verify each AC listed above:

- **graph-memory.AC1.1:** Call `upsertEdge()` or invoke `memory connect` handler with two valid keys and a relation. Assert the returned edge ID matches `deterministicUUID(BOUND_NAMESPACE, "key1|key2|relates_to")`. Query `memory_edges` table and verify `source_key`, `target_key`, `relation`, `weight` (default 1.0), `created_at`, `modified_at`, and `deleted = 0`.

- **graph-memory.AC1.2:** Call `memory connect` handler with `args.weight = "0.5"`. Verify the stored edge has `weight = 0.5`.

- **graph-memory.AC1.3:** Create an edge, note its `modified_at`. Wait briefly or use a later timestamp. Call `upsertEdge()` again with the same triple but `weight = 2.0`. Verify `weight` updated to 2.0 and `modified_at` changed. Verify `id` is the same (no duplicate row).

- **graph-memory.AC1.4:** Create an edge with relation `"relates_to"`. Call `removeEdges()` with the same triple (including relation). Verify `deleted = 1` in the DB. Verify only that specific edge was deleted (create a second edge with different relation, confirm it's untouched).

- **graph-memory.AC1.5:** Create two edges between the same keys with different relations (`"relates_to"` and `"governs"`). Call `removeEdges()` without a relation. Verify both edges have `deleted = 1`.

- **graph-memory.AC1.6:** Call `memory connect` handler with a nonexistent source key. Assert the result has `exitCode: 1` and `stderr` contains `"source memory not found"`. Repeat with valid source but nonexistent target key. Assert `"target memory not found"`.

- **graph-memory.AC1.7:** Create an edge, then soft-delete it via `removeEdges()`. Call `upsertEdge()` with the same triple. Verify `deleted = 0` and the edge is restored with the new weight.

- **graph-memory.AC1.8:** After any write operation (`upsertEdge` or `removeEdges`), query `change_log WHERE table_name = 'memory_edges'`. Verify at least one changelog entry exists with the correct `row_id` matching the edge ID. Verify `row_data` JSON contains the edge fields.

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-edges.test.ts`
Expected: All tests pass

Run: `bun test packages/core packages/agent`
Expected: All tests pass (no regressions)

**Commit:** `test(agent): add edge CRUD tests covering graph-memory.AC1`

<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
