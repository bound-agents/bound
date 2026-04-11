# Hierarchical Memory Retrieval — Human Test Plan

**Feature:** Hierarchical memory retrieval with four-tier system (pinned/summary/default/detail)
**Date:** 2026-04-10
**Automated coverage:** 36/36 acceptance criteria covered by automated tests

## Prerequisites

- Bound running locally via `bun packages/cli/src/bound.ts start` (or compiled binary)
- Web UI accessible at `http://localhost:3001`
- All automated tests passing: `bun test packages/core packages/agent --recursive`
- At least one model backend configured and operational

## Phase 1: Memory Store Tier Assignment

| Step | Action | Expected |
|------|--------|----------|
| 1 | In a thread, ask the agent to store a memory: "Remember that project Alpha uses Kubernetes. Store this as a summary." | Agent calls `memory store project_alpha_infra "Project Alpha uses Kubernetes" --tier summary`. Memory created with `tier = 'summary'` visible in DB |
| 2 | Ask the agent to store a plain memory: "Remember that I prefer dark mode." | Agent calls `memory store` without `--tier`. DB row has `tier = 'default'` |
| 3 | Ask the agent to store a standing instruction: "From now on, always use formal language." | Agent stores with `_standing:` prefix key. DB row has `tier = 'pinned'` regardless of any tier the agent may attempt to set |
| 4 | Ask the agent to update an existing memory value without changing tier: "Update the project Alpha memory with: Project Alpha migrated to EKS." | DB row retains its previous tier (e.g. `summary`) and value is updated |

## Phase 2: Forget/Connect/Disconnect Tier Transitions

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a summary memory S and two detail children C1, C2 via the agent. Verify edges exist with `memory traverse S` | Three memories visible, summarizes edges shown in traversal output |
| 2 | Ask the agent to forget S: "Forget the summary memory S." | S soft-deleted. C1 and C2 promoted from `detail` to `default` in DB. Summarizes edges tombstoned (deleted=1) |
| 3 | Create two default memories A and B. Ask agent to connect them: "Connect A to B with relation summarizes." | B's tier changes from `default` to `detail` in DB |
| 4 | With the connection from step 3, ask: "Disconnect A from B." | B promoted back from `detail` to `default` (no remaining summarizes parents) |

## Phase 3: Hierarchical Retrieval in Context

| Step | Action | Expected |
|------|--------|----------|
| 1 | Populate 3 pinned memories, 1 summary with 2 clean children, and 5 default memories. Start a new thread and send a message | Context debug (via `/api/threads/:id/context-debug`) shows L0 with pinned entries, L1 with summary, children excluded from L2/L3 |
| 2 | Update one of the summary's children so its `modified_at` is newer than the summary | In the next turn's context, the stale child appears in L1 with `[stale-detail]` annotation alongside the summary |
| 3 | Verify ordering in the volatile context section of any assembled context | Pinned entries appear first, then summaries/stale-details, then graph-seeded, then recency entries |

## Phase 4: Budget Pressure Shedding

| Step | Action | Expected |
|------|--------|----------|
| 1 | Populate many memories (20+ default, 5+ pinned, 3+ summary). Create a very long thread conversation that fills most of the context window | Under budget pressure: L3 (recency) entries disappear from context, L2 capped at 5, all L0 (pinned) and L1 (summary) entries remain |
| 2 | Create 25+ pinned+summary entries. Send a message in a small-context-window scenario | Warning logged about L0+L1 exceeding budget, but no entries truncated. Agent still functions |

## Phase 5: Migration and Backward Compatibility

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start bound against an existing database that was created before this feature (no `tier` column) | Startup succeeds. `PRAGMA table_info(semantic_memory)` shows `tier` column. Pre-existing `_standing:*`, `_feedback:*`, `_policy:*`, `_pinned:*` entries have `tier = 'pinned'`. All other entries have `tier = 'default'` |
| 2 | Restart bound against the same database | No errors. Tier values unchanged (idempotent) |
| 3 | With NO summary-tier entries in the database, verify memory context in a thread | Output is identical to pre-feature behavior: pinned entries first, then graph-seeded, then recency. No regressions in existing memory retrieval |

## End-to-End: Full Hierarchy Lifecycle

**Purpose:** Validate the complete lifecycle from creation through retrieval to deletion of a hierarchical memory structure.

1. Start a fresh thread. Ask the agent to memorize 3 related facts about a topic (e.g., "TypeScript generics", "TypeScript type guards", "TypeScript mapped types")
2. Ask the agent to create a summary: "Create a summary memory called 'typescript_type_system' that summarizes the three TypeScript memories, and connect them with summarizes edges"
3. Verify via DB or `memory traverse typescript_type_system` that all edges exist and children are `detail` tier
4. Send a new message in the thread asking about TypeScript. Verify the summary appears in context (via context-debug) but the 3 detail children are suppressed
5. Update one of the detail children: "Update the type guards memory with new information about discriminated unions"
6. Send another message. Verify the stale child now appears alongside the summary with `[stale-detail]` tag
7. Ask the agent to forget the summary. Verify all 3 children promoted back to `default`, edges tombstoned
8. Send another message. Verify all 3 children now appear normally in L2/L3 retrieval (no longer suppressed)

## End-to-End: Multi-Host Sync of Tier Data

**Purpose:** Validate that tier column changes and summarizes edges replicate correctly between hub and spoke.

