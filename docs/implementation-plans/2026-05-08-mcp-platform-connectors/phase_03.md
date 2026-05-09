# MCP Platform Connectors Implementation Plan — Phase 3

**Goal:** Build the connector handle lifecycle infrastructure that manages active event subscriptions and delivers events to tasks transparently across push/poll delivery modes.

**Architecture:** Extend `PlatformMcpRegistry` with subscription management (stream listeners + poll timers), event batching/buffering, batch delivery (persist as developer-role messages in event task threads via outbox, fire event triggers), cursor advancement, and reconnection from `connector_handles` table on failover.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk (Client notifications), bun:sqlite, TypedEventEmitter

**Scope:** 7 phases from original design (phase 3 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC1: Platform events arrive as MCP Events and persist correctly
- **mcp-platform-connectors.AC1.2 Success:** Event persisted as `role: "developer"` message in the correct event task thread via outbox
- **mcp-platform-connectors.AC1.3 Success:** Duplicate event (same eventId) is not persisted twice

### mcp-platform-connectors.AC5: Delivery mode transparency
- **mcp-platform-connectors.AC5.1 Success:** Push-mode subscription receives events via `notifications/events/event` and delivers batch to task
- **mcp-platform-connectors.AC5.2 Success:** Poll-mode handle's timer calls `events/poll` at server-specified interval
- **mcp-platform-connectors.AC5.3 Success:** Poll with no new events produces no inference cost (no task wake)
- **mcp-platform-connectors.AC5.4 Success:** Both modes produce identical developer-role messages from event task's perspective
- **mcp-platform-connectors.AC5.5 Success:** Cursor persisted after each successful batch delivery

### mcp-platform-connectors.AC6: Leader election and failover (partial)
- **mcp-platform-connectors.AC6.3 Success:** On failover, new leader reconstitutes subscriptions from connector_handles table with correct cursors
- **mcp-platform-connectors.AC6.4 Success:** Replayed events after failover resume from stored cursor (no duplicates if upstream supports replay)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Add `connector:event` event type to EventMap

**Files:**
- Modify: `packages/shared/src/events.ts` (add new event type to EventMap)

**Implementation:**

Add a new event type that the connector handle infrastructure will emit when event batches are delivered to task threads. This is what wakes event-driven tasks:

```typescript
// Add to EventMap interface:
"connector:event": { trigger_key: string; task_id: string; handle_id: string; batch_size: number };
```

This event fires AFTER the developer-role message is persisted. The `trigger_key` field carries the per-handle event trigger (e.g., `connector:event:{handleId}`) which is passed to `scheduler.onEvent(triggerKey, payload)`. Each event task has a unique `trigger_spec` matching its handle, so only the target task wakes — NOT all event tasks.

The startup wiring calls `scheduler.onEvent(payload.trigger_key, payload)` on receiving this event, ensuring exact-match routing to the correct task.

Also add `"connector:list_changed"` for the dispatcher wake:
```typescript
"connector:list_changed": { server_name: string };
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(shared): add connector:event and connector:list_changed to EventMap`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement push-mode stream subscription manager

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Add stream subscription management to `PlatformMcpRegistry`. When a connector handle is activated in push mode:

1. The registry calls `events/stream` on the MCP client with the handle's `(event_name, event_args, cursor)`
2. Registers a notification handler for `notifications/events/event` on that client
3. Incoming events are buffered per-handle
4. When buffer reaches threshold (size >= 1, or flush timer fires at 2s), deliver the batch

Subscription state per handle:
```typescript
interface ActiveSubscription {
  handleId: string;
  serverName: string;
  taskId: string;
  threadId: string; // resolved from task → thread
  buffer: McpEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  deduplicationSet: Set<string>; // recent eventIds for AC1.3
}
```

Push-mode notification handler:
- On `notifications/events/event`: append to buffer, set flush timer if not set
- Flush: persist batch as developer-role message, fire `connector:event`, advance cursor

The flush logic calls `deliverBatch()` (shared between push and poll modes — implemented in Task 3).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement push-mode stream subscription in registry`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement batch delivery (shared between modes)

**Verifies:** mcp-platform-connectors.AC1.2, mcp-platform-connectors.AC1.3, mcp-platform-connectors.AC5.4, mcp-platform-connectors.AC5.5

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Create the `deliverBatch()` method that both push and poll modes call:

```typescript
private deliverBatch(subscription: ActiveSubscription, events: McpEvent[]): void {
  // 1. Deduplicate: skip events whose eventId is in deduplicationSet (AC1.3)
  const newEvents = events.filter(e => !subscription.deduplicationSet.has(e.eventId));
  if (newEvents.length === 0) return; // No-op if all duplicates

  // 2. Track eventIds for future dedup (prune set at 500 entries)
  for (const e of newEvents) subscription.deduplicationSet.add(e.eventId);

  // 3. Format batch content (opaque to bound — format determined by MCP server)
  const batchContent = JSON.stringify(newEvents.map(e => e.data));

  // 4. Persist as developer-role message in the event task's thread (AC1.2)
  const now = new Date().toISOString();
  insertRow(this.deps.db, "messages", {
    id: randomUUID(),
    thread_id: subscription.threadId,
    role: "developer",
    content: batchContent,
    model_id: null,
    tool_name: null,
    created_at: now,
    modified_at: now,
    host_origin: this.deps.siteId,
    deleted: 0,
    exit_code: null,
    metadata: null,
  }, this.deps.siteId);

  // 5. Update cursor on connector handle (AC5.5)
  const lastCursor = newEvents[newEvents.length - 1].cursor;
  updateConnectorHandleCursor(this.deps.db, this.deps.siteId, subscription.handleId, lastCursor);

  // 6. Fire event trigger to wake the SPECIFIC task (AFTER commit per invariant #6)
  // Use per-handle trigger key so only the target task wakes (not all event tasks)
  const triggerKey = `connector:event:${subscription.handleId}`;
  this.deps.eventBus.emit("connector:event", {
    trigger_key: triggerKey,
    task_id: subscription.taskId,
    handle_id: subscription.handleId,
    batch_size: newEvents.length,
  });
  // The scheduler.onEvent(triggerKey, payload) matches against task.trigger_spec exactly
}
```

Both push and poll modes call this same method, ensuring identical developer-role messages (AC5.4).

**Transaction note:** `insertRow()` and `updateRow()` each wrap their own writes in `BEGIN IMMEDIATE` transactions internally (per `@bound/core` pattern). The event bus emit MUST happen AFTER both calls complete (invariant #6). If cursor update fails after message insert, the message exists but cursor is stale — on reconnection, the event will be re-delivered but the deduplication set catches it (AC1.3). This is acceptable eventual consistency.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement shared batch delivery for connector handles`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Implement poll-mode driver

**Verifies:** mcp-platform-connectors.AC5.2, mcp-platform-connectors.AC5.3

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Add poll-mode subscription management. When a connector handle is activated in poll mode:

1. Start a timer that fires at the `nextPollSeconds` interval (from server's `events/poll` response)
2. On timer fire: call `events/poll` on the MCP client with `{ event, params, cursor }`
3. If response has events: call `deliverBatch()` (same as push mode)
4. If response has no events: do nothing (AC5.3 — no inference cost)
5. Reschedule timer with updated `nextPollSeconds`

```typescript
private startPollTimer(subscription: ActiveSubscription, pollSeconds: number): void {
  const timer = setTimeout(async () => {
    try {
      const handle = getConnectorHandle(this.deps.db, subscription.handleId);
      if (!handle || handle.deleted) return; // handle was deleted

      const client = this.getClient(subscription.serverName);
      if (!client) return; // server disconnected

      const result = await client.request(
        { method: "events/poll", params: { event: handle.event_name, params: JSON.parse(handle.event_args), cursor: handle.cursor } },
        EventsPollResultSchema,
      );

      if (result.events.length > 0) {
        this.deliverBatch(subscription, result.events);
      }
      // AC5.3: empty response = no-op (no deliverBatch, no task wake)

      // Reschedule with server-specified interval
      this.startPollTimer(subscription, result.nextPollSeconds ?? pollSeconds);
    } catch (err) {
      this.deps.logger.error(`Poll failed for handle ${subscription.handleId}: ${err}`);
      // Retry after double the interval (exponential backoff capped at 60s)
      this.startPollTimer(subscription, Math.min(pollSeconds * 2, 60));
    }
  }, pollSeconds * 1000);

  // Store timer reference for cleanup
  this.pollTimers.set(subscription.handleId, timer);
}
```

Timer cleanup: `stopSubscription(handleId)` clears both flush timers and poll timers.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement poll-mode driver for connector handles`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Implement subscription activation and reconnection

**Verifies:** mcp-platform-connectors.AC6.3, mcp-platform-connectors.AC6.4

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts`

**Implementation:**

Add methods to activate subscriptions (from connector handle records) and reconstitute them after failover:

```typescript
/**
 * Activates a subscription for an existing connector handle.
 * Used both for new handles and for reconnection after failover.
 */
async activateSubscription(handle: ConnectorHandleRecord): Promise<void> {
  const task = this.deps.db.query("SELECT thread_id FROM tasks WHERE id = ?").get(handle.task_id) as { thread_id: string } | null;
  if (!task) {
    this.deps.logger.warn(`Cannot activate handle ${handle.id}: task ${handle.task_id} not found`);
    return;
  }

  const subscription: ActiveSubscription = {
    handleId: handle.id,
    serverName: handle.server_name,
    taskId: handle.task_id!,
    threadId: task.thread_id,
    buffer: [],
    flushTimer: null,
    deduplicationSet: new Set(),
  };

  this.activeSubscriptions.set(handle.id, subscription);

  if (handle.delivery_mode === "push") {
    await this.startStreamSubscription(subscription, handle);
  } else {
    this.startPollTimer(subscription, 2); // Initial 2s interval
  }
}

/**
 * Reconstitutes all active subscriptions from the database.
 * Called on leader election / failover (AC6.3).
 * Resumes from stored cursors (AC6.4).
 */
async reconnectAll(): Promise<void> {
  const handles = getAllActiveConnectorHandles(this.deps.db);
  this.deps.logger.info(`Reconnecting ${handles.length} connector handles`);
  for (const handle of handles) {
    if (!handle.task_id) continue; // orphan handle, skip
    await this.activateSubscription(handle);
  }
}
```

The `startStreamSubscription` method sends `events/stream` with the handle's stored cursor, enabling replay of events missed during downtime (AC6.4).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement subscription activation and failover reconnection`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Integration tests for connector handle lifecycle

**Verifies:** mcp-platform-connectors.AC1.2, mcp-platform-connectors.AC1.3, mcp-platform-connectors.AC5.1, mcp-platform-connectors.AC5.2, mcp-platform-connectors.AC5.3, mcp-platform-connectors.AC5.4, mcp-platform-connectors.AC5.5, mcp-platform-connectors.AC6.3, mcp-platform-connectors.AC6.4

**Files:**
- Create: `packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts`

**Testing:**

Tests use a real SQLite database, real InMemoryTransport, and a minimal MCP server stub that emits events on demand. Verify:

- **AC1.2**: Activate push subscription → emit event from server → verify developer-role message persisted in correct thread with expected content
- **AC1.3**: Emit event with same eventId twice → verify only one developer-role message persisted
- **AC5.1**: Push-mode: emit event notification → verify deliverBatch fires and message appears in thread
- **AC5.2**: Poll-mode: advance time past poll interval → verify client calls events/poll
- **AC5.3**: Poll returns empty events → verify no message inserted, no connector:event emitted
- **AC5.4**: Emit same event via push and poll (separate handles) → verify identical developer-role message content
- **AC5.5**: After batch delivery → verify connector_handles.cursor updated in DB
- **AC6.3**: Create handles in DB → call reconnectAll() → verify subscriptions activated with correct cursor
- **AC6.4**: Store cursor "5" in handle → reconnect → emit events 3,4,5,6,7 → verify only 6,7 delivered (replay from cursor)

Test setup:
- Temp DB with schema applied
- Minimal MCP server with programmatic event emission
- InMemoryTransport pair connecting client/server
- PlatformMcpRegistry instance with test deps

**Verification:**
Run: `bun test packages/platforms/src/__tests__/connector-handle-lifecycle.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add connector handle lifecycle integration tests`
<!-- END_TASK_6 -->
