# Graph Memory — Human Test Plan

**Implementation plan:** `docs/implementation-plans/2026-04-04-graph-memory/`
**Date:** 2026-04-04
**Automated tests:** 132 tests across 7 files (1050 total with core/agent/sync)

## Prerequisites

- The graph-memory branch deployed and running (`bun packages/cli/src/bound.ts start`)
- All automated tests passing: `bun test packages/core packages/agent packages/sync`
- Access to the web UI at `http://localhost:3000` (default)
- Access to the context debug endpoint: `GET /api/threads/:id/context-debug`

## Phase 1: Agent Behavioral Transition (HV-1)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Open the config directory and read `persona.md`. Search for references to `memorize` or `forget`. | No references to `memorize` or `forget` as standalone commands. References should use `memory store` and `memory forget` instead. |
| 1.2 | Open a new interactive thread in the web UI. Type: "Please remember that my preferred timezone is UTC+2." | The agent uses the `memory` tool with subcommand `store` (visible in the tool call trace). It does NOT attempt to call a standalone `memorize` command. |
| 1.3 | In the same thread, type: "Please forget my timezone preference." | The agent uses the `memory` tool with subcommand `forget`. It does NOT attempt to call a standalone `forget` command. |
| 1.4 | Query the tasks table for any scheduled tasks that reference `memorize` or `forget` in their payload: `SELECT id, trigger_spec, payload FROM tasks WHERE deleted = 0 AND (payload LIKE '%memorize%' OR payload LIKE '%forget%')` | Zero rows returned, or if rows exist, note the task IDs for manual payload migration (see HV-4). |
| 1.5 | Wait for the heartbeat task to run (check task status via `boundctl`). Review the thread it creates. | The heartbeat task uses `memory connect` to build edges between related memories. Tool calls should show `memory` with subcommand `connect`, not any standalone command. |

## Phase 2: Gradual Transition / Day-One Backward Compatibility (HV-2)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Immediately after deployment, query the memory_edges table: `SELECT COUNT(*) FROM memory_edges WHERE deleted = 0` | Zero rows (no edges exist yet). |
| 2.2 | Open the web UI. Start a new interactive thread and have a multi-turn conversation (3+ turns). After each turn, check context debug at `GET /api/threads/:id/context-debug`. | The "Memory" section in volatile context shows entries with the existing delta+provenance format (e.g., `via task "name"` / `via thread "title"`). No `[seed]`, `[depth N, relation]`, or `[recency]` tags are present. Output is identical to pre-deployment behavior. |
| 2.3 | Wait for the heartbeat task to run 3+ cycles (check via `SELECT COUNT(*) FROM memory_edges WHERE deleted = 0`). | Edge count should be > 0 and growing each cycle. |
| 2.4 | After edges exist, start another interactive thread. Ask about a topic covered by memories that have edges. Check context debug. | The "Memory" section now includes `[seed]` and `[depth N, relation]` tagged entries alongside `[recency]` entries. The header line shows `Memory: N entries (M via graph, K via recency)`. |

## Phase 3: Retrieval Quality Assessment (HV-3)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | After edges have accumulated (post HV-2 step 2.3), start 3 interactive threads on different topics the agent has memories about. | Threads should work normally; no errors or hangs. |
| 3.2 | For each thread, fetch context debug: `GET /api/threads/:id/context-debug`. Examine the "Memory" section. | Graph-retrieved entries (`[seed]` and `[depth N, relation]`) should be topically related to the conversation subject. |
| 3.3 | Compare the graph-retrieved entries against what pure recency would have returned (check the `modified_at` ordering of memories via `SELECT key, modified_at FROM semantic_memory WHERE deleted = 0 ORDER BY modified_at DESC LIMIT 10`). | Graph retrieval should surface memories that are semantically related but might not be the most recent. If graph consistently misses relevant memories, the keyword extraction for seed finding may need tuning. |

## Phase 4: Scheduled Task Payload Migration (HV-4)

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Before deploying, run against production DB: `SELECT id, trigger_spec, payload FROM tasks WHERE deleted = 0 AND (payload LIKE '%memorize%' OR payload LIKE '%forget%')` | Note any matching task IDs. |
| 4.2 | For each matching task, either update the payload to replace `memorize` with `memory store` and `forget` with `memory forget`, or document that the task will fail and reschedule on its next cron cycle. | Task payloads updated, or documentation created for expected transient failures. |
| 4.3 | After deployment, monitor advisories for 24 hours: `SELECT * FROM advisories WHERE title LIKE '%unknown command%' AND proposed_at > datetime('now', '-1 day')` | Zero "unknown command" advisories (if payloads were migrated), or expected transient failures from cron tasks that self-heal on the next cycle. |

