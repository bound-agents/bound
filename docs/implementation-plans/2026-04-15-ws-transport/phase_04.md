# WebSocket Sync Transport Implementation Plan — Phase 4

**Goal:** Event-driven changelog push replaces HTTP push/pull/ack cycle — entries replicate bidirectionally over WS immediately on write

**Architecture:** Create `ws-transport.ts` as the transport layer that bridges changelog writes to WS frame delivery. A push-on-write listener hooks into changelog creation via a new `changelog:written` event on `TypedEventEmitter`. A microtask coalescer batches entries within the same event loop tick before sending a single `changelog_push` frame. The receive handler replays entries through existing `replayEvents()` reducers and sends `changelog_ack` with the highest HLC. Reconnect drain catches up missed entries by querying `change_log WHERE hlc > last_sent`.

**Tech Stack:** TypeScript, existing change-log/reducers/peer-cursor infrastructure, `queueMicrotask()` for coalescing

**Scope:** Phase 4 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic
- **ws-transport.AC2.2 Success:** Changelog entries replicate bidirectionally within 100ms of write

### ws-transport.AC6: Cross-cutting behaviors
- **ws-transport.AC6.2 Success:** Reconnect drain synchronizes missed changelog entries and relay messages from last confirmed HLC cursor
- **ws-transport.AC6.5 Success:** `relay_outbox`/`relay_inbox` tables remain as durable buffers throughout
- **ws-transport.AC6.6 Failure:** Hub disconnection does not lose relay messages — entries remain in spoke's outbox with `delivered = 0`

---

## Reference Files

The executor should read these files for context:

- `packages/core/src/change-log.ts` — `createChangeLogEntry()`, `insertRow()`, `updateRow()`, `softDelete()` write path
- `packages/sync/src/reducers.ts` — `replayEvents(db, events)` returns `{ applied, skipped }`
- `packages/sync/src/peer-cursor.ts` — `getPeerCursor()`, `updatePeerCursor()`, `getMinConfirmedHlc()`
- `packages/sync/src/changeset.ts` — `fetchOutboundChangeset()` queries `change_log WHERE hlc > last_sent`
- `packages/sync/src/sync-loop.ts` — existing HTTP push/pull/ack phases for reference (the pattern being replaced)
- `packages/sync/src/routes.ts` — hub-side `/sync/push`, `/sync/pull`, `/sync/ack` handlers for reference
- `packages/sync/src/ws-frames.ts` — frame codec (Phase 1)
- `packages/sync/src/ws-server.ts` — hub-side WS server (Phase 2)
- `packages/sync/src/ws-client.ts` — spoke-side WS client (Phase 3)
- `packages/shared/src/events.ts` — `TypedEventEmitter` event definitions
- `packages/shared/src/types.ts` — `SyncState`, `ChangeLogEntry` types
- `CLAUDE.md` — testing conventions, change-log outbox pattern invariant

---

<!-- START_TASK_1 -->
### Task 1: Add `changelog:written` event to TypedEventEmitter

**Verifies:** None (infrastructure for push-on-write)

**Files:**
- Modify: `packages/shared/src/events.ts` — add `changelog:written` event to EventMap
- Modify: `packages/core/src/change-log.ts` — emit `changelog:written` after successful changelog writes

**Implementation:**

In `packages/shared/src/events.ts`, add to the EventMap:
```typescript
"changelog:written": { hlc: string; tableName: string; siteId: string }
```

In `packages/core/src/change-log.ts`, the `insertRow()`, `updateRow()`, and `softDelete()` functions currently create changelog entries inside transactions. After the transaction commits, emit the event. This requires passing an `eventBus` parameter.

However, `insertRow()`/`updateRow()`/`softDelete()` currently do NOT have an `eventBus` parameter — they're pure database functions. Two approaches:

**Option A (preferred):** Add an optional `eventBus?: TypedEventEmitter` parameter to these functions. When provided, emit `changelog:written` after the transaction commits. This is backward compatible — existing callers without eventBus continue to work.

**Option B:** Create a separate listener at a higher level that detects new changelog entries. This is more complex and less reliable.

Go with Option A. Add the optional parameter to all three functions. Callers that need push-on-write (the sync layer) will pass eventBus. Existing callers (tests, migration) don't need to change.

**EventBus threading strategy:** NOT every caller needs updating. The push-on-write behavior only needs to fire when the WS transport is active (i.e., when a WS connection exists). The eventBus is threaded through at a single integration point:

1. In `packages/cli/src/commands/start/sync.ts`, when WsSyncClient is active, store the eventBus reference on the `AppContext`.
2. The `WsTransport.start()` method (Task 3) registers a listener on `changelog:written`. When it receives the event, it reads the entry from DB and pushes it over WS.
3. To emit the event: rather than modifying every `insertRow()`/`updateRow()`/`softDelete()` callsite, use bun:sqlite's **update hook** (`db.run("...")` callback) or wrap the database instance. Specifically, add a post-commit event emitter at the `createChangeLogEntry()` level — this is the SINGLE function that writes all changelog entries, regardless of caller. Add `eventBus` as an optional module-level binding (set once at startup via `setChangelogEventBus(eventBus)`) rather than threading through every call signature. This avoids modifying function signatures across the codebase.

