# Inference Relay Implementation Plan — Phase 3: RELAY_STREAM State Machine

**Goal:** The agent loop can request inference from a remote host and receive streaming chunks transparently via the `RELAY_STREAM` state, producing an `AsyncIterable<StreamChunk>` indistinguishable from local inference.

**Architecture:** `RELAY_STREAM` is a new `AgentLoopState` and a new async generator method `relayStream()` in `AgentLoop`. It mirrors the `_relayWaitImpl()` pattern (lines 424-564 of agent-loop.ts) but for streaming: writes one `inference` outbox entry with a `stream_id` UUID, polls `readInboxByStreamId()` at 500ms intervals, reorders chunks by `seq`, yields from `stream_chunk` entries, and closes on `stream_end`. Cancel writes a "cancel" outbox entry with `ref_id` pointing to the inference outbox entry. Failover generates a new `stream_id` and retries the next eligible host. The Phase 2 placeholder in LLM_CALL is replaced with an actual `yield*` from `relayStream()`. Large prompts (serialized size > 2MB) are written to the synced files table and referenced by path.

**Tech Stack:** bun:sqlite, TypeScript 6.x strict, bun:test

**Scope:** Phase 3 of 7. Depends on Phase 1 (stream_id column, readInboxByStreamId, InferenceRequestPayload) and Phase 2 (ModelRouter in constructor, resolveModel()).

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC1: Streaming inference via relay
- **inference-relay.AC1.1 Success:** Requester writes `inference` request, target streams `stream_chunk` messages back, requester yields `StreamChunk`s from async generator
- **inference-relay.AC1.2 Success:** `stream_end` message closes the generator and provides usage stats to the caller
- **inference-relay.AC1.3 Success:** Chunks arrive ordered by `seq`; parser produces correct `ParsedResponse` identical to local inference
- **inference-relay.AC1.4 Success:** Cancel during RELAY_STREAM sends `cancel` to target, target aborts the `AsyncIterable`, requester exits cleanly
- **inference-relay.AC1.5 Success:** Failover on per-host timeout — new `stream_id`, retry on next eligible host
- **inference-relay.AC1.6 Failure:** No chunks within `inference_timeout_ms` (default 120s) returns timeout error to agent loop
- **inference-relay.AC1.7 Failure:** Target model unavailable returns `error` kind response
- **inference-relay.AC1.8 Edge:** Out-of-order `seq` — chunks buffered, yielded when contiguous, gap skipped after 2 sync cycles with log warning
- **inference-relay.AC1.9 Edge:** Large prompt (>2MB serialized) triggers file-based sync; target reads prompt from synced file

### inference-relay.AC4: Metrics and observability
- **inference-relay.AC4.1 Success:** Relayed inference records `relay_target` (host_name) and `relay_latency_ms` (first-chunk latency) on turns
- **inference-relay.AC4.2 Success:** Local inference has NULL `relay_target` and `relay_latency_ms` (no regression)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add `RELAY_STREAM` to `AgentLoopState`

**Verifies:** None (type infrastructure)

**Files:**
- Modify: `packages/agent/src/types.ts` (line 14 — after `"RELAY_WAIT"`)

**Implementation:**

Add `"RELAY_STREAM"` to the `AgentLoopState` union:

```typescript
export type AgentLoopState =
	| "IDLE"
	| "HYDRATE_FS"
	| "ASSEMBLE_CONTEXT"
	| "LLM_CALL"
	| "PARSE_RESPONSE"
	| "TOOL_EXECUTE"
	| "TOOL_PERSIST"
	| "RESPONSE_PERSIST"
	| "FS_PERSIST"
	| "QUEUE_CHECK"
	| "ERROR_PERSIST"
	| "AWAIT_POLL"
	| "RELAY_WAIT"
	| "RELAY_STREAM";
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add RELAY_STREAM to AgentLoopState`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `relayStream()` async generator

**Verifies:** inference-relay.AC1.1, inference-relay.AC1.2, inference-relay.AC1.3, inference-relay.AC1.4, inference-relay.AC1.5, inference-relay.AC1.6, inference-relay.AC1.7, inference-relay.AC1.8, inference-relay.AC4.1

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (add imports, add `relayStream()` private method after `_relayWaitImpl()` at line 565)

**Implementation:**

Add imports at the top of agent-loop.ts:

```typescript
import type { InferenceRequestPayload, StreamChunkPayload } from "@bound/llm";
import {
	readInboxByStreamId,
	markProcessed,
	recordRelayCycle,
} from "@bound/core";
```

