# RxJS Async Processing Refactor — Phase 3

**Goal:** Extract `relayWait()` and `_relayWaitImpl()` from `AgentLoop` into a standalone observable factory `createRelayWait$()`, replacing ~170 lines of polling loop with a declarative pipeline.

**Architecture:** The factory returns `Observable<string>` (emitting a single response content string). Host iteration uses `from(eligibleHosts).pipe(concatMap(...))` with per-host 30s timeout. Event-driven response detection merges `fromEventBus("relay:inbox")` filtered by `ref_id` with an immediate DB check via `startWith`. Consumed via `firstValueFrom()` at the call site.

**Tech Stack:** RxJS 7.8.2, TypeScript 6.x, Bun runtime, `bun:test` with RxJS `TestScheduler`

**Scope:** 6 phases from original design (phase 3 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase implements and tests:

### rxjs-async-refactor.AC2: Relay Wait Observable
- **rxjs-async-refactor.AC2.1 Success:** `result` response kind is parsed, `markProcessed()` called, content string emitted
- **rxjs-async-refactor.AC2.2 Success:** Relay metrics (timing, host) recorded to turns table when `currentTurnId` is set
- **rxjs-async-refactor.AC2.3 Failure:** `error` response kind from remote host throws typed error
- **rxjs-async-refactor.AC2.4 Failure:** Host timeout (30s) triggers failover — new outbox entry written for next host
- **rxjs-async-refactor.AC2.5 Edge:** `aborted$` firing writes cancel outbox entry and completes

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Create relay-wait$.ts with createRelayWait$() factory

**Verifies:** rxjs-async-refactor.AC2.1, rxjs-async-refactor.AC2.2, rxjs-async-refactor.AC2.3, rxjs-async-refactor.AC2.4, rxjs-async-refactor.AC2.5

**Files:**
- Create: `packages/agent/src/relay-wait$.ts`

**Implementation:**

Create a standalone factory function that returns `Observable<string>`. The function must faithfully reproduce the behavior of the existing `_relayWaitImpl()` method at `packages/agent/src/agent-loop.ts:1719-1871`.

**Function signature:**

```typescript
import {
	Observable,
	from,
	merge,
	race,
	timer,
	concatMap,
	map,
	filter,
	take,
	tap,
	takeUntil,
	finalize,
	switchMap,
	startWith,
	throwError,
	type SchedulerLike,
} from "rxjs";
import type { Database } from "bun:sqlite";
import type { TypedEventEmitter, RelayKind } from "@bound/shared";
import {
	parseJsonSafe,
	errorPayloadSchema,
	resultPayloadSchema,
} from "@bound/shared";
import {
	writeOutbox,
	readInboxByRefId,
	markProcessed,
	recordTurnRelayMetrics,
} from "@bound/core";
import type { Logger } from "@bound/shared";
import { buildCommandOutput } from "./agent-loop-utils";
import { createRelayOutboxEntry, type EligibleHost } from "./relay-router";
import { fromEventBus } from "./rx-utils";

export interface RelayWaitDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
}

export interface RelayWaitParams {
	outboxEntryId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	eligibleHosts: EligibleHost[];
	currentHostIndex: number;
	currentTurnId: string | null;
	threadId: string;
}

export interface RelayWaitOptions {
	timeoutMs?: number;
	scheduler?: SchedulerLike;
}

export function createRelayWait$(
	deps: RelayWaitDeps,
	params: RelayWaitParams,
	aborted$: Observable<unknown>,
	options?: RelayWaitOptions,
): Observable<string>
```

**Key behavioral requirements (match existing implementation exactly):**

1. **Host iteration via `concatMap`:** Starting from `params.currentHostIndex`, iterate through `eligibleHosts`. Each host attempt is an inner observable that either emits a response string or times out (causing `concatMap` to move to the next host).

2. **Per-host response detection:** For each host, the response comes from either:
   - **Immediate DB check:** Call `readInboxByRefId(db, outboxEntryId)` at subscription time — handles the race condition where the response arrives before the listener is set up (existing code lines 1788-1793).
   - **Event-driven:** `fromEventBus(eventBus, "relay:inbox")` filtered by `ref_id === outboxEntryId`, then `readInboxByRefId()` to fetch the full entry.
   - These two sources are merged, and the first non-null result wins via `take(1)`.

3. **Per-host timeout:** 30s default (`options?.timeoutMs ?? 30_000`). If no response within timeout, the inner observable completes without emission, causing `concatMap` to try the next host. On failover, write a new outbox entry for the next host (kind `"tool_call"`) and update `outboxEntryId`.

4. **Response parsing (match lines 1808-1840):**
   - `kind === "error"`: Parse with `errorPayloadSchema`, call `markProcessed()`, return error string.
   - `kind === "result"`: Parse with `resultPayloadSchema`, call `markProcessed()`, return `buildCommandOutput(stdout, stderr, exit_code)`.
   - Other kinds: Call `markProcessed()`, return `"Unknown response kind: ${kind}"`.

5. **Relay metrics:** When a response is received and `currentTurnId !== null`, call `recordTurnRelayMetrics(db, turnId, hostName, latencyMs, siteId)` with latency measured from the initial relay start time (not per-host start time).

6. **Cancellation via `takeUntil(aborted$)`:** When `aborted$` emits, the observable completes. Use `finalize()` to write a cancel outbox entry for the current host.

7. **All hosts exhausted:** If all hosts time out without response, emit a timeout message string: `"Timeout: all N eligible host(s) did not respond within Xms"`. This is NOT an error — the current code returns a string, not throws.

**Step 1: Create the file**

Write `packages/agent/src/relay-wait$.ts` implementing the factory as described above.

**Step 2: Export from package index**

Add export to `packages/agent/src/index.ts`:

```typescript
export { createRelayWait$, type RelayWaitDeps, type RelayWaitParams, type RelayWaitOptions } from "./relay-wait$.js";
```

**Step 3: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Replace relayWait() call site in agent-loop.ts

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:1319` (call site)
- Modify: `packages/agent/src/agent-loop.ts:1704-1871` (remove old methods)

**Implementation:**

**Step 1: Add imports**

Add to the imports at the top of `agent-loop.ts`:

```typescript
import { firstValueFrom, Subject } from "rxjs";
import { createRelayWait$ } from "./relay-wait$";
```

Note: `Subject` and `lastValueFrom` may already be imported from Phase 2's changes. If so, just add `firstValueFrom` and `createRelayWait$`.

**Step 2: Replace call site at line 1319**

The current code:
```typescript
resultContent = await this.relayWait(result, toolCall, currentTurnId);
```

Replace with:

```typescript
const previousRelayState = this.state;
this.state = "RELAY_WAIT";
try {
    const aborted$ = new Subject<void>();
    const abortCheck = setInterval(() => {
        if (this.aborted) {
            aborted$.next();
            aborted$.complete();
        }
    }, 100);

    resultContent = await firstValueFrom(
        createRelayWait$(
            {
                db: this.ctx.db,
                eventBus: this.ctx.eventBus,
                siteId: this.ctx.siteId,
                logger: this.ctx.logger,
            },
            {
                outboxEntryId: result.outboxEntryId,
                toolName: result.toolName,
                toolInput: toolCall.input,
                eligibleHosts: result.eligibleHosts,
                currentHostIndex: result.currentHostIndex,
                currentTurnId,
                threadId: this.config.threadId,
            },
            aborted$,
        ),
        { defaultValue: "Cancelled: relay request was cancelled by user" },
    );
    clearInterval(abortCheck);
} finally {
    this.state = previousRelayState;
}
```

The `defaultValue` handles the case where `aborted$` fires before any response (empty observable → returns cancel message, same as current behavior).

**Step 3: Remove the old methods**

Delete `relayWait()` (lines 1704-1717) and `_relayWaitImpl()` (lines 1719-1871).

**Step 4: Clean up unused imports**

Check if `readInboxByRefId` or `recordTurnRelayMetrics` are still used elsewhere in `agent-loop.ts`. If not, remove from the import block — they're now imported by `relay-wait$.ts` instead.

**Step 5: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:**

```bash
git add packages/agent/src/relay-wait$.ts packages/agent/src/agent-loop.ts packages/agent/src/index.ts
git commit -m "refactor(agent): extract relayWait to createRelayWait$ observable factory"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for createRelayWait$()

**Verifies:** rxjs-async-refactor.AC2.1, rxjs-async-refactor.AC2.2, rxjs-async-refactor.AC2.3, rxjs-async-refactor.AC2.4, rxjs-async-refactor.AC2.5

**Files:**
- Create: `packages/agent/src/__tests__/relay-wait$.test.ts`

**Testing:**

Tests must verify each AC listed above. Use a real temp SQLite database (same pattern as Phase 2 tests). Use a real `TypedEventEmitter` instance. The test helper should insert `relay_inbox` entries directly to simulate remote host responses.

**Test cases:**

1. **rxjs-async-refactor.AC2.1 — Result response parsed correctly:**
   Insert a `relay_inbox` entry with kind `"result"` and a JSON payload matching `resultPayloadSchema` (`{ stdout, stderr, exit_code, execution_ms }`). Subscribe to `createRelayWait$()`. Verify the emitted string matches `buildCommandOutput(stdout, stderr, exit_code)` and `markProcessed` was called (entry's `processed` flag is 1).

2. **rxjs-async-refactor.AC2.2 — Relay metrics recorded:**
   Provide a non-null `currentTurnId`. Insert a `turns` row first (needed for the UPDATE). Insert a result response. After observable completes, verify `turns.relay_target` and `turns.relay_latency_ms` are populated.

3. **rxjs-async-refactor.AC2.3 — Error response from remote:**
   Insert a `relay_inbox` entry with kind `"error"` and payload `{ error: "model overloaded", retriable: true }`. Verify the emitted string contains `"Remote error: model overloaded"`.

4. **rxjs-async-refactor.AC2.4 — Host timeout triggers failover:**
   Provide two hosts. Don't insert any response for first host. Use TestScheduler to advance virtual time past 30s. Verify a new outbox entry is written for the second host (kind `"tool_call"`). Then insert a result response for the second host and verify it's returned.

5. **rxjs-async-refactor.AC2.5 — Abort mid-wait:**
   Start waiting. Emit `aborted$` mid-wait. Verify cancel outbox entry is written for current host and observable completes with the default cancel message.

6. **Race condition — response already in DB before subscribe:**
   Insert response BEFORE subscribing to the observable. Verify it's detected immediately (the `startWith` / immediate DB check).

Follow project testing patterns: `describe`/`it`/`expect` from `bun:test`. Cleanup temp DB in `afterAll`.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-wait$.test.ts`
Expected: All test cases pass.

**Commit:**

```bash
git add packages/agent/src/__tests__/relay-wait$.test.ts
git commit -m "test(agent): add tests for createRelayWait$ observable"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Verify existing relay wait tests still pass

**Step 1: Run existing relay event-driven tests**

Run: `bun test packages/agent/src/__tests__/relay-event-driven.test.ts`
Expected: All existing tests pass. If tests directly reference `relayWait()` or `_relayWaitImpl()` as private methods, they may need updating to test through the public interface or via `createRelayWait$` directly.

**Step 2: Run full agent package tests**

Run: `bun test packages/agent`
Expected: All tests pass, no regressions.

**Step 3: Typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: Clean.

No commit needed — verification only.
<!-- END_TASK_4 -->
