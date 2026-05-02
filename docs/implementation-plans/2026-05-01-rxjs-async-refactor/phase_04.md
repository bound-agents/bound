# RxJS Async Processing Refactor — Phase 4

**Goal:** Replace the `setTimeout` self-rescheduling tick loop in `RelayProcessor.start()` with an RxJS observable pipeline, adding event-driven wakeup via `relay:outbox-written`.

**Architecture:** The tick loop is replaced by `merge(interval(pollIntervalMs), fromEventBus(eventBus, "relay:outbox-written"))` piped through `exhaustMap` for backpressure. A separate `interval(60_000)` handles periodic pruning. The `{ stop: () => void }` API shape is preserved — callers don't need to know about RxJS.

**Tech Stack:** RxJS 7.8.2, TypeScript 6.x, Bun runtime, `bun:test`

**Scope:** 6 phases from original design (phase 4 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase implements and tests:

### rxjs-async-refactor.AC3: Relay Processor Tick Loop
- **rxjs-async-refactor.AC3.1 Success:** `processPendingEntries()` called on each interval tick
- **rxjs-async-refactor.AC3.2 Success:** `relay:outbox-written` event triggers immediate `processPendingEntries()` call (not waiting for next interval)
- **rxjs-async-refactor.AC3.3 Success:** `pruneRelayTables` called approximately every 60 seconds
- **rxjs-async-refactor.AC3.4 Success:** `stop()` (unsubscribe) tears down all timers and prevents further ticks
- **rxjs-async-refactor.AC3.5 Failure:** Exception in `processPendingEntries()` is logged and does not stop subsequent ticks
- **rxjs-async-refactor.AC3.6 Edge:** Tick firing while `processPendingEntries()` is still running is dropped (no concurrent execution)

---

<!-- START_TASK_1 -->
### Task 1: Rewrite RelayProcessor.start() with RxJS

**Verifies:** rxjs-async-refactor.AC3.1, rxjs-async-refactor.AC3.2, rxjs-async-refactor.AC3.3, rxjs-async-refactor.AC3.4, rxjs-async-refactor.AC3.5, rxjs-async-refactor.AC3.6

**Files:**
- Modify: `packages/agent/src/relay-processor.ts:197-223` (rewrite `start()`)
- Modify: `packages/agent/src/relay-processor.ts:123` (remove `stopped` field)

**Implementation:**

Rewrite `start()` to replace the setTimeout self-rescheduling pattern with an RxJS observable pipeline. The current implementation is at lines 197-223 of `relay-processor.ts`.

**Current code to replace:**
```typescript
start(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS): { stop: () => void } {
    this.stopped = false;
    let tickCount = 0;
    const PRUNE_EVERY_N_TICKS = Math.max(1, Math.round(60_000 / pollIntervalMs));
    const tick = async () => {
        if (this.stopped) return;
        try {
            await this.processPendingEntries();
            this.pruneIdempotencyCache();
            if (++tickCount % PRUNE_EVERY_N_TICKS === 0) {
                pruneRelayTables(this.db);
            }
        } catch (error) {
            this.logger.error("Relay processor tick failed", { error });
        }
        if (!this.stopped) {
            setTimeout(tick, pollIntervalMs);
        }
    };
    setTimeout(tick, pollIntervalMs);
    return {
        stop: () => { this.stopped = true; },
    };
}
```

**New implementation:**

```typescript
import {
    Subscription,
    merge,
    interval,
    exhaustMap,
    from,
    tap,
    catchError,
    EMPTY,
    type SchedulerLike,
} from "rxjs";
import { fromEventBus } from "./rx-utils";
```

```typescript
start(
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    scheduler?: SchedulerLike,
): { stop: () => void } {
    const sub = new Subscription();

    // Main processing tick: interval + event-driven wakeup
    const tick$ = scheduler
        ? interval(pollIntervalMs, scheduler)
        : interval(pollIntervalMs);

    const wakeup$ = fromEventBus(this.eventBus, "relay:outbox-written");

    const process$ = merge(tick$, wakeup$).pipe(
        exhaustMap(() =>
            from(
                (async () => {
                    await this.processPendingEntries();
                    this.pruneIdempotencyCache();
                })(),
            ).pipe(
                catchError((error) => {
                    this.logger.error("Relay processor tick failed", { error });
                    return EMPTY;
                }),
            ),
        ),
    );

    // Separate prune interval (~every 60s)
    const pruneInterval$ = scheduler
        ? interval(60_000, scheduler)
        : interval(60_000);

    const prune$ = pruneInterval$.pipe(
        tap(() => {
            try {
                pruneRelayTables(this.db);
            } catch (error) {
                this.logger.error("Relay table prune failed", { error });
            }
        }),
    );

    sub.add(process$.subscribe());
    sub.add(prune$.subscribe());

    return {
        stop: () => sub.unsubscribe(),
    };
}
```

**Key behavioral mapping:**

| Old behavior | New behavior |
|---|---|
| `setTimeout(tick, pollIntervalMs)` self-reschedule | `interval(pollIntervalMs)` |
| No event-driven wakeup | `fromEventBus(eventBus, "relay:outbox-written")` merged with interval |
| `this.stopped` flag checked before/after work | `sub.unsubscribe()` tears down all subscriptions |
| `tickCount % PRUNE_EVERY_N_TICKS` counter | Separate `interval(60_000)` for pruning |
| try/catch logs and continues | `catchError` logs and returns `EMPTY` (re-subscribes on next tick) |
| Sequential: next tick waits for current to finish | `exhaustMap`: drops ticks while processing is active |

**Step 1: Add RxJS imports to relay-processor.ts**

Add the necessary imports at the top of the file.

**Step 2: Rewrite the `start()` method**

Replace the method body as shown above. Add optional `scheduler?: SchedulerLike` parameter (second arg, after `pollIntervalMs`) for testability.

**Step 3: Delete `this.stopped` field**

Remove `private stopped = false;` at line 123. It's no longer needed — lifecycle is managed by the RxJS `Subscription`.

**Step 4: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:**

```bash
git add packages/agent/src/relay-processor.ts
git commit -m "refactor(agent): replace relay processor tick loop with RxJS observable pipeline"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for relay processor RxJS tick loop

**Verifies:** rxjs-async-refactor.AC3.1, rxjs-async-refactor.AC3.2, rxjs-async-refactor.AC3.3, rxjs-async-refactor.AC3.4, rxjs-async-refactor.AC3.5, rxjs-async-refactor.AC3.6

**Files:**
- Modify: `packages/agent/src/__tests__/relay-processor.test.ts` (add new tests)

**Testing:**

Add tests to the existing relay-processor test file. The existing test file at `packages/agent/src/__tests__/relay-processor.test.ts` already has setup patterns (mock clients, mock logger, real DB, real eventBus). Add a new `describe` block for the RxJS tick loop behavior.

**Test cases:**

1. **rxjs-async-refactor.AC3.1 — processPendingEntries called on interval:**
   Start the processor with a short interval (e.g., 50ms). Insert an outbox entry. Use `waitFor()` to verify `processPendingEntries()` picks it up within a few intervals. (This tests that the interval-based tick works.)

2. **rxjs-async-refactor.AC3.2 — Event-driven wakeup:**
   Start the processor with a long interval (e.g., 10_000ms so no interval tick fires during test). Emit `relay:outbox-written` event on the eventBus. Verify `processPendingEntries()` is called within milliseconds (not waiting for the 10s interval). Use `waitFor()` with a short timeout.

3. **rxjs-async-refactor.AC3.3 — pruneRelayTables called periodically:**
   This is harder to test in real time (60s interval). Two approaches:
   - Use TestScheduler with `scheduler` param to advance virtual time past 60s and verify prune was called.
   - Or: start with a short-enough test interval and spy on `pruneRelayTables` calls.
   The TestScheduler approach is preferred since it tests exact timing without waiting.

4. **rxjs-async-refactor.AC3.4 — stop() tears down:**
   Start the processor. Call `handle.stop()`. Verify no further ticks fire (insert an outbox entry after stop, wait briefly, verify it's NOT processed).

5. **rxjs-async-refactor.AC3.5 — Error recovery:**
   Make `processPendingEntries()` throw (e.g., corrupt an inbox entry). Verify the error is logged but subsequent ticks still fire (insert a valid entry after the error, verify it's processed).

6. **rxjs-async-refactor.AC3.6 — exhaustMap backpressure:**
   Make `processPendingEntries()` artificially slow (e.g., add a delay). Fire multiple wakeup events rapidly. Verify that only one concurrent execution occurs (e.g., by tracking call count and ensuring it doesn't spike).

Follow the existing relay-processor test patterns: use `waitFor()` from `packages/agent/src/__tests__/helpers.ts` for async assertions.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: All existing tests pass plus new tick loop tests.

**Commit:**

```bash
git add packages/agent/src/__tests__/relay-processor.test.ts
git commit -m "test(agent): add tests for relay processor RxJS tick loop"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify existing relay processor tests still pass

**Step 1: Run full relay processor test suite**

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: All tests pass.

Run: `bun test packages/agent/src/__tests__/relay-processor-inference.test.ts`
Expected: All tests pass.

**Step 2: Check that start/stop API is compatible**

Verify that the instantiation in `packages/cli/src/commands/start/relay.ts:78` (`relayProcessor.start()`) still works. The return type `{ stop: () => void }` must be preserved — the caller only calls `.stop()` during shutdown.

**Step 3: Run full agent package tests**

Run: `bun test packages/agent`
Expected: All tests pass, no regressions.

**Step 4: Typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: Clean.

No commit needed — verification only.
<!-- END_TASK_3 -->
