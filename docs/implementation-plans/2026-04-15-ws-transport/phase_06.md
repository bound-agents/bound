# WebSocket Sync Transport Implementation Plan — Phase 6

**Goal:** RELAY_WAIT and RELAY_STREAM consume relay messages via `relay:inbox` events instead of 500ms database polling, and all `sync:trigger` emits are removed

**Architecture:** Replace the polling loops in RELAY_WAIT and RELAY_STREAM with event-driven handlers. Each state registers a listener on the `relay:inbox` event (added in Phase 5) that matches its `ref_id` or `stream_id`. When a matching event fires, the handler reads the entry from DB and processes it. Timer-based timeouts and failover logic are preserved. All 16 `sync:trigger` emit sites are removed (no longer needed — WS push-on-write delivers immediately). The `sync:trigger` and `sync:completed` events are removed from EventMap.

**Tech Stack:** TypeScript, existing `TypedEventEmitter`, `relay:inbox` event from Phase 5

**Scope:** Phase 6 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC5: Inference streaming latency reduced
- **ws-transport.AC5.2 Success:** RELAY_STREAM state consumes chunks via `relay:inbox` event listener (no database polling)
- **ws-transport.AC5.3 Success:** RELAY_WAIT state consumes tool results via `relay:inbox` event listener (no database polling)
- **ws-transport.AC5.4 Success:** Per-host inference timeout (`inference_timeout_ms`) still triggers failover

### ws-transport.AC1: All HTTP-based sync removed
- **ws-transport.AC1.4 Success:** `sync:trigger` event is removed from EventMap with no remaining emitters or listeners

---

## Reference Files

The executor should read these files for context:

- `packages/agent/src/agent-loop.ts` lines 1082-1217 — RELAY_WAIT state (polling readInboxByRefId every 500ms)
- `packages/agent/src/agent-loop.ts` lines 1223-1425 — RELAY_STREAM state (polling readInboxByStreamId every 500ms)
- `packages/shared/src/events.ts` — EventMap with `sync:trigger`, `sync:completed`, and new `relay:inbox`
- `packages/core/src/relay.ts` — `readInboxByRefId()`, `readInboxByStreamId()` signatures

**sync:trigger emit sites to remove (16 total):**
- `packages/agent/src/agent-loop.ts` — lines 451, 1110, 1125, 1206, 1253, 1286
- `packages/agent/src/relay-processor.ts` — lines 562, 1251, 1386, 1682
- `packages/agent/src/mcp-bridge.ts` — line 612
- `packages/agent/src/commands/emit.ts` — line 58
- `packages/cli/src/commands/start/server.ts` — line 276
- `packages/platforms/src/connectors/discord.ts` — line 567
- `packages/platforms/src/connectors/discord-interaction.ts` — line 639
- `packages/web/src/server/routes/status.ts` — line 215

**sync:trigger listener sites to remove (2 total):**
- `packages/sync/src/sync-loop.ts` — line 667
- `packages/cli/src/commands/start/server.ts` — line 201

**sync:completed emit site to remove (1 total):**
- `packages/sync/src/sync-loop.ts` — line 166

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Rewrite RELAY_WAIT to event-driven

**Verifies:** ws-transport.AC5.3, ws-transport.AC5.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` — rewrite `_relayWaitImpl()` (lines 1097-1217)

**Implementation:**

Replace the 500ms polling loop with an event-driven approach:

Current pattern (to replace):
```typescript
while (!timedOut) {
	await sleep(500);
	const response = readInboxByRefId(db, refId);
	if (response) { /* handle */ }
}
```

New pattern:
```typescript
const response = await new Promise<RelayInboxEntry | null>((resolve) => {
	const timeoutId = setTimeout(() => {
		cleanup();
		resolve(null); // timeout
	}, timeoutMs);

	const onInbox = (event: { ref_id?: string; kind: RelayKind }) => {
		if (event.ref_id !== outboxEntryId) return;
		const entry = readInboxByRefId(db, outboxEntryId);
		if (!entry) return; // spurious event
		cleanup();
		resolve(entry);
	};

	const cleanup = () => {
		clearTimeout(timeoutId);
		eventBus.off("relay:inbox", onInbox);
	};

	// Check immediately in case entry arrived before listener
	const existing = readInboxByRefId(db, outboxEntryId);
	if (existing) {
		cleanup();
		resolve(existing);
		return;
	}

	eventBus.on("relay:inbox", onInbox);
});
```

Key points:
- Listen for `relay:inbox` events matching the `ref_id` of the outbox entry.
- On match, read the entry from DB (ground truth — event is a notification, DB is authoritative).
- **Check DB immediately** before setting up listener (race condition: entry may arrive between write and listen).
- Timer-based timeout preserved: `setTimeout(timeoutMs)` triggers failover to next host (same 30s default).
- Cancellation check: `this.aborted` flag checked before each event handler invocation.
- Remove `sync:trigger` emits at lines 1110, 1125, 1206 — no longer needed since WS push-on-write delivers immediately.
- The failover logic (cycling through eligible hosts) remains identical.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): rewrite RELAY_WAIT to event-driven via relay:inbox listener`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rewrite RELAY_STREAM to event-driven

