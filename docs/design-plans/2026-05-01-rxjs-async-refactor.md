# RxJS Async Processing Refactor Design

## Summary

This design refactors three async processing sites in the Bound agent codebase — relay streaming, relay waiting, and Discord interaction polling — from imperative `while`-loop and `setTimeout`-chain orchestration to declarative RxJS Observable pipelines. The current implementation uses manual event listener registration/cleanup, mutable timeout tracking, and flag-based cancellation across ~400 lines of imperative code, a pattern that has historically caused bugs across five live debugging sessions. By replacing this orchestration layer with RxJS operators (`merge`, `concatMap`, `timeout`, `takeUntil`, `exhaustMap`), the runtime manages listener lifecycle, timeout scheduling, and teardown automatically, eliminating manual state tracking.

Complex relay observables are extracted into standalone factory modules (`relay-stream$.ts`, `relay-wait$.ts`) for isolated marble testing, while simpler patterns (relay processor tick loop, Discord polling) are replaced in-place on their existing classes. The relay processor also gains event-driven wakeup via `relay:outbox-written` as the one intentional behavioral improvement. All other behavior is preserved exactly, and the surrounding state machine code in `AgentLoop` remains imperative.

## Definition of Done

1. **Three async processing sites refactored to RxJS Observables:** `relayStream()` + `relayWait()` (agent-loop.ts), relay processor tick loop (relay-processor.ts), and Discord interaction polling (discord-interaction.ts) — replacing imperative while-loops, setTimeout chains, and manual listener management with declarative operator pipelines.

2. **Behavior preserved exactly** except where explicitly changed: the relay processor gains event-driven wakeup via `relay:outbox-written` (new behavior). All other observable semantics (timeouts, failover order, cancellation, error handling, idempotency) must match current behavior.

3. **All existing tests pass** with no regressions, plus new marble tests (via `rxjs/testing` TestScheduler) covering the operator pipelines — particularly the tricky sequences like out-of-order chunk reordering, silence timeout to host failover, and cancellation mid-stream.

4. **RxJS v7.8.2 added as a dependency** scoped to the packages that use it (`packages/agent`, `packages/platforms`), not workspace-root.

## Acceptance Criteria

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

### rxjs-async-refactor.AC2: Relay Wait Observable
- **rxjs-async-refactor.AC2.1 Success:** `result` response kind is parsed, `markProcessed()` called, content string emitted
- **rxjs-async-refactor.AC2.2 Success:** Relay metrics (timing, host) recorded to turns table when `currentTurnId` is set
- **rxjs-async-refactor.AC2.3 Failure:** `error` response kind from remote host throws typed error
- **rxjs-async-refactor.AC2.4 Failure:** Host timeout (30s) triggers failover — new outbox entry written for next host
- **rxjs-async-refactor.AC2.5 Edge:** `aborted$` firing writes cancel outbox entry and completes

### rxjs-async-refactor.AC3: Relay Processor Tick Loop
- **rxjs-async-refactor.AC3.1 Success:** `processPendingEntries()` called on each interval tick
- **rxjs-async-refactor.AC3.2 Success:** `relay:outbox-written` event triggers immediate `processPendingEntries()` call (not waiting for next interval)
- **rxjs-async-refactor.AC3.3 Success:** `pruneRelayTables` called approximately every 60 seconds
- **rxjs-async-refactor.AC3.4 Success:** `stop()` (unsubscribe) tears down all timers and prevents further ticks
- **rxjs-async-refactor.AC3.5 Failure:** Exception in `processPendingEntries()` is logged and does not stop subsequent ticks
- **rxjs-async-refactor.AC3.6 Edge:** Tick firing while `processPendingEntries()` is still running is dropped (no concurrent execution)

### rxjs-async-refactor.AC4: Discord Interaction Polling
- **rxjs-async-refactor.AC4.1 Success:** Assistant response found in DB triggers `deliver()` and completes polling
- **rxjs-async-refactor.AC4.2 Success:** First poll fires immediately (not after waiting one interval)
- **rxjs-async-refactor.AC4.3 Failure:** No response within `pollTimeoutMs` triggers timeout error message via `editReply` and cleans up interaction
- **rxjs-async-refactor.AC4.4 Edge:** `disconnecting$` firing mid-poll completes the observable cleanly (no error, no timeout message)

