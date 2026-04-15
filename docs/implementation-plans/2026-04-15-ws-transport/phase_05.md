# WebSocket Sync Transport Implementation Plan — Phase 5

**Goal:** Relay messages route through hub via WS instead of HTTP sync relay phase — tool calls, inference streaming, platform delivery, and broadcasts all flow as encrypted binary frames

**Architecture:** Extend `WsTransport` with relay send/receive/ack handlers. A push-on-write listener hooks into `writeOutbox()` calls and immediately sends `relay_send` frames. The hub-side relay router receives `relay_send` frames and applies the same routing logic as the existing HTTP `/sync/relay` handler: broadcast fan-out, hub-local dispatch, and spoke forwarding via `relay_deliver` frames. The spoke-side receive handler inserts into `relay_inbox` and emits the new `relay:inbox` event on `TypedEventEmitter`.

**Tech Stack:** TypeScript, existing relay CRUD from `@bound/core`, existing relay routing logic from `routes.ts`

**Scope:** Phase 5 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic
- **ws-transport.AC2.3 Success:** Relay messages (tool_call, inference, intake, platform_deliver, event_broadcast) route correctly through hub via WS
- **ws-transport.AC2.4 Success:** Broadcast relay (`target_site_id === "*"`) fans out to all connected spokes except source
- **ws-transport.AC2.5 Success:** Hub-local relay dispatches to RelayProcessor (request kinds) or relay_inbox (response kinds)

### ws-transport.AC4: NAT spokes fully supported
- **ws-transport.AC4.1 Success:** Spoke behind NAT (no `sync_url` in hosts table) connects to hub and receives relay messages at same latency as non-NAT spokes
- **ws-transport.AC4.2 Success:** Spoke without inbound-reachable IP receives inference stream_chunk frames over WS

### ws-transport.AC5: Inference streaming latency reduced
- **ws-transport.AC5.1 Success:** Inference stream_chunk frames arrive at spoke within 50ms of hub writing to relay_outbox (excluding network RTT)

---

## Reference Files

The executor should read these files for context:

- `packages/core/src/relay.ts` — `writeOutbox()`, `insertInbox()`, `readUndelivered()`, `markDelivered()`, `readUnprocessed()`, `markProcessed()` signatures
- `packages/shared/src/types.ts` — `RelayOutboxEntry`, `RelayInboxEntry`, `RelayKind`, `RELAY_KIND_REGISTRY`
- `packages/sync/src/routes.ts` lines 143-319 — existing HTTP relay routing logic (broadcast/hub-local/forward)
- `packages/agent/src/relay-processor.ts` — `RelayProcessor` class, `executeImmediate()` for sync dispatch
- `packages/shared/src/events.ts` — `EventMap` for adding `relay:inbox` event
- `packages/sync/src/ws-transport.ts` — existing WsTransport from Phase 4 (to extend)
- `packages/sync/src/ws-frames.ts` — frame codec (relay_send, relay_deliver, relay_ack types)
- `CLAUDE.md` — relay response routing invariant (response kinds go to relay_inbox, NOT executeImmediate)

---

<!-- START_TASK_1 -->
### Task 1: Add `relay:inbox` event to TypedEventEmitter

**Verifies:** None (infrastructure for Phase 6 agent loop integration)

**Files:**
- Modify: `packages/shared/src/events.ts` — add `relay:inbox` event to EventMap

**Implementation:**

Add to the EventMap in `packages/shared/src/events.ts`:

```typescript
"relay:inbox": { ref_id?: string; stream_id?: string; kind: RelayKind }
```

This event is emitted when a relay entry arrives in the inbox via WS (Phase 5) and consumed by the agent loop in Phase 6 to replace 500ms polling.

**Verification:**
Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add relay:inbox event to TypedEventEmitter EventMap`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-4) -->

<!-- START_TASK_2 -->
### Task 2: Relay send listener — push-on-write for outbox

**Verifies:** ws-transport.AC2.3 (partial — sending side)

**Files:**
- Modify: `packages/sync/src/ws-transport.ts` — add relay send handlers
- Modify: `packages/shared/src/events.ts` — add `relay:outbox-written` event to EventMap (if needed)

**Implementation:**

Extend `WsTransport` with relay outbox push-on-write:

1. Add a new event to EventMap: `"relay:outbox-written": { id: string; target_site_id: string }` — emitted after `writeOutbox()` calls (analogous to `changelog:written` for changelog entries).

2. In `WsTransport.start()`, listen for `relay:outbox-written` events. On each event:
   - Read the outbox entry from DB by ID.
   - Encode as a `relay_send` frame (message type `0x03`).
   - Send to the appropriate peer:
     - If hub connection exists (spoke mode): send to hub.
     - If spoke connections exist (hub mode): this is handled in the relay router (Task 3).

3. Add `writeOutbox()` event emission: Modify the relay outbox write path so that after `writeOutbox()` completes, it emits `relay:outbox-written`. This requires either:
   - Adding an optional `eventBus` parameter to `writeOutbox()` in `packages/core/src/relay.ts` (same pattern as Phase 4's changelog event).
   - Or emitting from the caller after `writeOutbox()`.
   
   Use the same approach as Phase 4 (optional eventBus parameter) for consistency.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add relay send listener with push-on-write for outbox entries`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Hub-side relay router over WS

