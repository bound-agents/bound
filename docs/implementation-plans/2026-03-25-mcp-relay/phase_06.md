# MCP Relay Transport — Phase 6: Hub Migration Drain

**Goal:** Safely drain in-flight relay messages before switching hubs, ensuring no messages are lost during hub migration.

**Architecture:** When `boundctl set-hub` is called, the hub sets a `relay_draining` flag that gets included in sync responses. Spokes receiving this flag hold back request-kind outbox entries (keeping them `delivered = 0`) while still sending response-kind and cancel entries. The hub polls its own relay outbox until empty or timeout (120s), then proceeds with the hub switch. Held request-kind entries are automatically delivered to the new hub on the spoke's first post-switch sync.

**Tech Stack:** TypeScript, bun:sqlite, CLI (boundctl)

**Scope:** 8 phases from original design (phase 6 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC4: Hub migration drain
- **mcp-relay.AC4.1 Success:** `boundctl set-hub` drains relay outbox before switching hubs
- **mcp-relay.AC4.2 Success:** Spokes hold back request-kind entries when `relay_draining` is true
- **mcp-relay.AC4.3 Success:** Response-kind and cancel entries still flow during drain
- **mcp-relay.AC4.4 Success:** Held request-kind entries deliver to new hub on first sync after switch
- **mcp-relay.AC4.5 Edge:** Drain timeout (120s) proceeds with switch even if outbox not empty

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add relay drain flag to hub sync response

**Files:**
- Modify: `packages/sync/src/routes.ts` (update /sync/relay handler to read drain state)

**Implementation:**

Update the `/sync/relay` route handler to read the drain state from the `host_meta` table (non-synced, local-only) and include it in the relay response. The drain state is set by `boundctl set-hub` (Task 3).

**Important:** The drain flag is stored in `host_meta` (non-synced), NOT `cluster_config` (synced). The flag is communicated to spokes exclusively via the sync relay response — it does not need to replicate via the change-log outbox pattern.

Replace the hardcoded `relay_draining: false` in the RelayResponse with a dynamic lookup:

```typescript
// In the /sync/relay handler:
const drainState = db
	.query("SELECT value FROM host_meta WHERE key = 'relay_draining'")
	.get() as { value: string } | null;

const response: RelayResponse = {
	relay_inbox: inboxForRequester,
	relay_delivered: deliveredIds,
	relay_draining: drainState?.value === "true",
};
```

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): read relay_draining flag from host_meta in RELAY response`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add spoke holdback logic for draining

**Verifies:** mcp-relay.AC4.2, mcp-relay.AC4.3

**Files:**
- Modify: `packages/sync/src/sync-loop.ts` (update relay() method to hold back request-kind entries when draining)

**Implementation:**

Update the spoke's `relay()` method (added in Phase 2) to filter outbox entries based on the `relay_draining` flag from the previous sync response. When draining is active:

1. Read all undelivered outbox entries
2. Split into two groups:
   - **Sendable**: response-kind entries (`result`, `error`) and `cancel` entries (AC4.3)
   - **Held back**: all other request-kind entries (`tool_call`, `resource_read`, `prompt_invoke`, `cache_warm`) (AC4.2)
3. Only send the sendable group to the hub
4. Held entries stay in outbox with `delivered = 0` — they will be sent on the next sync after the hub switch (AC4.4)

Store the draining state locally so it persists across sync cycles:

```typescript
import { RELAY_RESPONSE_KINDS } from "@bound/shared";

// In the relay() method:
const outbox = readUndelivered(this.db);

let entriesToSend = outbox;
if (this.relayDraining) {
	entriesToSend = outbox.filter(
		(entry) =>
			RELAY_RESPONSE_KINDS.includes(entry.kind as any) ||
			entry.kind === "cancel",
	);
}

const relayRequest: RelayRequest = {
	relay_outbox: entriesToSend,
};
```

After receiving the relay response, update the local drain state:

```typescript
this.relayDraining = relayResponse.relay_draining;
```

Add a `relayDraining` instance property to `SyncClient`, initialized as `false`.

**Testing:**

Tests must verify:
- **mcp-relay.AC4.2:** Set `relayDraining = true` → outbox has `tool_call` and `resource_read` entries → only response/cancel entries sent
- **mcp-relay.AC4.3:** Set `relayDraining = true` → outbox has `result`, `error`, and `cancel` entries → all three sent normally

**Verification:**

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): add spoke holdback logic for request-kind entries during relay drain`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add relay drain to boundctl set-hub

