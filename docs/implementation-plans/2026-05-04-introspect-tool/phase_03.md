# Introspect Tool Implementation Plan — Phase 3: Post-Loop Response Stamp Hook

**Goal:** After the target thread completes its turn, stamp the last assistant message with the correlation metadata so the caller's polling loop can detect it.

**Architecture:** A post-loop hook function (following delivery-check pattern) that runs after the agent loop drain. It finds developer-role messages with `introspect_id` metadata in the turn window, then stamps the last assistant message with `introspect_response_id`. Also includes the injection-time metadata write that tags the notification message with `introspect_id` when it enters the target thread.

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** 4 phases from original design (phase 3 of 4)

**Codebase verified:** 2026-05-04

---

## Acceptance Criteria Coverage

This phase implements and tests:

### introspect-tool.AC2: Request Dispatch & Wakeup
- **introspect-tool.AC2.2 Success:** Target thread wakes, processes request as developer-role message, produces assistant response, and response is stamped with `introspect_response_id` in metadata

### introspect-tool.AC4: Post-Loop Hook Behavior
- **introspect-tool.AC4.1 Success:** Hook is no-op when turn was not triggered by introspect notification
- **introspect-tool.AC4.2 Success:** Hook handles multiple `introspect_id` messages in one turn, stamping each independently

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Write introspect_id metadata during notification injection