1. On spoke A, create a memory with `tier = 'summary'` and a child with `tier = 'detail'`, connected by a `summarizes` edge
2. Trigger sync cycle (wait for automatic or force via SIGHUP)
3. On spoke B (or hub), query `semantic_memory` and `memory_edges` tables
4. Verify: the summary entry has `tier = 'summary'`, the child has `tier = 'detail'`, and the `summarizes` edge exists with `deleted = 0`
5. On spoke A, forget the summary
6. After sync, verify on spoke B: summary soft-deleted, child promoted to `default`, edges tombstoned

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| Context quality with hierarchy | Subjective assessment of whether summaries meaningfully compress detail entries and the agent's responses improve | Read agent responses in threads where hierarchical memory is active. Verify summaries are referenced naturally and stale-detail annotations trigger appropriate agent behavior |
| Agent tier assignment behavior | Verify the agent chooses appropriate tiers when storing memories organically (not prompted) | Run the agent in normal operation across several conversations. Monitor DB tier assignments. Verify the agent uses `summary` tier when creating overviews and `detail` tier is assigned via connect, not directly |
| Budget pressure UX | Verify degraded context under pressure is graceful | Create a scenario with many memories and a long conversation history. Verify the agent does not produce confused or contradictory responses when L3 is shed |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | memory-tier-store.test.ts: "AC1.1" | Phase 1, Step 1 |
| AC1.2 | memory-tier-store.test.ts: "AC1.2" | Phase 1, Step 2 |
| AC1.3 | memory-tier-store.test.ts: "AC1.3" | Phase 1, Step 3 |
| AC1.4 | memory-tier-store.test.ts: "AC1.4" | Phase 1, Step 3 |
| AC1.5 | memory-tier-store.test.ts: "AC1.5" | Phase 1, Step 4 |
| AC1.6 | memory-tier-store.test.ts: "AC1.6" | Phase 1, Step 4 |
| AC2.1 | memory-tier-forget.test.ts: "AC2.1" | Phase 2, Step 2 |
| AC2.2 | memory-tier-forget.test.ts: "AC2.2" | Phase 2, Step 2 |
| AC2.3 | memory-tier-connect.test.ts: "AC2.3" | Phase 2, Step 3 |
| AC2.4 | memory-tier-connect.test.ts: "AC2.4" | Phase 2, Step 3 |
| AC2.5 | memory-tier-connect.test.ts: "AC2.5" | Phase 2, Step 3 |
| AC2.6 | memory-tier-disconnect.test.ts: "AC2.6" | Phase 2, Step 4 |
| AC2.7 | memory-tier-disconnect.test.ts: "AC2.7" | Phase 2, Step 4 |
| AC2.8 | memory-tier-connect.test.ts: "AC2.8" | -- |
| AC3.1 | stage-functions.test.ts: "AC3.1" | Phase 3, Step 1 |
| AC3.2 | stage-functions.test.ts: "AC3.2" | Phase 3, Step 1 |
| AC3.3 | stage-functions.test.ts: "AC3.3" | Phase 3, Step 2 |
| AC3.4 | stage-functions.test.ts: "AC3.4" | Phase 3, Step 2 |
| AC3.5 | stage-functions.test.ts: "AC3.5" | Phase 3, Step 1 |
| AC3.6 | stage-functions.test.ts + hierarchical-memory-compat.test.ts | Phase 3, Step 1 |
| AC3.7 | stage-functions.test.ts: "AC3.7" | Phase 3, Step 1 |
| AC4.1 | pipeline-orchestrator.test.ts + hierarchical-memory-compat.test.ts | Phase 5, Step 3 |
| AC4.2 | pipeline-orchestrator.test.ts: "AC4.2" | Phase 3, Step 1 |
| AC4.3 | pipeline-orchestrator.test.ts: "AC4.3" | Phase 3, Step 2 |
| AC4.4 | pipeline-orchestrator.test.ts + hierarchical-memory-compat.test.ts | Phase 3, Step 3 |
| AC4.5 | pipeline-orchestrator.test.ts: "AC4.5" | Phase 4, Step 1 |
| AC4.6 | pipeline-orchestrator.test.ts: "AC4.6" | Phase 3, Step 3 |
| AC5.1 | memory-shedding.test.ts + context-assembly.test.ts | Phase 4, Step 1 |
| AC5.2 | memory-shedding.test.ts + context-assembly.test.ts | Phase 4, Step 1 |
| AC5.3 | memory-shedding.test.ts + context-assembly.test.ts | Phase 4, Step 1 |
| AC5.4 | memory-shedding.test.ts + context-assembly.test.ts | Phase 4, Step 2 |
| AC5.5 | memory-shedding.test.ts | -- |
| AC6.1 | tier-migration.test.ts: "AC6.1" | Phase 5, Steps 1-2 |
| AC6.2 | tier-migration.test.ts: "AC6.2" | Phase 5, Step 1 |
| AC6.3 | tier-migration.test.ts: "AC6.3" | Phase 5, Step 1 |
| AC6.4 | tier-migration.test.ts: "AC6.4" | Phase 5, Step 2 |
| AC6.5 | hierarchical-memory-sync.test.ts: "AC6.5" | E2E Multi-Host Sync |
| AC6.6 | hierarchical-memory-sync.test.ts: "AC6.6" | E2E Multi-Host Sync |
