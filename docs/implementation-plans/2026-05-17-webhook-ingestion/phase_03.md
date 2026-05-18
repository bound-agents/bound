# Webhook Ingestion Implementation Plan — Phase 3

**Goal:** Webhook deliveries trigger the scheduler via event bus, duplicate deliveries are deduplicated via delivery-ID headers, and `systemPromptAddition` is wired from task rows through the relay processor and scheduler into the agent loop.

**Architecture:** The webhook handler (Phase 2) already writes the relay_inbox intake entry and returns 202. This phase adds: (1) event bus emission (`connector:event` with `trigger_key: "webhook:<name>"`) to trigger the scheduler's event task matching, (2) delivery-header extraction for natural deduplication of retried webhooks from external services, and (3) `system_prompt_addition` read from task rows in both `runDelegatedLoop()` and the scheduler's AgentLoopConfig construction. The existing context assembly pipeline (lines 387-391) already consumes `systemPromptAddition`.

**Tech Stack:** TypeScript, bun:sqlite, EventBus

**Scope:** 6 phases from original design (this is phase 3 of 6)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### webhook-ingestion.AC3: Relay delivery + agent invocation
- **webhook-ingestion.AC3.1 Success:** Relay intake entry routes to a spoke with models and creates a user message in the webhook's thread
- **webhook-ingestion.AC3.2 Success:** Message content is a structured JSON envelope containing method, path, filtered headers, content_type, and body
- **webhook-ingestion.AC3.3 Success:** Agent loop runs with `systemPromptAddition` populated from `tasks.system_prompt_addition`
- **webhook-ingestion.AC3.4 Success:** Duplicate deliveries (same dedup key) are silently discarded
- **webhook-ingestion.AC3.5 Edge:** Hub-only mode (no local models) routes to spoke via relay rather than failing
- **webhook-ingestion.AC3.6 Edge:** Scheduler-triggered tasks also receive `system_prompt_addition` when present (not just relay-delegated)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add event bus emission and delivery-header dedup to webhook handler

**Verifies:** webhook-ingestion.AC3.4

**Files:**
- Modify: `packages/web/src/server/webhook-handler.ts` (created in Phase 2)
- Modify: `packages/web/src/server/start.ts` (pass eventBus to handler deps)

**Implementation:**

Phase 2 already writes the relay_inbox entry with a generated platformEventId. This task enhances the handler with:

1. **Delivery-header extraction for deduplication (AC3.4):**

   Before generating a random platformEventId, check for known delivery headers:
   ```typescript
   function extractDeliveryId(headers: Headers, name: string): string | null {
     // Check platform-specific delivery headers
     const githubDelivery = headers.get("x-github-delivery");
     if (githubDelivery) return `github-${githubDelivery}`;

     const stripeIdempotency = headers.get("stripe-idempotency-key");
     if (stripeIdempotency) return `stripe-${stripeIdempotency}`;

     // Generic fallback header
     const genericId = headers.get("x-idempotency-key");
     if (genericId) return `generic-${genericId}`;

     // No delivery header — generate unique ID (no dedup for this delivery)
     return null;
   }

   const deliveryId = extractDeliveryId(request.headers, name);
   const platformEventId = deliveryId ?? `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
   ```

   This ensures repeated deliveries from the same external service (using the same delivery header) produce the same `idempotency_key`, triggering `INSERT OR IGNORE` dedup in relay_inbox.

2. **Event bus emission for scheduler triggering:**

   After writing the relay_inbox entry, emit the event:
   ```typescript
   deps.eventBus.emit("connector:event", {
     trigger_key: `webhook:${name}`,
     handle_id: webhook.id,
     event_data: { webhook_name: name },
   });
   deps.eventBus.emit("sync:trigger", undefined);
   ```

   The scheduler's `registerConnectorEventDelivery()` listens for `connector:event` and calls `scheduler.onEvent(payload.trigger_key, payload)`. This matches tasks where `trigger_spec = "webhook:<name>"`.

3. **Pass eventBus to handler deps:**

   Update `start.ts` to rename `_eventBus` to `eventBus` and pass it to `WebhookHandlerDeps`:
   ```typescript
   return handleWebhookRequest(request, webhookMatch[1], { db, siteId: config.siteId, eventBus });
   ```

**Testing:**

Tests must verify:
- webhook-ingestion.AC3.4: Two POST requests with the same `X-GitHub-Delivery` header value produce only one relay_inbox entry. A POST without any delivery header generates a unique ID (no dedup possible for that request).

Test file: `packages/web/src/server/__tests__/webhook-handler.test.ts` (extend from Phase 2)

**Verification:**

Run: `bun test packages/web/src/server/__tests__/webhook-handler.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add delivery-header dedup and event bus emission to webhook handler`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire systemPromptAddition in relay processor runDelegatedLoop

**Verifies:** webhook-ingestion.AC3.3, AC3.5

**Files:**
- Modify: `packages/agent/src/relay-processor.ts` (lines 1541-1558, `runDelegatedLoop()`)

**Implementation:**

Expand the owning-task SELECT query to include `system_prompt_addition`:

```typescript
const owningTask = this.db
  .query(
    "SELECT id, no_history, system_prompt_addition FROM tasks WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
  )
  .get(payload.thread_id) as { id: string; no_history: number; system_prompt_addition: string | null } | null;
