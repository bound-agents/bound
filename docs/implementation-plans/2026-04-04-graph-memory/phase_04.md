# Graph Memory Implementation Plan — Phase 4: Context Assembly Integration

**Goal:** Wire graph-seeded retrieval into Stage 5.5 volatile enrichment, replacing the recency+keyword approach when edges exist, with recency fallback for orphan nodes and empty graph.

**Architecture:** `buildVolatileEnrichment()` in `summary-extraction.ts` gains a graph-aware retrieval path that activates when `memory_edges` has rows. The flow becomes: pinned entries first, then graph-seeded retrieval (keyword seeds + depth-2 traversal), then recency fallback to fill remaining slots. When the edges table is empty, behavior is identical to current (pure recency + keyword boosting). Output format tags each entry with its retrieval method.

**Tech Stack:** TypeScript, bun:sqlite, `graph-queries.ts` (graphSeededRetrieval from Phase 3)

**Scope:** 5 phases from original design (phase 4 of 5)

**Codebase verified:** 2026-04-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### graph-memory.AC4: Context assembly integration
- **graph-memory.AC4.1 Success:** Graph-seeded retrieval injects connected memories from keyword seeds
- **graph-memory.AC4.2 Success:** Recency fallback fills remaining slots when graph returns fewer than maxMemory
- **graph-memory.AC4.3 Success:** Empty edges table produces identical output to current behavior
- **graph-memory.AC4.4 Success:** Output format shows retrieval method (seed/graph/recency/pinned)
- **graph-memory.AC4.5 Success:** Budget pressure reduces maxMemory to 3 with graph path
- **graph-memory.AC4.6 Edge:** No keyword matches in seeds falls back entirely to recency

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add graph-aware retrieval to buildVolatileEnrichment

**Verifies:** graph-memory.AC4.1, graph-memory.AC4.2, graph-memory.AC4.3, graph-memory.AC4.4, graph-memory.AC4.6

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts:304-487` (modify buildVolatileEnrichment)

**Implementation:**

The modification adds a graph-aware path that activates when `memory_edges` has rows. The current recency+boosting flow becomes the fallback for when the graph is empty.

**Step 1: Add import at top of summary-extraction.ts:**

```typescript
import { graphSeededRetrieval } from "./graph-queries";
import type { GraphRetrievalResult } from "./graph-queries";
```

**Step 2: Add edge count check inside buildVolatileEnrichment, after pinned entries are fetched (after approximately line 336):**

```typescript
// Check if graph edges exist — if so, use graph-seeded retrieval
const edgeCount = db
    .prepare("SELECT COUNT(*) AS cnt FROM memory_edges WHERE deleted = 0")
    .get() as { cnt: number };