Add the `relayStream()` private async generator method after `_relayWaitImpl()`:

```typescript
/**
 * Async generator that requests LLM inference from a remote host via the relay transport,
 * yielding StreamChunks identical to what a local LLMBackend.chat() would produce.
 *
 * Mirrors the _relayWaitImpl() pattern but for streaming:
 * - One inference outbox entry per host attempt (with unique stream_id per attempt)
 * - Polls readInboxByStreamId() for stream_chunk / stream_end entries
 * - Reorders chunks by seq, buffers out-of-order arrivals
 * - Skips gaps after MAX_GAP_CYCLES polling cycles with a warning
 * - Failover on withSilenceTimeout() expiry: new stream_id, next eligible host
 * - Cancel writes cancel entry with ref_id pointing to inference outbox entry
 */
private async *relayStream(
	payload: InferenceRequestPayload,
	eligibleHosts: EligibleHost[],
	currentTurnId: number | null,
): AsyncGenerator<StreamChunk> {
	const POLL_INTERVAL_MS = 500;
	const PER_HOST_TIMEOUT_MS = 120_000; // AC1.6: inference_timeout_ms default
	const MAX_GAP_CYCLES = 2;
	const previousState = this.state;
	this.state = "RELAY_STREAM";

	try {
		for (let hostIndex = 0; hostIndex < eligibleHosts.length; hostIndex++) {
			const host = eligibleHosts[hostIndex];
			const streamId = crypto.randomUUID();

			// Write inference request to outbox
			const serializedPayload = JSON.stringify(payload);
			const outboxEntry = createRelayOutboxEntry(
				host.site_id,
				"inference",
				serializedPayload,
				PER_HOST_TIMEOUT_MS,
				undefined,  // refId — not used for inference (no idempotency key)
				undefined,  // idempotencyKey — omitted per spec §3.6
				streamId,
			);
			writeOutbox(this.ctx.db, outboxEntry);
			this.ctx.eventBus.emit("sync:trigger", { reason: "relay-stream" });

			this.ctx.logger.info("RELAY_STREAM: connecting", {
				host: host.host_name,
				model: payload.model,
				streamId,
			});

			let firstChunkReceived = false;
			const hostStartTime = Date.now();  // when we started waiting on this host
			let lastActivityTime = Date.now(); // updated on each new chunk (for mid-stream silence)
			let firstChunkLatencyMs: number | null = null;
			let nextExpectedSeq = 0;
			// Buffer for out-of-order chunks: seq -> StreamChunkPayload
			const buffer = new Map<number, StreamChunkPayload>();
			let gapCyclesWaited = 0;
			let hostSucceeded = false;

			// Polling loop for this host attempt
			while (true) {
				// Check abort/cancel before every poll
				if (this.aborted) {
					// AC1.4: send cancel to target
					const cancelEntry = createRelayOutboxEntry(
						host.site_id,
						"cancel",
						JSON.stringify({}),
						30_000,
						outboxEntry.id, // ref_id points to original inference request
					);
					try {
						writeOutbox(this.ctx.db, cancelEntry);
						this.ctx.eventBus.emit("sync:trigger", { reason: "relay-cancel" });
					} catch {
						// Non-fatal if cancel write fails
					}
					return;
				}

				// Check per-host timeout: before first chunk use hostStartTime; after first chunk
				// use lastActivityTime (mid-stream silence). Both use PER_HOST_TIMEOUT_MS.
				const now = Date.now();
				const timeoutSource = firstChunkReceived ? lastActivityTime : hostStartTime;
				const elapsedMs = now - timeoutSource;
				if (elapsedMs > PER_HOST_TIMEOUT_MS) {
					// AC1.5: Failover to next host
					this.ctx.logger.warn("RELAY_STREAM: timeout, failing over", {
						host: host.host_name,
						elapsedMs,
						nextHostAvailable: hostIndex + 1 < eligibleHosts.length,
					});
					break; // Exit inner while(true) — outer for-loop will try next host
				}

				// Fetch all unprocessed stream_chunk / stream_end for this stream_id
				const inboxEntries = readInboxByStreamId(this.ctx.db, streamId);

				// AC1.7: Check for error response
				const errorEntry = inboxEntries.find((e) => e.kind === "error");
				if (errorEntry) {
					try {
						const errPayload = JSON.parse(errorEntry.payload) as { error?: string };
						markProcessed(this.ctx.db, [errorEntry.id]);
						throw new Error(errPayload.error ?? "Remote inference error");
					} catch (parseErr) {
						markProcessed(this.ctx.db, [errorEntry.id]);
						throw new Error(`Remote inference error: ${errorEntry.payload}`);
					}
				}

				// Buffer all received stream_chunk and stream_end entries by seq
				const streamEndEntry = inboxEntries.find((e) => e.kind === "stream_end");
				const chunkEntries = inboxEntries.filter((e) => e.kind === "stream_chunk");

				for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
					try {
						const chunkPayload = JSON.parse(entry.payload) as StreamChunkPayload;
						if (!buffer.has(chunkPayload.seq)) {
							buffer.set(chunkPayload.seq, chunkPayload);
						}
						markProcessed(this.ctx.db, [entry.id]);
					} catch {
						markProcessed(this.ctx.db, [entry.id]);
					}
				}

				// AC1.3: Yield contiguous chunks starting from nextExpectedSeq
				while (buffer.has(nextExpectedSeq)) {
					const chunkPayload = buffer.get(nextExpectedSeq)!;
					buffer.delete(nextExpectedSeq);
					nextExpectedSeq++;

					for (const chunk of chunkPayload.chunks) {
						// AC4.1: Record relay_target and relay_latency_ms on first chunk
						if (!firstChunkReceived) {
							firstChunkReceived = true;
							firstChunkLatencyMs = Date.now() - hostStartTime; // first-chunk latency
							if (currentTurnId !== null) {
								try {
									recordTurnRelayMetrics(
										this.ctx.db,
										currentTurnId,
										host.host_name,
										firstChunkLatencyMs,
									);
								} catch {
									// Non-fatal
								}
							}
							this.ctx.logger.info("RELAY_STREAM: first chunk", {
								host: host.host_name,
								latencyMs: firstChunkLatencyMs,
							});
						}
						lastActivityTime = Date.now(); // reset mid-stream silence timer
						yield chunk;
					}
					gapCyclesWaited = 0; // Gap resolved
				}

				// Check if stream_end was the last contiguous chunk (buffer empty after draining)
				if (streamEndEntry && buffer.size === 0 && !buffer.has(nextExpectedSeq)) {
					// Stream complete — all chunks yielded including stream_end's chunks
					hostSucceeded = true;
					break;
				}

				// AC1.8: Detect gap — buffer has entries but next seq is missing
				if (buffer.size > 0) {
					gapCyclesWaited++;
					if (gapCyclesWaited >= MAX_GAP_CYCLES) {
						this.ctx.logger.warn("RELAY_STREAM: seq gap detected, skipping", {
							expectedSeq: nextExpectedSeq,
							bufferedSeqs: Array.from(buffer.keys()).sort(),
						});
						// Skip the gap by advancing nextExpectedSeq to lowest buffered seq
						const lowestBuffered = Math.min(...buffer.keys());
						nextExpectedSeq = lowestBuffered;
						gapCyclesWaited = 0;
					}
				}

				// Wait before next poll
				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			if (hostSucceeded) {
				return; // Done
			}
			// Continue outer for-loop to try next host
		}

		// All hosts exhausted
		throw new Error(
			`inference-relay.AC1.5: all ${eligibleHosts.length} eligible host(s) timed out`,
		);
	} finally {
		this.state = previousState;
	}
}
```

