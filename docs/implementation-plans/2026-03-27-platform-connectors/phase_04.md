# Platform Connectors Implementation Plan — Phase 4: `emit` Broadcast + Webhook Route

**Goal:** Wire the `emit` command to broadcast events cluster-wide via `event_broadcast` relay, and add a generic `POST /hooks/:platform` webhook ingress on the web server.

**Architecture:** Two components. (1) `packages/agent/src/commands/emit.ts` — after the local `eventBus.emit()`, check `cluster_config` for a hub entry; if found, write an `event_broadcast` relay to `relay_outbox` with `target_site_id = "*"`. (2) New file `packages/web/src/server/routes/webhooks.ts` — a Hono route with `POST /hooks/:platform` that emits `"platform:webhook"` on `eventBus` and returns 200. The webhook route is mounted in `packages/web/src/server/index.ts`.

**Tech Stack:** TypeScript, Hono, existing `writeOutbox` helper from `@bound/core`

**Scope:** Phase 4 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Phase 3 Correction

**Before starting Phase 4, apply this correction to `phase_03.md` Task 3 (`leader-election.ts`):**

Codebase investigation reveals that `cluster_config` uses `key` (not `id`) as the column name for the primary key. The Phase 3 leader election code uses `WHERE id = ?` which must be changed to `WHERE key = ?`.

Correct the following SQL queries in `PlatformLeaderElection` implementation:

```typescript
// WRONG (from phase_03.md):
this.db.query("SELECT value FROM cluster_config WHERE id = ? AND deleted = 0 LIMIT 1").get(leaderKey)
this.db.query("SELECT id FROM cluster_config WHERE id = ? LIMIT 1").get(leaderKey)

// CORRECT:
this.db.query("SELECT value FROM cluster_config WHERE key = ? LIMIT 1").get(leaderKey)
this.db.query("SELECT key FROM cluster_config WHERE key = ? LIMIT 1").get(leaderKey)
```

**Note:** The `insertRow` call was replaced with `INSERT OR REPLACE` + manual `change_log` entry in Phase 3 Task 3 (see Phase 3 corrections above). Do not use `insertRow` for `cluster_config`.

Also update `DiscordConnector.getHubSiteId()` in `phase_03.md` Task 5:

```typescript
// WRONG:
this.db.query("SELECT value FROM cluster_config WHERE id = 'hub' AND deleted = 0 LIMIT 1").get()

// CORRECT:
this.db.query("SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1").get()
```

Verify the exact column names with `PRAGMA table_info(cluster_config)` before implementing.

---

## Acceptance Criteria Coverage

### platform-connectors.AC4: emit command cross-host broadcast
- **platform-connectors.AC4.1 Success:** `emit` writes `event_broadcast` relay entry when hub is in `cluster_config`
- **platform-connectors.AC4.2 Success:** `emit` does NOT write relay entry in single-host mode (no hub in `cluster_config`)

### platform-connectors.AC7: discord package deleted + webhook route (partial)
- **platform-connectors.AC7.3 Success:** `POST /hooks/discord` returns 200 and emits `"platform:webhook"` on `eventBus`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Update `emit` command to write event_broadcast relay

**Verifies:** platform-connectors.AC4.1, AC4.2

**Files:**
- Modify: `packages/agent/src/commands/emit.ts`

**Implementation:**

Read the current `packages/agent/src/commands/emit.ts` before editing. The file is ~31 lines. It currently calls `ctx.eventBus.emit(event, payload)` but does nothing with the relay system.

After the local `eventBus.emit()` call, add hub detection and relay write:

```typescript
import { randomUUID } from "crypto";
import { writeOutbox } from "@bound/core";
import type { EventBroadcastPayload } from "@bound/shared";

// ... existing CommandDefinition ...

handler: async (args, ctx) => {
  const event = args["event"];
  const rawPayload = args["payload"];

  let payload: Record<string, unknown> = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch {
      return commandError(`Invalid JSON payload: ${rawPayload}`);
    }
  }

  // Fire event locally on this host
  // @ts-expect-error — dynamic event name not statically typed
  ctx.eventBus.emit(event, payload);

  // Cross-host broadcast: write event_broadcast relay if hub is configured
  const hubRow = ctx.db
    .query<{ value: string }, []>(
      "SELECT value FROM cluster_config WHERE key = 'cluster_hub' LIMIT 1",
    )
    .get();

  if (hubRow?.value) {
    // Hub is configured — broadcast to all spokes via relay
    const eventDepth = (payload.__relay_event_depth as number | undefined) ?? 0;
    writeOutbox(ctx.db, {
      id: randomUUID(),
      source_site_id: ctx.siteId,
      target_site_id: "*",
      kind: "event_broadcast",
      ref_id: null,
      idempotency_key: `event_broadcast:${event}:${randomUUID()}`,
      stream_id: null,
      payload: JSON.stringify({
        event_name: event,
        event_payload: payload,
        source_host: ctx.hostName,
        event_depth: eventDepth + 1,
      } satisfies EventBroadcastPayload),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    ctx.eventBus.emit("sync:trigger", { reason: "emit-broadcast" });
  }

  return commandSuccess(`Event '${event}' emitted`);
},
```

**Note on `ctx.siteId` and `ctx.hostName`:** The `CommandContext` extends `AppContext` and includes `siteId` and `hostName`. Verify these fields are accessible on `ctx` by checking `packages/agent/src/commands/helpers.ts` or the `CommandDefinition` type definition. If `CommandContext` does not have `siteId`, use `ctx.db.query("SELECT value FROM cluster_config WHERE key = 'site_id' ...").get()` as a fallback.

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add cross-host event_broadcast relay to emit command (AC4.1, AC4.2)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create webhook route

