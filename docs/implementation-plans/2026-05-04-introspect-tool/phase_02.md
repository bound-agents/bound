# Introspect Tool Implementation Plan — Phase 2: Polling Loop & Response Detection

**Goal:** Caller blocks after dispatch and detects the target's response via metadata correlation, with timeout handling and early termination on error/abort.

**Architecture:** Replace the Phase 1 placeholder return with an await_event-style polling loop. After enqueuing the notification, poll the messages table for a row whose metadata contains `introspect_response_id` matching the correlation ID. Also poll the turns table to detect early failure (error/aborted status).

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 2 of 4)

**Codebase verified:** 2026-05-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### introspect-tool.AC2: Request Dispatch & Wakeup
- **introspect-tool.AC2.2 Success:** Target thread wakes, processes request as developer-role message, produces assistant response, and response is stamped with `introspect_response_id` in metadata
- **introspect-tool.AC2.3 Success:** Caller detects stamped response and returns assistant message content

### introspect-tool.AC3: Timeout & Error Handling
- **introspect-tool.AC3.1 Failure:** Caller returns timeout error when no response within configured timeout
- **introspect-tool.AC3.2 Failure:** Caller detects target turn with `status = 'error'` and returns early with error message
- **introspect-tool.AC3.3 Failure:** Caller detects target turn with `status = 'aborted'` and returns early with error message

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Implement polling loop in introspect tool execute function

**Verifies:** introspect-tool.AC2.2, introspect-tool.AC2.3, introspect-tool.AC3.1, introspect-tool.AC3.2, introspect-tool.AC3.3

**Files:**
- Modify: `packages/agent/src/tools/introspect.ts`

**Implementation:**

Replace the Phase 1 placeholder success return with a polling loop following the `await-event.ts` pattern (`packages/agent/src/tools/await-event.ts` lines 41-75).

After the `enqueueNotification()` call and event emission, add:

1. **Constants:**
   - `POLL_INTERVAL_MS = 2000` (2 seconds, matches await_event)
   - `DEFAULT_TIMEOUT_MS = 300000` (5 minutes, matches await_event)

2. **Timeout setup:**
   - `const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS`
   - `const startTime = Date.now()`
   - Record `const dispatchTime = new Date(Date.now() - 5000).toISOString()` — 5-second clock-skew buffer for cross-host scenarios where the target host's clock may be slightly behind the caller

3. **Polling loop** (`while (true)`):

   a. **Check for response stamp:** Query messages where metadata contains `introspect_response_id` matching our `correlationId`. Pattern from Discord connector — query messages with `metadata IS NOT NULL` for the target thread created after dispatch, parse each in JS:
   ```typescript
   const candidates = ctx.db
     .query("SELECT id, content, metadata FROM messages WHERE thread_id = ? AND role = 'assistant' AND metadata IS NOT NULL AND created_at >= ? AND deleted = 0")
     .all(input.thread_id, dispatchTime) as Array<{ id: string; content: string; metadata: string }>;
   
   for (const row of candidates) {
     try {
       const meta = JSON.parse(row.metadata) as Record<string, unknown>;
       // Handle both single string and array format (multiple introspect requests per turn)
       if (meta.introspect_response_id === correlationId ||
           (Array.isArray(meta.introspect_response_id) && meta.introspect_response_id.includes(correlationId))) {
         return row.content; // BuiltInToolResult — the target's assistant message
       }
     } catch {
       // malformed metadata, skip
     }
   }
   ```

   b. **Check for target turn error/abort:** Query turns for the target thread created after dispatch:
   ```typescript
   const latestTurn = ctx.db
     .query("SELECT status FROM turns WHERE thread_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
     .get(input.thread_id, dispatchTime) as { status: string | null } | null;
   
   if (latestTurn?.status === "error") {
     return `Error: Target thread encountered an error during processing.`;
   }
   if (latestTurn?.status === "aborted") {
     return `Error: Target thread's turn was aborted.`;
   }
   ```

   c. **Timeout check:**
   ```typescript
   if (Date.now() - startTime >= timeout) {
     return `Error: Introspect request timed out after ${timeout}ms waiting for response from thread ${input.thread_id}.`;
   }
   ```

   d. **Sleep:**
   ```typescript
   await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
   ```

**Key design notes:**
- The response detection (step a) runs BEFORE error detection (step b). This handles the case where a turn completes successfully but the status check would see "ok" (harmless) — we want to find the stamp first.
- The error/abort check looks for turns created AFTER dispatch time, so historical errors don't trigger false positives.
- Content is returned as-is from the DB. The `messages.content` field stores the serialized content which is what the caller expects.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.test.ts`
Expected: All tests pass (Phase 1 tests still pass + new Phase 2 tests from Task 2)

**Commit:** `feat(agent): add polling loop and response detection to introspect tool`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Unit tests for polling loop, timeout, and error detection

**Verifies:** introspect-tool.AC2.2, introspect-tool.AC2.3, introspect-tool.AC3.1, introspect-tool.AC3.2, introspect-tool.AC3.3

**Files:**
- Modify: `packages/agent/src/tools/__tests__/introspect.test.ts`

**Testing:**

Add a new `describe("polling loop")` block. Tests must verify each AC:

- **introspect-tool.AC2.2 + AC2.3:** Successful round-trip detection — insert a target thread, call execute (it starts polling), then use a short setTimeout to insert a message with `metadata = JSON.stringify({ introspect_response_id: correlationId })` into the target thread's messages table (simulating the post-loop hook stamping). The execute call should resolve with that message's content. Use a short timeout (e.g., 5000ms) and extract the correlationId from the dispatch_queue entry's payload.

- **introspect-tool.AC3.1:** Timeout — call execute with `timeout: 100` (100ms). Don't insert any response. Verify result contains "timed out" error message.

- **introspect-tool.AC3.2:** Error turn detection — insert a target thread, call execute (starts polling), then shortly after insert a turn with `status: "error"` for the target thread with `created_at` after dispatch time. Verify result contains error message about target thread encountering an error.

- **introspect-tool.AC3.3:** Abort turn detection — same pattern as AC3.2 but insert turn with `status: "aborted"`. Verify result contains error about target thread's turn being aborted.

**Test helpers needed:**
- Helper to extract `correlationId` from dispatch_queue: `SELECT event_payload FROM dispatch_queue WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`, parse JSON, get `correlation_id`
- Async insertion helper that runs after a small delay (50-100ms) to simulate the target responding while the caller polls

**Important test pattern:** Since the polling loop is async, use concurrent operations. Start the execute() call (it returns a Promise), then while it's polling, insert the response/turn data. The Promise resolves when the poll detects the data.

```typescript
// Pattern for concurrent test:
const executePromise = tool.execute({ thread_id: "target", message: "question", timeout: 5000 });

// Small delay to ensure poll started
await new Promise(r => setTimeout(r, 50));

// Insert response data (simulates post-loop hook)
const correlationId = /* extract from dispatch_queue */;
insertRow(db, "messages", {
  id: randomUUID(),
  thread_id: "target",
  role: "assistant",
  content: "The answer is 42",
  metadata: JSON.stringify({ introspect_response_id: correlationId }),
  // ... other required fields
}, "test-site");

const result = await executePromise;
expect(result).toBe("The answer is 42");
```

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add polling loop and timeout tests for introspect tool`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
