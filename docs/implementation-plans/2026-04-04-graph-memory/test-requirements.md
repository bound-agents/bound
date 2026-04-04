# Graph Memory — Test Requirements

Maps every acceptance criterion from the design to either an automated test or a documented human verification step.

---

## Automated Tests

### graph-memory.AC1: Edge CRUD

| Criterion | Description | Type | Test File |
|-----------|-------------|------|-----------|
| AC1.1 | `memory connect` creates edge with correct deterministic UUID | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.2 | `memory connect` with weight parameter sets non-default weight | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.3 | Reconnecting existing edge updates weight and modified_at | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.4 | `memory disconnect` soft-deletes specific edge by relation | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.5 | `memory disconnect` without relation soft-deletes all edges between keys | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.6 | `memory connect` with nonexistent source or target key returns error | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.7 | Soft-deleted edge can be restored by reconnecting same triple | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |
| AC1.8 | Edge writes generate change-log entries for sync | unit | `packages/agent/src/__tests__/graph-memory-edges.test.ts` |

**Test strategy (AC1):** Each test seeds two `semantic_memory` entries via `insertRow()` in `beforeEach`, then exercises `upsertEdge()`/`removeEdges()` or the `memory` command handler directly. AC1.1 asserts the returned ID matches `deterministicUUID(BOUND_NAMESPACE, "key1|key2|relation")`. AC1.3 creates an edge, then calls `upsertEdge()` again with a different weight and verifies `weight` and `modified_at` changed while `id` stayed the same. AC1.7 soft-deletes an edge then calls `upsertEdge()` and verifies `deleted = 0` is restored. AC1.8 queries `change_log WHERE table_name = 'memory_edges'` after each write and verifies at least one entry with the correct `row_id`.

---

### graph-memory.AC2: Unified memory command

| Criterion | Description | Type | Test File |
|-----------|-------------|------|-----------|
| AC2.1 | `memory store` creates/updates memories (same behavior as old `memorize`) | unit | `packages/agent/src/__tests__/commands.test.ts` |
| AC2.2 | `memory forget` soft-deletes memories (same behavior as old `forget`) | unit | `packages/agent/src/__tests__/commands.test.ts` |
| AC2.3 | `memory search` returns keyword-matched entries across keys and values | unit | `packages/agent/src/__tests__/graph-memory-search.test.ts` |
| AC2.4 | All 7 subcommands registered under single `memory` command | unit | `packages/agent/src/__tests__/commands.test.ts` |
| AC2.5 | Unknown subcommand returns usage hint | unit | `packages/agent/src/__tests__/commands.test.ts` |
| AC2.6 | `memory store` on soft-deleted key restores it (existing behavior preserved) | unit | `packages/agent/src/__tests__/commands.test.ts` |

**Test strategy (AC2):** AC2.1, AC2.2, and AC2.6 are migrated from existing `memorize`/`forget` describe blocks in `commands.test.ts`, replacing `memorize.handler({key, value}, ctx)` with `memory.handler({subcommand: "store", source: key, target: value}, ctx)` and similar for forget. AC2.4 invokes each of the 7 subcommands (store, forget, search, connect, disconnect, traverse, neighbors) through the unified handler and asserts no "unknown subcommand" error. AC2.5 calls with `subcommand: "nonexistent"` and asserts `exitCode: 1` with stderr containing "unknown subcommand". AC2.3 is a separate file that seeds varied memories and tests keyword matching against keys, values, stop-word-only queries, no-match queries, ordering by `modified_at DESC`, and the 20-result cap.

---

### graph-memory.AC3: Graph traversal

| Criterion | Description | Type | Test File |
|-----------|-------------|------|-----------|
| AC3.1 | `memory traverse` walks depth-2 by default, returns connected entries with values | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.2 | Depth parameter limits traversal (1, 2, or 3) | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.3 | Relation filter narrows traversal to specific edge type | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.4 | `memory neighbors` returns one-hop connections with direction | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.5 | Cycle in graph does not cause infinite recursion | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.6 | Traversal on key with no edges returns empty result (not error) | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |
| AC3.7 | Depth > 3 is clamped to 3 | unit | `packages/agent/src/__tests__/graph-memory-traversal.test.ts` |