Add `EligibleHost` to imports from `./relay-router`:
```typescript
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
```

**Testing:**

The unit tests (Task 5) verify the RELAY_STREAM generator behavior using mock inbox entries. Describe tests that verify each AC case — the task-implementor will write actual test code at execution time.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors (may need fixups based on actual import resolution)

**No standalone commit** — commit together with Task 3.
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Replace Phase 2 placeholder with `relayStream()` in LLM_CALL

**Verifies:** inference-relay.AC1.1, inference-relay.AC4.2

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (the LLM_CALL section modified in Phase 2 — the `if (resolution.kind === "remote")` branch)

**Implementation:**

Replace the Phase 2 fallback placeholder with an actual `yield*` through `relayStream()`:

In the LLM_CALL section (added in Phase 2), replace:

```typescript
if (resolution.kind === "remote") {
    // Phase 3 will implement RELAY_STREAM here.
    // For now, fall back to the default local backend so Phase 2 is fully functional.
    const fallback = this.modelRouter.getDefault();
    const chatStream = fallback.chat({ ... });
    for await (const chunk of this.withSilenceTimeout(chatStream, SILENCE_TIMEOUT_MS)) {
        if (this.aborted) break;
        chunks.push(chunk);
    }
}
```

With:

```typescript
if (resolution.kind === "remote") {
    const inferencePayload: InferenceRequestPayload = {
        model: resolution.modelId,
        messages: nonSystemMessages,
        tools: this.config.tools,
        system: systemPrompt || undefined,
        max_tokens: undefined,
        temperature: undefined,
        cache_breakpoints: undefined,
        timeout_ms: 120_000,
    };

    for await (const chunk of this.relayStream(
        inferencePayload,
        resolution.hosts,
        currentTurnId,
    )) {
        if (this.aborted) break;
        chunks.push(chunk);
    }
}
```

