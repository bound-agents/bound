# Graph Memory Architecture Design

## Summary

Graph Memory adds structured relationships between the agent's semantic memories to improve context retrieval. Currently, the agent selects memories for inclusion in its context window based solely on recency and keyword matching — a memory about "scheduler_v3" might be included because it was recently modified, but related memories about "cron_rescheduling" or "heartbeat_scheduling" are missed unless they also happen to be recent. This design introduces a `memory_edges` table that expresses typed relationships (relates_to, supersedes, governs, part_of, derived_from) between existing memory entries, turning the flat memory store into a graph.

The implementation replaces the current recency-based retrieval in context assembly (Stage 5.5) with graph-seeded traversal: keywords extracted from the user's latest message find "seed" memories, then a recursive depth-2 walk follows edges outward to pull in connected context. Recency-based retrieval remains as a fallback for memories that have no edges. The agent gains seven subcommands under a unified `memory` command (store, forget, search, connect, disconnect, traverse, neighbors) to manipulate both nodes and edges. All graph structure syncs across hosts via the existing change-log outbox pattern, and the transition is gradual — the graph path only activates when edges exist, so day-one deployment is backward compatible.

## Definition of Done

1. **A `memory_edges` synced table** that expresses typed relationships (relates_to, supersedes, governs, part_of, derived_from) between existing semantic_memory entries, with full change-log outbox sync support
2. **Unified `memory` command** with subcommands for all memory operations: store, forget, search, connect, disconnect, traverse, neighbors — replacing the separate `memorize` and `forget` top-level commands
3. **Graph-aware context assembly** that replaces the recency-window approach in Stage 5.5 with graph traversal from seed nodes (keyword-matched from current message), while keeping recency/keyword as fallback for orphan nodes
4. **No schema changes to semantic_memory** — all graph structure lives in the edges table

## Acceptance Criteria

### graph-memory.AC1: Edge CRUD
- **graph-memory.AC1.1 Success:** `memory connect` creates edge with correct deterministic UUID
- **graph-memory.AC1.2 Success:** `memory connect` with weight parameter sets non-default weight
- **graph-memory.AC1.3 Success:** Reconnecting existing edge updates weight and modified_at
- **graph-memory.AC1.4 Success:** `memory disconnect` soft-deletes specific edge by relation
- **graph-memory.AC1.5 Success:** `memory disconnect` without relation soft-deletes all edges between keys
- **graph-memory.AC1.6 Failure:** `memory connect` with nonexistent source or target key returns error
- **graph-memory.AC1.7 Edge:** Soft-deleted edge can be restored by reconnecting same triple
- **graph-memory.AC1.8 Success:** Edge writes generate change-log entries for sync

### graph-memory.AC2: Unified memory command
- **graph-memory.AC2.1 Success:** `memory store` creates/updates memories (same behavior as old `memorize`)
- **graph-memory.AC2.2 Success:** `memory forget` soft-deletes memories (same behavior as old `forget`)
- **graph-memory.AC2.3 Success:** `memory search` returns keyword-matched entries across keys and values
- **graph-memory.AC2.4 Success:** All 7 subcommands registered under single `memory` command
- **graph-memory.AC2.5 Failure:** Unknown subcommand returns usage hint
- **graph-memory.AC2.6 Edge:** `memory store` on soft-deleted key restores it (existing behavior preserved)

### graph-memory.AC3: Graph traversal
- **graph-memory.AC3.1 Success:** `memory traverse` walks depth-2 by default, returns connected entries with values
- **graph-memory.AC3.2 Success:** Depth parameter limits traversal (1, 2, or 3)
- **graph-memory.AC3.3 Success:** Relation filter narrows traversal to specific edge type
- **graph-memory.AC3.4 Success:** `memory neighbors` returns one-hop connections with direction
- **graph-memory.AC3.5 Success:** Cycle in graph does not cause infinite recursion
- **graph-memory.AC3.6 Edge:** Traversal on key with no edges returns empty result (not error)
- **graph-memory.AC3.7 Edge:** Depth > 3 is clamped to 3

