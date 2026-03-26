# Inference Relay Implementation Plan — Phase 5: End-to-End Streaming Integration

**Goal:** Validate the full requester → hub → target → hub → requester streaming path with integration tests covering ordered chunk delivery, cancel propagation, failover, error responses, large prompts, and relay metrics.

**Architecture:** Integration tests in `packages/agent/src/__tests__/relay-stream.integration.test.ts` use the sync test harness from `packages/sync/src/__tests__/test-harness.ts` (imported via relative path) to create real two-spoke clusters. The target spoke runs a full `RelayProcessor` with a mock `LLMBackend`. The requester runs an `AgentLoop` with the remote model. Sync cycles (`syncClient.syncCycle()`) are driven in a parallel loop to transport relay messages while the agent loop polls. This validates the full network path without mocking any relay transport layer.

**Tech Stack:** bun:sqlite, bun:test, bun:serve (via test harness), TypeScript 6.x strict

**Scope:** Phase 5 of 7. Depends on Phase 1 (schema), Phase 2 (ModelRouter/resolveModel), Phase 3 (RELAY_STREAM), Phase 4 (executeInference).

**Codebase verified:** 2026-03-26

---

## Acceptance Criteria Coverage

### inference-relay.AC1: Streaming inference via relay (integration validation)
- **inference-relay.AC1.1 Success:** Requester writes `inference` request, target streams `stream_chunk` messages back, requester yields `StreamChunk`s from async generator
- **inference-relay.AC1.5 Success:** Failover on per-host timeout — new `stream_id`, retry on next eligible host
- **inference-relay.AC1.7 Failure:** Target model unavailable returns `error` kind response
- **inference-relay.AC1.8 Edge:** Out-of-order `seq` — chunks buffered, yielded when contiguous, gap skipped after 2 sync cycles with log warning

### inference-relay.AC3: Target-side inference execution (integration validation)
- **inference-relay.AC3.5 Failure:** Expired request (past `expires_at`) discarded without execution
- **inference-relay.AC3.6 Edge:** Multiple concurrent inference streams execute simultaneously on same target without interference

### inference-relay.AC4: Metrics and observability (integration validation)
- **inference-relay.AC4.1 Success:** Relayed inference records `relay_target` (host_name) and `relay_latency_ms` (first-chunk latency) on turns
- **inference-relay.AC4.2 Success:** Local inference has NULL `relay_target` and `relay_latency_ms` (no regression)

---

## Test Architecture

### Cluster Setup

Each integration test creates a three-node cluster:

```
Requester (spoke A) ← sync → Hub ← sync → Target (spoke B)
```

- **Hub**: A `createTestInstance({ role: "hub" })` instance (just routes relay messages)
- **Spoke A (requester)**: Has an `AgentLoop` with remote model pointing to Spoke B
- **Spoke B (target)**: Has a `RelayProcessor` with a `MockLLMBackend`

Both spokes connect to the hub. Relay messages flow via:
1. Spoke A `syncCycle()` → pushes `inference` outbox to hub
2. Hub routes `inference` to Spoke B's inbox
3. Spoke B `syncCycle()` → pulls `inference` from hub → `RelayProcessor` processes it
4. Spoke B writes `stream_chunk`/`stream_end` to its outbox
5. Spoke B `syncCycle()` → pushes chunks to hub
6. Spoke A `syncCycle()` → pulls chunks → `relayStream()` polling finds them

### Mock LLM Backend

Use the `MockLLMBackend` pattern from `agent-loop.test.ts` (lines 13-83): implements `LLMBackend` interface with `pushResponse(gen: AsyncGenerator<StreamChunk>)` for queuing responses. The target's `RelayProcessor` is constructed with a `ModelRouter` wrapping this mock backend.

### Sync Driver

A `driveSyncUntil(requester, target, predicate, maxCycles)` helper drives sync cycles in sequence until a condition is met or max cycles exceeded:

```typescript
async function driveSyncUntil(
    requester: TestInstance,
    target: TestInstance,
    predicate: () => boolean,
    maxCycles = 20,
): Promise<boolean> {
    for (let i = 0; i < maxCycles; i++) {
        await requester.syncClient!.syncCycle();
        await target.syncClient!.syncCycle();
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return false;
}
```