const hasGraphEdges = edgeCount.cnt > 0;
```

**Step 3: Add graph-seeded retrieval path. After the `hasGraphEdges` check, before the existing delta query:**

When `hasGraphEdges && userMessage`:
1. Extract keywords from userMessage (reuse the existing keyword extraction logic already in the function at lines 392-396)
2. Call `graphSeededRetrieval(db, keywords, maxMemory)` from `graph-queries.ts`
3. Format results with retrieval method tags: `[seed]`, `[graph, depth N, relation]`, `[recency]`
4. Fill remaining slots with recency fallback (entries not already in graph results or pinned set)

When `!hasGraphEdges` or `!userMessage`:
- Fall through to existing delta+boosting logic unchanged (this ensures AC4.3 backward compatibility)

The key code structure:

```typescript
if (hasGraphEdges && userMessage) {
    // Extract keywords (same logic as existing boosting section)
    const keywords = userMessage
        .toLowerCase()
        .replace(/[^a-z0-9_\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    if (keywords.length > 0) {
        // Graph-seeded retrieval
        const graphResults = graphSeededRetrieval(db, keywords, maxMemory);

        // Track keys we've already included (pinned + graph)
        const includedKeys = new Set<string>(pinnedKeys);

        for (const r of graphResults) {
            if (includedKeys.has(r.key)) continue;
            includedKeys.add(r.key);

            const tag = r.retrievalMethod === "seed"
                ? "[seed]"
                : `[depth ${r.depth}, ${r.viaRelation}]`;

            const valueDisplay = r.value.length > 200
                ? r.value.substring(0, 200) + "..."
                : r.value;
            memoryDeltaLines.push(`- ${r.key}: ${valueDisplay} ${tag}`);
        }

        // Recency fallback: fill remaining slots
        const remaining = maxMemory - graphResults.filter((r) => !pinnedKeys.has(r.key)).length;
        if (remaining > 0) {
            // Use same LEFT JOIN pattern as existing delta query (summary-extraction.ts:339-365)
            // to resolve task/thread source labels via resolveSource(taskName, threadId, threadTitle, source)
            const recencyEntries = db
                .prepare(
                    `SELECT m.key, m.value, m.source, m.modified_at,
                            t_src.trigger_spec AS task_name,
                            th_src.id AS thread_id,
                            th_src.title AS thread_title
                     FROM semantic_memory m
                     LEFT JOIN tasks t_src ON m.source = t_src.id
                     LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0
                     WHERE m.deleted = 0
                       AND m.key NOT LIKE '\\_policy%' ESCAPE '\\'
                       AND m.key NOT LIKE '\\_pinned%' ESCAPE '\\'
                     ORDER BY m.modified_at DESC
                     LIMIT ?`,
                )
                .all(remaining + includedKeys.size) as Array<{
                    key: string;
                    value: string;
                    source: string | null;
                    modified_at: string;
                    task_name: string | null;
                    thread_id: string | null;
                    thread_title: string | null;
                }>;

            for (const entry of recencyEntries) {
                if (includedKeys.has(entry.key)) continue;
                includedKeys.add(entry.key);

                const valueDisplay = entry.value.length > 200
                    ? entry.value.substring(0, 200) + "..."
                    : entry.value;
                const sourceLabel = resolveSource(
                    entry.task_name, entry.thread_id, entry.thread_title, entry.source,
                );
                const relTime = relativeTime(entry.modified_at);
                memoryDeltaLines.push(
                    `- ${entry.key}: ${valueDisplay} (${relTime}, via ${sourceLabel}) [recency]`,
                );

                if (memoryDeltaLines.length >= maxMemory + pinnedLines.length) break;
            }
        }
    } else {
        // No keywords extracted — fall back to pure recency (AC4.6)
        // ... existing delta+boost logic unchanged
    }
} else {
    // No graph edges or no user message — existing delta+boost logic unchanged
    // ... existing code
}
```

**Important: Preserve the existing code path.** The existing delta query (lines 339-365) and keyword boosting (lines 378-431) must remain as the fallback. Wrap them in the `else` branch. Do not delete them.

**Note on callers:** The existing callers of `buildVolatileEnrichment` already pass `userMessage` where available:
- Interactive path (context-assembly.ts ~line 989): passes `userMessageText` extracted from the last user message
- Autonomous path (~line 1179): does NOT pass userMessage (undefined) — graph seeding correctly skips when userMessage is absent
- Budget pressure path (~line 1240): does NOT pass userMessage — graph seeding also skips, falling back to recency

No caller updates are needed.

**Budget pressure interaction:** When budget pressure fires (context-assembly.ts ~line 1240), it re-calls `buildVolatileEnrichment(db, enrichmentBaseline, 3, 3)` without `userMessage`. This means the re-call takes the non-graph fallback path, which is correct — under budget pressure we want the simplest/cheapest retrieval. The header construction in Task 2 must use the `graphCount`/`recencyCount` from the **final** `buildVolatileEnrichment` call (the budget pressure one), not the initial one. Since the budget pressure call omits `userMessage`, `graphCount` will be `undefined`, and the header will correctly fall back to the generic format.

**Testing:**
Tests in Task 3 verify all listed ACs.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add graph-seeded retrieval to buildVolatileEnrichment`

<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update VolatileEnrichment return type and memory header format

**Verifies:** graph-memory.AC4.4

**Files:**
- Modify: `packages/agent/src/summary-extraction.ts` (extend VolatileEnrichment interface with retrieval counts)
- Modify: `packages/agent/src/context-assembly.ts` (update header format near the "Memory: N entries" construction, around line 1001)

**Implementation:**

**Step 1: Extend VolatileEnrichment interface** in `summary-extraction.ts` to return structured counts alongside `memoryDeltaLines`:

```typescript
export interface VolatileEnrichment {
    memoryDeltaLines: string[];
    taskDigestLines: string[];
    graphCount?: number;   // entries retrieved via graph (seed + traversal)
    recencyCount?: number; // entries retrieved via recency fallback
}
```

In the graph-aware retrieval path (Task 1), set `graphCount` and `recencyCount` as the code builds the result set. In the fallback path (no edges), leave them undefined.

**Step 2: Update header construction** in context-assembly.ts. Where the memory header is built (near the `memHeaderLine` construction, around line 1001-1006), use the structured counts:

```typescript
let memHeaderLine = `Memory: ${totalMemCount} entries`;
if (graphCount !== undefined && graphCount > 0) {
    memHeaderLine += ` (${graphCount} via graph, ${recencyCount ?? 0} via recency)`;
} else if (memChangedCount > 0) {
    memHeaderLine += ` (${memChangedCount} changed since your last turn in this thread)`;
}
```

This avoids parsing string tags and preserves the existing header format when graph is not used (AC4.3).

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): update memory header to show graph/recency retrieval counts`

<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Tests for context assembly graph integration

**Verifies:** graph-memory.AC4.1, graph-memory.AC4.2, graph-memory.AC4.3, graph-memory.AC4.4, graph-memory.AC4.5, graph-memory.AC4.6

**Files:**
- Create: `packages/agent/src/__tests__/graph-memory-context.test.ts`

**Test file:** `packages/agent/src/__tests__/graph-memory-context.test.ts` (unit)

**Testing:**

Use the standard test DB setup pattern. Seed semantic_memory entries and memory_edges in `beforeEach`. Tests call `buildVolatileEnrichment()` directly (not through the full context assembly pipeline). Reference `packages/agent/src/__tests__/volatile-enrichment.test.ts` for the existing test pattern.

Tests must verify each AC:

- **graph-memory.AC4.1:** Seed 5 memories, create edges forming a graph (A→B→C). Set userMessage to match keyword in A's key/value. Call `buildVolatileEnrichment(db, baseline, 10, 5, userMessage)`. Verify `memoryDeltaLines` contains A with `[seed]` tag and B, C with `[depth N, relation]` tags.

- **graph-memory.AC4.2:** Seed 10 memories but only 3 connected via edges, with `maxMemory=8`. Verify graph returns 3 entries, then recency fills remaining 5 slots. Verify recency entries have `[recency]` tag.

- **graph-memory.AC4.3:** Run with NO rows in `memory_edges` table. Verify output is identical to existing behavior — delta entries with relative time and source labels, keyword-boosted entries with `[relevant]` tag. No `[seed]`, `[graph]`, or `[recency]` tags should appear.

- **graph-memory.AC4.4:** After graph retrieval, verify each line in `memoryDeltaLines` has one of: `[pinned]`, `[seed]`, `[depth N, relation]`, or `[recency]`. Parse and count each type.

- **graph-memory.AC4.5:** Call `buildVolatileEnrichment(db, baseline, 3, 3, userMessage)` (simulating budget pressure). Verify at most 3 non-pinned memory entries returned, even with graph edges available.

- **graph-memory.AC4.6:** Seed memories and edges, but set userMessage to keywords that don't match any memory key or value. Verify falls back entirely to recency-based retrieval (no graph tags, pure recency output like AC4.3).

**Verification:**
Run: `bun test packages/agent/src/__tests__/graph-memory-context.test.ts`
Expected: All tests pass

Run: `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts`
Expected: Existing volatile enrichment tests still pass (no regressions)

Run: `bun test packages/core packages/agent`
Expected: All tests pass

**Commit:** `test(agent): add graph-memory context assembly tests covering graph-memory.AC4`

<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
