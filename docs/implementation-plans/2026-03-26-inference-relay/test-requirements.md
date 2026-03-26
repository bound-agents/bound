# Inference Relay -- Test Requirements

This document maps every acceptance criterion (inference-relay.AC1.1 through inference-relay.AC6.7) to either an automated test or a documented human verification. Criteria are grouped by AC section. Each entry references the implementation phase that introduces the relevant code.

---

## AC1: Streaming inference via relay

### inference-relay.AC1.1 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "yields StreamChunks from async generator when stream_chunk and stream_end inbox entries arrive"
- **Verifies:** Insert 3 `stream_chunk` inbox entries (seq 0, 1, 2) with text chunks plus 1 `stream_end` entry into a real SQLite database. Call `relayStream()`. Verify all text chunks are yielded in order and the generator closes.
- **Phase:** 3 (Task 5)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "streams inference chunks from target to requester end-to-end"
- **Verifies:** Two-spoke cluster with hub. Requester's AgentLoop targets a remote model on the target spoke. MockLLMBackend on target yields text chunks "Hello", " world", then done. Sync cycles driven in parallel. Requester's assistant message contains "Hello world". Full relay_outbox -> hub -> relay_inbox -> yield path exercised.
- **Phase:** 5 (Task 2)

### inference-relay.AC1.2 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Test:** "stream_end closes the generator and yields the done chunk with usage stats"
- **Verifies:** Insert `stream_chunk` entries followed by a `stream_end` entry whose chunks include a `done` StreamChunk with usage stats. Verify the done chunk is included in yielded values and the async generator returns (does not hang).
- **Phase:** 3 (Task 5)

### inference-relay.AC1.3 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Test:** "chunks reordered by seq produce correct ParsedResponse identical to local inference"
- **Verifies:** Insert inbox entries with seq 2, 0, 1 (out of order in DB by `received_at`). Verify yielded chunks follow seq 0, 1, 2 order. The downstream chunk accumulation pipeline (text + tool calls + usage) produces a ParsedResponse identical to what a local inference call would produce given the same chunks.
- **Phase:** 3 (Task 5)

### inference-relay.AC1.4 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "cancel during RELAY_STREAM sends cancel to target and requester exits cleanly"
- **Verifies:** Insert an initial `stream_chunk` (seq 0). Set `this.aborted = true` before the second poll. Verify the generator yields seq 0 then stops. Verify a `cancel` entry appears in `relay_outbox` with `ref_id` matching the inference outbox entry ID.
- **Phase:** 3 (Task 5)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "cancel during streaming sends cancel to target and stops requester"
- **Verifies:** Two-spoke cluster. MockLLMBackend yields chunks slowly (one per 200ms, 10 total). After first sync cycle, abort the requester's AgentLoop. Drive sync until cancel propagates. Verify agent loop completes (no hang), `cancel` entry in requester outbox with correct `ref_id`, `error` entry in target outbox with payload containing "cancelled".
- **Phase:** 5 (Task 3)

### inference-relay.AC1.5 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "failover on per-host timeout generates new stream_id and retries next host"
- **Verifies:** Provide two eligible hosts. Do NOT insert any inbox entries for the first host. Use a very short `perHostTimeoutMs` override. Verify the generator writes a second `inference` outbox entry targeting the second host with a different `stream_id`. Insert valid stream responses for the second host. Verify chunks from the second host are yielded.
- **Phase:** 3 (Task 5)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "failover to second host on first host timeout" (optional, covered by unit tests primarily)
- **Phase:** 5 (implicit via end-to-end infrastructure)

### inference-relay.AC1.6 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Test:** "no chunks within inference_timeout_ms returns timeout error to agent loop"
- **Verifies:** Use a single eligible host. Do NOT insert any inbox entries. Use a very short `perHostTimeoutMs` override. Verify the generator throws an Error with message "all 1 eligible host(s) timed out".
- **Phase:** 3 (Task 5)

### inference-relay.AC1.7 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "target model unavailable returns error kind response"
- **Verifies:** Insert an `error` inbox entry (kind="error", payload=`{"error":"model not found"}`). Verify the generator throws with "model not found".
- **Phase:** 3 (Task 5)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "target model unavailable returns error response"
- **Verifies:** Register target with empty `models = '[]'`. Requester resolves model as remote. `executeInference()` on target writes error. Agent loop completes with `result.error` containing "Model not available".
- **Phase:** 5 (Task 4)