### rxjs-async-refactor.AC5: Cross-Cutting
- **rxjs-async-refactor.AC5.1:** All existing tests pass with no regressions
- **rxjs-async-refactor.AC5.2:** `bun run typecheck` clean across all packages
- **rxjs-async-refactor.AC5.3:** `bun run build` produces working binary
- **rxjs-async-refactor.AC5.4:** No dead code from removed imperative implementations remains

## Glossary

- **RxJS**: Reactive Extensions for JavaScript — a library for composing asynchronous and event-based programs using observable sequences and declarative operators
- **Observable**: An RxJS primitive representing a stream of values over time; can be subscribed to, transformed with operators, and unsubscribed from to release resources
- **Marble testing**: A visual syntax for representing Observable behavior over time; marble tests use `TestScheduler` from `rxjs/testing` to verify operator pipelines in virtual time
- **`concatMap`**: RxJS operator that projects each source emission to an Observable and flattens them sequentially (waits for each to complete before starting the next)
- **`exhaustMap`**: RxJS operator that ignores new source emissions while an inner Observable is active, providing backpressure
- **`takeUntil`**: RxJS operator that mirrors the source Observable until a notifier Observable emits, then completes
- **`finalize`**: RxJS operator that executes a callback when the Observable completes, errors, or is unsubscribed
- **`lastValueFrom` / `firstValueFrom`**: RxJS utilities that convert an Observable to a Promise, resolving with the last/first emitted value
- **TestScheduler**: RxJS testing utility that controls virtual time for deterministic marble tests without real delays
- **Relay**: Bound's remote inference routing protocol — a spoke node can forward LLM requests to a hub or another spoke with better model access
- **Relay processor**: Component that consumes entries from `relay_outbox` and `relay_inbox` tables, dispatching requests to LLM backends and routing responses back
- **Spoke / Hub**: Spoke is a Bound node that syncs state and may delegate inference; hub coordinates sync and handles inference for spokes
- **Agent loop**: The state machine in `AgentLoop` orchestrating a single turn: hydrate FS, assemble context, call LLM, execute tools, persist results
- **Chunk reordering**: Buffering relay stream chunks arriving with non-sequential sequence numbers and emitting them in order once gaps are filled
- **Silence timeout**: Watchdog timer triggering host failover if no relay response chunks arrive within a threshold duration
- **Host failover**: Trying successive eligible remote hosts when one fails to respond, exhausting the list before reporting error
- **Gap detection**: Detecting when `nextExpectedSeq` has stalled for multiple poll cycles and skipping to the next buffered sequence
- **`TypedEventEmitter`**: Thin typed wrapper over Node's `EventEmitter` used throughout Bound for event-driven coordination
- **Backpressure**: Flow-control mechanism preventing overwhelming a consumer; `exhaustMap` implements this by dropping emissions while inner work is active
- **Event-driven wakeup**: Triggering processing immediately when an event occurs (via `relay:outbox-written`) rather than waiting for the next interval tick

## Architecture

Hybrid extraction approach: complex relay observables (`relayStream`, `relayWait`) extracted into standalone factory modules for isolated marble testing; simpler patterns (relay processor tick, Discord polling) replaced in-place on their existing classes.

All three refactor sites share a common theme: imperative `while`-loop or `setTimeout`-chain orchestration of event listeners, polling intervals, timeouts, and mutable flags. Each is replaced by an RxJS operator pipeline where the runtime manages listener lifecycle, timeout scheduling, and teardown — eliminating the manual state tracking that has historically caused bugs.

**Dependency:** RxJS v7.8.2 added to `packages/agent/package.json` and `packages/platforms/package.json`. Not installed at workspace root.

**Shared utilities** in new file `packages/agent/src/rx-utils.ts`:

```typescript
function fromEventBus<K extends keyof EventMap>(
  eventBus: TypedEventEmitter<EventMap>,
  event: K,
): Observable<EventMap[K]>
```

Wraps `eventBus.on` / `eventBus.off` in an Observable constructor with teardown on unsubscribe. Replaces all manual listener add/remove pairs.

```typescript
function pollDb<T>(
  query: () => T | null,
  opts: { intervalMs: number; wakeup$?: Observable<unknown>; scheduler?: SchedulerLike },
): Observable<T>
```

Emits non-null query results on each interval tick or wakeup event. Captures the "poll DB on timer with optional event-driven shortcut" pattern shared across all three targets.