This means:
- `setChangelogEventBus(eventBus)` called once at startup in `sync.ts`
- `createChangeLogEntry()` emits `changelog:written` after the transaction commits if eventBus is set
- Zero changes to `insertRow()`/`updateRow()`/`softDelete()` signatures
- Zero changes to callers across agent, platforms, cli, web packages

**Verification:**
Run: `tsc -p packages/shared --noEmit && tsc -p packages/core --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All existing tests still pass (optional parameter is backward compatible)

**Commit:** `feat(core): add changelog:written event emission from insertRow/updateRow/softDelete`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->

<!-- START_TASK_2 -->
### Task 2: Microtask coalescer utility

**Verifies:** None (infrastructure utility, tested in Task 4)

**Files:**
- Create: `packages/sync/src/ws-coalescer.ts`

**Implementation:**

Create a microtask coalescer that batches changelog entries within the same event loop tick:

```typescript
export class MicrotaskCoalescer<T> {
	private pending: T[] = [];
	private scheduled = false;

	constructor(private flush: (items: T[]) => void) {}

	add(item: T): void {
		this.pending.push(item);
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				const batch = this.pending;
				this.pending = [];
				this.scheduled = false;
				this.flush(batch);
			});
		}
	}

	get pendingCount(): number {
		return this.pending.length;
	}
}
```

When multiple changelog entries are written synchronously (e.g., during a burst of `insertRow()` calls in the same event loop tick), they accumulate in `pending`. The `queueMicrotask()` callback fires after all synchronous code completes, sending one batched `changelog_push` frame instead of N individual frames.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add MicrotaskCoalescer utility for batching WS frame sends`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: WsTransport — push-on-write and receive handlers for changelog

**Verifies:** ws-transport.AC2.2, ws-transport.AC6.2, ws-transport.AC6.5, ws-transport.AC6.6

**Files:**
- Create: `packages/sync/src/ws-transport.ts`

**Implementation:**

Create a `WsTransport` class that manages event-driven changelog replication:

```typescript
export interface WsTransportConfig {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger?: Logger;
}

export class WsTransport {
	private changelogCoalescer: MicrotaskCoalescer<ChangeLogEntry>;
	private peerConnections: Map<string, {
		sendFrame: (frame: Uint8Array) => boolean;
		symmetricKey: Uint8Array;
		peerSiteId: string;
	}> = new Map();

	constructor(private config: WsTransportConfig);

	/** Register a peer connection (called when WS connects) */
	addPeer(peerSiteId: string, sendFrame: (frame: Uint8Array) => boolean, symmetricKey: Uint8Array): void;

	/** Remove a peer connection (called when WS disconnects) */
	removePeer(peerSiteId: string): void;

	/** Start listening for changelog:written events */
	start(): void;

	/** Stop listening */
	stop(): void;

	/** Handle incoming changelog_push frame from a peer */
	handleChangelogPush(peerSiteId: string, payload: ChangelogPushPayload, symmetricKey: Uint8Array): void;

	/** Handle incoming changelog_ack frame from a peer */
	handleChangelogAck(peerSiteId: string, payload: ChangelogAckPayload): void;

	/** Drain changelog entries since last confirmed HLC for a peer (reconnection catch-up) */
	drainChangelog(peerSiteId: string): void;
}
```

**`start()` method:**
1. Listen on `eventBus` for `changelog:written` events.
2. On each event, query the full `ChangeLogEntry` from `change_log WHERE hlc = ?`.
3. Add to the `MicrotaskCoalescer`.
4. The coalescer's flush callback: for each registered peer, encode a `changelog_push` frame (via `encodeFrame()`) containing the batched entries, and call `sendFrame()`. Skip entries where `entry.site_id === peerSiteId` (echo suppression).
5. After sending, update `last_sent` cursor via `updatePeerCursor()`.

**`handleChangelogPush()` method:**
1. Receive `ChangelogPushPayload` containing `ChangeLogEntry[]`.
2. Call `replayEvents(db, entries)` — existing reducers handle LWW/append-only logic.
3. Update `last_received` cursor to the highest HLC in the batch via `updatePeerCursor()`.
4. Send `changelog_ack` frame back to the peer with the highest HLC.

**`handleChangelogAck()` method:**
1. Receive `ChangelogAckPayload` containing `{ cursor: string }` (the HLC the peer confirmed).
2. Update `last_sent` cursor for this peer via `updatePeerCursor()`.

**`drainChangelog()` method (reconnection catch-up):**
1. Get `last_sent` HLC for this peer via `getPeerCursor()`.
2. Query `change_log WHERE hlc > last_sent AND site_id != peerSiteId` (echo suppression).
3. Batch into chunks of 100 entries (respecting `max_payload_bytes`).
4. Send each chunk as a `changelog_push` frame.
5. Check `sendFrame()` return value for backpressure — if false, store a resume callback in the peer's `pendingDrain` to continue from the current cursor when drain fires.
6. After all chunks sent, send `drain_complete` frame.

