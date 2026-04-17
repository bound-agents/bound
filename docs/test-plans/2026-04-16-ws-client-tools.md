# WebSocket Client Tools -- Human Test Plan

## Overview

This test plan covers the three acceptance criteria that require manual browser verification (AC6.1, AC6.2, AC6.3). All other criteria are covered by automated tests.

## Prerequisites

- Bound server running locally: `bun packages/cli/src/bound.ts start` (from `~/bound/`)
- Web UI accessible at `http://localhost:3001`
- Browser with DevTools (Network tab for WS inspection)

---

## Test 1: AC6.1 -- Single BoundClient (no BoundSocket)

**Objective:** Verify the web UI uses a single `BoundClient` with no trace of `BoundSocket`.

**Steps:**
1. Open browser DevTools Console
2. Navigate to `http://localhost:3001`
3. In Console, type `window` and expand — verify no `BoundSocket` references in loaded modules
4. Verify only one WebSocket connection is established (Network tab > WS filter)

**Verification (static analysis -- can also run from terminal):**
```bash
grep -r "BoundSocket" packages/web/src/client/
# Expected: zero matches

grep -r "from.*socket" packages/web/src/client/lib/bound.ts
# Expected: zero matches

grep "BoundClient" packages/web/src/client/lib/bound.ts
# Expected: at least one match
```

**Pass criteria:** Zero references to `BoundSocket` in client code. Single WebSocket connection in browser.

---

## Test 2: AC6.2 -- Message Sending Over WS

**Objective:** Verify messages are sent via WebSocket (not HTTP POST) and responses arrive via events.

**Steps:**
1. Open browser DevTools, go to Network tab, filter by "WS"
2. Navigate to `http://localhost:3001`
3. Open or create a thread
4. Click on the WebSocket connection in the Network tab to inspect frames
5. Type a message in the chat input and send
6. In the WS frames view, verify:
   - An outgoing frame with `{"type":"message:send","thread_id":"...","content":"..."}` appears
   - **No** HTTP POST request to `/api/threads/:id/messages` appears in the Network tab
7. Wait for the agent to respond
8. In the WS frames view, verify:
   - An incoming frame with `{"type":"message:created",...}` appears with the user's message
   - An incoming frame with `{"type":"thread:status","active":true,...}` appears (agent working)
   - Additional `{"type":"message:created",...}` frames arrive with the agent's response
   - A final `{"type":"thread:status","active":false,...}` frame appears (agent idle)
9. Verify the response renders in the chat UI without page reload

**Pass criteria:** 
- Message sent via WS `message:send` frame (no HTTP POST)
- Response arrives via `message:created` WS event
- Thread status updates arrive via `thread:status` WS events
- UI updates in real-time without refresh

---

## Test 3: AC6.3 -- Updated Event Names

**Objective:** Verify event listeners use colon-delimited names.

**Steps:**
1. Open browser DevTools Console
2. Navigate to `http://localhost:3001`
3. Open a thread and trigger some activity (send a message, let agent process)
4. In the WS frames view, verify:
   - Task updates arrive as `{"type":"task:updated",...}` (not `task_update`)
   - File updates arrive as `{"type":"file:updated",...}` (not `file_update`)
   - Message events are `{"type":"message:created",...}`
   - Debug events are `{"type":"context:debug",...}`

**Verification (static analysis):**
```bash
grep -r "task_update" packages/web/src/client/
# Expected: zero matches

grep -r "file_update" packages/web/src/client/
# Expected: zero matches

grep -r "task:updated" packages/web/src/client/
# Expected: at least one match

grep -r "file:updated" packages/web/src/client/
# Expected: at least one match
```

**Pass criteria:** All WS event types use colon-delimited format. No underscore-delimited event names in client code or WS frames.

---

## Automated Test Summary

| Test File | Tests | ACs Covered |
|-----------|-------|-------------|
| `packages/core/src/__tests__/dispatch-queue.test.ts` | 45 | AC4.1, AC4.2, AC4.3, AC4.4, AC4.5, AC7.2, AC7.4 |
| `packages/agent/src/__tests__/client-tool-dispatch.test.ts` | 18 | AC3.1, AC3.2, AC3.3, AC3.4 |
| `packages/web/src/server/__tests__/websocket.test.ts` | 43 | AC1.1, AC1.3, AC1.4, AC1.5, AC3.2, AC3.5, AC3.6 |
| `packages/web/src/server/__tests__/websocket-reconnect.test.ts` | 7 | AC7.1, AC7.2, AC7.3 |
| `packages/web/src/server/__tests__/websocket.integration.test.ts` | 10 | AC1.3 |
| `packages/web/src/server/__tests__/routes.integration.test.ts` | 34 | AC4.5 |
| `packages/web/src/__tests__/messages-route.test.ts` | 4 | AC1.2 |
| `packages/client/src/__tests__/client.test.ts` | 13 | AC2.1, AC2.2, AC2.3, AC2.4, AC2.5 |
| `packages/mcp-server/src/__tests__/handler.test.ts` | 17 | AC5.1, AC5.2 |
