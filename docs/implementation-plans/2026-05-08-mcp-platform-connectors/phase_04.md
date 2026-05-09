# MCP Platform Connectors Implementation Plan — Phase 4

**Goal:** Create the dispatcher task — an agent-driven system task that discovers new platform conversations and creates connector handles + event tasks for them.

**Architecture:** Seed a deterministic dispatcher task (follows `seedHeartbeat` pattern) with `type: "event"` triggered by `connector:list_changed`. Implement three dispatcher-specific tools (`connector_list`, `connector_channels`, `connector_attach`) that let the agent discover and bind new platform conversations. The dispatcher also receives all platform MCP tools for introspection.

**Tech Stack:** TypeScript, bun:sqlite, deterministicUUID, RegisteredTool interface

**Scope:** 7 phases from original design (phase 4 of 7)

**Codebase verified:** 2026-05-08

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-platform-connectors.AC4: Dispatcher discovers and binds new conversations
- **mcp-platform-connectors.AC4.1 Success:** Dispatcher wakes on `notifications/events/list_changed` from MCP server
- **mcp-platform-connectors.AC4.2 Success:** `connector_channels` returns available event types with existing binding annotations
- **mcp-platform-connectors.AC4.3 Success:** `connector_attach` creates connector handle + event task + thread with history retention
- **mcp-platform-connectors.AC4.4 Failure:** `connector_attach` for already-bound (server, event, args) tuple returns error
- **mcp-platform-connectors.AC4.5 Success:** Newly attached subscription replays buffered events via cursor
- **mcp-platform-connectors.AC4.6 Success:** Periodic cron fallback wakes dispatcher even without list_changed

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create dispatcher task seeding function

**Files:**
- Create: `packages/platforms/src/dispatcher.ts`

**Implementation:**

Follow the `seedHeartbeat()` pattern from `packages/agent/src/task-resolution.ts`. Create a `seedDispatcher()` function that idempotently creates the dispatcher task:

```typescript
import { type Database } from "bun:sqlite";
import { insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export const DISPATCHER_TASK_ID = deterministicUUID(BOUND_NAMESPACE, "platform-dispatcher");

/**
 * Seeds the platform dispatcher task. Idempotent — safe to call on every startup.
 * The dispatcher wakes on "connector:list_changed" events and periodic cron fallback.
 */
export function seedDispatcher(db: Database, siteId: string): void {
  const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(DISPATCHER_TASK_ID) as { id: string } | null;
  if (existing) return;

  const now = new Date().toISOString();
  insertRow(db, "tasks", {
    id: DISPATCHER_TASK_ID,
    type: "event",
    status: "pending",
    trigger_spec: "connector:list_changed",
    payload: null,
    created_at: now,
    created_by: "system",
    thread_id: null, // thread created on first execution
    origin_thread_id: null,
    claimed_by: null,
    claimed_at: null,
    lease_id: null,
    next_run_at: now, // immediately available for first cron fallback
    last_run_at: null,
    run_count: 0,
    max_runs: null,
    requires: null,
    model_hint: null,
    no_history: 0, // keep history so dispatcher remembers past bindings
    inject_mode: "results",
    depends_on: null,
    require_success: 0,
    alert_threshold: 5,
    consecutive_failures: 0,
    event_depth: 0,
    no_quiescence: 0,
    heartbeat_at: null,
    result: null,
    error: null,
    modified_at: now,
    deleted: 0,
  }, siteId);
}
```

The dispatcher uses `type: "event"` with `trigger_spec: "connector:list_changed"`. The scheduler's `onEvent()` method matches event tasks by comparing `trigger_spec` to the event type string.