**Verifies:** platform-connectors.AC7.3

**Files:**
- Create: `packages/web/src/server/routes/webhooks.ts`

**Implementation:**

**`packages/web/src/server/routes/webhooks.ts`:**

```typescript
import { Hono } from "hono";
import type { TypedEventEmitter } from "@bound/shared";

/**
 * Generic webhook ingress for exclusive-delivery platform connectors.
 * Receives platform webhook payloads (Telegram, Slack, etc.) and emits
 * "platform:webhook" on the eventBus for connectors to handle.
 *
 * No authentication middleware — platform-specific signature verification
 * is handled by each connector's handleWebhookPayload() implementation.
 */
export function createWebhookRoutes(eventBus: TypedEventEmitter): Hono {
  const app = new Hono();

  app.post("/:platform", async (c) => {
    const platform = c.req.param("platform");
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(c.req.header())) {
      if (value !== undefined) {
        headers[key] = value;
      }
    }

    eventBus.emit("platform:webhook", { platform, rawBody, headers });

    return c.text("OK", 200);
  });

  return app;
}
```

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add POST /hooks/:platform webhook ingress route (AC7.3)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Mount webhook route in web server

**Verifies:** platform-connectors.AC7.3 (integration with server)

**Files:**
- Modify: `packages/web/src/server/index.ts`

**Implementation:**

Read `packages/web/src/server/index.ts` before editing. The file is ~119 lines and uses `app.route()` to mount routes.

**3a. Add import** for the new webhook routes factory near the other route imports:

```typescript
import { createWebhookRoutes } from "./routes/webhooks.js";
```

**3b. Mount the webhook route** in `createApp()` (or the equivalent function that builds the Hono app), alongside the other `app.route()` calls:

```typescript
// After the existing app.route() calls for /api/... routes:
app.route("/hooks", createWebhookRoutes(eventBus));
```

The webhook routes will then be accessible at `POST /hooks/:platform` (e.g., `POST /hooks/discord`, `POST /hooks/telegram`).

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: mount /hooks webhook route in web server`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4) -->

<!-- START_TASK_4 -->
### Task 4: Tests

**Verifies:** platform-connectors.AC4.1, AC4.2, AC7.3

**Files:**
- Modify or create: `packages/agent/src/__tests__/emit.test.ts` (check if it exists first; create if not)
- Create: `packages/web/src/__tests__/webhooks.test.ts`

**Testing:**

---

**`packages/agent/src/__tests__/emit.test.ts`:**

Follow the same test patterns as `relay-processor.test.ts`. Create an in-memory DB, apply schema, create a `CommandContext`-compatible object with `db`, `eventBus`, `siteId`, `hostName`.

Tests must verify:

- **AC4.1:** Seed `cluster_config` with a hub entry (`key = 'cluster_hub'`, `value = 'hub-site-id'`). Call the emit command handler with `args = { event: "task:triggered", payload: '{"task_id":"t1","trigger":"test"}' }`. Assert that `relay_outbox` has exactly one new row with `kind = 'event_broadcast'`, `target_site_id = '*'`, and payload containing `event_name = 'task:triggered'`.

- **AC4.2:** Ensure `cluster_config` has NO hub entry (empty table or only non-hub entries). Call the emit command handler. Assert that `relay_outbox` has zero rows with `kind = 'event_broadcast'`. Assert that `eventBus.emit()` was still called with the event name (local emission still happens).

---

**`packages/web/src/__tests__/webhooks.test.ts`:**

Use Hono's testing utilities to make requests against the webhook route. Check an existing web test file (e.g., in `packages/web/src/__tests__/`) for the pattern.

Tests must verify:

- **AC7.3:** Make a `POST /hooks/discord` request with a JSON body. Assert the response status is 200. Assert that `"platform:webhook"` was emitted on the eventBus with `platform = "discord"`, and `rawBody` containing the request body.

Example test:

```typescript
import { describe, it, expect, mock } from "bun:test";
import { createWebhookRoutes } from "../server/routes/webhooks";
import { TypedEventEmitter } from "@bound/shared";

describe("platform-connectors Phase 4 — webhook route", () => {
  it("AC7.3: POST /hooks/discord returns 200 and emits platform:webhook", async () => {
    const eventBus = new TypedEventEmitter();
    const emittedEvents: Array<{ platform: string; rawBody: string }> = [];
    eventBus.on("platform:webhook", (payload) => emittedEvents.push(payload));

    const app = createWebhookRoutes(eventBus);
    const res = await app.request("/discord", {
      method: "POST",
      body: '{"type":"MESSAGE_CREATE"}',
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].platform).toBe("discord");
    expect(emittedEvents[0].rawBody).toBe('{"type":"MESSAGE_CREATE"}');
  });
});
```

**Verification:**

Run: `bun test packages/agent/src/__tests__/emit.test.ts`
Expected: AC4.1 and AC4.2 tests pass.

Run: `bun test packages/web/src/__tests__/webhooks.test.ts`
Expected: AC7.3 test passes.

Run: `bun test packages/agent && bun test packages/web`
Expected: All package tests pass.

**Commit:** `test: add platform-connectors Phase 4 tests for emit broadcast and webhook route (AC4.1, AC4.2, AC7.3)`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->
