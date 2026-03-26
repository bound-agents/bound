# Inference Relay Implementation Plan — Phase 4: Target-Side Inference Execution

**Goal:** A host can receive and execute inference requests from the relay, streaming response chunks back via `stream_chunk` / `stream_end` outbox entries.

**Architecture:** New `inference` case in `RelayProcessor.processEntry()` follows the existing tool_call/resource_read pattern (validate → expire → execute → write response → mark processed → record metrics) but the execution is async and writes multiple outbox entries rather than one. A new `executeInference()` private method on `RelayProcessor` calls the local `LLMBackend.chat()`, buffers chunks at 200ms timer OR 4KB threshold, and flushes as `stream_chunk` outbox entries (with `stream_id` and monotonic `seq`). The final flush writes `stream_end`. Cancel arrives as a separate `cancel` inbox entry referencing the inference request by `ref_id`; a new `Map<string, AbortController>` on RelayProcessor enables immediate abort of the active stream. `ModelRouter` is added to the RelayProcessor constructor. `executeImmediate()` (used by hub sync path) skips `inference` kind with empty result, letting the background polling loop handle it asynchronously.

**Tech Stack:** bun:sqlite, TypeScript 6.x strict, bun:test

**Scope:** Phase 4 of 7. Depends on Phase 1 (stream_id column, payload types, writeOutbox with stream_id). Phase 2's ModelRouter injection is the model-lookup mechanism.

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC3: Target-side inference execution
- **inference-relay.AC3.1 Success:** Target receives `inference` request, calls local `chat()`, streams chunks back with correct `stream_id` and monotonic `seq`
- **inference-relay.AC3.2 Success:** Chunks flushed to outbox at 200ms timer OR 4KB buffer threshold (whichever fires first)
- **inference-relay.AC3.3 Success:** `stream_end` outbox entry carries final chunk batch including `done` chunk with usage stats
- **inference-relay.AC3.4 Success:** Cancel message aborts active inference stream via `AbortController`; target writes `error` response with `"cancelled by requester"`
- **inference-relay.AC3.5 Failure:** Expired request (past `expires_at`) discarded without execution
- **inference-relay.AC3.6 Edge:** Multiple concurrent inference streams execute simultaneously on same target without interference

### inference-relay.AC4: Metrics and observability
- **inference-relay.AC4.3 Success:** `relay_cycles` records entries for `inference`, `stream_chunk`, `stream_end` kinds with `stream_id`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Add `ModelRouter` to `RelayProcessor` constructor

**Verifies:** None (wiring)

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (constructor at lines 32-39, imports at lines 1-17)
- Modify: `packages/cli/src/commands/start.ts` (RelayProcessor instantiation at line 336)

**Implementation:**

Add `ModelRouter` import at the top of relay-processor.ts:

```typescript
import type { InferenceRequestPayload, StreamChunkPayload } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
```

Update the constructor to add `modelRouter` as the 4th parameter (after `mcpClients`, before `keyringSiteIds`):

```typescript
export class RelayProcessor {
	private stopped = false;
	private idempotencyCache = new Map<string, IdempotencyCacheEntry>();
	private pendingCancels = new Set<string>();
	private activeInferenceStreams = new Map<string, AbortController>();

	constructor(
		private db: Database,
		private siteId: string,
		private mcpClients: Map<string, MCPClient>,
		private modelRouter: ModelRouter | null, // null if no LLM configured
		private keyringSiteIds: Set<string>,
		private logger: Logger,
		private relayConfig?: RelayConfig,
	) {}
```

Update start.ts RelayProcessor instantiation at lines 336-343 to pass `modelRouter` (or `null` if not configured):

```typescript
const relayProcessor = new RelayProcessor(
    appContext.db,
    appContext.siteId,
    mcpClientsMap,
    modelRouter ?? null,   // <-- new parameter
    new Set(Object.keys(keyring.hosts)),
    appContext.logger,
    relayConfig,
);
```