**Test strategy (AC3):** Seeds a 5-node graph in `beforeEach`: memories A through E with edges A->B (relates_to), B->C (relates_to), C->D (governs), A->D (part_of), D->B (derived_from, creating a cycle). AC3.1 calls `traverseGraph(db, "A")` and verifies B at depth 1, D at depth 1, C at depth 2, each with `key`, `value`, `depth`, `viaRelation`, `modifiedAt`. AC3.2 calls with depth=1 (expects only B and D) and depth=3 (expects deeper results). AC3.3 filters by `"relates_to"` and verifies only that relation is followed (A->B->C but not A->D or C->D). AC3.4 tests `getNeighbors(db, "B", "out")` (B->C), `"in"` (A->B, D->B), and `"both"` (union). AC3.5 calls `traverseGraph(db, "A", 3)` and verifies it terminates and B appears only once despite the D->B cycle. AC3.6 calls on node E (no edges) and asserts empty array. AC3.7 calls `traverseGraph(db, "A", 10)` and verifies results match depth=3. Also tests `graphSeededRetrieval` with keyword matching, empty keywords, and no-match keywords.

---

### graph-memory.AC4: Context assembly integration

| Criterion | Description | Type | Test File |
|-----------|-------------|------|-----------|
| AC4.1 | Graph-seeded retrieval injects connected memories from keyword seeds | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |
| AC4.2 | Recency fallback fills remaining slots when graph returns fewer than maxMemory | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |
| AC4.3 | Empty edges table produces identical output to current behavior | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |
| AC4.4 | Output format shows retrieval method (seed/graph/recency/pinned) | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |
| AC4.5 | Budget pressure reduces maxMemory to 3 with graph path | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |
| AC4.6 | No keyword matches in seeds falls back entirely to recency | unit | `packages/agent/src/__tests__/graph-memory-context.test.ts` |

**Test strategy (AC4):** Tests call `buildVolatileEnrichment()` directly, following the pattern in `packages/agent/src/__tests__/volatile-enrichment.test.ts`. AC4.1 seeds 5 memories with edges (A->B->C), sets `userMessage` to match A's key, and asserts `memoryDeltaLines` contain `[seed]` and `[depth N, relation]` tags. AC4.2 seeds 10 memories with only 3 connected, uses `maxMemory=8`, and verifies 3 graph entries plus 5 recency entries with `[recency]` tag. AC4.3 runs with zero rows in `memory_edges` and verifies output matches the existing delta+boost format (no graph-specific tags). AC4.4 parses every line in `memoryDeltaLines` and asserts one of `[pinned]`, `[seed]`, `[depth N, ...]`, or `[recency]`. AC4.5 calls with `maxMemory=3` (simulating budget pressure) and asserts at most 3 non-pinned entries. AC4.6 seeds memories and edges but uses a `userMessage` with keywords matching nothing; verifies pure recency output identical to AC4.3. Existing tests in `volatile-enrichment.test.ts` must also pass to confirm no regressions.

---

### graph-memory.AC5: Sync and edge lifecycle

| Criterion | Description | Type | Test File |
|-----------|-------------|------|-----------|
| AC5.1 | Edges replicate via sync (LWW reducer, change-log outbox) | unit | `packages/sync/src/__tests__/reducers.test.ts` |
| AC5.1 (changelog) | Edge writes generate change-log entries | unit | `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` |
| AC5.2 | `memory forget` cascades to soft-delete all edges referencing the key | unit | `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` |
| AC5.3 | Thread redaction cascades edge deletion for affected memories | unit | `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` |
| AC5.4 | Forgetting a key that is target of edges also cleans up those edges | unit | `packages/agent/src/__tests__/graph-memory-lifecycle.test.ts` |

**Test strategy (AC5):** AC5.1 has two test locations. In `reducers.test.ts`, a new case inside the existing `describe("applyLWWReducer")` block creates a `memory_edges` row via changelog event, then applies a later event with updated weight (verifies LWW wins) and an earlier event (verifies it is ignored). In `graph-memory-lifecycle.test.ts`, verifies changelog entries exist after `upsertEdge()` and `removeEdges()` calls. AC5.2 seeds memories A and B with edge A->B, calls `handleForget` for A, and verifies both memory A and edge A->B have `deleted = 1` while memory B is untouched. AC5.3 seeds a thread, creates a memory with `source = threadId`, creates edges from that memory, calls `redactThread()`, and verifies the memory and its edges are soft-deleted while unrelated memories/edges survive. AC5.4 seeds A, B, C with edges A->B and C->B, forgets B, and verifies both edges have `deleted = 1` while A and C are unaffected.

---

## Regression Tests

These are not new test files but existing tests that must continue to pass after each phase to confirm backward compatibility.

| Phase | Regression Suite | Command |
|-------|-----------------|---------|
| 1 | Core schema tests | `bun test packages/core/src/__tests__/schema.test.ts` |
| 1 | Sync test harness | `bun test packages/sync` |
| 2 | Agent command tests | `bun test packages/agent/src/__tests__/commands.test.ts` |
| 4 | Volatile enrichment tests | `bun test packages/agent/src/__tests__/volatile-enrichment.test.ts` |
| 4 | Context assembly tests | `bun test packages/agent/src/__tests__/context-assembly.test.ts` |
| 5 | Sync reducer tests | `bun test packages/sync/src/__tests__/reducers.test.ts` |
| All | Full suite | `bun test packages/core packages/agent packages/sync` |

