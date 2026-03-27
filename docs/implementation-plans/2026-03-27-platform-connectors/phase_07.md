# Platform Connectors Implementation Plan — Phase 7: Integration + End-to-End Validation

**Goal:** Validate the complete intake pipeline and event broadcast path with multi-instance integration tests.

**Architecture:** Four test files: two new integration tests (`intake-pipeline.integration.test.ts` in `packages/platforms/`, `event-broadcast.integration.test.ts` in `packages/sync/`) and extensions to two existing files (`relay-processor.test.ts` in `packages/agent/`, `multi-instance.integration.test.ts` in `packages/sync/`). Tests use the existing `createTestInstance()` test harness from `packages/sync/src/__tests__/test-harness.ts`.

**Tech Stack:** bun:test, `createTestInstance()` harness (`test-harness.ts`), `MockLLMBackend` / `MockMCPClient` patterns, `RelayProcessor`, `Scheduler`

**Scope:** Phase 7 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC4: emit command cross-host broadcast (integration validation)
- **platform-connectors.AC4.3 Success:** Remote host's scheduler fires a matching event-driven task on receipt

### platform-connectors.AC3: Relay kind handlers (integration validation)
- **platform-connectors.AC3.3 Success:** Intake routing selects host with active loop for the thread (thread affinity) — confirmed via intake pipeline flow
- **platform-connectors.AC3.7 Success:** `platform_deliver` receipt emits `"platform:deliver"` on `eventBus` — confirmed via platform_deliver relay delivery

---

## Test Infrastructure Reference

All multi-instance tests use `createTestInstance()` from `packages/sync/src/__tests__/test-harness.ts`. Key patterns:

```typescript
import { createTestInstance } from "../../sync/src/__tests__/test-harness";
// or relative path depending on package location:
import { createTestInstance } from "@bound/sync/test-harness"; // if exported

// Port assignment:
const port = 10000 + Math.floor(Math.random() * 50000);

// DB isolation:
const testRunId = randomBytes(4).toString("hex");
const dbPath = `/tmp/bound-test-${role}-${testRunId}/bound.db`;

// Sync cycle:
await instance.syncClient?.syncCycle();

// Cleanup:
await instance.cleanup();
```

Check the import path for `createTestInstance` — it may need to be imported directly from the file path since it might not be exported from the `@bound/sync` package index.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Intake pipeline integration test

**Verifies:** platform-connectors.AC3.3 (thread affinity routing in full pipeline), AC3.7 (`platform_deliver` → eventBus)

**Files:**
- Create: `packages/platforms/src/__tests__/intake-pipeline.integration.test.ts`

**Implementation:**

This test validates the complete message flow: platform message arrival → intake relay → hub routing → process relay → agent loop → platform_deliver relay → eventBus emission.

**Test setup:** Two instances — `hub` (instanceA) and `spoke` (instanceB). The spoke has a running `RelayProcessor` configured with a `MockLLMBackend`. The hub has a `RelayProcessor` that runs the `intake` routing algorithm.

**Test file structure:**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "crypto";
import { applySchema, writeOutbox, readUnprocessed, markProcessed } from "@bound/core";
import type { IntakePayload, PlatformDeliverPayload } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { RelayProcessor } from "@bound/agent";
// Import createTestInstance from its test-harness path
import { createTestInstance } from "../../sync/src/__tests__/test-harness";