**Verifies:** mcp-relay.AC4.1, mcp-relay.AC4.5

**Files:**
- Modify: `packages/cli/src/commands/set-hub.ts` (add relay drain wait before hub switch)

**Implementation:**

Update `runSetHub()` to perform a relay drain before switching hubs. The drain sequence:

1. **Set drain flag**: Write `relay_draining = "true"` to `host_meta` table (non-synced, local-only). The flag is communicated to spokes via the sync relay response, not via table replication.
2. **Wait for outbox to empty**: Poll `relay_outbox` for undelivered entries (`WHERE delivered = 0`), waiting up to the configured drain timeout (default 120s from `RelayConfig.drain_timeout_seconds`)
3. **On success**: Outbox is empty → proceed with hub switch
4. **On timeout**: 120 seconds elapsed with outbox still not empty (AC4.5) → log warning, proceed with hub switch anyway
5. **Switch hub**: Update `cluster_config.cluster_hub` (existing logic, uses `insertRow()` per change-log outbox pattern)
6. **Clear drain flag**: Remove `relay_draining` from `host_meta`

```typescript
// Insert before the existing hub switch logic:

// Step 1: Set drain flag (host_meta is non-synced, no change-log needed)
db.query(
	"INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)",
).run("relay_draining", "true");

// Step 2: Wait for relay outbox to drain
const drainTimeoutMs = (relayConfig?.drain_timeout_seconds ?? 120) * 1000;
const drainStart = Date.now();
let drained = false;

while (Date.now() - drainStart < drainTimeoutMs) {
	const pending = db
		.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0")
		.get() as { count: number };

	if (pending.count === 0) {
		drained = true;
		break;
	}

	logger.info(`Draining relay outbox: ${pending.count} entries remaining...`);
	await Bun.sleep(1000);
}

if (!drained) {
	const remaining = db
		.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0")
		.get() as { count: number };
	logger.warn(
		`Drain timeout reached with ${remaining.count} entries remaining. Proceeding with hub switch.`,
	);
}

// Step 3: Proceed with hub switch (existing logic)
// ...

// Step 4: Clear drain flag (host_meta is non-synced)
db.query("DELETE FROM host_meta WHERE key = 'relay_draining'").run();
```

**Testing:**

Tests must verify:
- **mcp-relay.AC4.1:** Call set-hub → drain flag set → outbox polled → outbox empties → hub switch proceeds
- **mcp-relay.AC4.5:** Call set-hub with outbox entries that never get delivered → drain timeout (use short timeout for test) → hub switch proceeds anyway → drain flag cleared

**Verification:**

Run: `bun test packages/cli`
Expected: All existing + new tests pass.

**Commit:** `feat(cli): add relay outbox drain to boundctl set-hub with configurable timeout`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify held messages deliver to new hub

**Verifies:** mcp-relay.AC4.4

**Files:**
- Create: `packages/sync/src/__tests__/relay-drain.integration.test.ts`

**Testing:**

Integration test verifying the complete drain + switch + delivery flow:

1. Set up hub A, spoke B, hub C (three instances via test harness)
2. Spoke B writes request-kind relay entries to outbox targeting hub A
3. Hub A sets `relay_draining = true`
4. Spoke B syncs → receives draining flag → holds back request-kind entries
5. Hub A verifies outbox is drained (response-kind completed)
6. Switch spoke B's hub to hub C
7. Spoke B syncs with hub C → held request-kind entries now deliver to hub C

- **mcp-relay.AC4.4:** After hub switch, spoke's held request-kind entries (still `delivered = 0`) are sent in the first sync with the new hub

Additional tests:
- **mcp-relay.AC4.2:** During drain, spoke sends response-kind entries but holds back tool_call entries
- **mcp-relay.AC4.3:** Cancel entries flow during drain alongside response-kind entries

Follow multi-instance test patterns from `packages/sync/src/__tests__/multi-instance.integration.test.ts`: random ports, unique testRunId, createTestInstance().

**Verification:**

Run: `bun test packages/sync/src/__tests__/relay-drain.integration.test.ts`
Expected: All tests pass.

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `test(sync): add relay drain integration tests for hub migration`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->
