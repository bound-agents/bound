# Edge Graph Normalization — Human Test Plan

## Prerequisites

- Bound built and installed: `bun run build && cp ./dist/bound* ~/.local/bin/`
- Automated tests passing (70/70):
  ```bash
  bun test packages/core/src/__tests__/memory-edges-schema.test.ts \
    packages/core/src/__tests__/normalize-edge-relations.test.ts \
    packages/agent/src/__tests__/graph-memory-edges.test.ts \
    packages/sync/src/__tests__/edge-context-sync.integration.test.ts
  ```
- Access to hub node (`polaris.karashiiro.moe`) and at least one spoke

## Phase 1: Bootstrap Integration Verification

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `packages/cli/src/commands/start/bootstrap.ts` | File exists and is readable |
| 2 | Locate the `clearColumnCache()` call (line 134) | Called immediately after `createAppContext()` returns, inside the same try block, before any sync or agent operations |
| 3 | Verify the import on line 21 | `clearColumnCache` is imported from `@bound/sync` |
| 4 | Locate the `normalizeEdgeRelations()` call (line 216) | Called at step 5.6, after `seedSkillAuthoring` (step 5.5) and after `createAppContext` (which runs `applySchema` internally) |
| 5 | Verify the call is wrapped in try/catch (lines 215-224) | Failure logs a warning via `appContext.logger.warn` but does not crash startup |
| 6 | Verify the log line on line 217-219 | Logs `"[edges] Normalized edge relations"` with the summary object |

## Phase 2: Single-Source-of-Truth Verification

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open `packages/core/src/memory-relations.ts` | `CANONICAL_RELATIONS` array is defined here (10 entries), along with `isCanonicalRelation()` and `InvalidRelationError` |
| 2 | Open `packages/core/src/schema.ts` | Imports `CANONICAL_RELATIONS` from `./memory-relations` to build the trigger SQL |
| 3 | Open `packages/agent/src/graph-queries.ts` | Imports `isCanonicalRelation` and `InvalidRelationError` from `@bound/core` |
| 4 | Search entire repo for any parallel definition of the canonical list | `grep -r "contrasts-with.*competes-with" --include="*.ts"` should only find `memory-relations.ts`, `schema.ts` (trigger SQL), test files, and `normalize-edge-relations.test.ts` helper. No other production module should define its own list |

## Phase 3: First Startup After Deploy

| Step | Action | Expected |
|------|--------|----------|
| 1 | Stop the running bound process on spoke | Process exits cleanly |
| 2 | Deploy the new binary to the spoke | Binary replaced at `~/.local/bin/bound` |
| 3 | Start bound: `bound start` from `~/bound/` | Process starts without errors |
| 4 | Check startup logs for `[edges] Normalized edge relations` | Log line present with non-zero counts if non-canonical edges existed (e.g., `variants_mapped: N, moved_to_context: M, collisions_merged: K, total_scanned: T`) |
| 5 | Query the database: `sqlite3 ~/bound/data/bound.db "SELECT relation, context, deleted FROM memory_edges WHERE deleted = 0 LIMIT 20"` | All `relation` values are one of the 10 canonical relations. Rows that were previously bespoke have `context` containing the original relation string |
| 6 | Stop and restart bound again | Startup logs show `[edges] Normalized edge relations` with all-zero counts (idempotency confirmed) |

## Phase 4: Live Agent Interaction

| Step | Action | Expected |
|------|--------|----------|
| 1 | In a thread, ask the agent to run: `memory connect scheduler_v3 cron_rescheduling informs --context "both handle recurring scheduled work"` | Agent reports edge created successfully; output includes `context="both handle recurring scheduled work"` |
| 2 | Ask the agent to run: `memory neighbors scheduler_v3` | Output shows `cron_rescheduling [informs, w=1.0 (both handle recurring scheduled work)]` |
| 3 | Ask the agent to run: `memory connect scheduler_v3 cron_rescheduling free-text-relation` | Agent returns error listing the 10 valid relations and hints at using `--context` |
| 4 | Ask the agent to run: `memory connect scheduler_v3 cron_rescheduling related_to --context "durable execution pattern"` | Edge created with `related_to` relation and context preserved |
| 5 | Ask the agent to run: `memory traverse scheduler_v3 --depth 2` | Traverse output includes context in parentheses for edges that have it; omits parenthetical for those without |

## End-to-End: Multi-Node Convergence

