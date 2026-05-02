# RxJS Async Processing Refactor — Phase 5

**Goal:** Replace the `while(true)` DB polling loop in `DiscordInteractionConnector.pollForResponse()` with an RxJS observable pipeline, and replace the `disconnecting` boolean flag with a `Subject<void>`.

**Architecture:** The polling loop becomes `interval(POLL_INTERVAL_MS).pipe(startWith(0), map(dbQuery), filter(nonNull), take(1), timeout(pollTimeoutMs), takeUntil(disconnecting$))`. The `disconnecting` boolean is replaced by a `disconnecting$: Subject<void>` that `connect()` creates fresh and `disconnect()` calls `.next()` on. Timeout handling is extracted into `handlePollTimeout()`.

**Tech Stack:** RxJS 7.8.2, TypeScript 6.x, Bun runtime, `bun:test`

**Scope:** 6 phases from original design (phase 5 of 6)

**Codebase verified:** 2026-05-01

---

## Acceptance Criteria Coverage

This phase implements and tests:

### rxjs-async-refactor.AC4: Discord Interaction Polling
- **rxjs-async-refactor.AC4.1 Success:** Assistant response found in DB triggers `deliver()` and completes polling
- **rxjs-async-refactor.AC4.2 Success:** First poll fires immediately (not after waiting one interval)
- **rxjs-async-refactor.AC4.3 Failure:** No response within `pollTimeoutMs` triggers timeout error message via `editReply` and cleans up interaction
- **rxjs-async-refactor.AC4.4 Edge:** `disconnecting$` firing mid-poll completes the observable cleanly (no error, no timeout message)

---

<!-- START_TASK_1 -->
### Task 1: Replace disconnecting boolean with Subject and rewrite pollForResponse()

**Verifies:** rxjs-async-refactor.AC4.1, rxjs-async-refactor.AC4.2, rxjs-async-refactor.AC4.3, rxjs-async-refactor.AC4.4

**Files:**
- Modify: `packages/platforms/src/connectors/discord-interaction.ts`

**Implementation:**

The current `pollForResponse()` is at lines 344-391. The `disconnecting` boolean is at line 92.

**Step 1: Add RxJS imports**

Add to the top of `discord-interaction.ts`:

```typescript
import { interval, firstValueFrom, Subject, TimeoutError } from "rxjs";
import { startWith, map, filter, take, timeout, takeUntil, finalize } from "rxjs/operators";
```

**Step 2: Replace `disconnecting` boolean with `disconnecting$: Subject<void>`**

Replace line 92:
```typescript
// Old:
private disconnecting = false;

// New:
private disconnecting$ = new Subject<void>();
```

**Step 3: Update `connect()` to create fresh Subject**

In `connect()` (line 105), replace `this.disconnecting = false;` with:
```typescript
this.disconnecting$ = new Subject<void>();
```

This ensures each connection cycle gets a fresh Subject (important because Subjects that have been completed cannot re-emit).

**Step 4: Update `disconnect()` to emit on Subject**

In `disconnect()` (line 151), replace `this.disconnecting = true;` with:
```typescript
this.disconnecting$.next();
this.disconnecting$.complete();
```

**Step 5: Rewrite `pollForResponse()`**

Replace the entire method (lines 344-391) with:

```typescript
private async pollForResponse(threadId: string, afterTimestamp: string): Promise<void> {
	try {
		const response = await firstValueFrom(
			interval(POLL_INTERVAL_MS).pipe(
				startWith(0),
				map(() =>
					this.db
						.query<{ id: string; content: string }, [string, string]>(
							"SELECT id, content FROM messages WHERE thread_id = ? AND role = 'assistant' AND created_at > ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
						)
						.get(threadId, afterTimestamp),
				),
				filter(
					(row): row is { id: string; content: string } => row !== null && row !== undefined,
				),
				take(1),
				timeout(this.pollTimeoutMs),
				takeUntil(this.disconnecting$),
				finalize(() => {
					// No cleanup needed here — deliver() and handlePollTimeout()
					// handle interactions Map cleanup in their respective paths
				}),
			),
			{ defaultValue: null },
		);

		if (response) {
			await this.deliver(threadId, response.id, response.content);
		}
		// If response is null, disconnecting$ fired → clean exit (AC4.4)
		// The interactions map entry is cleaned up by disconnect() which calls
		// this.interactions.clear()
	} catch (err) {
		if (err instanceof TimeoutError) {
			await this.handlePollTimeout(threadId);
		} else {
			this.logger.error("Unexpected error in pollForResponse", {
				threadId,
				error: String(err),
			});
			this.interactions.delete(threadId);
		}
	}
}
```

