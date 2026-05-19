# Notify Action-Selector Test Plan

> **Superseded (2026-05-18):** The `action: "user"` branch has been removed and the tool flattened to `(thread_id, message)`. Phase 2 (User Notification Delivery) is no longer applicable. Phase 1 remains valid with the simplified schema.

## Prerequisites
- Working `bound` instance with at least one configured platform (Discord or web)
- `bun test packages/agent/src/tools/__tests__/notify.test.ts` passing (7 tests, 0 failures)
- At least two threads in the database

## Phase 1: Thread Notification Delivery

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open the web UI at http://localhost:3001, start a conversation in Thread A | Thread A is created and active |
| 2 | Open a second browser tab, create Thread B, note its ID from the URL | Thread B exists with a distinct ID |
| 3 | In Thread A, send: "Please notify thread [B's ID] with the message: ping from thread A" | Agent uses the `notify` tool with `action: "thread"`, `thread_id: <B's ID>`, `message: "ping from thread A"`. Agent responds confirming notification was enqueued. |
| 4 | Switch to Thread B tab, wait for the agent to deliver the notification | Within ~10 seconds, Thread B shows a new turn initiated by the agent containing "ping from thread A" or its paraphrased delivery |
| 5 | In Thread A, send: "Notify this thread with the message: self test" | Agent either refuses (tool returns self-notify error) or explains it cannot send a notification to the current thread |

## Phase 2: User Notification Delivery

| Step | Action | Expected |
|------|--------|----------|
| 1 | Verify a Discord user exists: run `bun packages/cli/src/boundctl.ts query "SELECT display_name FROM users WHERE deleted=0 LIMIT 5"` | Shows at least one user with a known display_name (e.g., "alice") |
| 2 | Identify a known user who has a Discord DM thread: `bun packages/cli/src/boundctl.ts query "SELECT u.display_name, t.interface FROM users u JOIN threads t ON t.user_id=u.id WHERE u.deleted=0 AND t.deleted=0 AND t.interface='discord' LIMIT 5"` | Returns at least one row showing a user with a discord thread |
| 3 | In a web thread, ask: "Notify user [username] on discord with: hello from web" | Agent uses `notify` tool with `action: "user"`, `user: "[username]"`, `platform: "discord"`, `message: "hello from web"`. Confirms enqueued. |
| 4 | Check the Discord channel or DM where that user's thread lives | Within ~30 seconds, the agent delivers a message containing "hello from web" in the user's Discord DM thread |
| 5 | In the same web thread, ask: "Notify user nonexistent_person on discord with: test" | Agent uses notify tool and returns/reports an error that the user was not found |

## Phase 3: Schema Correctness (LLM perspective)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start a fresh thread, ask: "What parameters does your notify tool accept?" | Agent describes `action` (thread/user), `thread_id`, `user`, `platform`, `message`. Does NOT mention `all`, `broadcast`, or anything related to sending to all threads. |
| 2 | Ask: "Send a notification to all threads with the message: broadcast test" | Agent either explains it cannot broadcast to all threads, or attempts a specific thread/user action. It does NOT iterate over all threads sending notifications. |

## End-to-End: Cross-Platform Notification Round-Trip

**Purpose:** Validates that the full pipeline works: agent tool invocation, dispatch_queue insertion, thread executor pickup, platform connector delivery.

**Steps:**
1. From a Discord DM, send the agent a message asking it to notify a specific web thread (provide the ID).
2. Verify the web thread (in browser) receives the notification content within 30 seconds.
3. From the web thread, reply asking the agent to notify the Discord user back.
4. Verify the Discord DM receives the reply notification.

**Expected:** Bidirectional notification delivery between Discord and web interfaces works end-to-end without manual intervention.

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC3.2 | Documentation quality/accuracy cannot be asserted programmatically | Open `docs/design/agent-system.md`, navigate to the `### notify` section (line 668). Verify: (1) parameter table lists `action`, `thread_id`, `user`, `platform`, `message` with correct types and required/conditional markers, (2) description mentions both actions with JSON examples, (3) no mention of `all` parameter or broadcast semantics anywhere in the section. |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | notify.test.ts "AC1.1: enqueues notification for valid thread_id" | Phase 1, Steps 3-4 |
| AC1.2 | notify.test.ts "AC1.2: returns error when thread_id is missing" | -- |
| AC1.3 | notify.test.ts "AC1.3: returns error for non-existent/soft-deleted thread" (2 tests) | -- |
| AC1.4 | notify.test.ts "AC1.4: returns error for self-notify" | Phase 1, Step 5 |
| AC1.5 | notify.test.ts "AC1.5: returns error for empty or whitespace-only message" | -- |
| AC2.1 | notify.test.ts "AC2.1: resolves DM thread and enqueues notification" | Phase 2, Steps 3-4 |
| AC2.2 | notify.test.ts "AC2.2: returns error when user/platform missing" (2 tests) | -- |
| AC2.3 | notify.test.ts "AC2.3: returns error for non-existent username" | Phase 2, Step 5 |
| AC2.4 | notify.test.ts "AC2.4: returns error when no DM thread on platform" | -- |
| AC2.5 | notify.test.ts "AC2.5: returns error for self-notify via resolved thread" | -- |
| AC3.1 | notify.test.ts "AC3.1: tool schema exposes action as required enum" | Phase 3, Step 1 |
| AC3.2 | -- | Human Verification (documentation review) |
| AC3.3 | notify.test.ts "AC3.3: tool schema does not contain 'all'" + "calling with all=true" (2 tests) | Phase 3, Step 2 |