Note: `currentTurnId` is the turn ID used for metrics recording. Ensure it is in scope here — check if the existing local LLM call path has access to the current turn ID and thread it through. The RELAY_WAIT method receives `currentTurnId` as a parameter; the LLM_CALL section should have it in scope from the context assembly stage.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): implement RELAY_STREAM state machine, wire into LLM_CALL`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Large prompt handling (AC1.9)

**Verifies:** inference-relay.AC1.9

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` (in the LLM_CALL remote branch, before calling `relayStream()`)
- Modify: `packages/agent/src/types.ts` (extend `InferenceRequestPayload` import if needed)

**Implementation:**

Before calling `relayStream()` in the LLM_CALL remote branch, check the serialized payload size. If it exceeds the 2MB limit, write the messages to a synced file via the `files` table, then replace `messages` with an empty array and add a `messages_file_ref` field.

First, extend `InferenceRequestPayload` in `packages/llm/src/types.ts` to add the optional file reference field:

```typescript
export interface InferenceRequestPayload {
	model: string;
	messages: LLMMessage[];
	tools?: ToolDefinition[];
	system?: string;
	max_tokens?: number;
	temperature?: number;
	cache_breakpoints?: number[];
	timeout_ms: number;
	messages_file_ref?: string; // Set when messages are written to synced file (large prompt path)
}
```

In the LLM_CALL remote branch, add large prompt handling before `relayStream()`:

```typescript
// AC1.9: Large prompt handling — write to synced file if payload >2MB
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const serialized = JSON.stringify(inferencePayload);
const payloadBytes = new TextEncoder().encode(serialized).byteLength;

if (payloadBytes > MAX_INLINE_BYTES) {
    const fileRef = `cluster/relay/inference-${inferencePayload.messages.length > 0
        ? crypto.randomUUID()
        : "empty"}.json`;
    const messagesJson = JSON.stringify(inferencePayload.messages);
    // Write messages to synced files table via insertRow (change-log outbox pattern)
    insertRow(this.ctx.db, "files", {
        id: crypto.randomUUID(),
        path: fileRef,
        content: messagesJson,
        is_binary: 0,
        size_bytes: new TextEncoder().encode(messagesJson).byteLength,
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
        deleted: 0,
        created_by: this.config.userId,
        host_origin: this.ctx.hostName,
    }, this.ctx.siteId);
    // Trigger sync so the file reaches the target host
    this.ctx.eventBus.emit("sync:trigger", { reason: "relay-large-prompt" });
    inferencePayload = {
        ...inferencePayload,
        messages: [],            // Clear inline messages
        messages_file_ref: fileRef,
    };
}
```

Add `insertRow` to imports from `@bound/core`.