**Verifies:** ws-transport.AC5.2, ws-transport.AC5.4

**Files:**
- Modify: `packages/agent/src/agent-loop.ts` — rewrite `relayStream()` generator (lines 1223-1425)

**Implementation:**

Replace the 500ms polling loop with an event-driven approach. RELAY_STREAM is more complex than RELAY_WAIT because it's a generator that yields chunks in sequence order.

New pattern for the inner polling loop (lines 1310-1409):

```typescript
// Instead of: await sleep(500); const entries = readInboxByStreamId(db, streamId);
// Use: wait for relay:inbox event matching stream_id, with timeout

const waitForChunk = () => new Promise<void>((resolve) => {
	const timeoutId = setTimeout(() => {
		cleanup();
		resolve(); // timeout check happens after
	}, POLL_INTERVAL_MS); // keep short timeout for responsiveness

	const onInbox = (event: { stream_id?: string; kind: RelayKind }) => {
		if (event.stream_id !== streamId) return;
		cleanup();
		resolve();
	};

	const cleanup = () => {
		clearTimeout(timeoutId);
		eventBus.off("relay:inbox", onInbox);
	};

	eventBus.on("relay:inbox", onInbox);
});
```

After `waitForChunk()` resolves (either via event or timeout), read from DB:
```typescript
const entries = readInboxByStreamId(db, streamId);
// Continue with existing buffering, ordering, gap detection logic
```

Key points:
- The generator's `yield` semantics are preserved — each chunk is yielded as a `StreamChunk`.
- Gap detection and out-of-order handling remain unchanged (buffer by seq, yield in order).
- **Per-host timeout preserved:** `inference_timeout_ms` still triggers failover (AC5.4). The timeout logic checks `Date.now() - lastActivityTime > PER_HOST_TIMEOUT_MS`.
- A short fallback timeout (e.g., 500ms or 1s) on the event wait ensures the timeout check runs periodically even without events.
- Remove `sync:trigger` emits at lines 1253, 1286 — no longer needed.
- Cancellation check: `this.aborted` before each iteration.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: No type errors

**Commit:** `feat(agent): rewrite RELAY_STREAM to event-driven via relay:inbox listener`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Event-driven relay tests

**Verifies:** ws-transport.AC5.2, ws-transport.AC5.3, ws-transport.AC5.4

**Files:**
- Create or modify: `packages/agent/src/__tests__/relay-event-driven.test.ts`

**Testing:**

Test the event-driven RELAY_WAIT and RELAY_STREAM behavior. These tests can use mock eventBus and DB helpers without full WS infrastructure.

Test cases:

- **ws-transport.AC5.3 — RELAY_WAIT responds to event:** Set up RELAY_WAIT with a ref_id. Emit `relay:inbox` event with matching ref_id after a short delay. Verify the response is consumed without 500ms polling delay.

- **ws-transport.AC5.3 — RELAY_WAIT handles pre-existing entry:** Insert a relay_inbox entry BEFORE starting RELAY_WAIT. Verify it's found immediately on the initial DB check (no event needed).

- **ws-transport.AC5.2 — RELAY_STREAM yields on event:** Set up RELAY_STREAM with a stream_id. Emit `relay:inbox` events with matching stream_id. Verify chunks are yielded in order as events arrive.

- **ws-transport.AC5.4 — Timeout still triggers failover:** Set up RELAY_WAIT with a very short timeout (e.g., 100ms). Don't emit any event. Verify timeout fires and failover logic executes.

- **ws-transport.AC5.4 — RELAY_STREAM per-host timeout:** Set up RELAY_STREAM, deliver first chunk, then no more chunks. Verify per-host timeout fires after `inference_timeout_ms`.