This is run concurrently with the agent loop using `Promise.race()`.

---

<!-- START_SUBCOMPONENT_A (tasks 1-5) -->

<!-- START_TASK_1 -->
### Task 1: Integration test scaffold and helpers

**Verifies:** None (infrastructure)

**Files:**
- Create: `packages/agent/src/__tests__/relay-stream.integration.test.ts`

**Implementation:**

Create the test file with setup/teardown scaffolding and shared helpers. The file imports the test harness using a relative path:

```typescript
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// Import sync test harness via relative path (monorepo).
// This relative path is intentional: the test harness is not part of the @bound/sync
// public API and is not exported from its package.json. This pattern is consistent
// with how cross-package test utilities are referenced in Bun monorepos.
// If this path becomes a maintenance burden, consider adding createTestInstance as
// a named export in packages/sync/src/index.ts under a /testing subpath.
import { createTestInstance } from "../../../sync/src/__tests__/test-harness";
import type { TestInstance } from "../../../sync/src/__tests__/test-harness";

import { applySchema } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { RelayProcessor } from "../relay-processor";
import { AgentLoop } from "../agent-loop";
import type { AppContext } from "@bound/core";
import type { AgentLoopConfig } from "../types";
```

Define the `MockLLMBackend` class (matching pattern from agent-loop.test.ts) and the `driveSyncUntil` helper described in the architecture section above.

Define `makeTestAppContext(db, siteId, hostName, eventBus)` following the `makeCtx()` pattern from agent-loop.test.ts.

Define shared `let requester: TestInstance`, `let target: TestInstance`, `let hub: TestInstance` variables.

In `beforeEach`:
- Generate unique `testRunId = randomBytes(4).toString("hex")`
- Allocate base port: `10000 + Math.floor(Math.random() * 40000)`
- Create hub, requester, target instances via `createTestInstance()`
- Start RelayProcessor on target with MockLLMBackend

In `afterEach`:
- Stop RelayProcessor
- Call `hub.cleanup()`, `requester.cleanup()`, `target.cleanup()`

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors in test scaffold

**Commit:** `test(agent): add relay-stream integration test scaffold`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: End-to-end streaming test (AC1.1, AC4.1)

**Verifies:** inference-relay.AC1.1, inference-relay.AC4.1

**Files:**
- Modify: `packages/agent/src/__tests__/relay-stream.integration.test.ts`

**Implementation:**

Add test: "streams inference chunks from target to requester end-to-end"

Setup:
1. Register target spoke in `hosts` table on requester with `models = '["claude-3-5-sonnet"]'` and recent `online_at`
2. Configure `MockLLMBackend` on target to yield: text chunks "Hello", " world", then a `done` usage chunk
3. Create `ModelRouter` on requester that resolves `"claude-3-5-sonnet"` as remote (not in local backends)
4. Create `AgentLoop` on requester with `{ modelId: "claude-3-5-sonnet" }`
5. Insert a user message into the thread on requester's DB

Test execution:
- Start agent loop in background: `const loopPromise = agentLoop.run()`
- Drive sync until loop completes: `await driveSyncUntil(requester, target, () => loopDone, 30)`
- Await loop result

Assertions:
- `result.messagesCreated >= 1` (assistant message created)
- `result.error` is undefined
- Query requester's `messages` table: assistant message content contains "Hello world"
- Query requester's `turns` table: `relay_target = target.hostName` and `relay_latency_ms > 0`

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-stream.integration.test.ts --test-name-pattern "streams inference chunks"`
Expected: Test passes

**Commit:** `test(agent): add E2E streaming inference integration test (AC1.1, AC4.1)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Cancel integration test (AC1.4)

**Verifies:** inference-relay.AC1.4 (via integration path)

**Files:**
- Modify: `packages/agent/src/__tests__/relay-stream.integration.test.ts`

**Implementation:**

Add test: "cancel during streaming sends cancel to target and stops requester"

Setup:
1. Register target in requester's hosts with `models` containing the remote model
2. Configure `MockLLMBackend` to yield chunks slowly (one per 200ms, 10 total chunks) — use a generator with `await new Promise(r => setTimeout(r, 200))` between chunks
3. Create `AgentLoop` with `AbortController`; pass `abortSignal` in config