**Re-triggering pattern:** After the dispatcher executes, the scheduler marks it as `status: "completed"`. To make it re-triggerable on the next `connector:list_changed` event, the event task handler must reset the status back to `"pending"` after successful execution. This follows the same pattern as heartbeat tasks which call `rescheduleCronTask()` — event tasks need an equivalent `resetEventTask()` that sets `status = "pending"` via `updateRow()`. The periodic cron fallback (AC4.6) also serves as a re-trigger mechanism by setting `next_run_at` to 5 minutes in the future after each execution.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): add dispatcher task seeding`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire dispatcher event trigger to scheduler

**Verifies:** mcp-platform-connectors.AC4.1, mcp-platform-connectors.AC4.6

**Files:**
- Modify: `packages/platforms/src/mcp-registry.ts` (emit connector:list_changed when MCP server emits notifications/events/list_changed)
- Modify: startup wiring (register scheduler.onEvent for connector:list_changed)

**Implementation:**

In `PlatformMcpRegistry`, when the MCP client receives `notifications/events/list_changed` from a server, translate it to the internal event bus:

```typescript
// In registerServer(), after client connects:
client.setNotificationHandler(
  { method: "notifications/events/list_changed" },
  async () => {
    this.deps.eventBus.emit("connector:list_changed", { server_name: name });
  }
);
```

For the cron fallback (AC4.6), the dispatcher task should also have a periodic wake. Since the task system supports `next_run_at` for cron-like behavior, add a fallback check that re-triggers the dispatcher every 5 minutes if it hasn't been triggered by events:

In the startup wiring, register the event bus listeners so the scheduler can wake tasks:
```typescript
eventBus.on("connector:list_changed", (payload) => {
  scheduler.onEvent("connector:list_changed", payload);
});
eventBus.on("connector:event", (payload) => {
  // Route to specific event task using per-handle trigger key
  scheduler.onEvent(payload.trigger_key, payload);
});
```

For periodic fallback, use the scheduler's tick loop to check if the dispatcher task should be re-triggered periodically (set `next_run_at` to 5 min in the future after each execution completes).

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): wire list_changed notification to scheduler event trigger`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Implement `connector_list` dispatcher tool

**Verifies:** (supports AC4.2 — provides server discovery)

**Files:**
- Create: `packages/platforms/src/dispatcher-tools.ts`

**Implementation:**

Create the first dispatcher tool — `connector_list` returns names of all connected platform MCP servers:

```typescript
import type { RegisteredTool } from "@bound/agent";
import type { PlatformMcpRegistry } from "./mcp-registry.js";

export interface DispatcherToolContext {
  registry: PlatformMcpRegistry;
  db: Database;
  siteId: string;
}

export function createConnectorListTool(ctx: DispatcherToolContext): RegisteredTool {
  return {
    kind: "builtin",
    toolDefinition: {
      type: "function",
      function: {
        name: "connector_list",
        description: "List all connected platform MCP servers.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const servers = ctx.registry.getServerNames();
      return servers.length > 0
        ? `Connected platform servers: ${servers.join(", ")}`
        : "No platform servers connected.";
    },
  };
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement connector_list dispatcher tool`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement `connector_channels` dispatcher tool

**Verifies:** mcp-platform-connectors.AC4.2

**Files:**
- Modify: `packages/platforms/src/dispatcher-tools.ts`

**Implementation:**

`connector_channels` calls `events/list` on the named server and annotates results with existing binding state:

```typescript
export function createConnectorChannelsTool(ctx: DispatcherToolContext): RegisteredTool {
  return {
    kind: "builtin",
    toolDefinition: {
      type: "function",
      function: {
        name: "connector_channels",
        description: "List available event channels from a platform server, annotated with binding status.",
        parameters: {
          type: "object",
          properties: {
            server_name: { type: "string", description: "Name of the platform server to query" },
          },
          required: ["server_name"],
        },
      },
    },
    execute: async (input) => {
      const serverName = input.server_name as string;
      const client = ctx.registry.getClient(serverName);
      if (!client) return `Error: server '${serverName}' not found`;

      // Call events/list on the MCP server
      const result = await client.request(
        { method: "events/list", params: {} },
        EventsListResultSchema,
      );

      // Annotate with existing bindings
      const existingHandles = getConnectorHandlesByServer(ctx.db, serverName);
      const boundKeys = new Set(existingHandles.map(h => `${h.event_name}:${h.event_args}`));

      const annotated = result.events.map(evt => ({
        ...evt,
        bound: boundKeys.has(`${evt.name}:${JSON.stringify(evt.params ?? {})}`),
      }));

      return JSON.stringify(annotated, null, 2);
    },
  };
}
```

