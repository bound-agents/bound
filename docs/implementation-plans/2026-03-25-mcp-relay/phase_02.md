# MCP Relay Transport — Phase 2: Sync RELAY Phase

**Goal:** Extend the sync protocol with a 4th RELAY phase for bidirectional relay message exchange between spokes via the hub.

**Architecture:** A new `POST /sync/relay` endpoint handles the relay phase as a separate HTTP call after ACK. Spoke sends undelivered outbox entries, hub routes them (locally for self-targeted, stores for spoke-targeted), and responds with inbox entries + delivery confirmations. The spoke marks delivered and inserts received messages. A callback-based executor hook allows Phase 4 to plug in local MCP execution.

**Design deviation (justified):** The design shows relay fields as part of existing SyncRequest/SyncResponse. This plan instead uses a separate `POST /sync/relay` endpoint with distinct `RelayRequest`/`RelayResponse` types. This provides cleaner separation — relay failure is isolated from push/pull/ack, and the existing sync contract is not bloated. Functionally equivalent to the design's "4-phase sync exchange."

**Tech Stack:** Hono (routes), bun:sqlite, Ed25519 signing, TypeScript

**Scope:** 8 phases from original design (phase 2 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC1: Cross-host MCP calls via relay
- **mcp-relay.AC1.2 Success:** Tool call targeting the hub executes locally during RELAY phase (single round-trip)

### mcp-relay.AC5: Idempotency
- **mcp-relay.AC5.2 Success:** Hub rejects duplicate outbox pushes with same idempotency_key

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Extend wire format types for relay

**Files:**
- Modify: `packages/sync/src/changeset.ts` (add relay request/response types)

**Implementation:**

Add relay-specific wire format types alongside the existing `Changeset` type. These types represent the relay portion of the sync exchange — separate from the existing changeset push/pull flow.

```typescript
import type { RelayOutboxEntry, RelayInboxEntry } from "@bound/shared";

export interface RelayRequest {
	relay_outbox: RelayOutboxEntry[];
}

export interface RelayResponse {
	relay_inbox: RelayInboxEntry[];
	relay_delivered: string[];
	relay_draining: boolean;
}
```

Export these types from `packages/sync/src/index.ts`.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add RelayRequest and RelayResponse wire format types`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add hub-side relay executor callback type

**Files:**
- Create: `packages/sync/src/relay-executor.ts`

**Implementation:**

Define a callback type for hub-local relay execution. When the hub receives a relay message targeting itself, it needs to execute the request locally and return a response. Phase 4 provides the real implementation; Phase 2 provides the type and a no-op default.

```typescript
import type { RelayOutboxEntry, RelayInboxEntry } from "@bound/shared";

/**
 * Callback for executing relay requests locally on the hub.
 * Phase 4 provides the real implementation that dispatches to local MCP clients.
 * Returns inbox entries (results/errors) to send back to the requester,
 * or an empty array if the request kind is not supported yet.
 */
export type RelayExecutor = (
	request: RelayOutboxEntry,
	hubSiteId: string,
) => Promise<RelayInboxEntry[]>;

/**
 * Default no-op executor that returns an error for all requests.
 * Used until Phase 4 provides a real implementation.
 */
export const noopRelayExecutor: RelayExecutor = async (request, hubSiteId) => {
	const now = new Date().toISOString();
	return [
		{
			id: crypto.randomUUID(),
			source_site_id: hubSiteId,
			kind: "error",
			ref_id: request.id,
			idempotency_key: null,
			payload: JSON.stringify({
				error: "Hub-local relay execution not yet implemented",
				retriable: false,
			}),
			expires_at: request.expires_at,
			received_at: now,
			processed: 0,
		},
	];
};
```

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add RelayExecutor callback type with no-op default`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Add hub-side /sync/relay route handler

**Verifies:** mcp-relay.AC1.2, mcp-relay.AC5.2

**Files:**
- Modify: `packages/sync/src/routes.ts:19` (update `createSyncRoutes` signature and add relay route)

**Implementation:**

Add a `POST /sync/relay` endpoint to the existing sync routes. The hub processes relay outbox entries from the spoke:

1. Parse `RelayRequest` from request body
2. For each outbox entry:
   a. **Idempotency check**: If `idempotency_key` is set, check if hub has already seen it. Reject duplicates (AC5.2).
   b. **Hub-targeted**: If `target_site_id === hubSiteId`, execute locally via the `RelayExecutor` callback. Return results in `relay_inbox`.
   c. **Spoke-targeted**: Store in hub's local `relay_outbox` for delivery to the target spoke on their next sync.
3. Fetch any pending `relay_inbox` entries for the requesting spoke (messages routed to them from other spokes).
4. Return `RelayResponse` with inbox entries, delivered IDs, and draining flag.

Update the `createSyncRoutes` function signature to accept the executor and hub siteId:

```typescript
export function createSyncRoutes(
	db: Database,
	siteId: string,
	keyring: KeyringConfig,
	_eventBus: TypedEventEmitter,
	logger: Logger,
	relayExecutor?: RelayExecutor,
): Hono<AppContext>
```

The route handler:

```typescript
app.post("/sync/relay", async (c) => {
	const body = JSON.parse(c.get("rawBody")) as RelayRequest;
	const requesterSiteId = c.get("siteId");
	const executor = relayExecutor ?? noopRelayExecutor;

	const deliveredIds: string[] = [];
	const inboxForRequester: RelayInboxEntry[] = [];

	for (const entry of body.relay_outbox) {
		// Idempotency check on hub side
		if (entry.idempotency_key) {
			const existing = db
				.query(
					"SELECT id FROM relay_outbox WHERE idempotency_key = ? AND target_site_id = ?",
				)
				.get(entry.idempotency_key, entry.target_site_id) as { id: string } | null;
			if (existing) {
				deliveredIds.push(entry.id);
				continue;
			}
		}

		if (entry.target_site_id === siteId) {
			// Hub-local execution
			const results = await executor(entry, siteId);
			for (const result of results) {
				inboxForRequester.push(result);
			}
		} else {
			// Store for target spoke — write to hub's own outbox for delivery
			// Preserve source_site_id so target knows who sent the request
			writeOutbox(db, {
				id: crypto.randomUUID(),
				source_site_id: requesterSiteId,
				target_site_id: entry.target_site_id,
				kind: entry.kind,
				ref_id: entry.ref_id ?? entry.id,
				idempotency_key: entry.idempotency_key,
				payload: entry.payload,
				created_at: new Date().toISOString(),
				expires_at: entry.expires_at,
			});
		}
		deliveredIds.push(entry.id);
	}

	// Fetch pending inbox entries for this requester from hub's outbox
	// (messages routed to requester from other spokes)
	const pendingForRequester = readUndelivered(db, requesterSiteId);
	for (const pending of pendingForRequester) {
		inboxForRequester.push({
			id: pending.id,
			source_site_id: pending.source_site_id ?? requesterSiteId,
			kind: pending.kind,
			ref_id: pending.ref_id,
			idempotency_key: pending.idempotency_key,
			payload: pending.payload,
			expires_at: pending.expires_at,
			received_at: new Date().toISOString(),
			processed: 0,
		});
	}
	// Mark those as delivered on hub
	if (pendingForRequester.length > 0) {
		markDelivered(
			db,
			pendingForRequester.map((p) => p.id),
		);
	}

	const response: RelayResponse = {
		relay_inbox: inboxForRequester,
		relay_delivered: deliveredIds,
		relay_draining: false, // Phase 6 implements drain logic
	};

	return c.json(response);
});
```

Import `writeOutbox`, `readUndelivered`, `markDelivered` from `@bound/core` and `RelayRequest`, `RelayResponse` from `./changeset.js`. Import `RelayExecutor`, `noopRelayExecutor` from `./relay-executor.js`.

**Testing:**

Tests must verify:
- **mcp-relay.AC1.2:** Relay message targeting hub's own siteId triggers executor callback, result returned in same response's `relay_inbox`
- **mcp-relay.AC5.2:** Second relay message with same `idempotency_key` and `target_site_id` is accepted (ID in `relay_delivered`) but not stored again / not re-executed

Additional transport tests:
- Relay message targeting another spoke is stored in hub's outbox
- Pending messages for the requesting spoke are included in response `relay_inbox`
- Empty relay_outbox results in empty response

Follow existing integration test patterns from `packages/sync/src/__tests__/multi-instance.integration.test.ts`: use `createTestInstance()` from test-harness, random ports, unique testRunId.

**Verification:**

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): add POST /sync/relay hub route with local execution and idempotency`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Add spoke-side RELAY phase to sync loop

**Files:**
- Modify: `packages/sync/src/sync-loop.ts:103` (add relay phase after ack)

**Implementation:**

Add a `relay()` method to the `SyncClient` class and call it as the 4th phase in `syncCycle()` after `ack()`. The spoke:

1. Reads all undelivered outbox entries via `readUndelivered(db)`
2. POSTs them to `POST ${hubUrl}/sync/relay` with Ed25519 signing
3. Processes the response:
   - Marks `relay_delivered` IDs as delivered in local outbox
   - Inserts `relay_inbox` entries into local inbox via `insertInbox()` (INSERT OR IGNORE for dedup)
   - Stores `relay_draining` flag for Phase 6 to use

Add the relay method to `SyncClient`:

```typescript
async relay(): Promise<Result<RelayResult, SyncError>> {
	const outbox = readUndelivered(this.db);

	const relayRequest: RelayRequest = {
		relay_outbox: outbox,
	};

	const body = JSON.stringify(relayRequest);
	const headers = await signRequest(
		this.privateKey,
		this.siteId,
		"POST",
		"/sync/relay",
		body,
	);

	const response = await fetch(`${this.hubUrl}/sync/relay`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body,
	});

	if (!response.ok) {
		return err({
			phase: "relay",
			message: `Relay failed: ${response.status}`,
		});
	}

	const relayResponse = (await response.json()) as RelayResponse;

	// Mark delivered
	if (relayResponse.relay_delivered.length > 0) {
		markDelivered(this.db, relayResponse.relay_delivered);
	}

	// Insert inbox entries (INSERT OR IGNORE for dedup)
	let received = 0;
	for (const entry of relayResponse.relay_inbox) {
		const inserted = insertInbox(this.db, entry);
		if (inserted) received++;
	}

	return ok({
		sent: outbox.length,
		received,
		draining: relayResponse.relay_draining,
	});
}
```

Define `RelayResult`:

```typescript
export interface RelayResult {
	sent: number;
	received: number;
	draining: boolean;
}
```

Update `syncCycle()` to call relay after ack:

```typescript
// After ack phase (~line 103), add:
const relayResult = await this.relay();
if (!relayResult.ok) {
	this.logger.warn("Relay phase failed", { error: relayResult.error });
	// Relay failure is non-fatal — sync still succeeds
}
```

Import `readUndelivered`, `markDelivered`, `insertInbox` from `@bound/core` and relay types from `./changeset.js`.

Also extend `SyncResult` to include relay information:

```typescript
export interface SyncResult {
	pushed: number;
	pulled: number;
	relay?: RelayResult;
}
```

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): add spoke-side RELAY phase to sync loop after ACK`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->
<!-- START_TASK_5 -->
### Task 5: Relay transport integration tests

