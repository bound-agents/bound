# Remove Dispatcher Implementation Plan - Phase 4: Dispatcher Removal

**Goal:** Remove all dispatcher-related code and wiring from the codebase. After this phase, no references to the dispatcher task, its seeding logic, its tools file, or the `connector:list_changed` event wiring remain.

**Architecture:** Pure deletion phase. Delete dispatcher source files, remove imports/exports/calls in consuming files, update tests that reference dispatcher concepts, and verify the build passes clean.

**Tech Stack:** TypeScript (deletion and import cleanup)

**Scope:** 4 phases from original design (phase 4 of 4)

**Codebase verified:** 2026-05-14

---

## Acceptance Criteria Coverage

This phase implements and tests:

### remove-dispatcher.AC1: Dispatcher code fully removed
- **remove-dispatcher.AC1.1 Success:** No references to DISPATCHER_TASK_ID, seedDispatcher, registerConnectorEventListeners, or isDispatcherThread exist in source
- **remove-dispatcher.AC1.2 Success:** No connector:list_changed event emission or handling exists in mcp-registry.ts or server.ts
- **remove-dispatcher.AC1.3 Success:** Build passes and all existing tests pass after removal

### remove-dispatcher.AC5: Existing infrastructure unaffected
- **remove-dispatcher.AC5.1 Success:** Existing connector_handles rows continue to activate subscriptions at startup
- **remove-dispatcher.AC5.2 Success:** connector:event:{handleId} triggers still wake event tasks on delivery
- **remove-dispatcher.AC5.3 Success:** No DB migration required

---

<!-- START_TASK_1 -->
### Task 1: Delete dispatcher source files

**Files:**
- Delete: `packages/platforms/src/dispatcher.ts`
- Delete: `packages/platforms/src/dispatcher-tools.ts`
- Delete: `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts`

**Implementation:**

Delete these three files entirely. They are superseded by:
- `dispatcher.ts` (seedDispatcher, DISPATCHER_TASK_ID) → no longer needed; task row stays in DB but never wakes
- `dispatcher-tools.ts` (4 factory functions, DispatcherTool, DispatcherToolContext) → replaced by `connector-tool.ts` from Phase 2
- `dispatcher-tools.integration.test.ts` (595 lines) → replaced by `connector-tool.test.ts` from Phase 2

Note: Phase 2 defined `ConnectorToolDef` locally in `connector-tool.ts` (no import from `dispatcher-tools.ts`), so these files can be deleted cleanly without breaking the connector tool.

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: Will fail until remaining references are cleaned up (Tasks 2-4)

**Commit:** `refactor(platforms): delete dispatcher source files`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Clean up mcp-registry.ts

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Remove the following from `mcp-registry.ts`:

1. **Line 16** — Remove import: `import { DISPATCHER_TASK_ID } from "./dispatcher.js";`

2. **Lines 165-166** — Remove the `connector:list_changed` event emission in the notification handler:
   ```typescript
   // REMOVE this else-if branch:
   } else if (notification.method === "notifications/events/list_changed") {
       this.deps.eventBus.emit("connector:list_changed", { server_name: name });
   }
   ```
   Keep the `notifications/tools/list_changed` handler (line 162-164) that calls `discoverTools()` — tool discovery still happens, we just don't emit the dispatcher-waking event.

3. **Lines 595-604** — Remove the entire `isDispatcherThread()` method:
   ```typescript
   // REMOVE:
   isDispatcherThread(threadId: string): boolean {
       const task = this.deps.db
           .query("SELECT id FROM tasks WHERE thread_id = ? AND id = ? AND deleted = 0")
           .get(threadId, DISPATCHER_TASK_ID) as { id: string } | null;
       return task !== null;
   }
   ```

4. **Lines 622-644** — Remove the entire `registerConnectorEventListeners()` export function. Keep the `connector:event` handling for per-handle event task delivery — but that is handled separately (it lives in the scheduler setup, not here). Actually `registerConnectorEventListeners` handles BOTH `connector:list_changed` (dispatcher wake) AND `connector:event` (per-handle wake). The `connector:event` listener (lines 640-643) must be preserved somewhere. Move it to a new minimal export:

   ```typescript
   /**
    * Registers the connector:event listener that routes per-handle events to the scheduler.
    */
   export function registerConnectorEventDelivery(
       eventBus: TypedEventEmitter,
       scheduler: { onEvent: (eventType: string, payload: Record<string, unknown>) => void },
   ): void {
       eventBus.on("connector:event", (payload) => {
           scheduler.onEvent(payload.trigger_key, payload);
       });
   }
   ```

   This replaces `registerConnectorEventListeners` but ONLY keeps the per-handle event routing (removes the `connector:list_changed` listener).

**Verification:**
Run: `tsc -p packages/platforms --noEmit`
Expected: May still fail until index.ts and scheduler.ts are updated

**Commit:** `refactor(platforms): remove dispatcher references from mcp-registry`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Clean up package exports and scheduler wiring

**Files:**
- Modify: `packages/platforms/src/index.ts`
- Modify: `packages/cli/src/commands/start/scheduler.ts`
- Modify: `packages/cli/src/commands/start/server.ts`
- Modify: `packages/agent/src/scheduler.ts`
- Modify: `packages/shared/src/events.ts`

**Implementation:**

**`packages/platforms/src/index.ts`:**
- Remove line 27: `export { seedDispatcher, DISPATCHER_TASK_ID } from "./dispatcher.js";`
- Replace line 28: `export { registerConnectorEventListeners } from "./mcp-registry.js";` with `export { registerConnectorEventDelivery } from "./mcp-registry.js";`
- Remove exports for the 4 dispatcher tool factories: `createConnectorListTool`, `createConnectorChannelsTool`, `createConnectorAttachTool`, `createConnectorDetachTool`
- Remove export for `DispatcherToolContext` type
- Remove export for `DispatcherTool` type (Phase 2 defines `ConnectorToolDef` locally, no dependency)

