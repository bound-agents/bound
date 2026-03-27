# Platform Connectors Implementation Plan — Phase 2: Relay Kind Handlers

**Goal:** Implement the three new relay kinds (`intake`, `platform_deliver`, `event_broadcast`) in `RelayProcessor` and add broadcast fan-out + thread-affinity tracking to the sync relay route.

**Architecture:** Two files change. In `relay-processor.ts`, three new `case` branches are added to `processEntry()`. The `intake` case uses a hub-local `Map<thread_id, site_id>` (thread-affinity) plus four-tier fallback routing to select a processing host and write a `process` relay. The `platform_deliver` case emits `"platform:deliver"` on `eventBus`. The `event_broadcast` case fires the named event locally on `eventBus` with depth tracking. In `routes.ts`, `POST /sync/relay` gains a broadcast fan-out path for `target_site_id === "*"` and peeks at `status_forward` messages to keep the affinity map current. The affinity map is a `Map<string, string>` created externally and passed into both `RelayProcessor` and `createSyncRoutes`.

**Tech Stack:** TypeScript, bun:sqlite (relay_outbox depth query), existing `writeOutbox`/`insertInbox`/`eagerPushToSpoke` helpers

**Scope:** Phase 2 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC3: Relay kind handlers
- **platform-connectors.AC3.2 Success:** Duplicate `intake` with same `platform` + `platform_event_id` is discarded (idempotency)
- **platform-connectors.AC3.3 Success:** Intake routing selects host with active loop for the thread (thread affinity)
- **platform-connectors.AC3.4 Success:** Intake routing selects host that has the thread's model when no affinity
- **platform-connectors.AC3.5 Success:** Intake routing selects host with most matching `mcp_tools` when no model match
- **platform-connectors.AC3.6 Success:** Intake routing falls back to least-loaded host when no other signal
- **platform-connectors.AC3.7 Success:** `platform_deliver` receipt emits `"platform:deliver"` on `eventBus`
- **platform-connectors.AC3.8 Success:** `event_broadcast` receipt fires event on local `eventBus` with correct `event_depth`
- **platform-connectors.AC3.9 Success:** `target_site_id="*"` fan-out writes one outbox entry per spoke, excluding source spoke

### platform-connectors.AC4: emit command cross-host broadcast (partial)
- **platform-connectors.AC4.4 Success:** `event_depth` is incremented by 1 on each relay hop

---

## Phase 1 Correction

**Before starting Phase 2, apply this correction to `phase_01.md` Task 1:**

The `IntakePayload` defined in Phase 1 is missing `message_id`. The DiscordConnector (Phase 3) assigns a UUID to the user message before calling `insertRow()`, and includes that UUID in the intake relay so the target host can find the specific message to process. Update `packages/shared/src/types.ts`:

```typescript
export interface IntakePayload {
  platform: string;
  platform_event_id: string;
  thread_id: string;
  user_id: string;
  message_id: string;   // ← add this field
  content: string;
  attachments?: unknown[];
}
```

This field is used in Task 1 of this phase when the `intake` handler writes the `process` relay.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add intake routing + new case branches to RelayProcessor

**Verifies:** platform-connectors.AC3.2, AC3.3, AC3.4, AC3.5, AC3.6, AC3.7, AC3.8, AC4.4

**Files:**
- Modify: `packages/agent/src/relay-processor.ts`

**Implementation:**

**1a. Add `threadAffinityMap` parameter to the `RelayProcessor` constructor.**

The existing `RelayProcessor` constructor (line ~46–56) takes these parameters in order:
`db, siteId, mcpClients, modelRouter, keyringSiteIds, logger, eventBus, appCtx?, relayConfig?`

Add `threadAffinityMap` as the **last** (10th) optional parameter, after `relayConfig`. Store it as a private field:

