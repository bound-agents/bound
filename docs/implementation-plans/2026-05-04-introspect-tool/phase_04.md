# Introspect Tool Implementation Plan — Phase 4: Cross-Host & Integration Testing

**Goal:** Verify end-to-end flow with integration tests using real DB and mock LLM, and verify cross-host operation by confirming metadata writes generate changelog entries (which is how sync propagates them).

**Architecture:** Integration test simulates the full introspect round-trip: caller dispatches → target processes → hook stamps → caller detects response. Cross-host is proven by verifying `change_log` entries exist for all metadata writes (messages table is synced, so changelog entries = cross-host propagation).

**Tech Stack:** TypeScript, bun:sqlite (in-memory), bun:test

**Scope:** 4 phases from original design (phase 4 of 4)

**Codebase verified:** 2026-05-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### introspect-tool.AC4: Post-Loop Hook Behavior
- **introspect-tool.AC4.3 Edge:** Hook does not stamp when target turn produces no assistant message (error before output)

### introspect-tool.AC5: Cross-Host
- **introspect-tool.AC5.1 Success:** Request reaches remote host via relay forwarding (same path as notify)
- **introspect-tool.AC5.2 Success:** Response metadata syncs back to calling host via changelog, caller detects it

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Integration test for full introspect round-trip

**Verifies:** introspect-tool.AC4.3, introspect-tool.AC5.1, introspect-tool.AC5.2

**Files:**
- Create: `packages/agent/src/tools/__tests__/introspect.integration.test.ts`

**Implementation:**

Create an integration test file following the pattern from `packages/agent/src/__tests__/built-in-tools-integration.test.ts`. Use a real in-memory SQLite database with full schema.

**Test setup:**
```typescript
import { Database } from "bun:sqlite";
import { applySchema } from "@bound/core";
import { applyMetricsSchema } from "@bound/core";
import { insertRow, updateRow, writeMessageMetadata, readMessageMetadata } from "@bound/core";
import { enqueueNotification } from "@bound/core";
import { createIntrospectTool, runIntrospectResponseStamp } from "../introspect";
import { randomUUID } from "crypto";
```

Database: `new Database(":memory:")` + `applySchema(db)` + `applyMetricsSchema(db)`

Minimal ToolContext with real db, event capture array, and `threadId: "caller-thread"`.

Seed data: two threads ("caller-thread" and "target-thread") via `insertRow()`.

**Test scenarios:**

1. **Full round-trip flow** (AC5.1 + AC5.2):
   - Call `tool.execute({ thread_id: "target-thread", message: "What is the meaning?", timeout: 5000 })`
   - Concurrently (after 50ms delay):
     a. Extract `correlationId` from dispatch_queue
     b. Simulate notification injection: insert developer-role message with `metadata: JSON.stringify({ introspect_id: correlationId })`
     c. Insert an assistant-role message in target-thread (simulates target responding)
     d. Call `runIntrospectResponseStamp({ db, siteId, threadId: "target-thread", turnStartAt })` (simulates post-loop hook)
   - Verify: execute resolves with the assistant message content
   - Verify cross-host (AC5.2): Query `SELECT * FROM change_log WHERE table_name = 'messages'` — verify entries exist for:
     - The assistant message insert (from insertRow)
     - The metadata update on the assistant message (from writeMessageMetadata via the hook)
   - The existence of changelog entries proves that if sync were running, the metadata would propagate to the calling host

2. **AC5.1 — Request dispatch generates sync-visible entry:**
   - Call execute (with short timeout so it returns quickly)
   - Query `SELECT * FROM change_log WHERE table_name = 'messages'` for the injected developer-role message
   - This proves relay forwarding works: the notification injection uses `insertRow()` which generates changelog entries that sync propagates across hosts

3. **AC4.3 — Hook no-op when no assistant message:**
   - Insert developer-role message with `introspect_id` in target-thread
   - Do NOT insert any assistant message
   - Call `runIntrospectResponseStamp({ db, siteId, threadId: "target-thread", turnStartAt })`
   - Verify: no errors thrown, no metadata updates written
   - Query change_log to confirm no UPDATE changelog entry was generated for any message metadata

**Test helpers:**
- `simulateTargetResponse(correlationId)`: inserts dev message + assistant message + runs hook
- `extractCorrelationId(threadId)`: queries dispatch_queue, parses payload JSON

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.integration.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add integration test for introspect tool full round-trip`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Verify existing unit tests still pass end-to-end

**Files:**
- No new files — verification only

**Implementation:**

Run the full test suite for affected packages to ensure no regressions from all 4 phases:

**Verification:**
Run: `bun test packages/agent packages/core packages/cli`
Expected: All tests pass (including all new introspect tests from phases 1-4)

Run: `bun run typecheck`
Expected: No type errors across all packages

**Commit:** No commit needed — verification only
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