---

## Human Verification

### HV-1: Agent behavioral transition (relates to AC2, design "Additional Considerations")

**Justification:** The removal of `memorize` and `forget` as top-level commands is a breaking change for the agent's learned behavior. No automated test can verify that the LLM adapts to using `memory store` and `memory forget` instead, because the LLM's tool selection depends on the system prompt, prior conversation context, and model behavior that varies across providers.

**Verification approach:**
1. After deploying Phase 2, confirm the system prompt / persona.md references the `memory` command (not `memorize`/`forget`).
2. In a live interactive thread, ask the agent to remember something. Observe it uses `memory store` (not the removed `memorize`).
3. Trigger a scheduled task that previously used `memorize` in its payload. Confirm it either fails with "unknown command" and reschedules (expected), or the task payload has been updated to use `memory store`.
4. Verify the heartbeat consolidation task uses `memory connect` to build edges over time.

### HV-2: Gradual transition / day-one backward compatibility (relates to AC4.3, design "Additional Considerations")

**Justification:** AC4.3 is tested in isolation (empty edges table produces identical output), but the full deployment scenario -- where the agent starts with zero edges, the heartbeat task gradually builds edges via `memory connect`, and context assembly shifts from recency-heavy to graph-heavy over days -- cannot be replicated in a unit test. The transition timing depends on real agent behavior over multiple cycles.

**Verification approach:**
1. Deploy the full feature with zero edges in production.
2. Monitor the first few context assembly runs and confirm they produce output identical to pre-deployment (pure recency, no graph tags).
3. After the heartbeat task has run several cycles and created edges, verify context assembly output now includes `[seed]` and `[depth N, relation]` tagged entries.
4. Confirm no regression in context quality (memories surfaced are relevant to the conversation).

### HV-3: Retrieval quality (relates to AC4.1, AC4.2)

**Justification:** Automated tests verify that graph traversal mechanically returns the correct nodes. They cannot verify that the retrieved memories are actually more relevant to the agent's task than pure recency retrieval. Retrieval quality is subjective and depends on the edge structure the agent builds over time.

**Verification approach:**
1. After edges have accumulated (post HV-2 step 3), review the context debug output (`GET /api/threads/:id/context-debug`) for several interactive threads.
2. Compare graph-retrieved entries against what pure recency would have returned. Assess whether the graph path surfaces memories that are topically related to the conversation.
3. If graph retrieval consistently misses relevant memories, evaluate whether the keyword extraction for seed finding is too narrow and consider expanding the seed selection logic.

### HV-4: Scheduled task payload migration (relates to AC2, design "Breaking change for agent behavior")

**Justification:** Existing scheduled tasks may have `memorize` or `forget` hardcoded in their payloads. These will fail with "unknown command" after Phase 2. Automated tests cannot discover task payloads in production databases.

**Verification approach:**
1. Before deploying Phase 2, query production: `SELECT id, trigger_spec, payload FROM tasks WHERE deleted = 0 AND (payload LIKE '%memorize%' OR payload LIKE '%forget%')`.
2. For each matching task, either update the payload to use `memory store`/`memory forget`, or accept that it will fail and reschedule (cron tasks will recover on next cycle).
3. After deployment, monitor task failure advisories for "unknown command" errors.

### HV-5: Cross-host edge sync (relates to AC5.1)

**Justification:** The unit test in `reducers.test.ts` verifies the LWW reducer handles `memory_edges` rows correctly in isolation. It does not verify that edges replicate end-to-end across two hosts through the full sync protocol (push/pull/ack phases, encryption, transport). A full integration test would require a multi-host test harness.

**Verification approach:**
1. In a two-host deployment (hub + spoke), create an edge on the spoke via `memory connect`.
2. Trigger a sync cycle and verify the edge appears on the hub.
3. Create an edge on the hub and verify it appears on the spoke after sync.
4. Verify edge updates (weight change) replicate correctly with LWW semantics.
5. Alternatively, if `hub-spoke-e2e.integration.test.ts` is available, extend it with a `memory_edges` scenario.

---

## Summary

| Category | Count |
|----------|-------|
| Acceptance criteria (total) | 27 |
| Mapped to automated tests | 27 |
| Requiring human verification | 5 (HV-1 through HV-5) |
| New test files | 5 |
| Modified test files | 2 |

All 27 acceptance criteria have automated test coverage. The 5 human verification items address deployment-time behavioral concerns (agent adaptation, gradual transition, retrieval quality, payload migration, cross-host sync) that cannot be fully replicated in isolated unit tests.