**Verifies:** introspect-tool.AC2.2

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts`

**Implementation:**

In server.ts, after `resolveDelegationMessageId()` creates the developer-role message for a notification, add logic to detect introspect-type payloads and write `introspect_id` to the injected message's metadata.

Find where notifications are processed in the dispatch loop. The function `resolveDelegationMessageId()` (around lines 86-145) creates a developer-role message and returns the message ID. After it returns, the code has access to both the `messageId` and the parsed notification payload from `dispatch_queue.event_payload`.

Add after the message is created:
```typescript
// After resolveDelegationMessageId creates the developer-role message:
if (payload.type === "introspect" && payload.correlation_id) {
  writeMessageMetadata(db, messageId, { introspect_id: payload.correlation_id }, siteId);
}
```

Import `writeMessageMetadata` from `@bound/core` if not already imported.

**Key context:** The notification payload stored in `dispatch_queue.event_payload` is `{ type: "introspect", correlation_id, source_thread, content }`. The `correlation_id` is what links the request to the response — it becomes `introspect_id` on the injected message, and later `introspect_response_id` on the assistant response.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Run: `bun test packages/cli`
Expected: Existing tests pass

**Commit:** `feat(cli): write introspect_id metadata during notification injection`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement runIntrospectResponseStamp post-loop hook

**Verifies:** introspect-tool.AC2.2, introspect-tool.AC4.1, introspect-tool.AC4.2

**Files:**
- Create or append to: `packages/agent/src/tools/introspect.ts` — export `runIntrospectResponseStamp()`

**Implementation:**

Export a standalone async function following the delivery-check pattern (`packages/core/src/delivery-check.ts` signature):

```typescript
export async function runIntrospectResponseStamp(params: {
  db: Database;
  siteId: string;
  threadId: string;
  turnStartAt: string;
}): Promise<void>
```

**Logic:**

1. **Find developer-role messages with `introspect_id` in this turn window:**
   ```typescript
   const devMessages = params.db
     .query("SELECT id, metadata FROM messages WHERE thread_id = ? AND role = 'developer' AND created_at >= ? AND metadata IS NOT NULL AND deleted = 0")
     .all(params.threadId, params.turnStartAt) as Array<{ id: string; metadata: string }>;
   ```

2. **Extract correlation IDs:**
   ```typescript
   const correlationIds: string[] = [];
   for (const msg of devMessages) {
     try {
       const meta = JSON.parse(msg.metadata) as Record<string, unknown>;
       if (typeof meta.introspect_id === "string") {
         correlationIds.push(meta.introspect_id);
       }
     } catch {
       // malformed metadata, skip
     }
   }
   ```

3. **No-op if no introspect messages found (AC4.1):**
   ```typescript
   if (correlationIds.length === 0) return;
   ```

4. **Find the last assistant message in the turn window:**
   ```typescript
   const lastAssistant = params.db
     .query("SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND created_at >= ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1")
     .get(params.threadId, params.turnStartAt) as { id: string } | null;
   
   if (!lastAssistant) return; // No assistant message produced (AC4.3 edge case)
   ```

5. **Stamp each correlation ID independently (AC4.2):**
   For each `correlationId`, write `{ introspect_response_id: correlationId }` to the assistant message metadata. Since `writeMessageMetadata()` does additive merge, multiple stamps coexist. However, since there's only ONE last assistant message, we need to write all correlation IDs. Use a single merged write:
   ```typescript
   const metadataEntries: Record<string, unknown> = {};
   for (const cid of correlationIds) {
     // Multiple introspect requests → stamp each independently
     // Use array format to support multiple correlation IDs on one message
     metadataEntries.introspect_response_id = correlationIds.length === 1
       ? correlationIds[0]
       : correlationIds;
   }
   writeMessageMetadata(params.db, lastAssistant.id, metadataEntries, params.siteId);
   ```

   **Important design decision for multiple IDs:** When multiple introspect requests arrive in one turn, the single assistant response answers all of them. Each caller polls for their own `correlationId`. Store as a single string when one ID, or as an array when multiple. Update the Phase 2 polling detection to check both `=== correlationId` and `Array.isArray() && .includes(correlationId)`.

**Package export:** Add the export to `packages/agent/src/index.ts`:
```typescript
export { runIntrospectResponseStamp } from "./tools/introspect";
```

This is required for Phase 3 Task 3's import `from "@bound/agent"` to resolve.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

**Commit:** `feat(agent): implement runIntrospectResponseStamp post-loop hook`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Register post-loop hook in server.ts

**Files:**
- Modify: `packages/cli/src/commands/start/server.ts`

**Implementation:**

Add the hook call after the existing `runPostLoopDeliveryCheck` call. The hook should run unconditionally (unlike delivery-check which is gated behind platform connector existence) because introspect can target any thread.

1. Import: `import { runIntrospectResponseStamp } from "@bound/agent"`
   (The function is exported from `packages/agent/src/tools/introspect.ts` — ensure it's re-exported from the package's index if needed, or import directly from the tool file path)

2. After the delivery-check block (around line 604), add:
   ```typescript
   // Stamp introspect responses after turn completes
   await runIntrospectResponseStamp({
     db: appContext.db,
     siteId: appContext.siteId,
     threadId: thread_id,
     turnStartAt,
   });
   ```

**Key context:** `turnStartAt` is already computed on line 548 as `new Date().toISOString()` before the agent loop runs. The variable `thread_id` is the thread that just completed its turn.

**Verification:**
Run: `bun run typecheck`
Expected: No type errors

Run: `bun test packages/cli`
Expected: Existing tests pass

**Commit:** `feat(cli): register introspect response stamp hook after delivery-check`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Unit tests for post-loop hook

**Verifies:** introspect-tool.AC2.2, introspect-tool.AC4.1, introspect-tool.AC4.2

**Files:**
- Modify: `packages/agent/src/tools/__tests__/introspect.test.ts`

**Testing:**

Add a `describe("runIntrospectResponseStamp")` block testing the exported hook function directly:

- **introspect-tool.AC4.1:** No-op on non-introspect turn — set up a turn with only regular messages (no `introspect_id` metadata). Call `runIntrospectResponseStamp()`. Verify NO metadata was written to any message.

- **introspect-tool.AC4.2:** Multiple introspect requests in one turn — insert two developer-role messages with different `introspect_id` values and one assistant message. Call hook. Verify the assistant message has `introspect_response_id` containing both correlation IDs (as array).

- **introspect-tool.AC2.2:** Single introspect stamps correctly — insert one developer-role message with `introspect_id: "corr-123"` and one assistant message. Call hook. Verify assistant message metadata has `introspect_response_id: "corr-123"` (as string).

- **Edge case (AC4.3 preparation):** No assistant message produced — insert developer-role message with introspect_id but no assistant message. Call hook. Verify it returns without error (no-op).

**Note:** Phase 2 already implements array-format detection in its polling loop (handling both `string` and `string[]` for `introspect_response_id`), so no cross-phase modification is needed here.

**Verification:**
Run: `bun test packages/agent/src/tools/__tests__/introspect.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add post-loop hook tests for introspect response stamp`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