The response lets the agent see which event streams are already bound (have connector handles) and which are new and available for attachment.

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement connector_channels dispatcher tool`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Implement `connector_attach` dispatcher tool

**Verifies:** mcp-platform-connectors.AC4.3, mcp-platform-connectors.AC4.4, mcp-platform-connectors.AC4.5

**Files:**
- Modify: `packages/platforms/src/dispatcher-tools.ts`

**Implementation:**

`connector_attach` creates a connector handle + event task + thread and starts the subscription:

```typescript
export function createConnectorAttachTool(ctx: DispatcherToolContext): RegisteredTool {
  return {
    kind: "builtin",
    toolDefinition: {
      type: "function",
      function: {
        name: "connector_attach",
        description: "Bind to a platform event stream, creating a connector handle, event task, and thread.",
        parameters: {
          type: "object",
          properties: {
            server_name: { type: "string", description: "Platform server name" },
            event_name: { type: "string", description: "Event type to subscribe to (e.g., 'message.received')" },
            event_args: { type: "object", description: "Subscription filter parameters (e.g., { channel_id: '123' })" },
          },
          required: ["server_name", "event_name", "event_args"],
        },
      },
    },
    execute: async (input) => {
      const serverName = input.server_name as string;
      const eventName = input.event_name as string;
      const eventArgs = (input.event_args ?? {}) as Record<string, unknown>;

      // Check if handle already exists (AC4.4)
      const handleId = connectorHandleId(serverName, eventName, eventArgs);
      const existing = getConnectorHandle(ctx.db, handleId);
      if (existing) {
        return `Error: subscription already exists for (${serverName}, ${eventName}, ${JSON.stringify(eventArgs)}). Handle ID: ${handleId}`;
      }

      // 1. Create thread for the event task (history retention enabled)
      const threadId = randomUUID();
      const now = new Date().toISOString();
      insertRow(ctx.db, "threads", {
        id: threadId,
        user_id: null,
        interface: "platform",
        host_origin: ctx.siteId,
        color: 0,
        title: `${serverName}:${eventName}`,
        summary: null,
        summary_through: null,
        summary_model_id: null,
        extracted_through: null,
        created_at: now,
        last_message_at: now,
        modified_at: now,
        deleted: 0,
        model_hint: null,
      }, ctx.siteId);

      // 2. Create event task linked to thread
      // Use per-handle trigger_spec so only THIS task wakes when THIS handle delivers
      const taskId = randomUUID();
      insertRow(ctx.db, "tasks", {
        id: taskId,
        type: "event",
        status: "pending",
        trigger_spec: `connector:event:${handleId}`,
        payload: JSON.stringify({ handle_id: handleId, server_name: serverName }),
        created_at: now,
        created_by: "system",
        thread_id: threadId,
        origin_thread_id: null,
        claimed_by: null,
        claimed_at: null,
        lease_id: null,
        next_run_at: null,
        last_run_at: null,
        run_count: 0,
        max_runs: null,
        requires: null,
        model_hint: null,
        no_history: 0, // retain conversation history
        inject_mode: "results",
        depends_on: null,
        require_success: 0,
        alert_threshold: 5,
        consecutive_failures: 0,
        event_depth: 0,
        no_quiescence: 0,
        heartbeat_at: null,
        result: null,
        error: null,
        modified_at: now,
        deleted: 0,
      }, ctx.siteId);

      // 3. Create connector handle with task link
      createConnectorHandle(ctx.db, ctx.siteId, {
        serverName,
        eventName,
        eventArgs,
        deliveryMode: "push", // default to push mode
        taskId,
      });

      // 4. Activate the subscription (starts stream, replays from cursor) (AC4.5)
      const handle = getConnectorHandle(ctx.db, handleId)!;
      await ctx.registry.activateSubscription(handle);

      return `Attached: created handle ${handleId}, task ${taskId}, thread ${threadId} for ${serverName}:${eventName}`;
    },
  };
}
```

**Verification:**
Run: `bun run typecheck`
Expected: Clean typecheck.

**Commit:** `feat(platforms): implement connector_attach dispatcher tool`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Integration tests for dispatcher tools

**Verifies:** mcp-platform-connectors.AC4.1, mcp-platform-connectors.AC4.2, mcp-platform-connectors.AC4.3, mcp-platform-connectors.AC4.4, mcp-platform-connectors.AC4.5, mcp-platform-connectors.AC4.6

**Files:**
- Create: `packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts`

**Testing:**

Tests use a real temp SQLite database, a minimal MCP server stub (with programmatic event list), and InMemoryTransport.

- **AC4.1**: Register eventBus listener for connector:list_changed → emit notifications/events/list_changed from MCP server → verify event bus fires and dispatcher task matches
- **AC4.2**: Register server with 3 event channels, bind 1 → call connector_channels → verify 3 returned with 1 annotated as bound
- **AC4.3**: Call connector_attach → verify connector_handles row created, tasks row created with type="event" and trigger_spec="connector:event", threads row created with interface="platform"
- **AC4.4**: Call connector_attach for same (server, event, args) twice → verify second call returns error string
- **AC4.5**: Emit events before attach → call connector_attach → verify subscription activates with replay from cursor (buffered events delivered)
- **AC4.6**: Set dispatcher task next_run_at to past → verify scheduler tick processes it (periodic fallback wakes dispatcher)

Test setup:
- Temp DB with schema applied
- PlatformMcpRegistry with test stub server
- Dispatcher tools created with test context
- Verify DB state after each tool execution

**Verification:**
Run: `bun test packages/platforms/src/__tests__/dispatcher-tools.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(platforms): add dispatcher tools integration tests`
<!-- END_TASK_6 -->