**Integration pattern:** Extracted factories return `Observable<T>`. Callers in the agent loop consume via `lastValueFrom()` or `firstValueFrom()` (both from `rxjs`), keeping the surrounding imperative code (state machine transitions, chunk collection) unchanged.

## Existing Patterns

Investigation found no existing RxJS usage in the codebase. The `TypedEventEmitter` in `packages/shared/src/event-emitter.ts` is the closest reactive primitive — a thin typed wrapper over Node's `EventEmitter`. The `fromEventBus()` utility bridges this to RxJS without replacing it.

The existing async patterns follow a consistent shape: `while(true)` or `setTimeout` self-rescheduling, with manual event listener registration/cleanup, mutable timeout tracking, and flag-based cancellation. All three targets use this same shape independently. The RxJS refactor replaces the orchestration layer but preserves the underlying operations (`processPendingEntries`, DB queries, outbox writes) untouched.

The relay processor's `start()` returns `{ stop: () => void }`. This API shape is preserved — the caller in `packages/cli/src/commands/start/server.ts` does not need to know about RxJS.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Dependency Setup and Shared Utilities

**Goal:** Install RxJS and create the foundational utility functions that all subsequent phases depend on.

**Components:**
- `packages/agent/package.json` — add `rxjs@7.8.2` dependency
- `packages/platforms/package.json` — add `rxjs@7.8.2` dependency
- `packages/agent/src/rx-utils.ts` (new) — `fromEventBus()` and `pollDb()` utilities
- `packages/agent/src/__tests__/rx-utils.test.ts` (new) — marble tests for both utilities

**Dependencies:** None (first phase)

**Done when:** `bun install` succeeds, `bun run build` succeeds, `bun run typecheck` succeeds, marble tests for `fromEventBus` and `pollDb` pass
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Relay Stream Observable

**Goal:** Extract `relayStream()` from `AgentLoop` into a standalone observable factory, replacing ~220 lines of async generator with a declarative operator pipeline.

**Components:**
- `packages/agent/src/relay-stream$.ts` (new) — `createRelayStream$()` factory function
  - Host iteration via `from(eligibleHosts).pipe(concatMap(...))`
  - Per-host polling via `pollDb` merged with `fromEventBus("relay:inbox")`
  - Chunk reordering via `scan` accumulator (buffer Map, nextExpectedSeq, gap cycle tracking)
  - Silence timeout via `timeout({ each: perHostTimeoutMs })`
  - Cancellation via `takeUntil(aborted$)` with `finalize` for cancel outbox write
  - Metadata tracking via `tap` (firstChunkLatencyMs, hostName)
- `packages/agent/src/agent-loop.ts` — replace `for await (const chunk of this.relayStream(...))` with `lastValueFrom(createRelayStream$(...).pipe(tap(...)))`. Remove the `relayStream()` async generator method. Keep `this.state` management in the calling code.
- `packages/agent/src/__tests__/relay-stream$.test.ts` (new) — marble tests covering: happy path, out-of-order reordering, gap detection/skip, silence timeout triggering host failover, all hosts exhausted, cancellation mid-stream

**Dependencies:** Phase 1 (rx-utils)

**Done when:** Relay streaming to remote hosts works identically to before (same chunk ordering, same failover behavior, same cancellation semantics), old `relayStream()` method removed, marble tests pass covering rxjs-async-refactor.AC1.* criteria
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Relay Wait Observable

**Goal:** Extract `relayWait()` from `AgentLoop` into a standalone observable factory, replacing ~170 lines of polling loop with a declarative pipeline.

**Components:**
- `packages/agent/src/relay-wait$.ts` (new) — `createRelayWait$()` factory function
  - Host iteration via `from(eligibleHosts).pipe(concatMap(...))`
  - Polling via `fromEventBus("relay:inbox")` filtered by `ref_id`, merged with `pollDb` fallback
  - Response parsing via `map` (schema validation, `markProcessed()`)
  - Single-response via `take(1)`
  - Relay metrics via `tap` (recording to turns table)
  - Cancellation via `takeUntil(aborted$)` with `finalize`
- `packages/agent/src/agent-loop.ts` — replace `await this.relayWait(result, toolCall, currentTurnId)` with `firstValueFrom(createRelayWait$(...))`. Remove the `relayWait()` and `_relayWaitImpl()` methods. Keep `this.state` management in calling code.
- `packages/agent/src/__tests__/relay-wait$.test.ts` (new) — marble tests covering: happy path, error response from remote, host failover on timeout, cancellation