AC6.5: `relay_outbox`/`relay_inbox` tables remain untouched — this task only handles changelog.
AC6.6: When the WS connection drops, `removePeer()` is called. New changelog entries continue to be written to the `change_log` table (the durable buffer). On reconnect, `drainChangelog()` catches up.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add WsTransport with push-on-write changelog replication and drain`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Changelog replication tests

**Verifies:** ws-transport.AC2.2, ws-transport.AC6.2, ws-transport.AC6.5, ws-transport.AC6.6

**Files:**
- Create: `packages/sync/src/__tests__/ws-transport.test.ts`

**Testing:**

Use the test harness for keypair/keyring/database setup. Some tests need real WS connections (hub + spoke via `Bun.serve()`), others can test the transport layer in isolation with mock `sendFrame` callbacks.

Test cases:

- **ws-transport.AC2.2 — Bidirectional replication within 100ms:** Create two `WsTransport` instances (hub + spoke) with real databases. Wire them together (hub's sendFrame delivers to spoke's handleChangelogPush, and vice versa). Write a row via `insertRow()` on the hub. Measure time from write to spoke seeing the entry in its DB. Verify < 100ms.

- **ws-transport.AC2.2 — Echo suppression:** Write an entry on hub, verify it replicates to spoke. Verify the spoke does NOT echo it back to hub (entries with `site_id === peerSiteId` are skipped).

- **ws-transport.AC2.2 — Microtask batching:** Write 10 entries in the same tick (synchronous loop of `insertRow()`). Verify only one `changelog_push` frame is sent (not 10), containing all 10 entries.

- **ws-transport.AC6.2 — Reconnect drain catches up:** Write 5 entries on hub while spoke is disconnected (no peer registered). Then call `drainChangelog()`. Verify all 5 entries are sent and replayed on spoke. Verify HLC cursors advance correctly.

- **ws-transport.AC6.5 — Relay tables untouched:** After changelog replication, verify `relay_outbox` and `relay_inbox` tables have no unexpected rows.

- **ws-transport.AC6.6 — Hub disconnection preserves data:** Write entries on spoke, disconnect (removePeer). Write more entries while disconnected. Verify they accumulate in `change_log`. Reconnect and drain. Verify all entries arrive at hub.

- **HLC cursor tracking:** After replication, verify `sync_state.last_received` and `last_sent` reflect the correct HLCs for each peer.

- **changelog_ack updates cursor:** Send a `changelog_push`, receive `changelog_ack`. Verify `last_sent` cursor advances on the sender.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-transport.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add changelog replication tests for push-on-write, drain, and echo suppression`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Wire WsTransport into WS server and client

**Verifies:** ws-transport.AC2.2 (end-to-end wiring)

**Files:**
- Modify: `packages/sync/src/ws-server.ts` — wire incoming frames to WsTransport handlers
- Modify: `packages/sync/src/ws-client.ts` — wire incoming frames to WsTransport handlers
- Modify: `packages/cli/src/commands/start/sync.ts` — create WsTransport and connect to WS server/client
- Modify: `packages/sync/src/index.ts` — export WsTransport, WsTransportConfig, MicrotaskCoalescer

**Implementation:**

1. In `ws-server.ts`, update the `message` handler in `createWsHandlers()`:
   - Decode the incoming binary frame via `decodeFrame(data, ws.data.symmetricKey)`.
   - If decode fails, log warning and continue (AC3.6 — discard, don't kill connection).
   - Dispatch based on frame type: `changelog_push` → `wsTransport.handleChangelogPush()`, `changelog_ack` → `wsTransport.handleChangelogAck()`, etc.
   - The `WsTransport` instance needs to be accessible from the WS handlers. Pass it via the `WsServerConfig`.

2. In `ws-server.ts`, on `open`: Call `wsTransport.addPeer()` with the peer's siteId, a `sendFrame` function that encodes + sends via `ws.send()`, and the symmetric key. Then call `wsTransport.drainChangelog()` to catch up. On `close`: Call `wsTransport.removePeer()`.

3. In `ws-client.ts`, set `WsSyncClient.onMessage` to decode frames and dispatch to `WsTransport` handlers (same pattern as server but from spoke perspective).

4. In `ws-client.ts`, set `WsSyncClient.onConnected` to call `wsTransport.addPeer()` and `wsTransport.drainChangelog()`. Set `onDisconnected` to call `wsTransport.removePeer()`.

5. In `packages/cli/src/commands/start/sync.ts`, create a `WsTransport` instance and pass it to both the WS server config and WS client. Pass `eventBus` to the outbox write functions so `changelog:written` events fire.

6. Export new types from `packages/sync/src/index.ts`.

**Verification:**
Run: `tsc -p packages/sync --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `feat(sync): wire WsTransport into WS server and client for end-to-end changelog replication`
<!-- END_TASK_5 -->