Test execution:
- Start agent loop in background
- After first sync cycle (inference request delivered to target), abort the agent loop: `abortController.abort()`
- Drive sync until cancellation propagates (target writes `error` with "cancelled by requester")

Assertions:
- Agent loop completes (doesn't hang)
- Query requester's `relay_outbox`: verify a `cancel` entry with `ref_id` matching the `inference` outbox entry ID
- Query target's `relay_outbox`: verify an `error` entry with payload containing "cancelled"

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-stream.integration.test.ts --test-name-pattern "cancel during streaming"`
Expected: Test passes within 5 seconds

**Commit:** `test(agent): add cancel-during-streaming integration test`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Error and metrics integration tests (AC1.7, AC3.5, AC4.1, AC4.2)

**Verifies:** inference-relay.AC1.7, inference-relay.AC3.5, inference-relay.AC4.1, inference-relay.AC4.2

**Files:**
- Modify: `packages/agent/src/__tests__/relay-stream.integration.test.ts`

**Implementation:**

**Test 4a: "target model unavailable returns error response" (AC1.7)**

Setup: Register target with empty `models = '[]'` (no models). Requester resolves the model as remote (no local backends match either). The `executeInference()` on target will write an error response.

Assertions:
- Agent loop completes
- `result.error` contains "Model not available"

**Test 4b: "expired inference request discarded silently" (AC3.5)**

Setup: Write an inference outbox entry directly on the target's `relay_inbox` with `expires_at` in the past. Call `relayProcessor.processPendingEntries()` directly.

Assertions:
- No `stream_chunk` or `stream_end` in target's `relay_outbox`
- Inbox entry is marked processed

**Test 4c: "local inference leaves relay metrics NULL" (AC4.2)**

Setup: Configure `ModelRouter` on requester with a LOCAL backend (mock backend for the requested model ID). Run agent loop with local model.

Assertions:
- `relay_target IS NULL` in turns table
- `relay_latency_ms IS NULL` in turns table

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-stream.integration.test.ts --test-name-pattern "target model unavailable|expired|local inference"`
Expected: All three tests pass

**Commit:** `test(agent): add error, expiry, and metrics integration tests`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Concurrent streams and large prompt integration tests (AC3.6, AC1.9)

**Verifies:** inference-relay.AC3.6, inference-relay.AC1.9

**Files:**
- Modify: `packages/agent/src/__tests__/relay-stream.integration.test.ts`

**Implementation:**

**Test 5a: "multiple concurrent inference streams run without interference" (AC3.6)**

Setup: Create 3 separate `AgentLoop` instances on the requester, all targeting the same remote model on target. Configure MockLLMBackend with 3 independent response queues keyed by stream_id.

Run all 3 loops concurrently: `await Promise.all([loop1.run(), loop2.run(), loop3.run()])` (with sync driving).

Assertions:
- All 3 loops complete without error
- Each produces an independent assistant message
- `relay_cycles` table has entries for 3 distinct `stream_id` values

**Test 5b: "large prompt uses file-based relay" (AC1.9)**

Setup: Create a user message with content large enough to make the serialized `InferenceRequestPayload` exceed 2MB (approximately 1500 messages each with 1.4KB content). Configure MockLLMBackend on target to yield a simple text response.

Run agent loop. Drive sync cycles.

Assertions:
- Agent loop completes without error
- Query requester's `relay_outbox`: verify the `inference` entry's payload has `messages_file_ref` set and `messages = []`
- Query requester's `files` table: verify file exists at the path referenced by `messages_file_ref`
- Query target's `relay_outbox`: verify `stream_chunk` entries were written (target processed the large prompt successfully)

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-stream.integration.test.ts --test-name-pattern "concurrent inference|large prompt"`
Expected: Both tests pass

**Commit:** `test(agent): add concurrent streams and large prompt integration tests`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_A -->

---

## Phase Completion Verification

After all 5 tasks are committed:

Run the full integration test suite:
```bash
bun test packages/agent/src/__tests__/relay-stream.integration.test.ts
```
Expected: All tests pass.

Run full agent package tests to check for regressions:
```bash
bun test packages/agent
```
Expected: All tests pass.

Run typechecks:
```bash
tsc -p packages/agent --noEmit
```
Expected: Zero type errors.