**Verifies:** ws-transport.AC2.3, ws-transport.AC2.4, ws-transport.AC2.5, ws-transport.AC5.1

**Files:**
- Modify: `packages/sync/src/ws-transport.ts` — add `handleRelaySend()` method for hub-side routing

**Implementation:**

Add a `handleRelaySend()` method to `WsTransport` that processes incoming `relay_send` frames from spokes. This implements the same routing logic as the existing HTTP `/sync/relay` handler in `routes.ts` lines 159-270:

```typescript
handleRelaySend(
	sourceSiteId: string,
	entries: RelayOutboxEntry[],
	relayExecutor?: RelayExecutor,
): void
```

For each entry:

1. **Idempotency check:** If `idempotency_key` matches an existing entry, mark as delivered, skip.

2. **Broadcast** (`target_site_id === "*"`):
   - For each connected spoke (via `WsConnectionManager`) except the source:
     - Convert entry to `RelayInboxEntry`
     - Encode as `relay_deliver` frame (message type `0x04`)
     - Send via the peer's WS connection
   - Also insert into hub's own `relay_inbox` if hub processes broadcasts locally.

3. **Hub-local** (`target_site_id === hubSiteId`):
   - **Request kinds** (tool_call, inference, process, intake, etc.): Insert into `relay_inbox` for `RelayProcessor` to pick up. (Note: sync dispatch kinds could potentially be executed inline, but for simplicity and consistency, route everything through inbox.)
   - **Response kinds** (result, error, stream_chunk, stream_end, status_forward): Insert into `relay_inbox`. CRITICAL: response kinds must go to relay_inbox, NOT executeImmediate (per CLAUDE.md invariant).
   - Emit `relay:inbox` event after insertion.

4. **Forward to another spoke** (`target_site_id` is a different spoke):
   - If target spoke is connected: encode as `relay_deliver` frame, send directly via WS.
   - If target spoke is NOT connected: write to hub's `relay_outbox` with `delivered = 0`. The entry will be delivered when the spoke reconnects and drains.

5. After processing all entries, send `relay_ack` frame (message type `0x05`) back to the source spoke with the IDs of processed entries.

AC5.1: For inference stream_chunk entries, the frame is sent immediately upon receipt — no polling delay. The only latency is WS frame encoding + network RTT.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add hub-side relay router over WS with broadcast, hub-local, and forwarding`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Relay delivery and routing tests

**Verifies:** ws-transport.AC2.3, ws-transport.AC2.4, ws-transport.AC2.5, ws-transport.AC5.1

**Files:**
- Modify: `packages/sync/src/__tests__/ws-transport.test.ts` — add relay routing tests

**Testing:**

Extend the existing `ws-transport.test.ts` with relay-specific tests. Use the test harness for multi-instance setup with real databases.

Test cases:

- **ws-transport.AC2.3 — Unicast relay routing:** Spoke A sends a `relay_send` frame targeting Spoke B. Hub receives, routes to Spoke B via `relay_deliver`. Verify Spoke B's `relay_inbox` has the entry and `relay:inbox` event fires.

- **ws-transport.AC2.4 — Broadcast fan-out:** Spoke A sends a broadcast (`target_site_id === "*"`). Hub fans out to Spoke B and Spoke C (but NOT back to Spoke A). Verify both Spoke B and C receive the entry.

- **ws-transport.AC2.5 — Hub-local request dispatch:** Spoke sends a `tool_call` targeting the hub. Verify it appears in hub's `relay_inbox` for RelayProcessor. Verify `relay:inbox` event emitted on hub.

- **ws-transport.AC2.5 — Hub-local response routing:** Spoke sends a `result` (response kind) targeting the hub. Verify it's inserted into `relay_inbox` (NOT dispatched through executeImmediate).

- **ws-transport.AC5.1 — Stream chunk latency:** Hub writes a `stream_chunk` outbox entry targeting a spoke. Measure time from write to spoke's `relay:inbox` event. Verify < 50ms (excluding network RTT — in test they're on localhost).

- **Relay ack confirms delivery:** After hub routes entries, verify `relay_ack` frame is sent back to source. Verify source marks outbox entries as delivered.

- **Offline spoke — entries accumulate:** Spoke B is disconnected. Spoke A sends a relay targeting B. Verify entry stays in hub's outbox with `delivered = 0`. When B reconnects and drains, verify it receives the entry.

- **Idempotency dedup:** Send same relay entry twice (same idempotency_key). Verify only processed once.

- **ws-transport.AC4.1 — NAT spoke receives relay at same latency:** Create a spoke with NO `sync_url` in the hosts table (simulating NAT — hub cannot reach spoke via HTTP). Spoke connects to hub via WS (outbound connection). Send a relay message targeting this spoke. Verify the spoke receives it via WS at the same latency as a spoke with `sync_url`. This proves NAT spokes are fully supported since they initiate the connection.

- **ws-transport.AC4.2 — NAT spoke receives inference chunks:** Same NAT spoke setup (no `sync_url`). Hub writes `stream_chunk` outbox entries targeting this spoke. Verify the spoke receives them over WS via `relay:inbox` events. This proves inference streaming works for NAT spokes.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-transport.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add relay routing tests for broadcast, hub-local, forwarding, and ack`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_5 -->
### Task 5: Spoke-side relay receive handler and drain