### graph-memory.AC4: Context assembly integration
- **graph-memory.AC4.1 Success:** Graph-seeded retrieval injects connected memories from keyword seeds
- **graph-memory.AC4.2 Success:** Recency fallback fills remaining slots when graph returns fewer than maxMemory
- **graph-memory.AC4.3 Success:** Empty edges table produces identical output to current behavior
- **graph-memory.AC4.4 Success:** Output format shows retrieval method (seed/graph/recency/pinned)
- **graph-memory.AC4.5 Success:** Budget pressure reduces maxMemory to 3 with graph path
- **graph-memory.AC4.6 Edge:** No keyword matches in seeds falls back entirely to recency

### graph-memory.AC5: Sync and edge lifecycle
- **graph-memory.AC5.1 Success:** Edges replicate via sync (LWW reducer, change-log outbox)
- **graph-memory.AC5.2 Success:** `memory forget` cascades to soft-delete all edges referencing the key
- **graph-memory.AC5.3 Success:** Thread redaction cascades edge deletion for affected memories
- **graph-memory.AC5.4 Edge:** Forgetting a key that is target of edges also cleans up those edges

## Glossary

- **Change-log outbox pattern**: Write pattern used for all synced tables where CRUD operations (`insertRow()`, `updateRow()`, `softDelete()`) wrap the data write plus a changelog entry in a single transaction, ensuring sync integrity.
- **CTE (Common Table Expression)**: SQL `WITH` clause that defines a temporary result set; `WITH RECURSIVE` enables iterative graph traversal by repeatedly joining against itself.
- **Deterministic UUID**: A UUID computed from hashed content (e.g., memory key or edge triple) rather than random generation, ensuring the same logical entity gets the same ID across all hosts.
- **LWW reducer**: Last-Write-Wins conflict resolution strategy used in sync — when two hosts modify the same row, the one with the later `modified_at` timestamp wins.
- **Recency fallback**: The current (pre-graph) approach where memories are selected by `modified_at DESC` ordering, used to fill remaining context slots when graph traversal returns fewer than `maxMemory` entries.
- **Seed node**: In graph traversal, a starting memory entry found via keyword matching from which the recursive walk begins.
- **Soft delete**: Setting `deleted = 1` rather than physically removing a row, required for synced tables to propagate deletion across hosts.
- **Stage 5.5 volatile enrichment**: The context assembly phase that injects dynamic content (recent memories, task digest, skill notifications) into the agent's prompt, computed fresh each turn.
- **Subcommand dispatch**: Command pattern where a single top-level command (e.g., `memory`) internally routes to different handlers based on an `args.subcommand` parameter.
- **Synced table**: One of 17 (now 18) database tables that replicate across hosts via the sync protocol, identified by having `created_at`, `modified_at`, and `deleted` columns plus changelog entries.

## Architecture

### Schema

One new synced table: `memory_edges`. Existing `semantic_memory` rows are the graph nodes; edges express relationships between them by referencing memory keys.

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
    id          TEXT PRIMARY KEY,
    source_key  TEXT NOT NULL,
    target_key  TEXT NOT NULL,
    relation    TEXT NOT NULL,
    weight      REAL DEFAULT 1.0,
    created_at  TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted     INTEGER DEFAULT 0
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_triple
    ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;
