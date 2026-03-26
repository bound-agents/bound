# Human Test Plan: Inference Relay

**Generated from:** `docs/implementation-plans/2026-03-26-inference-relay/`
**Generated on:** 2026-03-26
**Coverage:** 35/35 ACs — PASS

---

## Prerequisites

- Two Bound instances configured in a cluster (spoke-A and spoke-B) with a shared sync hub
- spoke-A has no local LLM backend configured; spoke-B has at least one LLM backend (e.g., Anthropic)
- Both instances have sync configured and keyring entries for each other
- Network connectivity between all three nodes (hub, spoke-A, spoke-B)
- Run `bun test --recursive` on development machine — all tests passing
- Web UI accessible on both spokes (default: `http://localhost:3000`)

---

## Phase 1: Streaming Inference via Relay

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open spoke-A web UI at `http://localhost:3000` | Chat interface loads with model selector visible |
| 2 | In model selector, verify spoke-B's models appear with "(host-name · via relay)" annotation | Remote models from spoke-B listed with relay badge and host name |
| 3 | Select a remote model hosted on spoke-B from the model selector | Model selector updates to show the selected remote model |
| 4 | Type "Hello, please respond with a short greeting" and press Send | Status indicator shows "thinking" or "LIVE" badge; after a few seconds, assistant response appears with greeting text |
| 5 | Inspect network tab: verify `/api/threads/{id}/status` returns `{ active: true, state: "thinking" }` during inference | Status polling confirms active delegation state |
| 6 | After response completes, verify status returns `{ active: false, state: "idle" }` | Status returns to idle |
| 7 | On spoke-A, run: `sqlite3 data/bound.db "SELECT relay_target, relay_latency_ms FROM turns ORDER BY created_at DESC LIMIT 1"` | `relay_target` shows spoke-B's host name; `relay_latency_ms > 0` |

---

## Phase 2: Cancel During Relay Streaming

| Step | Action | Expected |
|------|--------|----------|
| 1 | Select a remote model and send a complex prompt: "Write a 2000-word essay about distributed systems" | Status indicator shows "thinking" / active state |
| 2 | While the response is streaming (within first 2-3 seconds), click the Cancel button in the UI | Response stops mid-stream; no hang; status returns to idle |
| 3 | On spoke-A, run: `sqlite3 data/bound.db "SELECT kind, ref_id FROM relay_outbox WHERE kind = 'cancel' ORDER BY created_at DESC LIMIT 1"` | Cancel entry present with non-null `ref_id` |
| 4 | On spoke-B, run: `sqlite3 data/bound.db "SELECT kind, payload FROM relay_outbox WHERE kind = 'error' ORDER BY created_at DESC LIMIT 1"` | Error entry with payload containing "cancelled" |

---

## Phase 3: Model Resolution and Failover

| Step | Action | Expected |
|------|--------|----------|
| 1 | Stop spoke-B (shut down the process) | spoke-B becomes unreachable |
| 2 | Wait 6 minutes for spoke-B's `online_at` to become stale | (wait) |
| 3 | Refresh spoke-A's web UI model selector | spoke-B's models now show "offline?" annotation in italic |
| 4 | Attempt to send a message using the stale remote model | Timeout error appears, or local fallback model is used |
| 5 | Restart spoke-B | spoke-B comes back online |
| 6 | After next sync cycle (~60s), refresh model selector | spoke-B's models return to "online" status (no italic, no "offline?") |

---

## Phase 4: Large Prompt File-Based Relay

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create a thread with extensive conversation history (>50 back-and-forth messages with code blocks totaling >2MB when serialized) | Thread displays normally |
| 2 | Select a remote model on spoke-B and send a follow-up message | Response arrives (may take longer due to file sync) |
| 3 | On spoke-A, run: `sqlite3 data/bound.db "SELECT payload FROM relay_outbox WHERE kind = 'inference' ORDER BY created_at DESC LIMIT 1"` | If payload contains `messages_file_ref`, verify the `files` table has the referenced entry. Inline messages are also valid if payload is under 2MB. |

---

## Phase 5: Web UI Model Selector

| Step | Action | Expected |
|------|--------|----------|
| 1 | With both spokes online, open spoke-A web UI | Model selector shows both local models and remote models |
| 2 | Verify spoke-A local model and spoke-B remote model are both listed | Local model shows as-is; remote model shows "(spoke-B-hostname · via relay)" |
| 3 | If both spokes have the same model ID (e.g., "claude-3-5-sonnet"), verify two entries appear | Two separate selector entries, each with its own host annotation |
| 4 | Select a remote model and send a message; check system prompt (via agent logs or debug mode) | System prompt should contain "You are: model-name (via remote on host spoke-B, relayed from spoke-A)" |

---

## Phase 6: Loop Delegation End-to-End