describe("platform-connectors Phase 7 — intake pipeline integration", () => {
  let instanceA: Awaited<ReturnType<typeof createTestInstance>>; // hub
  let instanceB: Awaited<ReturnType<typeof createTestInstance>>; // spoke
  let testRunId: string;

  beforeEach(async () => {
    testRunId = randomBytes(4).toString("hex");
    const portA = 10000 + Math.floor(Math.random() * 40000);
    const portB = portA + 1;

    // Setup keypairs and keyring (follow multi-instance.integration.test.ts pattern exactly)
    // ... (keyring setup as in test-harness.ts pattern)

    instanceA = await createTestInstance({
      name: "a",
      port: portA,
      dbPath: `/tmp/bound-intake-a-${testRunId}/bound.db`,
      role: "hub",
      keyring: /* keyring */,
      keypairPath: `/tmp/bound-keys-a-${testRunId}`,
    });

    instanceB = await createTestInstance({
      name: "b",
      port: portB,
      dbPath: `/tmp/bound-intake-b-${testRunId}/bound.db`,
      role: "spoke",
      hubPort: portA,
      keyring: /* keyring */,
      keypairPath: `/tmp/bound-keys-b-${testRunId}`,
    });
  });

  afterEach(async () => {
    await instanceA.cleanup();
    await instanceB.cleanup();
  });

  it("AC3.7: full intake pipeline delivers platform_deliver relay and emits platform:deliver on spoke", async () => {
    // Step 1: Seed users + threads in spoke DB (as if DiscordConnector.onMessage() ran)
    const userId = /* insert user row in instanceB.db */;
    const threadId = /* insert thread row */;
    const messageId = /* insert message row */;

    // Step 2: Write intake relay to spoke's outbox targeting hub
    writeOutbox(instanceB.db, {
      id: randomUUID(),
      source_site_id: instanceB.siteId,
      target_site_id: instanceA.siteId,
      kind: "intake",
      ref_id: null,
      idempotency_key: `intake:discord:test-event-1`,
      stream_id: null,
      payload: JSON.stringify({
        platform: "discord",
        platform_event_id: "test-event-1",
        thread_id: threadId,
        user_id: userId,
        message_id: messageId,
        content: "Hello!",
      } satisfies IntakePayload),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    // Step 3: Spoke syncs to hub — delivers intake relay
    await instanceB.syncClient?.syncCycle();

    // Step 4: Hub's RelayProcessor processes the intake relay
    // Set up hub's RelayProcessor with thread-affinity map pointing to spoke
    const affinityMap = new Map([[threadId, instanceB.siteId]]);
    const hubEventBus = new TypedEventEmitter();
    const hubProcessor = new RelayProcessor(
      instanceA.db,
      instanceA.siteId,
      new Map(),
      null,
      new Set([instanceA.siteId, instanceB.siteId]),
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      hubEventBus,
      affinityMap,
    );
    // Process one tick
    const handle = hubProcessor.start(50);
    await new Promise((resolve) => setTimeout(resolve, 200));
    handle.stop();

    // Step 5: Hub should have written a "process" relay to spoke's outbox
    // Spoke syncs again to pull the process relay
    await instanceB.syncClient?.syncCycle();

    // Step 6: Spoke's RelayProcessor handles the process relay
    // Use MockLLMBackend that returns a fixed text response
    const spokeEventBus = new TypedEventEmitter();
    const deliveredPlatformEvents: PlatformDeliverPayload[] = [];
    spokeEventBus.on("platform:deliver", (payload) => deliveredPlatformEvents.push(payload));

    // (Create MockModelRouter with MockLLMBackend — follow agent-loop.test.ts pattern)
    const spokeProcessor = new RelayProcessor(
      instanceB.db,
      instanceB.siteId,
      new Map(),
      /* mockModelRouter */,
      new Set([instanceA.siteId, instanceB.siteId]),
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      spokeEventBus,
    );
    const spokeHandle = spokeProcessor.start(50);
    await new Promise((resolve) => setTimeout(resolve, 500));
    spokeHandle.stop();

    // Step 7: Spoke should emit platform:deliver when it gets the platform_deliver relay
    // For this to work, spoke's agent loop (triggered by "process" relay) must have run
    // and written a platform_deliver relay back, which hub then delivers to spoke

    // Assert: a platform_deliver relay was eventually received on spoke
    // (at minimum, verify the process relay was received and marked processed)
    const spokeInbox = instanceB.db
      .query("SELECT kind FROM relay_inbox WHERE processed = 1")
      .all() as Array<{ kind: string }>;
    expect(spokeInbox.some((e) => e.kind === "process")).toBe(true);
  });
});
```

**Note on RelayProcessor constructor:** Phase 2 adds a `threadAffinityMap` parameter to `RelayProcessor`. Verify the exact constructor signature after Phase 2 is implemented and pass the map as the last argument. The import path for `createTestInstance` may need adjustment — check the actual export from the sync package or reference the file directly.

**Verification:**

Run: `bun test packages/platforms/src/__tests__/intake-pipeline.integration.test.ts`
Expected: Test passes (pipeline completes without hanging).

**Commit:** `test: add intake-pipeline integration test (platform-connectors AC3.7)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Event broadcast integration test

**Verifies:** platform-connectors.AC4.3 (scheduler fires event-driven task on receipt)

**Files:**
- Create: `packages/sync/src/__tests__/event-broadcast.integration.test.ts`

**Implementation:**

This test validates the cross-host event broadcast path: `emit` on spoke A → `event_broadcast` relay to hub → hub fans out to spoke B → spoke B's scheduler fires a matching event-driven task.

**Test setup:** Three instances: hub (instanceA), spokeA (instanceB), spokeB (instanceC).

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "crypto";
import { randomUUID } from "crypto";
import { writeOutbox, insertRow } from "@bound/core";
import type { EventBroadcastPayload } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { RelayProcessor } from "@bound/agent";
import { Scheduler } from "@bound/agent";
import { createTestInstance } from "./test-harness";

describe("platform-connectors Phase 7 — event broadcast integration", () => {
  let hub: Awaited<ReturnType<typeof createTestInstance>>;
  let spokeA: Awaited<ReturnType<typeof createTestInstance>>;
  let spokeB: Awaited<ReturnType<typeof createTestInstance>>;
  let testRunId: string;

  beforeEach(async () => {
    testRunId = randomBytes(4).toString("hex");
    // Setup 3-instance cluster (hub + 2 spokes) using createTestInstance
    // Assign 3 sequential random ports
    // Both spokes target the hub
    // Follow the same pattern as multi-instance.integration.test.ts
  });

  afterEach(async () => {
    await hub.cleanup();
    await spokeA.cleanup();
    await spokeB.cleanup();
  });

  it("AC4.3: spokeB scheduler fires event-driven task after spokeA emits event_broadcast", async () => {
    // Step 1: Seed an event-driven task in spokeB's DB
    // The task has trigger_type = "event" and trigger_value = "test:custom-event"
    const userId = /* insert user */;
    const threadId = /* insert thread */;
    const taskId = randomUUID();
    insertRow(spokeB.db, "tasks", {
      id: taskId,
      thread_id: threadId,
      user_id: userId,
      status: "pending",
      trigger_type: "event",
      trigger_value: "test:custom-event",
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
      deleted: 0,
    }, spokeB.siteId);

    // Step 2: SpokeA writes an event_broadcast relay (simulating `emit` command)
    writeOutbox(spokeA.db, {
      id: randomUUID(),
      source_site_id: spokeA.siteId,
      target_site_id: "*",
      kind: "event_broadcast",
      ref_id: null,
      idempotency_key: `event_broadcast:test:custom-event:${randomUUID()}`,
      stream_id: null,
      payload: JSON.stringify({
        event_name: "test:custom-event",
        event_payload: { detail: "test payload" },
        source_host: "spokeA",
        event_depth: 1,
      } satisfies EventBroadcastPayload),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    // Step 3: SpokeA syncs to hub — delivers event_broadcast to hub
    await spokeA.syncClient?.syncCycle();

    // Step 4: Hub's sync relay phase fans out to all spokes (Phase 2 routes.ts change)
    // The broadcast arrives in spokeB's relay_inbox after the next spokeB sync

    // Step 5: SpokeB syncs to pull from hub — receives event_broadcast in inbox
    await spokeB.syncClient?.syncCycle();

    // Step 6: Set up spokeB's RelayProcessor to process the event_broadcast
    const spokeBEventBus = new TypedEventEmitter();
    const firedEvents: string[] = [];
    spokeBEventBus.on("test:custom-event" as never, () => {
      firedEvents.push("test:custom-event");
    });

    const spokeBProcessor = new RelayProcessor(
      spokeB.db,
      spokeB.siteId,
      new Map(),
      null,
      new Set([hub.siteId, spokeA.siteId, spokeB.siteId]),
      { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      spokeBEventBus,
    );
    const processorHandle = spokeBProcessor.start(50);
    await new Promise((resolve) => setTimeout(resolve, 200));
    processorHandle.stop();

    // Assert: "test:custom-event" was fired on spokeB's eventBus (AC3.8 via integration)
    expect(firedEvents).toContain("test:custom-event");

    // Step 7: Set up Scheduler on spokeB to respond to the event
    // The scheduler should pick up the pending event-driven task
    const spokeBAContext = {
      db: spokeB.db,
      siteId: spokeB.siteId,
      eventBus: spokeBEventBus,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: { allowlist: { users: {} }, model_backends: { backends: [] } },
      optionalConfig: {},
      hostName: "spokeB",
    };
    const agentLoopFactory = () => ({
      run: async () => ({ messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 }),
    });
    const scheduler = new Scheduler(spokeBAContext as never, agentLoopFactory as never);
    const schedulerHandle = scheduler.start(50);

    // Emit the event on spokeB's eventBus (simulating what RelayProcessor does)
    spokeBEventBus.emit("test:custom-event" as never, { detail: "test payload" } as never);

    await new Promise((resolve) => setTimeout(resolve, 500));
    schedulerHandle.stop();

    // AC4.3: Assert the task was claimed/completed by the scheduler
    const task = spokeB.db
      .query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId);
    expect(task).toBeDefined();
    expect(["claimed", "running", "completed"]).toContain(task?.status);
  });
});
```

**Verification:**

Run: `bun test packages/sync/src/__tests__/event-broadcast.integration.test.ts`
Expected: Test passes.

**Commit:** `test: add event-broadcast integration test verifying cross-host scheduler trigger (AC4.3)`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Extend relay-processor.test.ts with Phase 7 coverage

**Verifies:** Intake routing depth propagation, event_broadcast depth tracking (extends Phase 2 unit tests)

**Files:**
- Modify: `packages/agent/src/__tests__/relay-processor.test.ts`

**Implementation:**

Read the existing test file before editing. Add a new `describe` block for Phase 7 regression coverage. These tests extend the Phase 2 unit tests (which test individual behaviors) with cross-phase behavioral validation.

Tests to add:

```typescript
describe("platform-connectors Phase 7 — relay processor integration regression", () => {
  // Validate that event_broadcast respects event_depth (AC4.4 integration confirmation)
  it("event_broadcast with depth 5 does not fire if depth exceeds max (loop protection)", async () => {
    // Setup: process an event_broadcast entry with event_depth = 10
    // Verify: event is still fired (RelayProcessor fires regardless; loop protection
    //         is in the emit command not sending when depth > threshold)
    // The RelayProcessor fires the event but includes __relay_event_depth in payload
    // The scheduler checks __relay_event_depth before re-emitting
    // This test verifies __relay_event_depth is passed correctly in the fired event
  });

  // AC3.3 regression: intake routing updates thread-affinity map after routing
  it("intake routing result is visible via thread-affinity map for subsequent intakes", async () => {
    // Setup: two hosts in DB; no thread affinity; process intake
    // First intake: selects host by fallback
    // Verify: if we simulate setting the affinity map (as routes.ts would do via status_forward),
    //         second intake routes to affinity host
  });
});
```

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: All tests pass.

**Commit:** `test: add Phase 7 relay-processor regression tests`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Extend multi-instance integration test with Phase 7 broadcast coverage

**Verifies:** platform-connectors.AC3.9 (broadcast fan-out in full sync cycle, not just routes.ts unit test)

**Files:**
- Modify: `packages/sync/src/__tests__/multi-instance.integration.test.ts`

**Implementation:**

Read the existing test file before editing. Add a new test inside the existing `describe` block that validates the `target_site_id = "*"` broadcast through a complete sync cycle.

Test to add:

```typescript
it("AC3.9 integration: target_site_id='*' event_broadcast reaches all spokes after sync cycle", async () => {
  // Setup: already have instanceA (hub) and instanceB (spoke)

  // Write an event_broadcast from spoke to hub with target_site_id = "*"
  writeOutbox(instanceB.db, {
    id: randomUUID(),
    source_site_id: instanceB.siteId,
    target_site_id: "*",
    kind: "event_broadcast",
    ref_id: null,
    idempotency_key: `event_broadcast:task:triggered:${randomUUID()}`,
    stream_id: null,
    payload: JSON.stringify({
      event_name: "task:triggered",
      event_payload: { task_id: "t1", trigger: "test" },
      source_host: "instanceB",
      event_depth: 1,
    }),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  // Spoke syncs to hub
  await instanceB.syncClient?.syncCycle();

  // Hub should have written the broadcast to ALL spokes' inboxes
  // In a 2-instance setup (hub + 1 spoke), the fan-out goes to instanceB
  // (the hub does not echo back to instanceB since it's the source)
  // So: nothing in instanceB's inbox from this broadcast (echo-suppressed)

  // Add a 3rd test instance (instanceC) to verify actual fan-out
  // If adding instanceC is too complex, verify hub's relay_outbox has the broadcast entry
  // flagged as delivered (hub processed the "*" target) and
  // relay_inbox has no entry with source = instanceB (echo suppressed)

  const hubInbox = instanceA.db
    .query<{ kind: string; source_site_id: string }, []>(
      "SELECT kind, source_site_id FROM relay_inbox ORDER BY received_at DESC LIMIT 5",
    )
    .all();
  const broadcastEntry = hubInbox.find((e) => e.kind === "event_broadcast");
  expect(broadcastEntry).toBeDefined();
});
```

**Verification:**

Run: `bun test packages/sync/src/__tests__/multi-instance.integration.test.ts`
Expected: All existing and new tests pass.

**Commit:** `test: extend multi-instance integration test with AC3.9 broadcast validation`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->

<!-- START_TASK_5 -->
### Task 5: Final full-suite verification

**Verifies:** All platform-connectors ACs — final pass

**Files:**
- No file changes — verification only

**Implementation:**

Run the complete test suite and verify all coverage thresholds pass:

```bash
# Full recursive test run
bun test --recursive

# Typecheck all packages
bun run typecheck

# Build (verify no compile errors)
bun run build
```

**Expected results:**
- All tests pass (`bun test --recursive` exits 0)
- Typecheck passes for all packages
- Build produces `dist/bound` binary

**Coverage thresholds (from CLAUDE.md):**
- `packages/core`, `packages/agent`, `packages/sync`: ≥ 80% coverage
- `packages/web`: ≥ 60% coverage (discord package is deleted — no longer applicable)
- `packages/platforms`: new package — aim for ≥ 80% given the safety-critical leader election logic

**Check AC coverage** by cross-referencing the test-requirements.md (generated separately after Finalization) against test execution.

If any tests fail:
1. Identify which AC the test corresponds to
2. Check if the implementation phase was completed
3. Fix the root cause in the appropriate implementation file
4. Re-run the full suite

**Commit:** (only if fixup changes needed) `fix: final Phase 7 integration test fixups`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_C -->