**Dependencies:** Phase 1 (rx-utils)

**Done when:** Relay tool-call forwarding works identically to before (same timeout, same failover, same metrics recording), old `relayWait()` / `_relayWaitImpl()` methods removed, marble tests pass covering rxjs-async-refactor.AC2.* criteria
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Relay Processor Tick Loop

**Goal:** Replace the `setTimeout` self-rescheduling tick loop in `RelayProcessor.start()` with an RxJS observable pipeline, adding event-driven wakeup.

**Components:**
- `packages/agent/src/relay-processor.ts` — rewrite `start()` method:
  - `merge(interval(pollIntervalMs), fromEventBus(eventBus, "relay:outbox-written"))` for tick source
  - `exhaustMap(() => from(this.processPendingEntries()))` for backpressure
  - Separate `interval(60_000)` for `pruneRelayTables`
  - `catchError((err, caught) => { log; return caught })` for error recovery
  - Returns `{ stop: () => sub.unsubscribe() }` (same API shape)
  - Delete `this.stopped` flag, `tickCount` variable
- `packages/agent/src/__tests__/relay-processor.test.ts` — additions: event-driven wakeup verification, exhaustMap backpressure, error recovery, stop/unsubscribe

**Dependencies:** Phase 1 (rx-utils for `fromEventBus`)

**Done when:** Relay processor processes entries on interval and immediately on outbox writes, no concurrent tick execution, error recovery works, stop cleanly tears down all timers, tests pass covering rxjs-async-refactor.AC3.* criteria
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Discord Interaction Polling

**Goal:** Replace the `while(true)` DB polling loop in `DiscordInteractionConnector.pollForResponse()` with an RxJS observable pipeline.

**Components:**
- `packages/platforms/src/connectors/discord-interaction.ts` — rewrite `pollForResponse()`:
  - `interval(POLL_INTERVAL_MS).pipe(startWith(0), map(dbQuery), filter(nonNull), take(1), timeout(pollTimeoutMs), takeUntil(disconnecting$))`
  - Replace `disconnecting: boolean` with `disconnecting$: Subject<void>`
  - Extract `handlePollTimeout()` method
  - `connect()` creates fresh `Subject`, `disconnect()` calls `next()`
- `packages/platforms/src/connectors/__tests__/discord-interaction.test.ts` — additions: response found on first poll, timeout handling, disconnect mid-poll

**Dependencies:** Phase 1 (RxJS dependency in packages/platforms)

**Done when:** Discord interaction polling finds responses, times out correctly, aborts on disconnect, interactions Map cleanup unchanged, tests pass covering rxjs-async-refactor.AC4.* criteria
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Cleanup and Regression Verification

**Goal:** Remove dead code, run full test suite, verify binary compilation.

**Components:**
- `packages/agent/src/agent-loop.ts` — verify no remaining references to removed methods (`relayStream`, `relayWait`, `_relayWaitImpl`)
- `packages/agent/src/relay-processor.ts` — verify `stopped` flag and `tickCount` fully removed
- `packages/platforms/src/connectors/discord-interaction.ts` — verify `disconnecting` boolean fully replaced by Subject
- Full test suite — `bun test --recursive`
- Type check — `bun run typecheck`
- Lint — `bun run lint`
- Binary build — `bun run build`

**Dependencies:** Phases 2, 3, 4, 5

**Done when:** No dead code remains, full test suite passes (existing + new), typecheck clean, lint clean, binary compiles and runs
<!-- END_PHASE_6 -->

## Additional Considerations

**Scheduler injection for testability:** All observable factories and the relay processor accept an optional `scheduler?: SchedulerLike` parameter (defaulting to `asyncScheduler`). Marble tests inject `TestScheduler` to control virtual time. Production code is unaware of the test scheduler.

**Binary size:** RxJS v7.8.2 with tree-shaking adds ~40-60KB to the compiled binary. The operators used (merge, interval, from, concatMap, switchMap, scan, timeout, takeUntil, take, filter, map, tap, catchError, exhaustMap, startWith, finalize) are a moderate subset — Bun's tree-shaking eliminates unused operators.

**Error observability:** RxJS stack traces can be harder to read than imperative code. The `catchError` operators in the relay processor and the `subscribe({ error })` handlers should log with enough context (streamId, hostId, entry kind) to make debugging straightforward without needing to trace through operator internals.
