# WebSocket Client Tools Implementation Plan — Phase 7

**Goal:** Update Svelte web UI to use the unified `BoundClient` instead of separate `BoundClient` + `BoundSocket`.

**Architecture:** The web UI currently imports both classes in `packages/web/src/client/lib/bound.ts` (line 1): `import { BoundClient, BoundSocket } from "@bound/client"`. It creates singleton instances and exports helpers (`connectWebSocket`, `subscribeToThread`, `disconnectWebSocket`). Event bridging at lines 23-32 uses old event names (`task_update`, `file_update`). The migration replaces dual imports with unified `BoundClient`, updates event listener names, and switches message sending from HTTP to WS fire-and-forget.

**Tech Stack:** TypeScript, Svelte 5, `@bound/client`

**Scope:** 8 phases from original design (this is phase 7 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC1: Unified WS Protocol
- **ws-client-tools.AC1.2 Success:** `POST /api/threads/:id/messages` is removed; HTTP POST returns 404

### ws-client-tools.AC6: Svelte Web UI
- **ws-client-tools.AC6.1 Success:** Web UI uses single `BoundClient` (no separate `BoundSocket`)
- **ws-client-tools.AC6.2 Success:** Message sending works over WS; UI renders responses via `message:created` events
- **ws-client-tools.AC6.3 Success:** Event listeners use updated names (`task:updated`, `file:updated`)

---

<!-- START_TASK_1 -->
### Task 1: Update bound.ts to use unified BoundClient

**Verifies:** ws-client-tools.AC6.1, ws-client-tools.AC6.2, ws-client-tools.AC6.3

**Files:**
- Modify: `packages/web/src/client/lib/bound.ts` (replace dual imports with unified BoundClient)

**Implementation:**

1. **Replace imports** (line 1):
   - Before: `import { BoundClient, BoundSocket } from "@bound/client";`
   - After: `import { BoundClient } from "@bound/client";`

2. **Remove BoundSocket instance** — Delete `export const socket = new BoundSocket();` and replace with unified client usage:

   ```typescript
   export const client = new BoundClient();
   ```

3. **Update helper functions:**
   - `connectWebSocket()` → `client.connect()`
   - `subscribeToThread(threadId)` → `client.subscribe(threadId)`
   - `disconnectWebSocket()` → `client.disconnect()`

4. **Update event bridging** (lines 23-32) — The current code bridges `socket` events into a Svelte store. Switch to use `client` directly and update event names:
   - `socket.on("task_update", ...)` → `client.on("task:updated", ...)`
   - `socket.on("file_update", ...)` → `client.on("file:updated", ...)`
   - `socket.on("message:created", ...)` → `client.on("message:created", ...)` (unchanged)
   - `socket.on("context:debug", ...)` → `client.on("context:debug", ...)` (unchanged)
   - Add: `client.on("thread:status", ...)` for real-time status updates

5. **Update any direct `socket` references** in other files that import from `../lib/bound` — Search for `socket` imports and replace with `client` method calls.

**Testing:**

Tests must verify:
- ws-client-tools.AC6.1: No `BoundSocket` import exists in the codebase after this change
- ws-client-tools.AC6.3: Event listeners use `task:updated` and `file:updated` (not `task_update`, `file_update`)

Search the web/client directory for any remaining references to `BoundSocket`, `socket`, `task_update`, or `file_update`.

**Verification:**
Run: `tsc -p packages/web --noEmit`
Expected: No type errors

Run: `bun run build`
Expected: Vite build succeeds for the Svelte SPA

**Commit:** `feat(web): update Svelte UI to unified BoundClient (AC6.1-AC6.3)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update message sending in Svelte components

**Verifies:** ws-client-tools.AC6.2

**Files:**
- Modify: Any Svelte component that calls `client.sendMessage()` and expects a return value

**Implementation:**

The `sendMessage()` return type changed from `Promise<Message>` to `void` (fire-and-forget over WS). Find all call sites that `await client.sendMessage()` or use its return value and update them:

1. **Search for `sendMessage` calls** in `packages/web/src/client/` — Find all components that call `client.sendMessage()`. The investigator found these components import from `../lib/bound`:
   - ContextDebugPanel.svelte, MemoryGraph.svelte, FilePreviewModal.svelte, TopBar.svelte, ModelSelector.svelte, FilesView.svelte, NetworkStatus.svelte, SystemMap.svelte, AdvisoryView.svelte, Timetable.svelte

   Most of these use read-only HTTP methods. The message input component (likely in a chat/thread view) is the primary call site for `sendMessage()`.

2. **Update send pattern** — Remove `await` and any use of the return value. The created message arrives via `message:created` event:

   ```typescript
   // Before:
   const msg = await client.sendMessage(threadId, content);
   // After:
   client.sendMessage(threadId, content);
   // Message appears in UI via message:created event subscription
   ```

3. **Thread status updates** — If any component polls `client.getThreadStatus()` on an interval, replace with `thread:status` event listener:

   ```typescript
   // Before:
   const interval = setInterval(async () => {
       const status = await client.getThreadStatus(threadId);
       // update UI
   }, 1000);

   // After:
   client.on("thread:status", (data) => {
       if (data.thread_id === threadId) {
           // update UI
       }
   });
   ```

**Testing:**

Tests must verify:
- ws-client-tools.AC6.2: Message sending works — user types message, sends via WS, response appears via `message:created` event

This is best verified via the Playwright e2e test suite or manual testing. The Svelte components don't typically have unit tests in this codebase.

**Verification:**
Run: `bun run build`
Expected: Build succeeds

Run: `bun run test:e2e` (if applicable — requires running server)
Expected: E2E tests pass

**Commit:** `feat(web): update Svelte components for WS message sending and event-driven status`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Remove POST /api/threads/:id/messages endpoint

**Verifies:** ws-client-tools.AC1.2

**Files:**
- Modify: `packages/web/src/server/routes/messages.ts` (remove POST handler at lines 58-182)

**Implementation:**

Now that all consumers (MCP server in Phase 6, Svelte UI in Phase 7 Tasks 1-2) have migrated to WS-based message sending, safely remove the HTTP POST endpoint.

1. **Delete the POST handler** — Remove the `app.post("/:threadId/messages", ...)` handler (lines 58-182) from messages.ts. Keep all GET routes intact.

2. **Add a 404 stub** for clarity:

   ```typescript
   app.post("/:threadId/messages", (c) => {
       return c.json({ error: "POST endpoint removed. Use WebSocket message:send instead." }, 404);
   });
   ```

3. **Update or remove any POST-dependent tests.**

**Testing:**

Tests must verify:
- ws-client-tools.AC1.2: POST to `/api/threads/:id/messages` returns 404
- GET routes for messages still work (listing, reading)

**Verification:**
Run: `bun test packages/web`
Expected: All tests pass

**Commit:** `feat(web): remove POST /api/threads/:id/messages endpoint (AC1.2)`
<!-- END_TASK_3 -->
