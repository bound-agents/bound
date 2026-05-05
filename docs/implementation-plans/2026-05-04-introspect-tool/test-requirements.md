# Introspect Tool — Test Requirements

Maps each acceptance criterion from the introspect tool design to specific test cases.

---

## AC1: Input Validation & Guards

### introspect-tool.AC1.1 Success
**Criterion:** Valid `thread_id` and `message` accepted, notification enqueued to target

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Call execute with a valid thread_id (thread exists in DB, not deleted) and a non-empty message. Verify the result does not contain an error. Verify a `dispatch_queue` entry was created for the target thread with `event_type = 'notification'`. Verify the event bus emitted `"notify:enqueued"` with the correct thread_id.

---

### introspect-tool.AC1.2 Failure
**Criterion:** Missing or empty `thread_id` returns error without enqueuing

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Call execute with `{}` (missing thread_id) and separately with `{ thread_id: "", message: "hi" }` (empty thread_id). Verify both return an error/validation failure string. Verify no `dispatch_queue` entry is created in either case.

---

### introspect-tool.AC1.3 Failure
**Criterion:** Self-introspect (target = current thread) returns error without enqueuing

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Set `ctx.threadId = "thread-1"` and call execute with `{ thread_id: "thread-1", message: "hi" }`. Verify the result contains an error about self-introspect. Verify no `dispatch_queue` entry is created.

---

### introspect-tool.AC1.4 Failure
**Criterion:** Target thread not found or deleted returns error without enqueuing

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Two sub-cases: (1) Call execute with a `thread_id` that does not exist in the database. (2) Insert a thread with `deleted: 1`, then call execute targeting that thread. In both cases, verify the result contains a "not found" or "deleted" error string and no `dispatch_queue` entry is created.

---

## AC2: Request Dispatch & Wakeup

### introspect-tool.AC2.1 Success
**Criterion:** Notification enqueued with `{ type: "introspect", correlation_id, source_thread, content }` payload and `introspect_id` written to injected message metadata

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Call execute with valid inputs. Query `dispatch_queue` for the latest notification entry. Parse `event_payload` JSON and verify it contains exactly `{ type: "introspect", correlation_id: <valid UUID>, source_thread: ctx.threadId, content: input.message }`. Verify the correlation_id is a valid UUID format.

---

### introspect-tool.AC2.2 Success
**Criterion:** Target thread wakes, processes request as developer-role message, produces assistant response, and response is stamped with `introspect_response_id` in metadata

**Test type:** Unit (hook stamp verification) + Integration (full flow)
**Test files:**
- `packages/agent/src/tools/__tests__/introspect.test.ts` (hook unit test)
- `packages/agent/src/tools/__tests__/introspect.integration.test.ts` (full round-trip)

**Description (unit — hook):** Insert one developer-role message with `introspect_id: "corr-123"` in metadata and one assistant-role message in the same turn window. Call `runIntrospectResponseStamp()`. Verify the assistant message's metadata now contains `introspect_response_id: "corr-123"`.

**Description (integration — round-trip):** Call execute on the tool, then concurrently simulate the target side: inject developer-role message with `introspect_id`, insert assistant-role response, run the post-loop hook. Verify the caller's execute resolves with the target's assistant message content.

---

### introspect-tool.AC2.3 Success
**Criterion:** Caller detects stamped response and returns assistant message content

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Start the execute call (returns a Promise that polls). After a short delay, insert an assistant message in the target thread with `metadata = JSON.stringify({ introspect_response_id: correlationId })` (extracted from dispatch_queue). Verify the execute Promise resolves with the content of that assistant message.

---

## AC3: Timeout & Error Handling

### introspect-tool.AC3.1 Failure
**Criterion:** Caller returns timeout error when no response within configured timeout

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Call execute with `timeout: 100` (100ms). Do not insert any response message or run the hook. Verify the execute Promise resolves with a string containing "timed out" and the timeout duration.

---

### introspect-tool.AC3.2 Failure
**Criterion:** Caller detects target turn with `status = 'error'` and returns early with error message

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Start the execute call. After a short delay, insert a `turns` row for the target thread with `status: "error"` and `created_at` after the dispatch time. Verify execute resolves with an error string indicating the target thread encountered an error during processing.

---

### introspect-tool.AC3.3 Failure
**Criterion:** Caller detects target turn with `status = 'aborted'` and returns early with error message

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Start the execute call. After a short delay, insert a `turns` row for the target thread with `status: "aborted"` and `created_at` after the dispatch time. Verify execute resolves with an error string indicating the target thread's turn was aborted.

---