**Verifies:** mcp-relay.AC1.2, mcp-relay.AC5.2

**Files:**
- Create: `packages/sync/src/__tests__/relay.integration.test.ts`

**Testing:**

Follow the multi-instance integration test pattern from `packages/sync/src/__tests__/multi-instance.integration.test.ts` and `test-harness.ts`:
- Use `createTestInstance()` with role="hub" and role="spoke"
- Random ports + unique testRunId per test
- Pre-generate keypairs for shared keyring

Tests must verify:
- **mcp-relay.AC1.2:** Spoke writes relay outbox entry targeting hub's siteId → runs syncCycle() → hub executes locally via executor callback → spoke receives result in relay_inbox
- **mcp-relay.AC5.2:** Spoke sends two relay messages with same idempotency_key → hub accepts first, deduplicates second → both IDs appear in relay_delivered but only one execution occurs

Additional transport tests:
- **Spoke→Hub→Spoke flow:** Spoke A writes relay outbox targeting Spoke B → Spoke A syncs → hub stores for B → Spoke B syncs → Spoke B receives message in inbox. Requires two spoke instances + one hub.
- **Empty relay:** Spoke with no outbox entries syncs → relay phase succeeds with empty response
- **Relay failure non-fatal:** If relay endpoint returns error, sync still completes (pushed/pulled data preserved)
- **INSERT OR IGNORE dedup:** Same relay inbox entry delivered twice (simulating eager push + sync) → only one row in inbox

Note: The test-harness.ts `createTestInstance()` must pass the `relayExecutor` parameter to `createSyncRoutes()`. Update the test harness to accept an optional executor:

```typescript
export async function createTestInstance(config: {
	// ...existing fields...
	relayExecutor?: RelayExecutor;
}): Promise<TestInstance>
```

For hub-local execution tests, provide a simple executor that echoes back a result payload.

**Verification:**

Run: `bun test packages/sync/src/__tests__/relay.integration.test.ts`
Expected: All tests pass.

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `test(sync): add relay transport integration tests for hub routing and idempotency`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_C -->