| Step | Action | Expected |
|------|--------|----------|
| 1 | On spoke-A (no local LLM), open a thread that previously used MCP tools hosted on spoke-B (>50% of recent tool calls on spoke-B's tools) | Thread history displays normally |
| 2 | Select the remote model (hosted on spoke-B) and send a new message | spoke-A detects delegation conditions are met; status shows active/thinking |
| 3 | After spoke-B processes the request, wait for sync cycles | Assistant response appears in spoke-A's thread (synced back from spoke-B) |
| 4 | Verify no confirmed-tool prompts appeared during delegated execution | Delegated loops block confirmed tools; agent should have skipped or returned a block error for any confirmed tool |
| 5 | Click Cancel mid-delegation on spoke-A | Cancel relay message sent; spoke-B's agent loop aborts; spoke-A returns to idle |

---

## End-to-End: Full Relay Round-Trip

**Purpose:** Validates the complete inference relay path from requester to target and back, including sync transport, relay processor execution, and metrics recording.

1. Start hub, spoke-A (no LLM), and spoke-B (with LLM backend)
2. Verify initial sync cycle completes: `SELECT host_name FROM hosts` on each spoke shows the other
3. On spoke-A web UI, select spoke-B's model, send "What is 2+2?"
4. Observe: status indicator goes active, response arrives within 30 seconds
5. Verify on spoke-A: `SELECT relay_target, relay_latency_ms FROM turns ORDER BY created_at DESC LIMIT 1` — non-null values
6. Verify on spoke-B: `SELECT kind FROM relay_cycles WHERE kind IN ('inference', 'stream_chunk', 'stream_end')` — all three kinds present
7. Verify on spoke-A: assistant message content contains "4"

---

## End-to-End: Concurrent Streams

**Purpose:** Validates that multiple simultaneous relay inference requests do not interfere.

1. Open 3 browser tabs on spoke-A, each in a different thread
2. Select the same remote model in all 3 tabs
3. Send different prompts simultaneously (e.g., "Say hello", "Say goodbye", "Say thanks")
4. Verify all 3 threads receive independent, correct responses
5. On spoke-B: `SELECT DISTINCT stream_id FROM relay_cycles WHERE kind = 'stream_chunk'` — at least 3 distinct stream_ids

---

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC6.2 (full delegation path) | Integration test covers relay transport and RelayProcessor execution, but full web UI thread update across two real Bound instances involves timing-dependent sync cycles and WebSocket push | Start two Bound instances in a cluster. Configure spoke-A with no local LLM. Send a message on spoke-A's web UI targeting spoke-B's model. Verify response appears in spoke-A's thread after delegation and sync — without requiring manual refresh. |
| AC1.1 / AC4.1 visual streaming | Automated tests verify data correctness; visual check confirms text appears progressively | Watch the chat UI during a relayed inference. Verify text appears character-by-character (streaming), not all-at-once. |
| AC5.3 visual italic | Unit test confirms `status: "offline?"` in API; visual check confirms italic styling | With a stale remote host, verify the model selector option text displays in italic with "(offline?)" annotation. |

---

## Traceability

| AC | Automated Tests | Manual Phase |
|----|-----------------|--------------|
| AC1.1 | relay-stream.test.ts, relay-stream.integration.test.ts | Phase 1 Steps 1-6 |
| AC1.2 | relay-stream.test.ts | — |
| AC1.3 | relay-stream.test.ts | — |
| AC1.4 | relay-stream.test.ts, relay-stream.integration.test.ts | Phase 2 |
| AC1.5 | relay-stream.test.ts | Phase 3 |
| AC1.6 | relay-stream.test.ts | Phase 3 Step 4 |
| AC1.7 | relay-stream.test.ts, relay-stream.integration.test.ts | — |
| AC1.8 | relay-stream.test.ts | — |
| AC1.9 | relay-stream.test.ts, relay-stream.integration.test.ts | Phase 4 |
| AC2.1 | model-resolution.test.ts | — |
| AC2.2 | model-resolution.test.ts, relay-router.test.ts | — |
| AC2.3 | model-hint.test.ts | — |
| AC2.4 | model-resolution.test.ts | — |
| AC2.5 | relay-router.test.ts | Phase 3 Steps 2-3 |
| AC3.1 | relay-processor-inference.test.ts | — |
| AC3.2 | relay-processor-inference.test.ts | — |
| AC3.3 | relay-processor-inference.test.ts | — |
| AC3.4 | relay-processor-inference.test.ts | Phase 2 Steps 3-4 |
| AC3.5 | relay-processor-inference.test.ts, relay-stream.integration.test.ts | — |
| AC3.6 | relay-processor-inference.test.ts, relay-stream.integration.test.ts | E2E Concurrent Streams |
| AC4.1 | relay-stream.test.ts, relay-stream.integration.test.ts | Phase 1 Step 7 |
| AC4.2 | agent-loop.test.ts, relay-stream.integration.test.ts | — |
| AC4.3 | relay-processor-inference.test.ts | E2E Round-Trip Step 6 |
| AC5.1 | status-models.test.ts, model-selector.spec.ts | Phase 5 Steps 1-2 |
| AC5.2 | status-models.test.ts, model-selector.spec.ts | Phase 5 Step 2 |
| AC5.3 | status-models.test.ts, model-selector.spec.ts | Phase 3 Step 3, visual check |
| AC5.4 | context-assembly.test.ts | Phase 5 Step 4 |
| AC5.5 | status-models.test.ts | Phase 5 Step 3 |
| AC6.1 | delegation.test.ts, delegation.spec.ts | Phase 6 Step 2 |
| AC6.2 | relay-stream.integration.test.ts (placeholder) | Phase 6 Steps 1-3 (primary manual) |
| AC6.3 | threads-status.test.ts, delegation.spec.ts | Phase 1 Steps 4-6 |
| AC6.4 | threads-status.test.ts, delegation.spec.ts | Phase 6 Step 5 |
| AC6.5 | delegation.test.ts, delegation.spec.ts | — |
| AC6.6 | delegation.test.ts | Phase 6 Step 4 |
| AC6.7 | delegation.test.ts | — |