**Testing:**
Tests must verify AC1.9:
- Build an `InferenceRequestPayload` whose serialized size exceeds 2MB (e.g., 1000 messages each with 2KB content), call the LLM_CALL path, verify `messages_file_ref` is set in the outbox entry payload and `messages` is empty.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent/src/__tests__/relay-stream.test.ts`
Expected: All tests pass

**Cleanup note:** Large prompt files are written to the synced `files` table (path prefix `cluster/relay/inference-*.json`). They sync to all hosts, not just the target — this is acceptable since the files are small relative to the inference data. After the target processes the inference request, the file can be soft-deleted. Phase 4's `executeInference()` should soft-delete the file after reading it (using `updateRow` with `deleted: 1`). Alternatively, a periodic prune (similar to `pruneRelayTables()`) can clean up old relay prompt files. Document this cleanup responsibility in Phase 4 Task 3.

**Commit:** `feat(agent): add large prompt file-based relay for >2MB inference payloads`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Unit tests for RELAY_STREAM state machine

**Verifies:** inference-relay.AC1.1, inference-relay.AC1.2, inference-relay.AC1.3, inference-relay.AC1.4, inference-relay.AC1.5, inference-relay.AC1.6, inference-relay.AC1.7, inference-relay.AC1.8

**Files:**
- Create: `packages/agent/src/__tests__/relay-stream.test.ts`

**Implementation:**

These tests exercise the `relayStream()` async generator by:
1. Creating a real SQLite database with `applySchema(db)` applied (randomBytes temp path)
2. Manually inserting mock `stream_chunk` and `stream_end` entries into `relay_inbox` (with a known `stream_id`)
3. Constructing a mock `AgentLoop` instance (or calling `relayStream()` directly on a constructed instance with a mock `AppContext`)
4. Collecting all yielded `StreamChunk` values

Tests must verify each AC listed:

- **AC1.1**: Insert 3 `stream_chunk` inbox entries with `seq` 0, 1, 2 (each with a text chunk) + 1 `stream_end` entry. Call `relayStream()`. Verify all text chunks are yielded in order, then the generator closes.

- **AC1.2**: Verify the `done` chunk from `stream_end` is included in the yielded chunks. Verify the generator returns (does not hang) after `stream_end`.

- **AC1.3**: Insert entries with `seq` 2, 0, 1 (out of order in DB). Verify chunks are yielded in seq 0, 1, 2 order.

- **AC1.4**: Insert an initial `stream_chunk` (seq 0). Set `this.aborted = true` before the second poll. Verify the generator yields seq 0 then stops. Verify a `cancel` entry appears in `relay_outbox` with `ref_id` matching the inference outbox entry.

- **AC1.5**: Do NOT insert any inbox entries. Let the 120s timeout elapse (use a very short timeout in the test — override `PER_HOST_TIMEOUT_MS`). Verify the generator throws with a timeout error. Use two eligible hosts in the test; verify a second `inference` outbox entry is written for the second host.

- **AC1.6**: Use a single eligible host. Do NOT insert inbox entries. Let timeout elapse. Verify `Error` with "all 1 eligible host(s) timed out" message.

- **AC1.7**: Insert an `error` inbox entry (kind="error", payload=`{"error":"model not found"}`). Verify the generator throws with "model not found".

- **AC1.8**: Insert `stream_chunk` with seq=0 first poll, then seq=2 (skip seq=1). Wait 2 poll cycles. Verify the gap is detected (seq=1 skipped with warning) and seq=2 yields after the gap skip.

Use real SQLite databases. Use the existing pattern from relay-wait.test.ts for db setup.

For timing-dependent tests (AC1.5, AC1.6), override the `PER_HOST_TIMEOUT_MS` constant by passing it as a parameter or using a very fast timeout. Consider refactoring `relayStream()` to accept an options object with `pollIntervalMs` and `perHostTimeoutMs` for testability.

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-stream.test.ts`
Expected: All 8 test cases pass

**Commit:** `test(agent): add unit tests for RELAY_STREAM state machine`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Metrics regression test (AC4.2)

**Verifies:** inference-relay.AC4.2

**Files:**
- Modify or create: `packages/agent/src/__tests__/agent-loop.test.ts` (add test for NULL relay metrics on local inference)

**Implementation:**

Add a test that verifies local inference (resolution.kind === "local") results in NULL `relay_target` and `relay_latency_ms` on the turn record. This confirms AC4.2 — the relay metrics columns are not polluted by local inference calls.

Test approach:
- Create an `AgentLoop` with a mock `ModelRouter` that returns a mock local `LLMBackend`
- Run the agent loop
- Query the `turns` table: `SELECT relay_target, relay_latency_ms FROM turns WHERE thread_id = ?`
- Verify both columns are NULL

**Verification:**
Run: `bun test packages/agent/src/__tests__/agent-loop.test.ts`
Expected: All tests pass including new regression test

**Commit:** `test(agent): verify local inference leaves relay metrics columns NULL`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->

---

## Phase Completion Verification

After all 6 tasks are committed:

Run all agent tests:
```bash
bun test packages/agent
```
Expected: All tests pass, including relay-stream.test.ts and relay-router.test.ts.

Run typechecks:
```bash
tsc -p packages/shared --noEmit
tsc -p packages/llm    --noEmit
tsc -p packages/core   --noEmit
tsc -p packages/agent  --noEmit
```
Expected: Zero type errors.

Confirm AC1.1–AC1.9 and AC4.1–AC4.2 coverage via test output.
