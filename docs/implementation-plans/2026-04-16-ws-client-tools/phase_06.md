# WebSocket Client Tools Implementation Plan — Phase 6

**Goal:** Migrate `bound-mcp` from HTTP POST + polling to unified WS client for message sending and completion detection.

**Architecture:** The MCP server handler (`handler.ts`) currently uses `client.sendMessage()` (HTTP POST at line 22) and polls `client.getThreadStatus()` every 500ms (line 27) with a 30-minute timeout. The migration switches to WS-based `sendMessage()` (fire-and-forget) and waits for a `thread:status` event with `active: false` to detect completion, then fetches final response via HTTP `listMessages()`. The MCP server does NOT expose a tools parameter — it cannot pass function callbacks over MCP protocol.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `@bound/client`

**Scope:** 8 phases from original design (this is phase 6 of 8)

**Codebase verified:** 2026-04-16

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-client-tools.AC5: MCP Server
- **ws-client-tools.AC5.1 Success:** `bound-mcp` sends messages via WS and detects completion via `thread:status` event
- **ws-client-tools.AC5.2 Success:** `bound-mcp` does not expose a tools parameter

---

<!-- START_TASK_1 -->
### Task 1: Migrate MCP handler to WS-based message sending and event-driven completion

**Verifies:** ws-client-tools.AC5.1, ws-client-tools.AC5.2

**Files:**
- Modify: `packages/mcp-server/src/handler.ts` (rewrite completion detection, lines 13-60)
- Modify: `packages/mcp-server/src/server.ts` (add WS connection lifecycle, line 18)

**Implementation:**

1. **server.ts changes** (line 18) — After creating `BoundClient`, call `client.connect()` to establish the WS connection. Add cleanup on process exit:

   ```typescript
   const client = new BoundClient(baseUrl);
   client.connect();
   // On process exit: client.disconnect()
   ```

2. **handler.ts changes** — Replace the polling loop with event-driven completion detection:

   **Current pattern (lines 22-43):**
   ```
   client.sendMessage(threadId, message)  // HTTP POST
   while (elapsed < MAX_POLL_MS) {
       status = client.getThreadStatus(threadId)  // HTTP GET polling
       if (!status.active) break
       sleep(POLL_INTERVAL_MS)
   }
   ```

   **New pattern:**
   ```typescript
   // Subscribe to thread events
   client.subscribe(threadId);

   // Wait for completion via thread:status event
   const completionPromise = new Promise<void>((resolve, reject) => {
       const timeout = setTimeout(() => reject(new Error("Timeout")), MAX_POLL_MS);

       const handler = (data: { thread_id: string; active: boolean }) => {
           if (data.thread_id === threadId && !data.active) {
               clearTimeout(timeout);
               client.off("thread:status", handler);
               resolve();
           }
       };
       client.on("thread:status", handler);
   });

   // Send message over WS (fire-and-forget)
   client.sendMessage(threadId, message);

   // Wait for completion
   await completionPromise;

   // Fetch final response via HTTP (unchanged)
   const messages = await client.listMessages(threadId);
   ```

   Key differences:
   - Subscribe before sending to avoid race condition (status change could arrive before listener is registered)
   - `sendMessage()` is now fire-and-forget (void return from Phase 5)
   - Completion detected via `thread:status` event instead of polling
   - Final response still fetched via HTTP `listMessages()` (unchanged)
   - Unsubscribe from thread after fetching response (optional cleanup)

3. **No tools parameter** — The handler does NOT pass tools to `configureTools()`. The MCP execution model doesn't support passing function callbacks over the MCP protocol. The handler only uses `sendMessage`, `subscribe`, `on/off`, and `listMessages`.

4. **Error handling** — On timeout, unsubscribe from thread and clean up event listener. On WS disconnect during wait, fall back to polling `getThreadStatus()` as a degraded mode (or re-throw the error).

**Testing:**

Tests must verify:
- ws-client-tools.AC5.1: Handler sends message via WS (not HTTP POST), waits for `thread:status` event, and fetches response via `listMessages()`
- ws-client-tools.AC5.2: Handler does not call `configureTools()` or expose any tools parameter
- Timeout handling: if `thread:status` doesn't arrive within MAX_POLL_MS, handler returns error
- Event listener cleanup: after completion, the `thread:status` listener is removed

Note: These tests will need to mock the WS connection or use a test harness. The existing MCP handler tests (if any) can be adapted.

Add tests to: `packages/mcp-server/src/__tests__/handler.test.ts` (create if needed)

**Verification:**
Run: `tsc -p packages/mcp-server --noEmit`
Expected: No type errors

Run: `bun test packages/mcp-server` (if tests exist)
Expected: All tests pass

**Commit:** `feat(mcp-server): migrate to WS-based message sending and event-driven completion (AC5.1-AC5.2)`
<!-- END_TASK_1 -->