## AC4: Post-Loop Hook Behavior

### introspect-tool.AC4.1 Success
**Criterion:** Hook is no-op when turn was not triggered by introspect notification

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Set up a turn window with regular developer-role messages (no `introspect_id` in metadata) and an assistant message. Call `runIntrospectResponseStamp()`. Verify no metadata was written to the assistant message (read its metadata and confirm absence of `introspect_response_id`). Optionally verify no `change_log` UPDATE entry was generated for any message.

---

### introspect-tool.AC4.2 Success
**Criterion:** Hook handles multiple `introspect_id` messages in one turn, stamping each independently

**Test type:** Unit
**Test file:** `packages/agent/src/tools/__tests__/introspect.test.ts`
**Description:** Insert two developer-role messages with different `introspect_id` values (`"corr-A"` and `"corr-B"`) and one assistant-role message, all in the same turn window. Call `runIntrospectResponseStamp()`. Verify the assistant message's metadata contains `introspect_response_id` as an array `["corr-A", "corr-B"]` (both IDs present). This validates that both callers' polling loops will detect the response.

---

### introspect-tool.AC4.3 Edge
**Criterion:** Hook does not stamp when target turn produces no assistant message (error before output)

**Test type:** Unit + Integration
**Test files:**
- `packages/agent/src/tools/__tests__/introspect.test.ts` (unit — hook returns cleanly)
- `packages/agent/src/tools/__tests__/introspect.integration.test.ts` (integration — no changelog update generated)

**Description (unit):** Insert a developer-role message with `introspect_id` but do NOT insert any assistant-role message. Call `runIntrospectResponseStamp()`. Verify no error is thrown and the function returns void without writing any metadata.

**Description (integration):** Same setup in full-schema DB. After calling the hook, query `change_log` and verify no UPDATE entry exists for `messages` metadata during that turn window.

---

## AC5: Cross-Host

### introspect-tool.AC5.1 Success
**Criterion:** Request reaches remote host via relay forwarding (same path as notify)

**Test type:** Integration
**Test file:** `packages/agent/src/tools/__tests__/introspect.integration.test.ts`
**Description:** Call the introspect tool execute (with a short timeout so it returns). Verify that the notification dispatch uses `enqueueNotification()` which writes to `dispatch_queue` — this is the same mechanism notify uses and relay forwards dispatch_queue entries to remote hosts via the sync protocol. Verify the developer-role message injected into the target thread was created via `insertRow()` by confirming a corresponding `change_log` entry exists for `table_name = 'messages'`. The existence of the changelog entry proves the write will sync to remote hosts.

**Justification for test approach:** True multi-host relay integration testing requires two running sync instances with network. This is covered by the existing hub-spoke integration test infrastructure. The introspect-specific test verifies that it uses the correct outbox-compatible write path (changelog generation), which is the prerequisite for relay forwarding.

---

### introspect-tool.AC5.2 Success
**Criterion:** Response metadata syncs back to calling host via changelog, caller detects it

**Test type:** Integration
**Test file:** `packages/agent/src/tools/__tests__/introspect.integration.test.ts`
**Description:** Simulate the full round-trip: dispatch, inject, respond, stamp via hook. After the hook runs `writeMessageMetadata()`, query `change_log` for an UPDATE entry on the `messages` table targeting the stamped assistant message ID. Verify the changelog entry exists and its `row_data` contains the `introspect_response_id` metadata. This proves that on a multi-host deployment, the metadata update will propagate via changelog sync to the calling host where the polling loop runs.

---

## Criteria Requiring Human Verification

None. All acceptance criteria are fully testable via automated unit and integration tests.

**Rationale:** The design deliberately composes four existing, well-tested patterns (notify dispatch, await_event polling, delivery-check hook, messages.metadata). Cross-host behavior (AC5) is verified by confirming changelog generation rather than requiring a live multi-host environment, because the sync layer's correctness is already covered by its own integration test suite (`hub-spoke-e2e.integration.test.ts`). The introspect tool's contract with the sync layer is simply "use outbox-compatible writes" — and that contract is verifiable in a single-DB test.

---

## Test File Summary

| File | Type | ACs Covered |
|------|------|-------------|
| `packages/agent/src/tools/__tests__/introspect.test.ts` | Unit | AC1.1, AC1.2, AC1.3, AC1.4, AC2.1, AC2.2, AC2.3, AC3.1, AC3.2, AC3.3, AC4.1, AC4.2, AC4.3 |
| `packages/agent/src/tools/__tests__/introspect.integration.test.ts` | Integration | AC2.2, AC4.3, AC5.1, AC5.2 |