**`packages/cli/src/commands/start/scheduler.ts`:**
- Line 26: Remove `registerConnectorEventListeners` from import; add `registerConnectorEventDelivery`
- Line 251: Replace `registerConnectorEventListeners(appContext.eventBus, scheduler)` with `registerConnectorEventDelivery(appContext.eventBus, scheduler)`
- Lines 254-259: Remove the synthetic startup emit block:
  ```typescript
  // REMOVE:
  // If scheduler registered before platforms were fully up, the initial
  // connector:list_changed event is lost. This kick ensures the dispatcher
  // auto-binds on startup.
  if (platformMcpRegistry) {
      appContext.eventBus.emit("connector:list_changed", { server_name: "__startup" });
  }
  ```
- Also remove any remaining imports of `createConnectorListTool`, `createConnectorChannelsTool`, `createConnectorAttachTool`, `createConnectorDetachTool` (these should already be gone from Phase 3, but verify)

**`packages/cli/src/commands/start/server.ts`:**
- Line 36: Remove `seedDispatcher` from the import statement from `@bound/platforms`
- Line 819: Remove the `seedDispatcher(appContext.db, appContext.siteId)` call

**`packages/agent/src/scheduler.ts`:**
- Line 4: Remove `DISPATCHER_TASK_ID` from the destructure, keeping `type PlatformRegisteredTool`. Result: `import { type PlatformRegisteredTool } from "@bound/platforms";`
- Line 137: Simplify: `const fallbackMs = isCompletion ? 300_000 : 60_000;` (remove the dispatcher special-case 30-minute timeout)

**`packages/shared/src/events.ts`:**
- Line 40: Remove the event type definition: `"connector:list_changed": { server_name: string };`
- Preserve the adjacent `"connector:handle_synced"` event definition on line 41 — it is used by the cross-host handle activation flow (AC5)

**Verification:**
Run: `tsc -p packages/platforms --noEmit && tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: All typecheck passes

**Commit:** `refactor(platforms): clean up dispatcher exports and scheduler wiring`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update remaining test files

**Files:**
- Modify: `packages/platforms/src/__tests__/relay-integration.integration.test.ts`
- Modify: `packages/platforms/src/__tests__/tool-scoping.integration.test.ts`
- Modify: `packages/agent/src/__tests__/scheduler-features.test.ts`

**Implementation:**

**`relay-integration.integration.test.ts`:**
- Line 11: Remove `DISPATCHER_TASK_ID` from import
- Line 661: The test setup creates a task with `id: DISPATCHER_TASK_ID` to simulate the dispatcher thread owning platform tools. This test case should be updated to use the new model: instead of testing that a dispatcher thread gets all tools, test that an event task thread gets its scoped tools (which is already tested elsewhere). Remove or rewrite the test case that depends on DISPATCHER_TASK_ID.

**`tool-scoping.integration.test.ts`:**
- Line 10: Remove `DISPATCHER_TASK_ID` from import
- Line 258: The test creates a task with `id: DISPATCHER_TASK_ID` and then asserts `isDispatcherThread()` returns true. This test verifies dispatcher behavior that no longer exists. Remove the dispatcher-specific test case. Keep tests for event task scoping (the `getToolsForThread()` path) as those are unchanged.

**`scheduler-features.test.ts`:**
- Line 1883: Change `opts.triggerSpec ?? "connector:list_changed"` to `opts.triggerSpec ?? "test:event"` (or any valid event string — the test just needs a non-null trigger_spec for event-type tasks)
- Line 2026: Change the hardcoded `'connector:list_changed'` in the SQL insert to `'test:event'` to match

**Verification:**
Run: `bun test packages/platforms && bun test packages/agent/src/__tests__/scheduler-features.test.ts`
Expected: All tests pass

**Commit:** `test(platforms): update tests to remove dispatcher references`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Final verification — grep and full test run

**Verifies:** remove-dispatcher.AC1.1, remove-dispatcher.AC1.2, remove-dispatcher.AC1.3, remove-dispatcher.AC5.1, remove-dispatcher.AC5.2, remove-dispatcher.AC5.3

**Files:** None (verification only)

**Implementation:**

Run comprehensive grep to verify no dispatcher references remain in source (excluding docs):

```bash
grep -r "DISPATCHER_TASK_ID\|seedDispatcher\|registerConnectorEventListeners\|isDispatcherThread\|connector:list_changed" packages/ --include="*.ts" | grep -v "node_modules" | grep -v "design-plans" | grep -v "implementation-plans"
```

Expected: Zero results. This check includes test files — if any `__tests__/` references remain, Task 4 cleanup was incomplete.

Then run full build and test suite:

```bash
tsc -p packages/shared --noEmit
tsc -p packages/core --noEmit
tsc -p packages/platforms --noEmit
tsc -p packages/agent --noEmit
tsc -p packages/cli --noEmit
bun test --recursive
```

Expected: All typecheck passes, all tests pass.

Also verify AC5 (existing infrastructure unaffected):
- `connector:event` listener still exists (via `registerConnectorEventDelivery`)
- `connector_handles` table and CRUD helpers are untouched
- `activateSubscription()` and `reconnectAll()` are untouched
- No DB schema changes (connector_handles table unmodified)

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass

**Commit:** No commit — this is verification only.
<!-- END_TASK_5 -->