```typescript
// Add private field alongside other private fields (around line 40-50):
private readonly threadAffinityMap: Map<string, string>;

// Update constructor signature — add as the LAST parameter:
constructor(
  private db: Database,
  private siteId: string,
  private mcpClients: Map<string, MCPClient>,
  private modelRouter: ModelRouter | null,
  private keyringSiteIds: Set<string>,
  private logger: Logger,
  private eventBus: TypedEventEmitter,
  private appCtx: AppContext | null = null,
  private relayConfig?: RelayConfig,
  threadAffinityMap: Map<string, string> = new Map(),
) {
  // ... existing body ...
  this.threadAffinityMap = threadAffinityMap;
}
```

All existing callers pass 7–9 arguments and leave the new 10th parameter at its default `new Map()`. Phase 7 tests that need thread affinity must pass it as the 10th argument.

**1b. Add a private `selectIntakeHost()` method** to the `RelayProcessor` class. This implements the four-tier routing algorithm. Add it after the existing private helpers (before or after `pruneIdempotencyCache()`):

```typescript
/**
 * Select the best host to process an intake message.
 * Tiers (in order): thread affinity → model match → tool match → least-loaded fallback.
 */
private selectIntakeHost(threadId: string): string | null {
  // Tier 1: Thread affinity — use host that most recently processed this thread
  const affinityHost = this.threadAffinityMap.get(threadId);
  if (affinityHost) {
    const alive = this.db
      .query<{ site_id: string }, [string]>(
        "SELECT site_id FROM hosts WHERE site_id = ? AND deleted = 0",
      )
      .get(affinityHost);
    if (alive) return alive.site_id;
    // Affinity host gone — fall through
  }

  // Tier 2: Model match — find a host that supports the model last used in this thread
  const lastModel = this.db
    .query<{ model_id: string | null }, [string]>(
      "SELECT model_id FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(threadId);

  if (lastModel?.model_id) {
    const hosts = this.db
      .query<{ site_id: string; models: string }, []>(
        "SELECT site_id, models FROM hosts WHERE deleted = 0 AND models IS NOT NULL",
      )
      .all();
    for (const host of hosts) {
      const models = JSON.parse(host.models) as string[];
      if (models.includes(lastModel.model_id)) return host.site_id;
    }
  }

  // Tier 3: Tool match — find the host with the most tools matching this thread's tool usage.
  // Uses the tool_name column on messages (populated for role='tool' result messages).
  const threadTools = this.db
    .query<{ tool_name: string }, [string]>(
      `SELECT DISTINCT tool_name
       FROM messages
       WHERE thread_id = ? AND role = 'tool' AND tool_name IS NOT NULL
       LIMIT 50`,
    )
    .all(threadId)
    .map((r) => r.tool_name);

  if (threadTools.length > 0) {
    const hosts = this.db
      .query<{ site_id: string; mcp_tools: string | null }, []>(
        "SELECT site_id, mcp_tools FROM hosts WHERE deleted = 0",
      )
      .all();

    let bestHost: string | null = null;
    let bestScore = 0;
    for (const host of hosts) {
      if (!host.mcp_tools) continue;
      const hostToolNames = JSON.parse(host.mcp_tools) as string[];
      const score = threadTools.filter((t) => hostToolNames.includes(t)).length;
      if (score > bestScore) {
        bestScore = score;
        bestHost = host.site_id;
      }
    }
    if (bestHost) return bestHost;
  }

  // Tier 4: Least-loaded fallback — host with fewest pending relay_outbox entries
  const loaded = this.db
    .query<{ site_id: string; depth: number }, []>(
      `SELECT h.site_id, COUNT(o.id) AS depth
       FROM hosts h
       LEFT JOIN relay_outbox o ON o.target_site_id = h.site_id AND o.delivered = 0
       WHERE h.deleted = 0
       GROUP BY h.site_id
       ORDER BY depth ASC
       LIMIT 1`,
    )
    .get();
  return loaded?.site_id ?? null;
}
```