### inference-relay.AC1.8 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Test:** "out-of-order seq -- gap skipped after 2 poll cycles with log warning"
- **Verifies:** Insert `stream_chunk` with seq=0 on first poll, then seq=2 (skip seq=1). Wait 2 poll cycles (MAX_GAP_CYCLES). Verify the gap is detected (seq=1 skipped with warning logged), nextExpectedSeq advances to lowest buffered seq (2), and seq=2 yields after the gap skip.
- **Phase:** 3 (Task 5)

### inference-relay.AC1.9 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "large prompt >2MB triggers file-based sync with messages_file_ref"
- **Verifies:** Build an InferenceRequestPayload whose serialized size exceeds 2MB (e.g., 1000 messages each with 2KB content). Execute the LLM_CALL remote path. Verify the outbox entry payload has `messages_file_ref` set and `messages` is an empty array. Verify a row exists in the `files` table at the referenced path.
- **Phase:** 3 (Task 4)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "large prompt uses file-based relay"
- **Verifies:** Create a user message large enough for >2MB serialized payload. Run agent loop. Verify requester's outbox inference entry has `messages_file_ref` set. Verify target processes the request and writes `stream_chunk` entries (confirming it read the prompt from the synced file).
- **Phase:** 5 (Task 5)

---

## AC2: Cluster-wide model resolution

### inference-relay.AC2.1 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/model-resolution.test.ts`
- **Test:** "local model resolves to { kind: 'local', backend } with no relay"
- **Verifies:** Call `resolveModel()` with a model ID that exists in the ModelRouter's local backends. Verify `kind === "local"` and the returned backend matches the one registered in the router.
- **Phase:** 2 (Task 2)

### inference-relay.AC2.2 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-router.test.ts`
- **Test:** "remote model resolves to { kind: 'remote', hosts } sorted by online_at recency"
- **Verifies:** Insert multiple hosts with `models` JSON arrays containing the target model ID into a real SQLite database. Call `findEligibleHostsByModel()`. Verify only matching hosts returned, sorted by `online_at` descending (most recent first). Also verified in `model-resolution.test.ts`: call `resolveModel()` with a model ID NOT in local backends but present in hosts table. Verify `kind === "remote"` and hosts list contains the inserted host.
- **Phase:** 2 (Tasks 1, 2, 6)

### inference-relay.AC2.3 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/model-hint.test.ts`
- **Test:** "model-hint validates against cluster-wide model pool"
- **Verifies:** Create a CommandContext with a ModelRouter containing a local backend "claude-3". Call model-hint handler with `--model claude-3` -- verify success. Call with `--model unknown-model-xyz` and no remote hosts matching -- verify error response containing "unknown-model-xyz".
- **Phase:** 2 (Task 5)

### inference-relay.AC2.4 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/model-resolution.test.ts`
- **Test:** "unknown model returns error with available alternatives"
- **Verifies:** Call `resolveModel()` with a model ID not in local backends and no matching hosts in DB. Verify `kind === "error"` with message containing the model ID and listing available local backend IDs.
- **Phase:** 2 (Task 2)

### inference-relay.AC2.5 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-router.test.ts`
- **Test:** "host with matching model but stale online_at filtered from eligible hosts"
- **Verifies:** Insert a host with matching model but `online_at` older than STALE_THRESHOLD_MS (e.g., 6 minutes ago). Verify it is absent from `findEligibleHostsByModel()` results. Insert another host with the same model and fresh `online_at` (within 5 minutes). Verify it IS included. Also verify: if all hosts with a matching model are stale, the result is `{ ok: false }` (not `{ ok: true, hosts: [] }`).
- **Phase:** 2 (Tasks 1, 6)

---

## AC3: Target-side inference execution

### inference-relay.AC3.1 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Test:** "target receives inference request, calls local chat(), streams chunks back with correct stream_id and monotonic seq"
- **Verifies:** Insert a valid `inference` inbox entry with `stream_id`. Run `RelayProcessor.processPendingEntries()`. Verify `relay_outbox` contains entries with the same `stream_id`, kinds `stream_chunk`/`stream_end`, monotonic `seq` starting at 0. MockLLMBackend yields controlled StreamChunk sequences.
- **Phase:** 4 (Task 4)