**Verification:**
Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(agent): add ModelRouter to RelayProcessor constructor for inference execution`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add `inference` case to `processEntry()` and `executeImmediate()`

**Verifies:** inference-relay.AC3.1, inference-relay.AC3.5

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (processEntry() switch statement at lines 133-156; executeImmediate() at line 396)

**Implementation:**

**Part A: processEntry() switch case**

Add `inference` case to the switch statement inside `processEntry()` (before the `default` case at line 154). The `inference` case:
1. Skips idempotency check (per design spec §3.6 — inference is non-deterministic)
2. Returns `null` to signal that chunks are written directly

```typescript
case "inference": {
    const inferencePayload = JSON.parse(entry.payload) as InferenceRequestPayload;
    // inference is handled asynchronously — executeInference() writes
    // stream_chunk/stream_end outbox entries directly and returns null
    this.executeInference(entry, inferencePayload).catch((err) => {
        this.logger.error("executeInference failed", { error: err, entryId: entry.id });
    });
    // Return null to skip the single writeResponse() call below
    response = null;
    break;
}
```

Note: `inference` bypasses the idempotency check. The `entry.idempotency_key` will be `null` for inference entries (per Phase 1 design — no idempotency for inference). The `if (entry.idempotency_key && response !== null)` guard at Step 7 already handles this correctly.

Also modify the cancel first-pass (lines 68-73 in `processPendingEntries()`) to abort active inference streams when a cancel arrives:

```typescript
if (entry.kind === "cancel" && entry.ref_id) {
    this.pendingCancels.add(entry.ref_id);
    // Immediately abort any active inference stream for this ref_id
    const abortController = this.activeInferenceStreams.get(entry.ref_id);
    if (abortController) {
        abortController.abort();
    }
    markProcessed(this.db, [entry.id]);
}
```

**Part B: executeImmediate() skip for inference**

In `executeImmediate()` (around line 396), the hub uses this for synchronous execution. `inference` cannot be executed synchronously (it's multi-cycle streaming). Add an early return for `inference` kind:

```typescript
// inference kind is handled asynchronously by the target's background polling loop,
// not synchronously in the hub relay phase
if (request.kind === "inference") {
    return []; // hub routes to inbox; target's RelayProcessor handles it
}
```

Add this check after the expiry check (Step 2) and before the execute switch in `executeImmediate()`.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**No standalone commit** — commit with Task 3.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement `executeInference()` with chunk buffering and stream_end

**Verifies:** inference-relay.AC3.1, inference-relay.AC3.2, inference-relay.AC3.3, inference-relay.AC3.4, inference-relay.AC4.3

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (add `executeInference()` and `writeStreamChunk()` private methods)

**Implementation:**

Add a private `writeStreamChunk()` helper after `writeResponse()`:

```typescript
private writeStreamChunk(
    requestEntry: RelayInboxEntry,
    kind: "stream_chunk" | "stream_end",
    streamId: string,
    seq: number,
    chunks: StreamChunk[],
): void {
    if (!requestEntry.source_site_id) return;
    const chunkPayload: StreamChunkPayload = { chunks, seq };
    const now = new Date();
    const outboxEntry: Omit<RelayOutboxEntry, "delivered"> = {
        id: randomUUID(),
        source_site_id: this.siteId,
        target_site_id: requestEntry.source_site_id,
        kind,
        ref_id: requestEntry.id,
        idempotency_key: null,
        stream_id: streamId,
        payload: JSON.stringify(chunkPayload),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), // 10 min expiry for chunks
    };
    writeOutbox(this.db, outboxEntry);
}
```

Add the `executeInference()` private async method:

```typescript
private async executeInference(
    entry: RelayInboxEntry,
    payload: InferenceRequestPayload,
): Promise<void> {
    const FLUSH_INTERVAL_MS = 200;
    const FLUSH_BUFFER_BYTES = 4096;

    // stream_id comes from the inbox entry (set by the requester in RELAY_STREAM)
    const streamId = entry.stream_id;
    if (!streamId) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: "Missing stream_id on inference request", retriable: false }),
        );
        return;
    }

    // Check model availability
    if (!this.modelRouter) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: "No model router configured on this host", retriable: false }),
        );
        return;
    }

    const backend = this.modelRouter.tryGetBackend(payload.model);
    if (!backend) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({
                error: `Model not available on this host: ${payload.model}`,
                retriable: false,
            }),
        );
        return;
    }

    // Resolve large prompt file ref if present (AC1.9)
    let messages = payload.messages;
    if (payload.messages_file_ref) {
        const fileRow = this.db
            .query("SELECT content FROM files WHERE path = ? AND deleted = 0")
            .get(payload.messages_file_ref) as { content: string } | null;
        if (!fileRow) {
            this.writeResponse(
                entry,
                "error",
                JSON.stringify({
                    error: `Large prompt file not found: ${payload.messages_file_ref}`,
                    retriable: false,
                }),
            );
            return;
        }
        try {
            messages = JSON.parse(fileRow.content);
        } catch {
            this.writeResponse(
                entry,
                "error",
                JSON.stringify({ error: "Failed to parse large prompt file", retriable: false }),
            );
            return;
        }
    }

    // Set up AbortController for cancel support (AC3.4)
    const abortController = new AbortController();
    this.activeInferenceStreams.set(entry.id, abortController);

    // Note: LLMBackend.chat() currently does not accept an AbortSignal parameter
    // (ChatParams in packages/llm/src/types.ts has no `signal` field). The abortController
    // is used to break the for-await loop, but the underlying HTTP stream to the LLM
    // provider will NOT be cancelled — it continues until the provider completes or times out.
    // To properly cancel the provider stream, add `signal?: AbortSignal` to ChatParams
    // and wire it through the Anthropic, Bedrock, OpenAI-compatible, and Ollama drivers.
    // This is a resource efficiency improvement; cancel correctness is maintained by the
    // loop-break and "cancelled by requester" error response.

    let seq = 0;
    let chunkBuffer: StreamChunk[] = [];
    let bufferBytes = 0;
    let lastFlushTime = Date.now();
    const inferenceStartTime = Date.now();

    const flush = (isFinal: boolean): void => {
        if (chunkBuffer.length === 0 && !isFinal) return;
        const kind = isFinal ? "stream_end" : "stream_chunk";
        this.writeStreamChunk(entry, kind, streamId, seq, [...chunkBuffer]);
        // Record relay cycle for each flush
        try {
            recordRelayCycle(this.db, {
                direction: "inbound",
                peer_site_id: entry.source_site_id,
                kind,
                delivery_method: "sync",
                latency_ms: Date.now() - inferenceStartTime,
                expired: false,
                success: true,
            });
        } catch {
            // Non-fatal
        }
        seq++;
        chunkBuffer = [];
        bufferBytes = 0;
        lastFlushTime = Date.now();
    };

    try {
        const chatStream = backend.chat({
            model: payload.model,
            messages,
            tools: payload.tools,
            system: payload.system,
            max_tokens: payload.max_tokens,
            temperature: payload.temperature,
            cache_breakpoints: payload.cache_breakpoints,
        });

        for await (const chunk of chatStream) {
            // AC3.4: Check abort signal (cancel from requester)
            if (abortController.signal.aborted) break;

            chunkBuffer.push(chunk);
            const chunkBytes = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
            bufferBytes += chunkBytes;

            const elapsed = Date.now() - lastFlushTime;
            if (elapsed >= FLUSH_INTERVAL_MS || bufferBytes >= FLUSH_BUFFER_BYTES) {
                flush(false);
            }
        }

        if (abortController.signal.aborted) {
            // AC3.4: Write error response indicating cancellation
            this.writeResponse(
                entry,
                "error",
                JSON.stringify({ error: "cancelled by requester", retriable: false }),
            );
        } else {
            // Normal completion — final flush as stream_end (AC3.3)
            flush(true);
        }
    } catch (err) {
        this.writeResponse(
            entry,
            "error",
            JSON.stringify({ error: String(err), retriable: true }),
        );
        try {
            recordRelayCycle(this.db, {
                direction: "inbound",
                peer_site_id: entry.source_site_id,
                kind: "inference",
                delivery_method: "sync",
                latency_ms: Date.now() - inferenceStartTime,
                expired: false,
                success: false,
            });
        } catch {
            // Non-fatal
        }
    } finally {
        this.activeInferenceStreams.delete(entry.id);
    }
}
```

Add imports at the top:
```typescript
import type { StreamChunk } from "@bound/llm";
```

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

Run: `bun test packages/agent`
Expected: All existing tests pass (no regressions from constructor change)

**Commit:** `feat(agent): implement executeInference with 200ms/4KB buffering, cancel, stream_end`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Unit tests for `executeInference()`

**Verifies:** inference-relay.AC3.1, inference-relay.AC3.2, inference-relay.AC3.3, inference-relay.AC3.4, inference-relay.AC3.5, inference-relay.AC3.6

**Files:**
- Create: `packages/agent/src/__tests__/relay-processor-inference.test.ts`

**Implementation:**

Tests use real SQLite databases with `applySchema(db)`, a mock `ModelRouter` (wrapping a `MockLLMBackend` that returns controlled `StreamChunk` sequences), and a real `RelayProcessor` instance.

The mock `LLMBackend` should implement the `LLMBackend` interface and yield `StreamChunk` values on demand, similar to the pattern in `agent-loop.test.ts` (lines 13-83).

Tests must verify each AC listed:

- **AC3.1**: Insert a valid `inference` inbox entry with `stream_id`. Let `RelayProcessor.processPendingEntries()` run. Verify `relay_outbox` contains entries with the same `stream_id`, kinds `stream_chunk`/`stream_end`, monotonic `seq` starting at 0.

- **AC3.2**: Use a mock backend that yields chunks slowly (one per 250ms) and one immediately. Verify that: a flush occurs at 200ms even with pending chunks (timer threshold), and a flush occurs when buffer reaches 4096 bytes (size threshold) even before 200ms.

- **AC3.3**: Let the mock backend complete (yield `done` chunk with usage stats). Verify the final outbox entry has `kind === "stream_end"` and its chunks include the `done` chunk.

- **AC3.4**: Start inference processing, then insert a `cancel` inbox entry with `ref_id = inferenceEntry.id` before processing is complete. Call `processPendingEntries()`. Verify the inference stream was aborted and an `error` outbox entry with `"cancelled by requester"` appears in the outbox.

- **AC3.5**: Insert an `inference` entry with `expires_at` in the past (e.g., `new Date(0).toISOString()`). Call `processEntry()`. Verify no `stream_chunk` or `stream_end` appears in outbox. Verify entry is marked processed.

- **AC3.6**: Insert 3 concurrent `inference` entries with different `stream_id` values. Trigger processing. Verify all 3 produce independent `stream_chunk`/`stream_end` sequences with their respective `stream_id` values, none interfering.

Use real SQLite databases with randomBytes temp paths. Set up `keyringSiteIds` to include the test source site.

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-processor-inference.test.ts`
Expected: All AC tests pass