```

The `id` column is a deterministic UUID computed from `deterministicUUID(BOUND_NAMESPACE, source_key + "|" + target_key + "|" + relation)`. This enables the change-log outbox pattern (which requires a single PK column) while the unique index on the triple prevents duplicate active edges.

Relation types are freeform TEXT. Initial recommended set: `relates_to`, `supersedes`, `governs`, `part_of`, `derived_from`. The agent can create new relation types organically.

### Unified Memory Command

A single `CommandDefinition` named `memory` with internal subcommand dispatch (same pattern as MCP server commands). Replaces the separate `memorize` and `forget` top-level commands.

| Subcommand | Purpose | Sync |
|------------|---------|------|
| `memory store <key> <value> [source]` | Create/update memory entry | Write (outbox) |
| `memory forget <key> [prefix]` | Soft-delete memory entries | Write (outbox) |
| `memory search <query>` | Keyword search across keys and values | Read-only |
| `memory connect <src> <tgt> <rel> [weight]` | Create graph edge | Write (outbox) |
| `memory disconnect <src> <tgt> [rel]` | Remove graph edge(s) | Write (outbox) |
| `memory traverse <key> [depth] [rel]` | Recursive graph walk | Read-only |
| `memory neighbors <key> [dir]` | Direct one-hop connections | Read-only |

Write subcommands use `insertRow()`/`updateRow()`/`softDelete()` for change-log outbox sync. Read subcommands are pure SELECTs.

`connect` validates both keys exist in `semantic_memory WHERE deleted = 0` before creating the edge. `disconnect` without a relation filter soft-deletes all edges between the two keys.

### Graph Query Module

New module `packages/agent/src/graph-queries.ts` exports three functions used by both agent commands and context assembly.

**Interface:**

```typescript
interface TraversalResult {
  key: string;
  value: string;
  depth: number;
  viaRelation: string | null;
  viaWeight: number | null;
  modifiedAt: string;
}

interface NeighborResult {
  key: string;
  value: string;
  relation: string;
  weight: number;
  direction: "out" | "in";
}

interface GraphRetrievalResult {
  key: string;
  value: string;
  source: string | null;
  modifiedAt: string;
  retrievalMethod: "seed" | "graph" | "recency";
  depth?: number;
  viaRelation?: string;
}