**Purpose:** Validate that edge normalization and sync produce consistent state across hub and spoke nodes.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Deploy new binary to both hub and spoke | Both nodes running new code |
| 2 | Restart hub first, then spoke | Both show normalization log lines |
| 3 | On spoke, create an edge: `memory connect key_a key_b supports --context "implementation dependency"` | Edge created on spoke |
| 4 | Wait 30 seconds for sync replication | Sync completes without errors |
| 5 | On hub, query: `sqlite3 data/bound.db "SELECT context FROM memory_edges WHERE source_key='key_a' AND target_key='key_b'"` | Returns `implementation dependency` |
| 6 | Check spoke sync logs for any `memory_edges` errors | No trigger errors or reducer failures related to `memory_edges` |
| 7 | Compare non-deleted edge counts on both nodes: `SELECT COUNT(*) FROM memory_edges WHERE deleted = 0` | Counts match (or differ only by edges created since last sync) |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC1.5 -- clearColumnCache bootstrap integration | Call ordering in `bootstrap.ts` is a code-review concern; automated tests cover the functional outcome but not placement correctness | Phase 1, Steps 2-3 |
| AC2.1 -- Bootstrap ordering guarantee | `normalizeEdgeRelations` must run after `applySchema()` but the call site is in `bootstrap.ts` | Phase 1, Steps 4-5 |
| AC2.5 -- Startup log output | Log formatting is a bootstrap integration point | Phase 3, Steps 4 and 6 |
| AC2.8 -- Multi-node convergence under real sync | Automated test validates determinism but not real WebSocket sync with overlapping normalization | End-to-End scenario, Steps 1-7 |
| AC3.4 -- Single source of truth (structural) | Import chain is verified by reading code, not runtime test | Phase 2, Steps 1-4 |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `memory-edges-schema.test.ts` -- "Fresh DB has context column and triggers" | -- |
| AC1.2 | `memory-edges-schema.test.ts` -- "ALTER TABLE adds context column" | -- |
| AC1.3 | `memory-edges-schema.test.ts` -- "Triggers are created idempotently" | -- |
| AC1.4 | `memory-edges-schema.test.ts` -- "applySchema is idempotent" | -- |
| AC1.5 | `edge-context-sync.integration.test.ts` -- clearColumnCache in beforeEach | Phase 1, Steps 2-3 |
| AC2.1 | `normalize-edge-relations.test.ts` -- "spelling variant mapping" | Phase 1, Steps 4-5 |
| AC2.2 | `normalize-edge-relations.test.ts` -- "maps related_to variants" + "maps other canonical variants" | -- |
| AC2.3 | `normalize-edge-relations.test.ts` -- "rewrites bespoke relations" + "joins new context with existing" | -- |
| AC2.4 | `normalize-edge-relations.test.ts` -- "emits changelog entries" | -- |
| AC2.5 | `normalize-edge-relations.test.ts` -- "returns correct counts" | Phase 3, Steps 4 and 6 |
| AC2.6 | `normalize-edge-relations.test.ts` -- "merges variant collision" + "merges bespoke collision" + "deduplicates context" | -- |
| AC2.7 | `normalize-edge-relations.test.ts` -- "second run returns all zeros" | Phase 3, Step 6 |
| AC2.8 | `normalize-edge-relations.test.ts` -- "two independent normalizations converge" | End-to-End scenario |
| AC3.1 | `graph-memory-edges.test.ts` -- "should throw InvalidRelationError" + no row + no changelog | -- |
| AC3.2 | `memory-edges-schema.test.ts` -- "direct INSERT with non-canonical relation raises trigger error" | -- |
| AC3.3 | `memory-edges-schema.test.ts` -- "UPDATE SET relation to non-canonical value raises trigger error" | -- |
| AC3.4 | `memory-edges-schema.test.ts` -- "trigger SQL reflects CANONICAL_RELATIONS exactly" | Phase 2, Steps 1-4 |
| AC4.1 | `graph-memory-edges.test.ts` -- "should accept and persist context via --context flag" | Phase 4, Step 1 |
| AC4.2 | `graph-memory-edges.test.ts` -- "error message should list valid relations" + "hint at --context" | Phase 4, Step 3 |
| AC4.3 | `graph-memory-edges.test.ts` -- "should include context in traverse/neighbors output" | Phase 4, Steps 2 and 5 |
| AC4.4 | `graph-memory-edges.test.ts` -- "should allow memory connect without --context flag" | -- |
| AC5.1 | `edge-context-sync.integration.test.ts` -- "Context column replicates correctly" | End-to-End, Steps 3-5 |
| AC5.2 | `edge-context-sync.integration.test.ts` -- "Trigger fires on replay of non-canonical relation" | End-to-End, Step 6 |
| AC5.3 | `edge-context-sync.integration.test.ts` -- "FULL_SCHEMA includes context column and triggers" | -- |