### inference-relay.AC3.2 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Test:** "chunks flushed at 200ms timer OR 4KB buffer threshold, whichever fires first"
- **Verifies:** Use a MockLLMBackend that yields chunks slowly (one per 250ms) for the timer test and one large chunk (>4KB) for the buffer test. Verify that: a flush occurs at ~200ms even with pending chunks (timer threshold), and a flush occurs when buffer reaches 4096 bytes even before 200ms (size threshold).
- **Phase:** 4 (Task 4)

### inference-relay.AC3.3 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Test:** "stream_end outbox entry carries final chunk batch including done chunk with usage stats"
- **Verifies:** MockLLMBackend yields text chunks then a `done` chunk with usage stats. After processing completes, verify the final outbox entry has `kind === "stream_end"` and its deserialized payload `chunks` array includes the `done` chunk.
- **Phase:** 4 (Task 4)

### inference-relay.AC3.4 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Test:** "cancel message aborts active inference stream via AbortController; target writes error response"
- **Verifies:** Start inference processing. Insert a `cancel` inbox entry with `ref_id = inferenceEntry.id` before processing completes. Call `processPendingEntries()`. Verify the inference stream was aborted (AbortController signal) and an `error` outbox entry with `"cancelled by requester"` appears in the outbox. Note: underlying HTTP stream to LLM provider is not cancelled (AbortSignal not wired to ChatParams); only the for-await loop breaks. This is documented in Phase 4 Task 3.
- **Phase:** 4 (Tasks 2, 3, 4)

### inference-relay.AC3.5 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Unit Test:** "expired request past expires_at discarded without execution"
- **Verifies:** Insert an `inference` entry with `expires_at` in the past (e.g., `new Date(0).toISOString()`). Call `processEntry()`. Verify no `stream_chunk` or `stream_end` appears in outbox. Verify entry is marked processed.
- **Phase:** 4 (Task 4)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "expired inference request discarded silently"
- **Verifies:** Write an inference inbox entry directly on target with `expires_at` in the past. Call `relayProcessor.processPendingEntries()` directly. Verify no stream output.
- **Phase:** 5 (Task 4)