**Note on Tier 3 SQL:** The `tool_calls` column on `messages` may store tool call data in a different structure than shown above. If the query returns no results (because the column name or JSON structure differs), the fallback naturally proceeds to Tier 4. Verify the `messages` table schema with `PRAGMA table_info(messages)` if needed, and adjust the JSON extraction accordingly.

**1c. Add three new `case` branches to the `processEntry()` switch statement** (currently ending at line ~205 with a `default: throw`). Add these cases before the `default:` case:

```typescript
case "intake": {
  const payload = JSON.parse(entry.payload) as IntakePayload;
  const idempotencyKey = `intake:${payload.platform}:${payload.platform_event_id}`;

  // Dedup: check idempotency cache (same cache already used by other relay kinds)
  const cached = this.idempotencyCache.get(idempotencyKey);
  if (cached && cached.expiresAt > Date.now()) {
    // Duplicate — silently discard
    response = null;
    break;
  }
  this.idempotencyCache.set(idempotencyKey, {
    response: "",
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });

  // Select routing target
  const targetSiteId = this.selectIntakeHost(payload.thread_id);
  if (!targetSiteId) {
    this.logger.warn("relay-processor", "intake: no eligible host found, dropping");
    response = null;
    break;
  }

  // Write process signal to the selected host
  const processOutboxId = randomUUID();
  writeOutbox(this.db, {
    id: processOutboxId,
    source_site_id: entry.source_site_id,
    target_site_id: targetSiteId,
    kind: "process",
    ref_id: entry.id,
    idempotency_key: `process:${entry.id}`,
    stream_id: null,
    payload: JSON.stringify({
      thread_id: payload.thread_id,
      message_id: payload.message_id,
      user_id: payload.user_id,
    } satisfies ProcessPayload),
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  this.eventBus.emit("sync:trigger", { reason: "intake-routed" });
  response = null;
  break;
}

case "platform_deliver": {
  const payload = JSON.parse(entry.payload) as PlatformDeliverPayload;
  this.eventBus.emit("platform:deliver", payload);
  response = null;
  break;
}

case "event_broadcast": {
  const payload = JSON.parse(entry.payload) as EventBroadcastPayload;
  // Fire the named event locally. Strip __relay_event_depth from the
  // payload seen by the scheduler — it's an internal routing field only.
  const { event_depth, ...eventPayload } = payload.event_payload as Record<string, unknown>;
  this.eventBus.emit(payload.event_name as keyof EventMap, {
    ...eventPayload,
    __relay_event_depth: payload.event_depth,
  } as never);
  response = null;
  break;
}
```

**Imports to add** at the top of `relay-processor.ts`:

```typescript
import { randomUUID } from "crypto";
import type {
  IntakePayload,
  PlatformDeliverPayload,
  EventBroadcastPayload,
  ProcessPayload,
  EventMap,
} from "@bound/shared";
```

