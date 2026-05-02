# RxJS Async Processing Refactor — Phase 1

**Goal:** Install RxJS v7.8.2 and create the foundational `fromEventBus()` and `pollDb()` utility functions that all subsequent phases depend on.

**Architecture:** Two shared utility functions in a new `rx-utils.ts` module bridge the codebase's existing `TypedEventEmitter` and SQLite polling patterns to RxJS Observables. Both accept optional `SchedulerLike` for marble testing.

**Tech Stack:** RxJS 7.8.2, TypeScript 6.x, Bun runtime, `bun:test` with RxJS `TestScheduler`

**Scope:** 6 phases from original design (phase 1 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase is infrastructure — it installs dependencies and creates shared utilities. The utilities themselves are verified by marble tests, not by design-level acceptance criteria.

**Verifies:** None (infrastructure phase — "Done when" is operational: `bun install` succeeds, `bun run build` succeeds, `bun run typecheck` succeeds, marble tests pass)

---

<!-- START_TASK_1 -->
### Task 1: Add RxJS dependency to packages/agent and packages/platforms

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/platforms/package.json`

**Step 1: Add rxjs to both package.json files**

In `packages/agent/package.json`, add `"rxjs": "^7.8.2"` to the `dependencies` object (after the `@modelcontextprotocol/sdk` entry):

```json
{
  "dependencies": {
    "@bound/core": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/sandbox": "workspace:*",
    "@bound/shared": "workspace:*",
    "@bound/sync": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "rxjs": "^7.8.2"
  }
}
```

In `packages/platforms/package.json`, add `"rxjs": "^7.8.2"` to the `dependencies` object (after the `@bound/shared` entry):

```json
{
  "dependencies": {
    "@bound/core": "workspace:*",
    "@bound/llm": "workspace:*",
    "@bound/shared": "workspace:*",
    "rxjs": "^7.8.2"
  }
}
```

**Step 2: Install and verify**

Run: `bun install`
Expected: Installs without errors, lockfile updated.

Run: `bun run build`
Expected: Builds without errors (no code uses rxjs yet, so this just confirms the dep doesn't break compilation).

**Step 3: Commit**

```bash
git add packages/agent/package.json packages/platforms/package.json bun.lock
git commit -m "chore(agent,platforms): add rxjs@7.8.2 dependency"
```
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Create rx-utils.ts with fromEventBus() and pollDb()

**Files:**
- Create: `packages/agent/src/rx-utils.ts`

**Implementation:**

Create `packages/agent/src/rx-utils.ts` with two utility functions:

**`fromEventBus<K>`** wraps `TypedEventEmitter.on()` / `.off()` in an Observable constructor. The teardown removes the listener on unsubscribe.

```typescript
import { Observable, merge, interval, filter, map, type SchedulerLike } from "rxjs";
import type { TypedEventEmitter } from "@bound/shared";
import type { EventMap } from "@bound/shared";

export function fromEventBus<K extends keyof EventMap>(
	eventBus: TypedEventEmitter,
	event: K,
): Observable<EventMap[K]> {
	return new Observable<EventMap[K]>((subscriber) => {
		const listener = (data: EventMap[K]) => {
			subscriber.next(data);
		};
		eventBus.on(event, listener);
		return () => {
			eventBus.off(event, listener);
		};
	});
}
```

**`pollDb<T>`** emits non-null query results on each interval tick or wakeup event. It captures the "poll DB on timer with optional event-driven shortcut" pattern shared across relay stream, relay wait, and relay processor targets.

```typescript
export function pollDb<T>(
	query: () => T | null,
	opts: {
		intervalMs: number;
		wakeup$?: Observable<unknown>;
		scheduler?: SchedulerLike;
	},
): Observable<T> {
	const tick$ = opts.scheduler
		? interval(opts.intervalMs, opts.scheduler)
		: interval(opts.intervalMs);

	const source$ = opts.wakeup$ ? merge(tick$, opts.wakeup$) : tick$;

	return source$.pipe(
		map(() => query()),
		filter((v): v is T => v !== null),
	);
}
```

Key design decisions:
- `fromEventBus` does NOT accept a scheduler — events are inherently async and fire in real time. Marble tests for downstream consumers can test the operator pipelines that use `fromEventBus` output, not `fromEventBus` itself.
- `pollDb` accepts `scheduler` for `interval` only. The `wakeup$` observable is caller-provided and can be a hot subject in tests.
- `pollDb` uses `filter` with a type guard to narrow `T | null` to `T`.

**Step 1: Create the file**

Write the complete file as shown above.

**Step 2: Verify typecheck**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Step 3: Export from package index**

Add the export to `packages/agent/src/index.ts`:

```typescript
export { fromEventBus, pollDb } from "./rx-utils.js";
```

Verify the location of the existing exports in `packages/agent/src/index.ts` first — add the new export line alongside other utility exports.

**Step 4: Verify typecheck again after export**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Marble tests for fromEventBus() and pollDb()

**Files:**
- Create: `packages/agent/src/__tests__/rx-utils.test.ts`

**Testing:**

Write marble tests using RxJS `TestScheduler` for `pollDb`, and direct subscription tests for `fromEventBus` (since events are inherently async and don't use schedulers).

**Tests for `fromEventBus`:**
- Emits event data when eventBus fires the subscribed event
- Does not emit for unrelated events
- Stops receiving after unsubscribe (verifies `.off()` teardown)
- Multiple subscribers each receive events independently

Use a real `TypedEventEmitter` instance (not mocked) — this matches the project's existing pattern from `packages/shared/src/__tests__/event-emitter.test.ts`.

**Tests for `pollDb`:**
- Emits non-null query results on each interval tick (marble test with TestScheduler)
- Filters out null results — query returning null should not produce emissions
- Wakeup observable triggers immediate poll outside the interval schedule
- Both interval and wakeup emissions are merged — values from either source appear in output
- Scheduler injection works — interval respects the provided scheduler (verified implicitly by marble tests running in virtual time)

For `pollDb` marble tests, use `TestScheduler.run()` which auto-delegates `asyncScheduler` to virtual time. Pass the `scheduler` option to `pollDb` for explicit control:

```typescript
scheduler.run(({ expectObservable }) => {
    let callCount = 0;
    const query = () => {
        callCount++;
        return callCount <= 2 ? `result-${callCount}` : null;
    };
    const result$ = pollDb(query, { intervalMs: 10, scheduler });
    // interval(10) emits at 10, 20, 30ms...
    // query returns "result-1" at 10ms, "result-2" at 20ms, null at 30ms+
    expectObservable(result$.pipe(take(2))).toBe("-(ab|)", {
        a: "result-1",
        b: "result-2",
    });
});
```

Note: marble test timing depends on TestScheduler frame resolution. Adjust marble strings based on actual emission timing during implementation. The executor should verify exact marble strings by running tests.

**Verification:**

Run: `bun test packages/agent/src/__tests__/rx-utils.test.ts`
Expected: All tests pass.

**Commit:**

```bash
git add packages/agent/src/rx-utils.ts packages/agent/src/index.ts packages/agent/src/__tests__/rx-utils.test.ts
git commit -m "feat(agent): add rx-utils with fromEventBus() and pollDb() utilities"
```
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Verify full build pipeline

**Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: All packages typecheck clean.

**Step 2: Run full test suite**

Run: `bun test --recursive`
Expected: All existing tests pass, plus the new rx-utils tests.

**Step 3: Run build**

Run: `bun run build`
Expected: Builds successfully. RxJS is tree-shaken — only imported operators are included.

**Step 4: Run lint**

Run: `bun run lint`
Expected: No lint errors in new files.

No commit needed — this is verification only.
<!-- END_TASK_4 -->