function traverseGraph(db: Database, startKey: string, depth?: number, relation?: string): TraversalResult[];
function getNeighbors(db: Database, key: string, direction?: "out" | "in" | "both"): NeighborResult[];
function graphSeededRetrieval(db: Database, keywords: string[], maxResults: number, depth?: number): GraphRetrievalResult[];
```

`traverseGraph` and `getNeighbors` power the agent commands. `graphSeededRetrieval` combines keyword-based seed finding with traversal for context assembly — it finds seed memories via `LOWER(key) LIKE '%keyword%' OR LOWER(value) LIKE '%keyword%'`, then runs depth-2 traversal from each seed, deduplicates, and returns results ordered by depth ASC then `modified_at` DESC.

**Core traversal CTE:**

```sql
WITH RECURSIVE reachable(key, depth, path, via_relation, via_weight) AS (
    SELECT ?, 0, '/' || ? || '/', NULL, NULL
    UNION
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
       m.value, m.source, m.modified_at
FROM reachable r
JOIN semantic_memory m ON m.key = r.key AND m.deleted = 0
WHERE r.depth > 0
ORDER BY r.depth ASC, m.modified_at DESC
```

Cycle prevention uses path string with `/key/` delimiters and `INSTR` check. Depth is capped at 3 (hard max). Default depth is 2. At ~1000 nodes and ~5000 edges, traversal completes in single-digit milliseconds.

### Context Assembly Changes

`buildVolatileEnrichment()` in `packages/agent/src/summary-extraction.ts` gains graph-aware retrieval that replaces the recency + keyword approach.

**New flow (replaces steps 2-3 of current enrichment):**

1. **Pinned entries** — unchanged, always injected first (`_policy*`, `_pinned*`)
2. **Graph-seeded retrieval** — extract keywords from latest user message (reuse existing extraction: lowercase, strip special chars, remove stop words, filter < 3 chars), find seed memories via keyword match, run depth-2 traversal from seeds via `graphSeededRetrieval()`, cap at `maxMemory` (25 default)
3. **Recency fallback** — if graph retrieval returns fewer than `maxMemory` entries, fill remaining slots with recency-based delta (current approach). Handles orphan nodes with no edges.
4. **Task digest** — unchanged

The graph path activates only when `memory_edges` has rows. When the edges table is empty, behavior is identical to current (pure recency + keyword). This makes day-one deployment a no-op for context assembly.

**Budget pressure:** Under pressure (headroom < 2000 tokens), reduce to `maxMemory=3`. Graph traversal still runs with tighter cap. Depth stays at 2.

**Output format:**

```
Memory: 851 entries (12 via graph, 3 via recency)
- scheduler_v3: "Clock-aligned interval math..." [seed]
  - cron_rescheduling: "Extracted rescheduleCronTask()..." [depth 1, relates_to]
  - heartbeat_scheduling: "New rescheduleHeartbeat()..." [depth 2, relates_to]
- _policy_rate_limit: 100 req/s [pinned]
- some_recent_memory: "..." (2h ago) [recency]
```

## Existing Patterns

This design follows established patterns from the codebase:

- **Synced table pattern**: `memory_edges` follows the same structure as all 17 existing synced tables — TEXT PK, `created_at`/`modified_at`/`deleted` columns, writes via `insertRow()`/`updateRow()`/`softDelete()`, LWW sync reducer.
- **Deterministic UUIDs**: Edge IDs use `deterministicUUID(BOUND_NAMESPACE, ...)` — same pattern as `memorize` command for memory entries.
- **Subcommand dispatch**: The unified `memory` command uses the same internal subcommand pattern as MCP server commands (`args.subcommand` selects handler).
- **Keyword extraction**: Graph seed selection reuses the existing keyword extraction logic from `buildVolatileEnrichment()` (lines 383-396 of summary-extraction.ts) — stop word list, character stripping, length filtering.
- **Command framework**: All subcommands implement `CommandDefinition` handlers with `(args, ctx) -> CommandResult`, registered via `createDefineCommands()`.

**New pattern introduced:** Recursive CTE graph traversal for context assembly. No existing code uses recursive CTEs for data retrieval at runtime (they appear only in design docs and the files viewer). This is the first use of graph structure for agent context.

**Divergence:** Removing `memorize` and `forget` as top-level commands is a breaking change for the agent's learned behavior. The system prompt must reference the new `memory` command. Any scheduled tasks with `memorize` in their payload will fail with "unknown command" until updated.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema and Edge CRUD
**Goal:** Add `memory_edges` synced table and implement the write subcommands (connect/disconnect)

**Components:**
- `packages/core/src/schema.ts` — add `memory_edges` table definition and indexes
- `packages/core/src/change-log.ts` — add `memory_edges: "id"` to `TABLE_PK_COLUMN` map
- `packages/shared/src/types.ts` — add `MemoryEdge` type
- `packages/agent/src/commands/memory.ts` — new file with `connect` and `disconnect` subcommand handlers
- `packages/agent/src/graph-queries.ts` — new file, initially just edge insert/delete helpers

**Dependencies:** None (first phase)

**Done when:** `memory_edges` table is created by schema migration, edges can be created and soft-deleted via `connect`/`disconnect` handlers, change-log entries are generated for sync, tests verify CRUD operations including deterministic UUID generation, duplicate prevention, and soft-delete behavior.

**Covers:** graph-memory.AC1
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Command Consolidation
**Goal:** Unify memorize, forget, and new graph commands under the `memory` command

**Components:**
- `packages/agent/src/commands/memory.ts` — add `store`, `forget`, and `search` subcommand handlers (migrating logic from existing memorize.ts and forget.ts)
- `packages/agent/src/commands/memorize.ts` — delete
- `packages/agent/src/commands/forget.ts` — delete
- `packages/agent/src/commands/index.ts` — update command registration to use unified `memory` command
- `packages/cli/src/commands/start.ts` — update command setup

**Dependencies:** Phase 1 (memory.ts file exists)

**Done when:** All 7 subcommands are registered under `memory`, old `memorize`/`forget` commands are removed, `memory store` and `memory forget` pass the same tests as the old commands (ported to new invocation), `memory search` returns keyword-matched results with key/value display.

**Covers:** graph-memory.AC2
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Graph Traversal Queries
**Goal:** Implement the read-only graph traversal functions and agent commands

**Components:**
- `packages/agent/src/graph-queries.ts` — add `traverseGraph()`, `getNeighbors()`, and `graphSeededRetrieval()` functions with recursive CTEs
- `packages/agent/src/commands/memory.ts` — add `traverse` and `neighbors` subcommand handlers

**Dependencies:** Phase 1 (edges table exists for traversal)

**Done when:** `traverse` walks the graph with cycle prevention and depth limiting, `neighbors` returns one-hop connections with direction filtering, `graphSeededRetrieval` combines keyword seeding with traversal. Tests verify cycle prevention, depth limits, relation filtering, multi-seed deduplication, and empty-graph graceful handling.

**Covers:** graph-memory.AC3
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Context Assembly Integration
**Goal:** Wire graph-seeded retrieval into Stage 5.5 volatile enrichment

**Components:**
- `packages/agent/src/summary-extraction.ts` — modify `buildVolatileEnrichment()` to use `graphSeededRetrieval()` with recency fallback
- `packages/agent/src/context-assembly.ts` — update output formatting for graph-sourced entries (show depth, relation, retrieval method)

**Dependencies:** Phase 3 (graph queries available)

**Done when:** Context assembly uses graph traversal when edges exist, falls back to pure recency when edges table is empty, output format shows retrieval method (seed/graph/recency), budget pressure reduction works with graph path. Tests verify graph-first retrieval, recency fallback for orphans, empty-graph backward compatibility, and budget pressure behavior.

**Covers:** graph-memory.AC4
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Sync and Edge Lifecycle
**Goal:** Ensure edges sync correctly and handle memory deletion cascading

**Components:**
- `packages/sync/src/reducers.ts` — verify LWW reducer handles `memory_edges` table (should work with existing generic reducer, but needs test coverage)
- `packages/agent/src/commands/memory.ts` — `forget` subcommand cascades to soft-delete edges referencing the forgotten key (both source and target)
- `packages/agent/src/redaction.ts` — extend `redactThread()` to cascade edge deletion when memories are redacted

**Dependencies:** Phase 2 (forget command), Phase 1 (edges exist)

**Done when:** Edges replicate across hosts via sync, forgetting a memory soft-deletes all its edges, thread redaction cascades through edges, tests verify sync round-trip and cascade behavior.

**Covers:** graph-memory.AC5
<!-- END_PHASE_5 -->

## Additional Considerations

**Transition is gradual.** Day-one deployment changes nothing about context assembly behavior — the graph path only activates when edges exist. The heartbeat task will use `memory connect` to build edges during consolidation runs. As edges accumulate, retrieval naturally shifts from recency-heavy to graph-heavy. No migration script is needed.

**Breaking change for agent behavior.** Removing `memorize` and `forget` as top-level commands means the agent's learned patterns break. The persona/system prompt must reference the new `memory` command. Scheduled tasks with `memorize` in their payload will get "unknown command" errors and reschedule.

**Edge cleanup on memory deletion.** When a memory is forgotten or redacted, all edges referencing it (as source or target) must also be soft-deleted. This prevents dangling edges that point to deleted nodes, which would cause `traverseGraph` to JOIN against deleted memories and return no results for those paths.

**No embedding or vector search.** Seed node selection uses the existing keyword substring matching, not semantic embeddings. This keeps the system simple and avoids introducing an embedding model dependency. If keyword matching proves insufficient for seed quality, embeddings can be added later as a separate enhancement without changing the graph structure.