- **Cancellation in RELAY_WAIT:** Set `aborted = true` during RELAY_WAIT. Verify it exits cleanly.

- **Cancellation in RELAY_STREAM:** Set `aborted = true` during RELAY_STREAM. Verify generator completes without hanging.

- **Multiple concurrent relay waits:** Two RELAY_WAIT instances with different ref_ids. Emit events for each. Verify each receives its own response (no cross-talk).

**Verification:**
Run: `bun test packages/agent/src/__tests__/relay-event-driven.test.ts`
Expected: All tests pass

**Commit:** `test(agent): add event-driven RELAY_WAIT and RELAY_STREAM tests`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->

<!-- START_TASK_4 -->
### Task 4: Remove all sync:trigger emits

**Verifies:** ws-transport.AC1.4

**Files (16 emit sites to modify):**
- Modify: `packages/agent/src/agent-loop.ts` — remove emits at lines 451, 1110, 1125, 1206, 1253, 1286
- Modify: `packages/agent/src/relay-processor.ts` — remove emits at lines 562, 1251, 1386, 1682
- Modify: `packages/agent/src/mcp-bridge.ts` — remove emit at line 612
- Modify: `packages/agent/src/commands/emit.ts` — remove emit at line 58
- Modify: `packages/cli/src/commands/start/server.ts` — remove emit at line 276
- Modify: `packages/platforms/src/connectors/discord.ts` — remove emit at line 567
- Modify: `packages/platforms/src/connectors/discord-interaction.ts` — remove emit at line 639
- Modify: `packages/web/src/server/routes/status.ts` — remove emit at line 215

**Implementation:**

For each file, find the `eventBus.emit("sync:trigger", ...)` call and remove it. In most cases, the emit is the only purpose of that line — just delete the line and any surrounding comments about triggering sync.

Some emits serve as "wake-up" calls that also need replacement:
- **agent-loop.ts lines 451, 1253:** These emits after `writeOutbox()` calls previously ensured the sync loop would deliver the relay entry promptly. With WS push-on-write (Phase 4-5), the `relay:outbox-written` event handles this. No replacement needed — just remove.
- **relay-processor.ts line 1251 (inference-stream-flush):** This ensured stream chunks were pushed to the sync loop. With WS transport, chunks are pushed immediately. Remove.
- **emit.ts line 58 (broadcast):** The `emit` command writes a broadcast relay entry. WS push-on-write handles delivery. Remove.

For the `emit` command specifically: verify that the broadcast relay still gets delivered without sync:trigger. It will — `relay:outbox-written` event triggers WS send.

**Verification:**
Run: `grep -r "sync:trigger" packages/ --include="*.ts" -l` (should only find test files and event definition)
Expected: No production code references to `sync:trigger` remain

**Commit:** `refactor: remove all 16 sync:trigger emit sites (WS push-on-write replaces them)`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Remove sync:trigger and sync:completed from EventMap

**Verifies:** ws-transport.AC1.4

**Files:**
- Modify: `packages/shared/src/events.ts` — remove `sync:trigger` and `sync:completed` from EventMap
- Modify: `packages/sync/src/sync-loop.ts` — remove listener at line 667 and emit at line 166
- Modify: `packages/cli/src/commands/start/server.ts` — remove listener at line 201

**Implementation:**

1. Remove from EventMap in `packages/shared/src/events.ts`:
   ```typescript
   // REMOVE these lines:
   "sync:completed": { pushed: number; pulled: number; duration_ms: number };
   "sync:trigger": { reason: string };
   ```

2. In `packages/sync/src/sync-loop.ts`:
   - Remove the `sync:trigger` listener at line 667 (this made the sync loop wake up immediately).
   - Remove the `sync:completed` emit at line 166.
   
3. In `packages/cli/src/commands/start/server.ts`:
   - Remove the `sync:trigger` listener at line 201 (this triggered eager push on hub).

After this change, TypeScript will report compile errors for any remaining references to these events (type system enforces completeness).

**Verification:**
Run: `tsc -p packages/shared --noEmit && tsc -p packages/sync --noEmit && tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors (all references removed)

Run: `grep -r "sync:trigger\|sync:completed" packages/ --include="*.ts"` 
Expected: No matches (or only in test files being deleted in Phase 7)

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `refactor(shared): remove sync:trigger and sync:completed events from EventMap`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->