```

Then inject into the loopConfig after `noHistory`:

```typescript
const loopConfig: AgentLoopConfig = {
  threadId: payload.thread_id,
  userId: payload.user_id,
  taskId: owningTask?.id ?? `delegated-${entry.id}`,
  modelId: threadModelId,
  noHistory: owningTask?.no_history === 1,
  systemPromptAddition: owningTask?.system_prompt_addition ?? undefined,
  shouldYield,
  // ... existing platform/platformTools fields
};
```

This ensures:
- AC3.3: Agent loop receives `systemPromptAddition` from the task's persistent column
- AC3.5: Hub-only mode works because `handleIntake()` already routes to spokes with models via `selectIntakeHost()` Tier 2/4 fallback. No changes needed for hub-only routing.

**Testing:**

Tests must verify:
- webhook-ingestion.AC3.3: When a task has `system_prompt_addition` set, `runDelegatedLoop` passes it to the agent loop config
- webhook-ingestion.AC3.5: When no local models available, relay routes to a spoke (verified by existing hub-spoke integration test infrastructure)

Test file: `packages/agent/src/__tests__/relay-processor-webhook.test.ts`

Setup: Create in-memory DB, insert task with `system_prompt_addition = "You are a GitHub webhook processor"`, insert matching thread, verify the SELECT query returns the field correctly and it flows into the loop config.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor-webhook.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): wire system_prompt_addition through relay processor`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Wire systemPromptAddition in scheduler for event tasks

**Verifies:** webhook-ingestion.AC3.6

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (around lines 1010-1025, AgentLoopConfig construction)

**Implementation:**

In the scheduler's event task execution path, the task object is already fetched via `SELECT *` (line 1264), so `task.system_prompt_addition` is already available. Find where the scheduler builds `loopConfig` for claimed event tasks and add `systemPromptAddition`:

```typescript
const loopConfig: AgentLoopConfig = {
  threadId,
  taskId: task.id,
  userId: "system",
  modelId,
  modelTier,
  noHistory: task.no_history === 1,
  systemPromptAddition: task.system_prompt_addition ?? undefined,
};
```

Also verify the cron task path includes the same wiring — `system_prompt_addition` should work for all task types, not just event tasks.

**Testing:**

Tests must verify:
- webhook-ingestion.AC3.6: Scheduler-triggered task with `system_prompt_addition` set passes it through to AgentLoopConfig

Test file: `packages/agent/src/__tests__/scheduler-prompt-addition.test.ts`

Setup: Create in-memory DB, insert event task with `trigger_spec = "webhook:test-hook"` and `system_prompt_addition = "Process incoming webhook data"`, trigger the scheduler event path, verify the loopConfig contains the systemPromptAddition.

**Verification:**

Run: `bun test packages/agent/src/__tests__/scheduler-prompt-addition.test.ts`
Expected: All tests pass

**Commit:** `feat(agent): wire system_prompt_addition through scheduler event tasks`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Run full test suite to verify no regressions

**Step 1: Run tests**

Run: `bun test --recursive`
Expected: All tests pass. Existing relay and scheduler tests must still pass.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean across all packages

**Commit:** Only if fixes were needed: `fix(agent): type/test fixes for systemPromptAddition wiring`
<!-- END_TASK_4 -->