**Verifies:** ws-transport.AC2.3

**Files:**
- Modify: `packages/sync/src/ws-transport.ts` — add `handleRelayDeliver()` and relay drain logic

**Implementation:**

Add spoke-side relay handling to `WsTransport`:

**`handleRelayDeliver(entries: RelayInboxEntry[])`:**
1. For each entry, call `insertInbox(db, entry)` — idempotent via `INSERT OR IGNORE`.
2. If insertion succeeded (not a duplicate), emit `relay:inbox` event with `{ ref_id: entry.ref_id, stream_id: entry.stream_id, kind: entry.kind }`.
3. Send `relay_ack` frame back to hub with the IDs of received entries.

**`handleRelayAck(entryIds: string[])`:**
1. Call `markDelivered(db, entryIds)` to mark outbox entries as delivered.

**Relay drain on reconnection:**
Extend `drainChangelog()` (or create a new `drainRelay()` method) to also drain undelivered relay outbox entries:
1. Query `readUndelivered(db)` — entries with `delivered = 0`.
2. Send as `relay_send` frames.
3. Respect backpressure (same pattern as changelog drain).

**Hub-side relay drain:**
When a spoke reconnects, the hub should also drain undelivered relay entries targeting that spoke:
1. Query `readUndelivered(db, spokesSiteId)` — entries targeting the reconnected spoke.
2. Send as `relay_deliver` frames.
3. Mark delivered after send.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

Run: `bun test packages/sync/src/__tests__/ws-transport.test.ts`
Expected: All tests pass

**Commit:** `feat(sync): add spoke-side relay receive handler and bidirectional relay drain`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Wire relay handlers into WS message dispatch

**Verifies:** ws-transport.AC2.3, ws-transport.AC2.4, ws-transport.AC2.5

**Files:**
- Modify: `packages/sync/src/ws-server.ts` — add relay frame dispatch in message handler
- Modify: `packages/sync/src/ws-client.ts` — add relay frame dispatch in onMessage

**Implementation:**

In `ws-server.ts` `createWsHandlers()` message handler, add dispatch for relay frame types:
- `relay_send` (0x03): Call `wsTransport.handleRelaySend(ws.data.siteId, entries, relayExecutor)`
- `relay_deliver` (0x04): Should not arrive at hub from spoke (hub sends deliver, not receives it). Log warning.
- `relay_ack` (0x05): Call `wsTransport.handleRelayAck(entryIds)`

In `ws-client.ts` onMessage handler, add dispatch for relay frame types:
- `relay_deliver` (0x04): Call `wsTransport.handleRelayDeliver(entries)`
- `relay_ack` (0x05): Call `wsTransport.handleRelayAck(entryIds)`
- `relay_send` (0x03): Should not arrive at spoke (spoke sends, not receives). Log warning.

In `ws-server.ts` and `ws-client.ts`, also dispatch drain frames:
- `drain_request` (0x06): Trigger drain for the requesting peer
- `drain_complete` (0x07): Log completion, no action needed

**Verification:**
Run: `tsc -p packages/sync --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All tests pass

**Commit:** `feat(sync): wire relay frame dispatch into WS server and client message handlers`
<!-- END_TASK_6 -->