## Phase 5: Cross-Host Edge Sync (HV-5)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | In a two-host deployment (hub + spoke), create an edge on the spoke via an interactive thread where the agent calls `memory connect`. | Edge appears in `memory_edges` on the spoke with `deleted = 0`. |
| 5.2 | Trigger a sync cycle (or wait for automatic sync). On the hub, query: `SELECT * FROM memory_edges WHERE deleted = 0 ORDER BY modified_at DESC LIMIT 5` | The edge created on the spoke appears on the hub with matching `source_key`, `target_key`, `relation`, and `weight`. |
| 5.3 | On the hub, create an edge (either via interactive thread or direct DB insert using `insertRow`). Trigger sync. On the spoke, query memory_edges. | The edge created on the hub appears on the spoke. |
| 5.4 | On the spoke, update an existing edge's weight (via `memory connect` with same source/target/relation but different weight). Trigger sync. On the hub, check the edge's weight. | Weight updated on hub matches the spoke's new weight (LWW by `modified_at`). |

## End-to-End: Full Graph Memory Lifecycle

1. Start a new interactive thread. Store 3 related memories: "Tell me about project-alpha, project-beta, and their shared database-layer."
2. Verify the agent creates memories via `memory store` (check `semantic_memory` table).
3. Wait for the heartbeat task to run. Verify it creates edges between related memories (check `memory_edges` table).
4. Start a new thread. Ask: "What do you know about project-alpha?" Check context debug -- graph retrieval should surface project-beta and database-layer via edges.
5. In the thread, ask the agent to forget project-alpha: "Forget everything about project-alpha."
6. Verify the agent calls `memory forget`, and that edges referencing project-alpha are cascade-deleted (check `memory_edges WHERE source_key = 'project_alpha' OR target_key = 'project_alpha'` -- all should have `deleted = 1`).
7. Start another thread and ask about project-alpha. The agent should have no memory of it, and no edges should be traversed to/from it.

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 Deterministic edge UUID | graph-memory-edges.test.ts | -- |
| AC1.2 Non-default weight | graph-memory-edges.test.ts | -- |
| AC1.3 Reconnect updates weight/time | graph-memory-edges.test.ts | -- |
| AC1.4 Soft-delete by relation | graph-memory-edges.test.ts | -- |
| AC1.5 Soft-delete all edges | graph-memory-edges.test.ts | -- |
| AC1.6 Nonexistent key error | graph-memory-edges.test.ts | -- |
| AC1.7 Restore soft-deleted edge | graph-memory-edges.test.ts | -- |
| AC1.8 Change-log entries | graph-memory-edges.test.ts | -- |
| AC2.1 memory store | commands.test.ts | HV-1 step 1.2 |
| AC2.2 memory forget | commands.test.ts | HV-1 step 1.3 |
| AC2.3 memory search | graph-memory-search.test.ts | -- |
| AC2.4 All 7 subcommands | commands.test.ts + edges/traversal tests | HV-1 steps 1.2, 1.3, 1.5 |
| AC2.5 Unknown subcommand error | commands.test.ts | -- |
| AC2.6 Restore soft-deleted key | commands.test.ts | -- |
| AC3.1 Default depth-2 traversal | graph-memory-traversal.test.ts | -- |
| AC3.2 Depth parameter limits | graph-memory-traversal.test.ts | -- |
| AC3.3 Relation filter | graph-memory-traversal.test.ts | -- |
| AC3.4 Neighbors with direction | graph-memory-traversal.test.ts | -- |
| AC3.5 Cycle safety | graph-memory-traversal.test.ts | -- |
| AC3.6 No-edges empty result | graph-memory-traversal.test.ts | -- |
| AC3.7 Depth clamping | graph-memory-traversal.test.ts | -- |
| AC4.1 Graph-seeded retrieval | graph-memory-context.test.ts | HV-3 steps 3.1-3.3 |
| AC4.2 Recency fallback | graph-memory-context.test.ts | HV-2 step 2.4 |
| AC4.3 Empty edges = current behavior | graph-memory-context.test.ts | HV-2 step 2.2 |
| AC4.4 Retrieval method tags | graph-memory-context.test.ts | HV-2 step 2.4 |
| AC4.5 Budget pressure maxMemory=3 | graph-memory-context.test.ts | -- |
| AC4.6 No keyword match fallback | graph-memory-context.test.ts | -- |
| AC5.1 Edge sync via LWW | reducers.test.ts + lifecycle.test.ts | HV-5 steps 5.1-5.4 |
| AC5.2 Forget cascades edges | graph-memory-lifecycle.test.ts | E2E step 6 |
| AC5.3 Redaction cascades edges | graph-memory-lifecycle.test.ts | -- |
| AC5.4 Target key cascade | graph-memory-lifecycle.test.ts | -- |