**Commit:** `test(agent): add unit tests for executeInference on RelayProcessor`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Record inference relay cycle metrics (AC4.3)

**Verifies:** inference-relay.AC4.3

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (in `executeInference()` after the initial request is received)

**Implementation:**

Add a `relay_cycles` record for the initial `inference` request receipt in `executeInference()`, alongside the existing flush-level recordings. Add this at the top of `executeInference()` after model validation succeeds:

```typescript
// AC4.3: Record relay cycle for inference request receipt
try {
    recordRelayCycle(this.db, {
        direction: "inbound",
        peer_site_id: entry.source_site_id,
        kind: "inference",
        delivery_method: "sync",
        latency_ms: null, // not known yet at request start
        expired: false,
        success: true,
    });
} catch {
    // Non-fatal
}
```

This ensures `relay_cycles` has an entry with `kind = "inference"` for the initial request. The existing flush calls in `executeInference()` already record `stream_chunk` and `stream_end` entries. Together these satisfy AC4.3.

**Testing:**
Tests must verify AC4.3:
- After `executeInference()` completes, query `relay_cycles` where `kind IN ('inference', 'stream_chunk', 'stream_end')`. Verify entries exist for all three kinds.

Add this assertion to the AC3.1 test case in Task 4 (relay-processor-inference.test.ts).

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-processor-inference.test.ts`
Expected: All tests pass including AC4.3 assertion

**Commit:** `feat(agent): record relay_cycles entries for inference, stream_chunk, stream_end`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

---

## Phase Completion Verification

After all 5 tasks are committed:

Run all agent tests:
```bash
bun test packages/agent
```
Expected: All tests pass, including relay-processor-inference.test.ts.

Run typechecks:
```bash
tsc -p packages/llm    --noEmit
tsc -p packages/agent  --noEmit
tsc -p packages/cli    --noEmit
```
Expected: Zero type errors.

Confirm AC3.1–AC3.6 and AC4.3 coverage via test output.