### inference-relay.AC3.6 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Unit Test:** "multiple concurrent inference streams execute simultaneously without interference"
- **Verifies:** Insert 3 concurrent `inference` entries with different `stream_id` values. Trigger processing. Verify all 3 produce independent `stream_chunk`/`stream_end` sequences with their respective `stream_id` values, none interfering (seq counters independent, chunks from one stream do not appear in another's outbox entries).
- **Phase:** 4 (Task 4)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "multiple concurrent inference streams run without interference"
- **Verifies:** 3 separate AgentLoop instances on requester, all targeting the same remote model on target. Run all 3 concurrently with `Promise.all()`. All 3 complete without error, each produces an independent assistant message. `relay_cycles` table has entries for 3 distinct `stream_id` values.
- **Phase:** 5 (Task 5)

---

## AC4: Metrics and observability

### inference-relay.AC4.1 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/relay-stream.test.ts`
- **Unit Test:** "relayed inference records relay_target and relay_latency_ms on turns" (implicit in AC1.1 unit test via `recordTurnRelayMetrics` call)
- **Phase:** 3 (Task 2)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "streams inference chunks from target to requester end-to-end" (includes turns metrics assertion)
- **Verifies:** After relayed inference completes, query requester's `turns` table. Verify `relay_target = target.hostName` and `relay_latency_ms > 0` (first-chunk latency).
- **Phase:** 5 (Task 2)

### inference-relay.AC4.2 -- Automated (unit + integration)
- **Unit File:** `packages/agent/src/__tests__/agent-loop.test.ts`
- **Unit Test:** "local inference has NULL relay_target and relay_latency_ms (no regression)"
- **Verifies:** Create AgentLoop with a mock ModelRouter returning a local LLMBackend. Run the agent loop. Query `turns` table: `SELECT relay_target, relay_latency_ms FROM turns WHERE thread_id = ?`. Verify both columns are NULL.
- **Phase:** 3 (Task 6)

- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts`
- **Integration Test:** "local inference leaves relay metrics NULL"
- **Verifies:** Configure ModelRouter on requester with a LOCAL mock backend. Run agent loop. Verify `relay_target IS NULL` and `relay_latency_ms IS NULL` in turns table.
- **Phase:** 5 (Task 4)

### inference-relay.AC4.3 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/relay-processor-inference.test.ts`
- **Test:** "relay_cycles records entries for inference, stream_chunk, stream_end kinds with stream_id"
- **Verifies:** After `executeInference()` completes, query `relay_cycles WHERE kind IN ('inference', 'stream_chunk', 'stream_end')`. Verify entries exist for all three kinds. The `inference` entry is recorded on request receipt; `stream_chunk` and `stream_end` entries are recorded on each flush.
- **Phase:** 4 (Task 5, assertion added to Task 4 AC3.1 test case)

---

## AC5: Web UI model selector

### inference-relay.AC5.1 -- Automated (unit + e2e)
- **Unit File:** `packages/web/src/server/__tests__/status-models.test.ts`
- **Unit Test:** "/api/models returns union of local backends and remote models from hosts.models"
- **Verifies:** Insert a host with `models = '["gpt-4"]'` and fresh `online_at`. GET `/models` via Hono app.fetch(). Verify response includes both local model (from modelsConfig) and `gpt-4` with `via: "relay"`.
- **Phase:** 6 (Tasks 2, 6)

- **E2E File:** `e2e/model-selector.spec.ts`
- **E2E Test:** "model selector shows local and remote models"
- **Verifies:** Playwright loads chat page with route-intercepted `/api/models` returning both local and remote entries. Verify model selector options include both.
- **Phase:** 6 (Task 5)

### inference-relay.AC5.2 -- Automated (unit + e2e)
- **Unit File:** `packages/web/src/server/__tests__/status-models.test.ts`
- **Unit Test:** "remote models annotated with host name and via relay"
- **Verifies:** Remote model entry has `via: "relay"` and `host` field matching the host_name from the hosts table row.
- **Phase:** 6 (Tasks 2, 6)

- **E2E File:** `e2e/model-selector.spec.ts`
- **E2E Test:** "model selector shows via relay annotation for remote models"
- **Verifies:** Playwright verifies model selector option text contains "(host-name . via relay)" for remote model entries.
- **Phase:** 6 (Task 5)

### inference-relay.AC5.3 -- Automated (unit + e2e)
- **Unit File:** `packages/web/src/server/__tests__/status-models.test.ts`
- **Unit Test:** "stale remote models annotated offline?"
- **Verifies:** Insert a host with `online_at` set to 6 minutes ago (exceeds STALE_THRESHOLD_MS of 5 minutes). GET `/models`. Verify that model's `status === "offline?"`.
- **Phase:** 6 (Tasks 2, 6)

- **E2E File:** `e2e/model-selector.spec.ts`
- **E2E Test:** "stale remote model shows offline? annotation"
- **Verifies:** Playwright verifies model selector option text contains "offline?" and the option has italic styling (class `stale`).
- **Phase:** 6 (Task 5)

### inference-relay.AC5.4 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/context-assembly.test.ts`
- **Test:** "volatile context includes model relay location when relayInfo is provided"
- **Verifies:** Call `assembleContext()` with `relayInfo: { remoteHost: "target-host", localHost: "local-host", model: "claude-3-5-sonnet", provider: "remote" }`. Verify assembled system message contains `"You are: claude-3-5-sonnet (via remote on host target-host, relayed from local-host)"`. Call without `relayInfo` -- verify no relay location line appears.
- **Phase:** 6 (Task 4)

### inference-relay.AC5.5 -- Automated (unit)
- **File:** `packages/web/src/server/__tests__/status-models.test.ts`
- **Test:** "same model ID on multiple remote hosts listed as separate entries with different host annotations"
- **Verifies:** Insert two hosts both with `models = '["shared-model"]'` but different `host_name` values. GET `/models`. Verify two separate entries appear for "shared-model" with different `host` values.
- **Phase:** 6 (Tasks 2, 6)

---

## AC6: Web UI loop delegation

### inference-relay.AC6.1 -- Automated (unit + e2e)
- **Unit File:** `packages/agent/src/__tests__/delegation.test.ts`
- **Unit Test:** "delegation triggers when model remote, single host, and >=50% recent tools on that host"
- **Verifies:** Create thread with 12 tool calls: 8 matching target host's `mcp_tools`, 4 on other hosts. Remote model resolves to single host. `getDelegationTarget()` returns the target host.
- **Phase:** 7 (Tasks 1, 6)

- **E2E File:** `e2e/delegation.spec.ts`
- **E2E Test:** "delegation triggers when conditions hold" (implicit via status indicator showing remote processing)
- **Phase:** 7 (Task 7)

### inference-relay.AC6.2 -- Automated (integration) + Human verification
- **Integration File:** `packages/agent/src/__tests__/relay-stream.integration.test.ts` (or a new `delegation.integration.test.ts` if created)
- **Integration Test:** "processing host receives process message and starts agent loop for the thread"
- **Verifies:** Two-spoke cluster. Originating host writes `process` relay message. Target's RelayProcessor receives it, calls `executeProcess()`, which starts an AgentLoop. After sync, originating host's thread has a new assistant message (demonstrating the delegated loop ran and produced a response that synced back).
- **Phase:** 7 (Task 3)

- **Human Verification:** Full end-to-end delegation through a live multi-host cluster requires manual testing because the integration test cannot easily validate the web UI thread update flow across two real Bound instances.
- **Approach:** Start two Bound instances in a cluster. Configure one host with no local LLM backend and the other with a backend. Send a message in the web UI on the first host. Verify the response arrives after delegation to the second host.
- **Justification:** The integration test validates the relay transport path and RelayProcessor execution, but the full web UI update (thread message appearing after sync) involves timing-dependent sync cycles and WebSocket push that are better verified manually.

### inference-relay.AC6.3 -- Automated (unit + e2e)
- **Unit File:** `packages/web/src/server/__tests__/threads-status.test.ts`
- **Unit Test:** "status endpoint returns forwarded status from status_forward cache"
- **Verifies:** With forwarded status `{ status: "thinking", detail: null, tokens: 150 }` in cache, GET `/api/threads/{id}/status` returns `{ active: true, state: "thinking", detail: null, tokens: 150 }`. With `{ status: "tool_call", detail: "bash" }` returns `{ active: true, state: "tool_call", detail: "bash" }`. After idle forwarded, returns `{ active: false, state: "idle" }`.
- **Phase:** 7 (Task 4)

- **E2E File:** `e2e/delegation.spec.ts`
- **E2E Test:** "status indicator shows remote processing"
- **Verifies:** Route-intercept `/api/threads/{id}/status` to return `{ active: true, state: "thinking" }`. Verify thread UI shows a thinking indicator. Update to `{ active: false, state: "idle" }`. Verify indicator disappears.
- **Phase:** 7 (Task 7)

### inference-relay.AC6.4 -- Automated (unit + e2e)
- **Unit File:** `packages/web/src/server/__tests__/threads-status.test.ts` (or the cancel endpoint test file)
- **Unit Test:** "cancel on originating host sends cancel with ref_id matching process outbox entry"
- **Verifies:** Set up `activeDelegations` map with a delegation entry for a thread. Call the cancel endpoint. Verify a `cancel` relay outbox entry is written with `ref_id` matching the `processOutboxId` from the delegation.
- **Phase:** 7 (Task 5)

- **E2E File:** `e2e/delegation.spec.ts`
- **E2E Test:** "cancel button sends cancel to delegated host"
- **Verifies:** Set up route intercept for cancel endpoint. Click cancel button in thread UI. Verify cancel endpoint was called with correct threadId.
- **Phase:** 7 (Task 7)

### inference-relay.AC6.5 -- Automated (unit + e2e)
- **Unit File:** `packages/agent/src/__tests__/delegation.test.ts`
- **Unit Test:** "no delegation when conditions unmet"
- **Verifies:** Four sub-cases:
  1. Remote model but 2 hosts -> returns null.
  2. Remote model, single host, only 30% tools match -> returns null.
  3. Local model -> returns null.
  4. Model resolves to error -> returns null.
- **Phase:** 7 (Tasks 1, 6)

- **E2E File:** `e2e/delegation.spec.ts`
- **E2E Test:** "no delegation when conditions unmet -- local model runs normally"
- **Verifies:** Send a message with a local model selected. Response appears normally (no delegation failure, no status forwarding).
- **Phase:** 7 (Task 7)

### inference-relay.AC6.6 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/delegation.test.ts` (or `relay-processor-inference.test.ts`)
- **Test:** "confirmed tools blocked on delegated loops; agent receives block error"
- **Verifies:** The delegated AgentLoop is constructed with `taskId = "delegated-{id}"` (Phase 7 Task 3). Since this taskId does NOT start with `"interactive-"`, the existing confirmed-tool check in `mcp-bridge.ts` returns a block error. Test by running a delegated AgentLoop that encounters a confirmed tool call and verifying the tool result contains a block error message, not a confirmation prompt.
- **Phase:** 7 (Task 3, leveraging existing mcp-bridge.ts guard)

### inference-relay.AC6.7 -- Automated (unit)
- **File:** `packages/agent/src/__tests__/delegation.test.ts`
- **Test:** "thread with no tool call history -- vacuous >=50% match -- delegation proceeds"
- **Verifies:** Thread has 0 tool calls in messages table. Remote model resolves to single host. `getDelegationTarget()` returns the target host (vacuous match: 0/0 >= 50% is treated as true by the `totalToolCalls === 0` early return).
- **Phase:** 7 (Tasks 1, 6)

---

## Summary

| AC | Automated Tests | Human Verification |
|----|----------------|--------------------|
| AC1.1 | 1 unit + 1 integration | -- |
| AC1.2 | 1 unit | -- |
| AC1.3 | 1 unit | -- |
| AC1.4 | 1 unit + 1 integration | -- |
| AC1.5 | 1 unit | -- |
| AC1.6 | 1 unit | -- |
| AC1.7 | 1 unit + 1 integration | -- |
| AC1.8 | 1 unit | -- |
| AC1.9 | 1 unit + 1 integration | -- |
| AC2.1 | 1 unit | -- |
| AC2.2 | 2 unit | -- |
| AC2.3 | 1 unit | -- |
| AC2.4 | 1 unit | -- |
| AC2.5 | 1 unit | -- |
| AC3.1 | 1 unit | -- |
| AC3.2 | 1 unit | -- |
| AC3.3 | 1 unit | -- |
| AC3.4 | 1 unit | -- |
| AC3.5 | 1 unit + 1 integration | -- |
| AC3.6 | 1 unit + 1 integration | -- |
| AC4.1 | 1 unit + 1 integration | -- |
| AC4.2 | 1 unit + 1 integration | -- |
| AC4.3 | 1 unit | -- |
| AC5.1 | 1 unit + 1 e2e | -- |
| AC5.2 | 1 unit + 1 e2e | -- |
| AC5.3 | 1 unit + 1 e2e | -- |
| AC5.4 | 1 unit | -- |
| AC5.5 | 1 unit | -- |
| AC6.1 | 1 unit + 1 e2e | -- |
| AC6.2 | 1 integration | Live multi-host delegation |
| AC6.3 | 1 unit + 1 e2e | -- |
| AC6.4 | 1 unit + 1 e2e | -- |
| AC6.5 | 1 unit + 1 e2e | -- |
| AC6.6 | 1 unit | -- |
| AC6.7 | 1 unit | -- |

**Totals:** 35 acceptance criteria covered. 34 fully automated. 1 (AC6.2) has automated integration coverage supplemented by documented human verification for the full web UI delegation path.

### Test Files Created or Modified

| File | Type | ACs Covered |
|------|------|-------------|
| `packages/agent/src/__tests__/relay-stream.test.ts` | unit | AC1.1-AC1.9, AC4.1 |
| `packages/agent/src/__tests__/relay-stream.integration.test.ts` | integration | AC1.1, AC1.4, AC1.7, AC1.9, AC3.5, AC3.6, AC4.1, AC4.2 |
| `packages/agent/src/__tests__/model-resolution.test.ts` | unit | AC2.1, AC2.2, AC2.4 |
| `packages/agent/src/__tests__/relay-router.test.ts` | unit | AC2.2, AC2.5 |
| `packages/agent/src/__tests__/model-hint.test.ts` | unit | AC2.3 |
| `packages/agent/src/__tests__/relay-processor-inference.test.ts` | unit | AC3.1-AC3.6, AC4.3 |
| `packages/agent/src/__tests__/agent-loop.test.ts` | unit | AC4.2 |
| `packages/web/src/server/__tests__/status-models.test.ts` | unit | AC5.1-AC5.3, AC5.5 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | unit | AC5.4 |
| `packages/agent/src/__tests__/delegation.test.ts` | unit | AC6.1, AC6.5, AC6.6, AC6.7 |
| `packages/web/src/server/__tests__/threads-status.test.ts` | unit | AC6.3, AC6.4 |
| `e2e/model-selector.spec.ts` | e2e (Playwright) | AC5.1-AC5.3 |
| `e2e/delegation.spec.ts` | e2e (Playwright) | AC6.1, AC6.3-AC6.5 |
