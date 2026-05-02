# RxJS Async Processing Refactor — Phase 2

**Goal:** Extract `relayStream()` from `AgentLoop` into a standalone observable factory `createRelayStream$()`, replacing ~220 lines of imperative async generator with a declarative RxJS operator pipeline.

**Architecture:** The factory function takes the same parameters as the current `relayStream()` method but returns an `Observable<StreamChunk>` instead of `AsyncGenerator<StreamChunk>`. Host iteration uses `from(eligibleHosts).pipe(concatMap(...))`, per-host polling merges `pollDb` with `fromEventBus("relay:inbox")`, chunk reordering uses a `scan` accumulator, and cancellation uses `takeUntil(aborted$)`.

**Tech Stack:** RxJS 7.8.2, TypeScript 6.x, Bun runtime, `bun:test` with RxJS `TestScheduler`

**Scope:** 6 phases from original design (phase 2 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase implements and tests:

### rxjs-async-refactor.AC1: Relay Stream Observable
- **rxjs-async-refactor.AC1.1 Success:** Chunks arriving in sequence order are emitted immediately without buffering
- **rxjs-async-refactor.AC1.2 Success:** Out-of-order chunks (e.g., seq 0, 2, 1) are reordered and emitted as 0, 1, 2
- **rxjs-async-refactor.AC1.3 Success:** Stream completes normally when `stream_end` chunk is received and all prior sequences are accounted for
- **rxjs-async-refactor.AC1.4 Success:** First host responding successfully never triggers failover to second host
- **rxjs-async-refactor.AC1.5 Failure:** Silence timeout on host A triggers failover to host B with cancel outbox entry written for host A
- **rxjs-async-refactor.AC1.6 Failure:** All hosts exhausting their timeout results in an error emission (not silent completion)
- **rxjs-async-refactor.AC1.7 Edge:** Gap detection — if `nextExpectedSeq` stalls for `MAX_GAP_CYCLES` polls, skip to next buffered sequence
- **rxjs-async-refactor.AC1.8 Edge:** `aborted$` firing mid-stream writes cancel outbox entry and completes the observable (no error)
- **rxjs-async-refactor.AC1.9 Edge:** Metadata ref captures `firstChunkLatencyMs` from first non-heartbeat chunk and responding host name

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Create relay-stream$.ts with createRelayStream$() factory

**Verifies:** rxjs-async-refactor.AC1.1, rxjs-async-refactor.AC1.2, rxjs-async-refactor.AC1.3, rxjs-async-refactor.AC1.4, rxjs-async-refactor.AC1.5, rxjs-async-refactor.AC1.6, rxjs-async-refactor.AC1.7, rxjs-async-refactor.AC1.8, rxjs-async-refactor.AC1.9

**Files:**
- Create: `packages/agent/src/relay-stream$.ts`

**Implementation:**

Create a standalone factory function that returns `Observable<StreamChunk>`. The function must faithfully reproduce the behavior of the existing `relayStream()` async generator at `packages/agent/src/agent-loop.ts:1877-2095`.

**Function signature:**

```typescript
import {
	Observable,
	from,
	EMPTY,
	merge,
	interval,
	concatMap,
	map,
	filter,
	scan,
	tap,
	takeUntil,
	finalize,
	mergeMap,
	type SchedulerLike,
} from "rxjs";
import type { Database } from "bun:sqlite";
import type { StreamChunk, StreamChunkPayload, InferenceRequestPayload } from "@bound/llm";
import type { TypedEventEmitter, RelayInboxEntry, RelayKind } from "@bound/shared";
import { parseJsonSafe, parseJsonUntyped, errorPayloadSchema } from "@bound/shared";
import { writeOutbox, readInboxByStreamId, markProcessed } from "@bound/core";
import type { Logger } from "@bound/shared";
import { createRelayOutboxEntry, type EligibleHost } from "./relay-router";
import { fromEventBus } from "./rx-utils";

export interface RelayStreamDeps {
	db: Database;
	eventBus: TypedEventEmitter;
	siteId: string;
	logger: Logger;
}

export interface RelayStreamOptions {
	pollIntervalMs?: number;
	perHostTimeoutMs?: number;
	scheduler?: SchedulerLike;
}

export function createRelayStream$(
	deps: RelayStreamDeps,
	payload: InferenceRequestPayload,
	eligibleHosts: EligibleHost[],
	aborted$: Observable<unknown>,
	relayMetadataRef?: { hostName?: string; firstChunkLatencyMs?: number },
	options?: RelayStreamOptions,
): Observable<StreamChunk>
```

**Key behavioral requirements (match existing implementation exactly):**

1. **Host iteration via `concatMap`:** Iterate `eligibleHosts` sequentially. Each host attempt is an inner observable. If a host times out or fails, `concatMap` moves to the next. If a host succeeds (emits `stream_end` and buffer drains), the observable completes.

2. **Per-host outbox write:** At the start of each host attempt, generate a `streamId` via `randomUUID()`, call `createRelayOutboxEntry()` with kind `"inference"` and `writeOutbox()` to persist. This is a side effect in `concatMap`'s projection function.

3. **Per-host polling loop:** Use `interval(POLL_INTERVAL_MS, scheduler?)` merged with `fromEventBus(eventBus, "relay:inbox")` filtered to matching `stream_id`. On each tick, call `readInboxByStreamId()` to fetch unprocessed entries.

4. **Chunk reordering via `scan`:** Accumulate state `{ buffer: Map<number, StreamChunkPayload>, nextExpectedSeq: number, gapCyclesWaited: number, streamEndSeq: number | null, streamEndConsumed: boolean, firstChunkReceived: boolean, hostStartTime: number, lastActivityTime: number }`. The scan accumulator processes fetched inbox entries, buffers by seq, and outputs an array of `StreamChunk` to emit (may be empty if waiting for gaps). The downstream `mergeMap` flattens the array.

5. **Silence timeout:** Within the scan accumulator, check elapsed time against `PER_HOST_TIMEOUT_MS`. Before first chunk: measure from `hostStartTime`. After first chunk: measure from `lastActivityTime`. If exceeded, emit a sentinel value that triggers host failover.

6. **Gap detection:** If `buffer.size > 0` but `nextExpectedSeq` is missing, increment `gapCyclesWaited`. At `MAX_GAP_CYCLES` (6), skip forward or discard stale entries (same logic as existing code at lines 2058-2079).

7. **Cancellation via `takeUntil(aborted$)`:** When `aborted$` emits, the observable completes. Use `finalize()` to write a cancel outbox entry for the current host.

8. **Error handling:** Error entries from inbox throw typed errors (same as lines 1986-1998). All hosts exhausted throws `"inference-relay.AC1.5: all N eligible host(s) timed out"`.

9. **Metadata tracking:** On first non-heartbeat chunk, populate `relayMetadataRef` with `hostName` and `firstChunkLatencyMs`.

10. **Constants:** `POLL_INTERVAL_MS` defaults to 500, `PER_HOST_TIMEOUT_MS` defaults to `options?.perHostTimeoutMs ?? 300_000`, `MAX_GAP_CYCLES = 6`.

The `scheduler` parameter should be passed to `interval()` for marble testing. `fromEventBus` does not use a scheduler (events are real-time).

**Step 1: Create the file**

Write `packages/agent/src/relay-stream$.ts` implementing the factory function as described above. The implementation must match the behavior of lines 1877-2095 of `agent-loop.ts` exactly, translating each imperative construct to its RxJS equivalent:

| Imperative (current) | RxJS (new) |
|---|---|
| `for (host of eligibleHosts)` | `from(eligibleHosts).pipe(concatMap(...))` |
| `while (true)` polling loop | `interval(500).pipe(...)` merged with event wakeup |
| `buffer Map + nextExpectedSeq` | `scan` accumulator state |
| `if (this.aborted) return` | `takeUntil(aborted$)` |
| `if (elapsedMs > timeout) break` | Timeout check in scan, emit sentinel → concatMap moves to next host |
| `yield chunk` | Observable `next()` emission |
| `throw new Error(...)` | `subscriber.error(...)` or `throwError()` |

**Step 2: Export from package index**

Add export to `packages/agent/src/index.ts`:

```typescript
export { createRelayStream$, type RelayStreamDeps, type RelayStreamOptions } from "./relay-stream$.js";
```

**Step 3: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Replace relayStream() call site in agent-loop.ts

**Files:**
- Modify: `packages/agent/src/agent-loop.ts:834-843` (call site)
- Modify: `packages/agent/src/agent-loop.ts:1877-2095` (remove old method)

**Implementation:**

**Step 1: Add imports**

Add to the imports at the top of `agent-loop.ts`:

```typescript
import { lastValueFrom, Subject } from "rxjs";
import { tap } from "rxjs/operators";
import { createRelayStream$ } from "./relay-stream$";
```

**Step 2: Replace call site at lines 834-843**

The current code:
```typescript
for await (const chunk of this.relayStream(
    inferencePayload,
    resolution.hosts,
    relayMetadataRef,
)) {
    if (this.aborted) break;
    if (chunk.type === "heartbeat") continue;
    chunks.push(chunk);
}
break;
```

Replace with consumption via `lastValueFrom` and `tap`. The `aborted$` Subject should be created from the existing `this.aborted` boolean — create a Subject that the abort mechanism can push to.

The caller needs to:
1. Create an `aborted$` Subject (or derive from existing abort mechanism)
2. Subscribe to `createRelayStream$()` via `lastValueFrom` with a `tap` that pushes non-heartbeat chunks into the `chunks` array
3. Set `this.state = "RELAY_STREAM"` before and restore after (currently done inside `relayStream()` — move to caller)

```typescript
// Replace the for-await with:
const previousState = this.state;
this.state = "RELAY_STREAM";
try {
    const aborted$ = new Subject<void>();
    // Wire abort signal: check periodically or wire to existing mechanism
    const abortCheck = setInterval(() => {
        if (this.aborted) {
            aborted$.next();
            aborted$.complete();
        }
    }, 100);

    await lastValueFrom(
        createRelayStream$(
            {
                db: this.ctx.db,
                eventBus: this.ctx.eventBus,
                siteId: this.ctx.siteId,
                logger: this.ctx.logger,
            },
            inferencePayload,
            resolution.hosts,
            aborted$,
            relayMetadataRef,
            { perHostTimeoutMs: this.inferenceTimeoutMs },
        ).pipe(
            tap((chunk) => {
                if (chunk.type !== "heartbeat") {
                    chunks.push(chunk);
                }
            }),
        ),
        { defaultValue: undefined },
    );
    clearInterval(abortCheck);
} finally {
    this.state = previousState;
}
break;
```

Note: The `defaultValue: undefined` handles the case where `aborted$` fires before any chunks arrive (empty observable). The `setInterval` abort bridge is a simple approach — the executor may refine this to use an event-driven approach if a better pattern exists (e.g., if `agent:cancel` event already fires when abort is triggered).

**Step 3: Remove the old relayStream() method**

Delete lines 1877-2095 (the entire `private async *relayStream()` method). The new `createRelayStream$` factory in `relay-stream$.ts` replaces it entirely.

**Step 4: Clean up unused imports**

After removing `relayStream()`, check if any imports at the top of `agent-loop.ts` are now unused. The `readInboxByStreamId` and `markProcessed` imports may now only be needed by `relay-stream$.ts` (not `agent-loop.ts`) — verify and remove if so. Keep `createRelayOutboxEntry` if it's still used elsewhere in agent-loop.ts (check the `relayWait` method which also uses it).

**Step 5: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:**

```bash
git add packages/agent/src/relay-stream$.ts packages/agent/src/agent-loop.ts packages/agent/src/index.ts
git commit -m "refactor(agent): extract relayStream to createRelayStream$ observable factory"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Marble tests for createRelayStream$()

**Verifies:** rxjs-async-refactor.AC1.1, rxjs-async-refactor.AC1.2, rxjs-async-refactor.AC1.3, rxjs-async-refactor.AC1.4, rxjs-async-refactor.AC1.5, rxjs-async-refactor.AC1.6, rxjs-async-refactor.AC1.7, rxjs-async-refactor.AC1.8, rxjs-async-refactor.AC1.9

**Files:**
- Create: `packages/agent/src/__tests__/relay-stream$.test.ts`

**Testing:**

Tests must verify each AC listed above. Use a real temp SQLite database (following the project's existing pattern from `packages/agent/src/__tests__/helpers.ts` — `mkdtempSync`, `createDatabase`, `applySchema`). Use a real `TypedEventEmitter` instance.

The test setup needs:
- Temp database with `applySchema` (relay tables are local-only, created by applySchema)
- Real `TypedEventEmitter` for event-driven wakeup
- Mock logger: `{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }`
- Helper to insert `relay_inbox` entries directly (simulating what the relay processor would write)
- `Subject<void>` for `aborted$`

For tests that involve timing (timeout, interval polling), use `TestScheduler` with the `scheduler` option. For tests that only verify data flow (chunk ordering, error handling), real-time tests with `waitFor` may be simpler.

**Test cases:**

1. **rxjs-async-refactor.AC1.1 — Sequential chunks emitted immediately:**
   Insert relay_inbox entries with seq 0, 1, 2 in order. Verify output chunks arrive in same order without delay.

2. **rxjs-async-refactor.AC1.2 — Out-of-order reordering:**
   Insert seq 0 first, then seq 2, then seq 1. Verify output is emitted as 0, 1, 2 (seq 1 and 2 buffered until gap fills).

3. **rxjs-async-refactor.AC1.3 — Normal completion on stream_end:**
   Insert chunks ending with a `stream_end` entry. Verify observable completes after all chunks emitted.

4. **rxjs-async-refactor.AC1.4 — No failover when first host succeeds:**
   Provide two hosts, first host returns chunks successfully. Verify only one outbox entry written (for first host only).

5. **rxjs-async-refactor.AC1.5 — Silence timeout triggers failover:**
   Provide two hosts. First host returns no chunks within timeout. Verify cancel entry written for first host and new outbox entry written for second host. Use TestScheduler to advance virtual time past timeout threshold.

6. **rxjs-async-refactor.AC1.6 — All hosts exhausted:**
   Provide two hosts, both timeout. Verify observable errors with message containing "all 2 eligible host(s) timed out".

7. **rxjs-async-refactor.AC1.7 — Gap detection and skip:**
   Insert seq 0, then seq 3 (gap of 1,2). After MAX_GAP_CYCLES (6) poll intervals, verify nextExpectedSeq advances to 3 and seq 3 chunks are emitted.

8. **rxjs-async-refactor.AC1.8 — Abort mid-stream:**
   Start streaming, emit `aborted$` mid-stream. Verify cancel outbox entry is written and observable completes (no error).

9. **rxjs-async-refactor.AC1.9 — Metadata capture:**
   Provide `relayMetadataRef` object. After first chunk arrives, verify `hostName` and `firstChunkLatencyMs` are populated.

Follow project testing patterns: use `describe`/`it`/`expect` from `bun:test`. Cleanup temp DB in `afterAll` with `db.close()` and `cleanupTmpDir()`.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-stream$.test.ts`
Expected: All 9 test cases pass.

**Commit:**

```bash
git add packages/agent/src/__tests__/relay-stream$.test.ts
git commit -m "test(agent): add marble tests for createRelayStream$ observable"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Verify existing relay tests still pass

**Step 1: Run existing relay tests**

Run: `bun test packages/agent/src/__tests__/relay-stream.test.ts`
Expected: All existing tests pass (these test the old async generator — they should still pass since the behavior is preserved).

If existing tests directly call `relayStream()` as a private method on AgentLoop, they may need updating to either:
- Test through the public interface (call the agent loop state machine which now uses `createRelayStream$`)
- Or migrate to test `createRelayStream$` directly

Run: `bun test packages/agent/src/__tests__/relay-stream.integration.test.ts`
Expected: Integration tests pass.

**Step 2: Run full agent package tests**

Run: `bun test packages/agent`
Expected: All tests pass, no regressions.

**Step 3: Typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: Clean.

No commit needed — this is verification only.
<!-- END_TASK_4 -->