Key behavioral mapping:

| Old behavior | New behavior |
|---|---|
| `while (true)` loop with `setTimeout` sleep | `interval(POLL_INTERVAL_MS)` |
| First poll after 500ms delay | `startWith(0)` — first poll is immediate |
| `if (this.disconnecting)` check each iteration | `takeUntil(this.disconnecting$)` |
| `if (Date.now() - startTime >= pollTimeoutMs)` | `timeout(this.pollTimeoutMs)` throws `TimeoutError` |
| `if (response)` → deliver and return | `filter(nonNull)` + `take(1)` → `firstValueFrom` resolves |
| `await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))` | handled by `interval` operator |

**Step 6: Extract `handlePollTimeout()` method**

Add a new private method after `pollForResponse()`:

```typescript
private async handlePollTimeout(threadId: string): Promise<void> {
	this.logger.warn("Polling timed out waiting for agent response", { threadId });
	const stored = this.interactions.get(threadId);
	if (stored && new Date(stored.expiresAt) > new Date()) {
		try {
			await stored.interaction.editReply({
				content: "Error: Timed out waiting for agent response after 5 minutes.",
			});
		} catch (err) {
			this.logger.warn("editReply failed for timeout message", {
				threadId,
				error: String(err),
			});
		}
	}
	this.interactions.delete(threadId);
}
```

This is extracted directly from the old `pollForResponse()` lines 368-385 — same behavior, just factored into its own method.

**Step 7: Verify typecheck**

Run: `tsc -p packages/platforms --noEmit`
Expected: No errors.

**Commit:**

```bash
git add packages/platforms/src/connectors/discord-interaction.ts
git commit -m "refactor(platforms): replace Discord polling loop with RxJS observable"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for Discord interaction polling observable

**Verifies:** rxjs-async-refactor.AC4.1, rxjs-async-refactor.AC4.2, rxjs-async-refactor.AC4.3, rxjs-async-refactor.AC4.4

**Files:**
- Modify: `packages/platforms/src/__tests__/discord-interaction.test.ts` (add new tests)

**Testing:**

Add a new `describe` block to the existing test file. The existing test file already has extensive setup patterns (mock client, mock interactions, real temp DB). Add tests that specifically verify the RxJS observable behavior.

**Test cases:**

1. **rxjs-async-refactor.AC4.1 — Response found triggers deliver:**
   Insert an assistant message into the DB before starting polling. Call `pollForResponse()`. Verify `editReply` is called with the message content. This is already covered by existing AC8.1 tests — verify they still pass.

2. **rxjs-async-refactor.AC4.2 — First poll fires immediately:**
   Insert an assistant message into the DB. Start polling. Verify `editReply` is called within < 100ms (not after waiting 500ms for the first interval tick). The `startWith(0)` ensures immediate first poll.

3. **rxjs-async-refactor.AC4.3 — Timeout delivers error:**
   Start polling with a short `pollTimeoutMs` (e.g., 200ms). Don't insert any response. Verify `editReply` is called with the timeout error string "Error: Timed out waiting for agent response after 5 minutes." and the interaction is cleaned up from the Map. This is already covered by existing AC8.2 tests — verify they still pass.

4. **rxjs-async-refactor.AC4.4 — Disconnect mid-poll completes cleanly:**
   Start polling. After a short delay (50ms), call `disconnect()` (which fires `disconnecting$.next()`). Verify that `editReply` is NOT called with a timeout error (the observable completed cleanly, not via timeout). Verify the interactions Map is cleared (by disconnect's `this.interactions.clear()`).

Follow the existing test patterns: mock Discord client, mock interactions with captured `editReply` calls, real temp SQLite DB.

**Verification:**

Run: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts`
Expected: All existing tests pass plus new RxJS behavior tests.

**Commit:**

```bash
git add packages/platforms/src/__tests__/discord-interaction.test.ts
git commit -m "test(platforms): add tests for Discord interaction RxJS polling"
```
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Verify existing Discord interaction tests still pass

**Step 1: Run full discord interaction test suite**

Run: `bun test packages/platforms/src/__tests__/discord-interaction.test.ts`
Expected: All existing tests pass. The existing AC8.1 (response found) and AC8.2 (timeout) tests should work identically with the new RxJS implementation since the external behavior is preserved.

**Step 2: Run full platforms package tests**

Run: `bun test packages/platforms`
Expected: All tests pass, no regressions.

**Step 3: Typecheck**

Run: `tsc -p packages/platforms --noEmit`
Expected: Clean.

No commit needed — verification only.
<!-- END_TASK_3 -->