(Check which of these are already imported and add only the missing ones.)

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add intake/platform_deliver/event_broadcast relay kind handlers to RelayProcessor`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Broadcast fan-out + thread-affinity tracking in sync routes

**Verifies:** platform-connectors.AC3.9

**Files:**
- Modify: `packages/sync/src/routes.ts`

**Implementation:**

**2a. Update `createSyncRoutes` signature** to accept the thread-affinity map:

Current signature (lines 20–29):
```typescript
export function createSyncRoutes(
  db: Database,
  siteId: string,
  keyring: KeyringConfig,
  _eventBus: TypedEventEmitter,
  logger: Logger,
  relayExecutor?: RelayExecutor,
  hubSiteId?: string,
  eagerPushConfig?: EagerPushConfig,
): Hono<AppContext>
```

Add `threadAffinityMap?: Map<string, string>` as the last parameter:

```typescript
export function createSyncRoutes(
  db: Database,
  siteId: string,
  keyring: KeyringConfig,
  _eventBus: TypedEventEmitter,
  logger: Logger,
  relayExecutor?: RelayExecutor,
  hubSiteId?: string,
  eagerPushConfig?: EagerPushConfig,
  threadAffinityMap?: Map<string, string>,
): Hono<AppContext>
```

**2b. Add broadcast fan-out in the relay phase handler** (`POST /sync/relay`, around lines 114–219).

Inside the loop that processes each `entry` in `body.relay_outbox`, add a check BEFORE the existing `if (entry.target_site_id === siteId)` block:

```typescript
// Broadcast: fan-out to all known spokes except the source
if (entry.target_site_id === "*") {
  const allSiteIds = Object.keys(keyring.spokes ?? {});
  const targets = allSiteIds.filter((id) => id !== entry.source_site_id);

  for (const targetId of targets) {
    const inboxEntry: RelayInboxEntry = {
      id: randomUUID(),
      source_site_id: entry.source_site_id,
      kind: entry.kind,
      ref_id: entry.id,
      idempotency_key: entry.idempotency_key,
      stream_id: entry.stream_id ?? null,
      payload: entry.payload,
      expires_at: entry.expires_at,
      received_at: new Date().toISOString(),
      processed: 0,
    };
    insertInbox(db, inboxEntry);
    void eagerPushToSpoke(eagerPushConfig, targetId, [inboxEntry]);
  }
  delivered.push(entry.id);
  continue; // skip the single-target routing below
}
```

**2c. Peek at `status_forward` messages to update thread affinity.**

Still in the relay phase handler, after routing each entry (but before the `continue` for broadcast), add affinity tracking. Find where `status_forward` entries are routed through the hub (they come from spokes reporting back to the hub after processing). Add this snippet after the broadcast check, wrapping the existing single-target routing:

```typescript
// Update thread-affinity map when a status_forward passes through
if (entry.kind === "status_forward" && threadAffinityMap) {
  try {
    const sfPayload = JSON.parse(entry.payload) as { thread_id?: string };
    if (sfPayload.thread_id) {
      threadAffinityMap.set(sfPayload.thread_id, entry.source_site_id);
    }
  } catch {
    // Malformed payload — ignore, affinity is best-effort
  }
}
```

Add `import { randomUUID } from "crypto"` and `import { insertInbox } from "@bound/core"` to `routes.ts` imports if not already present.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add broadcast fan-out (target_site_id="*") and thread-affinity tracking to sync relay route`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3) -->

<!-- START_TASK_3 -->
### Task 3: Tests for new relay kind handlers

**Verifies:** platform-connectors.AC3.2, AC3.3, AC3.4, AC3.5, AC3.6, AC3.7, AC3.8, AC3.9, AC4.4

