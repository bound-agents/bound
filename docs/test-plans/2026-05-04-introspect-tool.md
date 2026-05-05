# Introspect Tool — Human Test Plan

## Prerequisites

- Working `bound` build: `bun run build && cp dist/bound* ~/.local/bin/`
- Running `bound start` instance (spoke or standalone)
- At least two existing threads in the database (one to act as caller, one as target)
- `bun test packages/agent/src/tools/__tests__/introspect.test.ts packages/agent/src/tools/__tests__/introspect.integration.test.ts` passing (23 tests, 0 failures)

## Phase 1: Input Validation (AC1)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open a thread in the web UI. Send a message asking the agent to use introspect on a nonexistent thread ID (e.g., "Use introspect to ask thread `aaaaaaaa-0000-0000-0000-000000000000` what it thinks") | Agent should report an error indicating the thread was not found |
| 2 | Send a message asking the agent to introspect on the current thread (e.g., "Use introspect on this thread with message 'hello'") | Agent should report a self-introspect error |
| 3 | Identify a real existing thread via `SELECT id, title FROM threads WHERE deleted = 0 LIMIT 5` in the DB. Ask the agent to introspect on that thread | No immediate error on dispatch; agent should begin waiting for response |

## Phase 2: Dispatch and Polling (AC2)

| Step | Action | Expected |
|------|--------|----------|
| 1 | After step 3 from Phase 1, query the DB: `SELECT event_payload FROM dispatch_queue WHERE thread_id = '<target_thread_id>' ORDER BY created_at DESC LIMIT 1` | JSON payload with `type: "introspect"`, valid UUID `correlation_id`, `source_thread` matching the calling thread, `content` matching the message sent |
| 2 | Monitor logs for `notify:enqueued` event emission | Event should appear in logs with the target thread_id |
| 3 | If the target thread is active and processes the notification, wait for the response | The introspect tool should return the assistant's response text to the calling thread within the timeout window |

## Phase 3: Timeout and Error Handling (AC3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Use introspect targeting a thread that has no active agent loop (e.g., an old stale thread). Wait for 5 minutes (default timeout) | Agent returns a timeout error message indicating no response was received |
| 2 | Target a thread where you can force an error (e.g., by misconfiguring the model for that thread's next turn). Trigger introspect | Agent should detect the error turn and return early with an error message rather than waiting for the full timeout |

## Phase 4: Post-Loop Hook (AC4)

| Step | Action | Expected |
|------|--------|----------|
| 1 | After a successful introspect round-trip, query the target thread's assistant message: `SELECT metadata FROM messages WHERE thread_id = '<target>' AND role = 'assistant' ORDER BY created_at DESC LIMIT 1` | Metadata JSON contains `introspect_response_id` matching the correlation_id from the dispatch payload |
| 2 | Send a regular message to a thread (not via introspect). Check the latest assistant message metadata | No `introspect_response_id` key present in metadata (hook was a no-op) |

## Phase 5: Cross-Host Sync (AC5)

| Step | Action | Expected |
|------|--------|----------|
| 1 | On a multi-host cluster (spoke + hub), initiate introspect from the spoke targeting a thread that runs on the hub | dispatch_queue entry appears on spoke, syncs to hub via changelog |
| 2 | After the hub processes the introspect request and stamps the response, check the spoke's DB for the metadata | `introspect_response_id` metadata should replicate back to the spoke via changelog sync, and the spoke's polling loop should detect it and return the response |

## End-to-End: Full Introspect Round-Trip (Single Host)

**Purpose:** Validate the complete flow from tool invocation through dispatch, target wakeup, response generation, hook stamping, and caller detection on a single running instance.

**Steps:**
1. Create two threads via the web UI (Thread A and Thread B). Note both thread IDs.
2. In Thread A, ask the agent: "Use introspect to ask thread `<Thread B ID>` what it knows about recent tasks."
3. Observe Thread A enters a waiting state (tool call pending).
4. Verify Thread B receives a developer-role message containing the introspect content (check DB: `SELECT * FROM messages WHERE thread_id = '<B>' AND role = 'developer' ORDER BY created_at DESC LIMIT 1`).
5. Verify Thread B produces an assistant response and the post-loop hook stamps it with `introspect_response_id`.
6. Verify Thread A's introspect tool resolves with Thread B's assistant message content displayed to the user.
7. Total elapsed time should be within the 5-minute default timeout.

## End-to-End: Concurrent Introspect Requests

**Purpose:** Validate that multiple introspect requests landing on the same target in one turn all get their correlation IDs stamped.

**Steps:**
1. Create three threads (A, B, C). Thread C is the target.
2. From Thread A, introspect Thread C with message "Question from A."
3. From Thread B (in a separate browser tab), introspect Thread C with message "Question from B."
4. Wait for Thread C to process both (it may batch them in one turn or process sequentially).
5. If batched in one turn: verify the assistant message metadata has `introspect_response_id` as an array containing both correlation IDs.
6. Verify both Thread A and Thread B receive the response content from Thread C.

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 Valid inputs accepted | introspect.test.ts:46 | Phase 1, Step 3 |
| AC1.2 Missing/empty thread_id error | introspect.test.ts:101 | Phase 1, Step 1 (implicit) |
| AC1.3 Self-introspect guard | introspect.test.ts:127 | Phase 1, Step 2 |
| AC1.4 Thread not found/deleted | introspect.test.ts:161 | Phase 1, Step 1 |
| AC2.1 Payload structure | introspect.test.ts:211 | Phase 2, Step 1 |
| AC2.2 Hook stamps response | introspect.test.ts:684, integration:152 | Phase 4, Step 1 |
| AC2.3 Caller detects response | introspect.test.ts:294 | E2E Round-Trip, Step 6 |
| AC3.1 Timeout | introspect.test.ts:337 | Phase 3, Step 1 |
| AC3.2 Error turn detection | introspect.test.ts:355 | Phase 3, Step 2 |
| AC3.3 Abort turn detection | introspect.test.ts:385 | Phase 3, Step 2 (variant) |
| AC4.1 No-op on non-introspect | introspect.test.ts:543 | Phase 4, Step 2 |
| AC4.2 Multiple IDs stamped | introspect.test.ts:600, integration:296 | E2E Concurrent, Step 5 |
| AC4.3 No-op when no assistant | introspect.test.ts:747, integration:246 | -- (hard to reproduce manually without killing agent mid-turn) |
| AC5.1 Sync-compatible dispatch | integration:90 | Phase 5, Step 1 |
| AC5.2 Response syncs back | integration:152 | Phase 5, Step 2 |