**Files:**
- Modify: `packages/agent/src/__tests__/relay-processor.test.ts`
- Modify: `packages/sync/src/__tests__/multi-instance.integration.test.ts` (or create if the broadcast test doesn't exist there)

**Testing:**

**In `packages/agent/src/__tests__/relay-processor.test.ts`**, add a new `describe` block following the existing test patterns (temp DB, `applySchema`, mock event bus, `RelayProcessor` construction). Key patterns to follow: `randomBytes(4).toString("hex")` for temp DB path; the existing mock `eventBus` using `TypedEventEmitter`; direct `db.run()` to seed test data.

Tests to add:

```typescript
describe("platform-connectors Phase 2 — intake/platform_deliver/event_broadcast", () => {
  // AC3.2: Duplicate intake is discarded via idempotency
  it("AC3.2: duplicate intake with same platform+platform_event_id is discarded", async () => {
    // Setup: create RelayProcessor, insert two intake inbox entries with same
    // platform + platform_event_id, process both
    // Assert: writeOutbox (process signal) was called only ONCE, not twice
    // Hint: count relay_outbox rows with kind="process" — should be 1 after processing both
  });

  // AC3.3: Thread affinity routing
  it("AC3.3: intake routing selects host with active loop for the thread (thread affinity)", async () => {
    // Setup:
    // - Create two hosts in hosts table: hostA, hostB
    // - Set threadAffinityMap.set(threadId, hostA.site_id)
    // - Process an intake entry for that thread
    // Assert: relay_outbox has a "process" entry targeting hostA
  });

  // AC3.4: Model match routing
  it("AC3.4: intake routing selects host with matching model when no affinity", async () => {
    // Setup:
    // - Two hosts: hostA (models: ["gpt-4"]), hostB (models: ["claude-3"])
    // - Insert a turns row for the thread with model_id = "claude-3"
    // - No thread affinity set
    // - Process intake
    // Assert: process signal targets hostB
  });

  // AC3.5: Tool match routing
  it("AC3.5: intake routing selects host with most matching mcp_tools", async () => {
    // Setup:
    // - Two hosts: hostA (mcp_tools: ["bash","files"]), hostB (mcp_tools: ["bash","web","files"])
    // - Thread has recent tool usage: ["bash", "web", "files"]
    // - No turns row (no model match)
    // - No thread affinity
    // - Process intake
    // Assert: process signal targets hostB (score 3 vs hostA score 2)
  });

  // AC3.6: Fallback routing
  it("AC3.6: intake routing falls back to least-loaded host", async () => {
    // Setup:
    // - Two hosts: hostA, hostB
    // - relay_outbox has 3 pending entries targeting hostA, 1 targeting hostB
    // - No affinity, no turns, no mcp_tools
    // - Process intake
    // Assert: process signal targets hostB (least-loaded)
  });

  // AC3.7: platform_deliver emits on eventBus
  it("AC3.7: platform_deliver emits platform:deliver on eventBus", async () => {
    // Setup: insert a platform_deliver inbox entry with a PlatformDeliverPayload
    // Listen for "platform:deliver" event on eventBus
    // Process the entry
    // Assert: eventBus emitted "platform:deliver" with the correct payload
  });

  // AC3.8: event_broadcast fires event locally with correct event_depth
  it("AC3.8: event_broadcast fires named event on eventBus with correct event_depth", async () => {
    // Setup: insert an event_broadcast inbox entry with:
    //   { event_name: "task:triggered", event_payload: { task_id: "t1", trigger: "test" },
    //     source_host: "hub", event_depth: 2 }
    // Listen for "task:triggered" on eventBus
    // Process the entry
    // Assert: eventBus emitted "task:triggered" with task_id = "t1"
    // Assert: the emitted payload does NOT contain event_depth (stripped before scheduler sees it)
    // Assert: emitted payload contains __relay_event_depth = 2
  });

  // AC4.4: event_depth propagation
  it("AC4.4: event_broadcast with event_depth=1 fires with __relay_event_depth=1", async () => {
    // Similar to AC3.8 but verify the depth counter is preserved correctly
  });
});
```

**In `packages/sync/src/__tests__/multi-instance.integration.test.ts`** (or the closest broadcast integration test file), add:

```typescript
// AC3.9: target_site_id="*" fan-out
it("AC3.9: broadcast target_site_id='*' writes one outbox entry per spoke excluding source", async () => {
  // Setup:
  // - Two spoke site IDs in keyring: spokeA, spokeB
  // - Call the sync relay route POST /sync/relay from spokeA
  //   with an entry that has target_site_id = "*"
  // Assert:
  //   - relay_inbox has one entry for spokeA's outbox (from hub perspective: one entry targeting spokeB)
  //   - relay_inbox does NOT have an entry targeting spokeA (echo suppressed)
  //   - Total new relay_inbox rows = 1 (number of spokes minus source)
});
```

Follow the existing multi-instance test pattern: random ports, `randomBytes(4).toString("hex")` testRunId, create Hub + Spoke instances with in-process Hono servers.

**Verification:**

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: All new tests pass.

Run: `bun test packages/sync/src/__tests__/multi-instance.integration.test.ts`
Expected: All tests pass including the new broadcast test.

Run: `bun test packages/agent && bun test packages/sync`
Expected: Full package test suites pass.

**Commit:** `test: add platform-connectors Phase 2 relay kind handler tests (AC3.2–3.9, AC4.4)`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_B -->
