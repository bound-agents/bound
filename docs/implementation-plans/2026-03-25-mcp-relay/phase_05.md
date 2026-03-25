# MCP Relay Transport — Phase 5: Eager Push

**Goal:** Low-latency relay delivery for addressable hosts via HTTP push from the hub.

**Architecture:** After the hub stores a relay message for a spoke during the RELAY sync phase, it immediately attempts an HTTP POST to the spoke's `/api/relay-deliver` endpoint (using the spoke's `sync_url` from the hosts table). The push is signed with Ed25519 using the hub's private key. A reachability tracker (in-memory Map) marks spokes unreachable after 3 consecutive failures, falling back to sync-only delivery. Successful sync resets the failure counter.

**Tech Stack:** Hono (routes), Ed25519 signing, fetch(), TypeScript

**Scope:** 8 phases from original design (phase 5 of 8)

**Codebase verified:** 2026-03-25

---

## Acceptance Criteria Coverage

This phase implements and tests:

### mcp-relay.AC2: Eager push for addressable hosts
- **mcp-relay.AC2.1 Success:** Hub eager-pushes relay messages to addressable spoke via `/api/relay-deliver`
- **mcp-relay.AC2.2 Success:** Duplicate delivery (eager push + sync) deduped via `INSERT OR IGNORE` on UUID PK
- **mcp-relay.AC2.3 Failure:** Eager push failure degrades to sync-only delivery (invisible to requester)
- **mcp-relay.AC2.4 Edge:** 3 consecutive push failures mark spoke unreachable; next successful sync resets

### mcp-relay.AC9: Data integrity
- **mcp-relay.AC9.4 Success:** `/api/relay-deliver` accepts only messages from current hub (Ed25519 verified)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add /api/relay-deliver endpoint on spoke side

**Verifies:** mcp-relay.AC2.2, mcp-relay.AC9.4

**Files:**
- Modify: `packages/sync/src/routes.ts` (add relay-deliver endpoint after existing ack handler)

**Implementation:**

Add a `POST /api/relay-deliver` endpoint that accepts relay messages pushed from the hub. The endpoint:

1. Is protected by the same `createSyncAuthMiddleware(keyring)` — Ed25519 verified (AC9.4)
2. Validates that the sender is the current hub (compare `c.get("siteId")` against known hub siteId)
3. Parses the request body as an array of relay inbox entries
4. Inserts each entry via `insertInbox()` (INSERT OR IGNORE for dedup — AC2.2)
5. Returns `{ ok: true, received: count }` response

The endpoint needs to know the hub's siteId to validate the sender. Add a `hubSiteId` parameter to `createSyncRoutes()`:

```typescript
export function createSyncRoutes(
	db: Database,
	siteId: string,
	keyring: KeyringConfig,
	_eventBus: TypedEventEmitter,
	logger: Logger,
	relayExecutor?: RelayExecutor,
	hubSiteId?: string,
): Hono<AppContext>
```

The endpoint handler:

```typescript
app.post("/api/relay-deliver", async (c) => {
	const senderSiteId = c.get("siteId") as string;

	// Only accept messages from the current hub
	if (hubSiteId && senderSiteId !== hubSiteId) {
		return c.json({ ok: false, error: "Not from current hub" }, 403);
	}

	const body = JSON.parse(c.get("rawBody")) as { entries: RelayInboxEntry[] };
	let received = 0;
	for (const entry of body.entries) {
		const inserted = insertInbox(db, entry);
		if (inserted) received++;
	}

	return c.json({ ok: true, received });
});
```

Apply auth middleware to the new path:

```typescript
app.use("/api/relay-deliver", createSyncAuthMiddleware(keyring));
```

**Testing:**

Tests must verify:
- **mcp-relay.AC9.4:** Request from a non-hub siteId → 403 "Not from current hub"
- **mcp-relay.AC2.2:** Push same entry twice → first insert succeeds, second deduped (INSERT OR IGNORE), received count is 1 on second call

Additional tests:
- Valid request from hub siteId → entries inserted → 200 with received count
- Invalid signature → 401 (handled by auth middleware)

**Verification:**

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): add /api/relay-deliver endpoint with hub-only authentication`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create reachability tracker

**Files:**
- Create: `packages/sync/src/reachability.ts`

**Implementation:**

Create an in-memory reachability tracker that the hub uses to decide whether to attempt eager push to a spoke. The tracker:

- Initializes all hosts as reachable (`reachable: true, failureCount: 0`)
- On push failure: increments `failureCount`, sets `reachable = false` when count reaches 3
- On successful sync from spoke: resets `failureCount = 0`, `reachable = true`

```typescript
interface ReachabilityState {
	reachable: boolean;
	failureCount: number;
}

export class ReachabilityTracker {
	private states = new Map<string, ReachabilityState>();
	private readonly maxFailures: number;

	constructor(maxFailures: number = 3) {
		this.maxFailures = maxFailures;
	}

	isReachable(siteId: string): boolean {
		const state = this.states.get(siteId);
		if (!state) return true; // Unknown hosts assumed reachable
		return state.reachable;
	}

	recordFailure(siteId: string): void {
		const state = this.states.get(siteId) ?? { reachable: true, failureCount: 0 };
		state.failureCount++;
		if (state.failureCount >= this.maxFailures) {
			state.reachable = false;
		}
		this.states.set(siteId, state);
	}

	recordSuccess(siteId: string): void {
		this.states.set(siteId, { reachable: true, failureCount: 0 });
	}

	getState(siteId: string): ReachabilityState | undefined {
		return this.states.get(siteId);
	}
}
```

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add reachability tracker for eager push failure counting`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Implement eager push sender on hub side

**Verifies:** mcp-relay.AC2.1, mcp-relay.AC2.3, mcp-relay.AC2.4

**Files:**
- Create: `packages/sync/src/eager-push.ts`
- Modify: `packages/sync/src/routes.ts` (call eager push after storing relay messages)

**Implementation:**

Create an eager push sender that the hub calls after storing relay messages for spokes during the RELAY sync phase. The sender:

1. Checks if the target spoke is reachable (via ReachabilityTracker)
2. Looks up the spoke's URL from the hosts table `sync_url` field (or keyring)
3. Signs the request with the hub's Ed25519 private key using `signRequest()`
4. POSTs the relay entries to `{spokeUrl}/api/relay-deliver`
5. On success: marks entries as delivered, records success in tracker
6. On failure: does NOT mark as delivered (sync will deliver), records failure in tracker (AC2.3)

The hub needs access to its private key for signing outbound requests. Currently `privateKey` is only passed to `SyncClient`. Update the routes setup to receive the private key:

```typescript
export interface EagerPushConfig {
	privateKey: CryptoKey;
	siteId: string;
	db: Database;
	keyring: KeyringConfig;
	reachabilityTracker: ReachabilityTracker;
	logger: Logger;
}

export async function eagerPushToSpoke(
	config: EagerPushConfig,
	targetSiteId: string,
	entries: RelayInboxEntry[],
): Promise<boolean> {
	if (!config.reachabilityTracker.isReachable(targetSiteId)) {
		config.logger.debug("Skipping eager push to unreachable spoke", { targetSiteId });
		return false;
	}

	// Look up spoke URL from hosts table
	const host = config.db
		.query("SELECT sync_url FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(targetSiteId) as { sync_url: string | null } | null;

	if (!host?.sync_url) {
		// NAT'd host — no URL, sync-only delivery
		return false;
	}

	try {
		const body = JSON.stringify({ entries });
		const headers = await signRequest(
			config.privateKey,
			config.siteId,
			"POST",
			"/api/relay-deliver",
			body,
		);

		const response = await fetch(`${host.sync_url}/api/relay-deliver`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(5000),
		});

		if (response.ok) {
			config.reachabilityTracker.recordSuccess(targetSiteId);
			return true;
		}
		config.reachabilityTracker.recordFailure(targetSiteId);
		return false;
	} catch {
		config.reachabilityTracker.recordFailure(targetSiteId);
		return false;
	}
}
```

Integrate into the hub's `/sync/relay` route handler (Phase 2's Task 3). After storing relay messages for spoke targets, fire eager push as a non-blocking side effect:

```typescript
// In the /sync/relay handler, after writing messages for spoke targets:
// Fire-and-forget — push failure is invisible to requester (AC2.3)
if (eagerPushConfig) {
	void eagerPushToSpoke(eagerPushConfig, entry.target_site_id, [inboxEntry]);
}
```

Update `createSyncRoutes()` to accept `EagerPushConfig`:

```typescript
export function createSyncRoutes(
	db: Database,
	siteId: string,
	keyring: KeyringConfig,
	eventBus: TypedEventEmitter,
	logger: Logger,
	relayExecutor?: RelayExecutor,
	hubSiteId?: string,
	eagerPushConfig?: EagerPushConfig,
): Hono<AppContext>
```

Wire up the reachability reset on successful sync: in the `/sync/push` handler, after a spoke successfully pushes, call `reachabilityTracker.recordSuccess(pusherSiteId)`.

**Testing:**

Tests must verify:
- **mcp-relay.AC2.1:** Hub receives relay message for addressable spoke → eager push POST sent to spoke's sync_url + /api/relay-deliver → spoke receives entries
- **mcp-relay.AC2.3:** Eager push fails (spoke unreachable) → no error returned to requester → message still in hub outbox for sync delivery
- **mcp-relay.AC2.4:** Three push failures to same spoke → tracker marks unreachable → subsequent pushes skipped → spoke syncs successfully → tracker resets → pushes resume

Additional tests:
- Spoke with no sync_url (NAT'd) → push skipped, sync-only delivery
- Push timeout (5s) → treated as failure

**Verification:**

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `feat(sync): implement eager push sender with reachability tracking`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire private key into hub routes and start.ts

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (pass private key to sync routes for eager push)

**Implementation:**

Update the `createSyncRoutes()` call in `start.ts` to pass the hub's private key and reachability tracker for eager push.

```typescript
import { ReachabilityTracker } from "@bound/sync";

const reachabilityTracker = new ReachabilityTracker();

// Determine hub siteId from keyring (for spoke-side validation)
const hubSiteIdFromKeyring = syncConfig
	? Object.entries(keyring.hosts).find(([_, v]) => v.url === syncConfig.hub)?.[0]
	: undefined;

const eagerPushConfig = {
	privateKey: keypair.privateKey,
	siteId,
	db,
	keyring,
	reachabilityTracker,
	logger,
};

const syncRoutes = createSyncRoutes(
	db,
	siteId,
	keyring,
	eventBus,
	logger,
	relayExecutor,
	hubSiteIdFromKeyring,
	eagerPushConfig,
);
```

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

**Commit:** `feat(cli): wire private key and reachability tracker into sync routes for eager push`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5) -->
<!-- START_TASK_5 -->
### Task 5: Eager push tests

**Verifies:** mcp-relay.AC2.1, mcp-relay.AC2.2, mcp-relay.AC2.3, mcp-relay.AC2.4, mcp-relay.AC9.4

**Files:**
- Create: `packages/sync/src/__tests__/eager-push.test.ts` (unit)
- Create: `packages/sync/src/__tests__/reachability.test.ts` (unit)

**Testing:**

**reachability.test.ts** — Unit tests for ReachabilityTracker:
- Unknown host defaults to reachable
- One failure → still reachable (failureCount=1)
- Three failures → unreachable
- Record success after failures → resets to reachable with failureCount=0
- **mcp-relay.AC2.4:** Full state transition cycle: reachable → 3 failures → unreachable → sync success → reachable

**eager-push.test.ts** — Unit tests for eagerPushToSpoke:

Use multi-instance test harness pattern with a mock spoke HTTP server that accepts/rejects relay deliveries.

- **mcp-relay.AC2.1:** Hub pushes entry to spoke → spoke receives it at /api/relay-deliver → returns success → hub marks delivery success
- **mcp-relay.AC2.2:** Push delivers entry to spoke → sync also delivers same entry (same ID) → spoke has only one copy (INSERT OR IGNORE dedup)
- **mcp-relay.AC2.3:** Spoke's /api/relay-deliver returns 500 → eager push returns false → no error propagated → message remains in hub outbox
- **mcp-relay.AC9.4:** Push from non-hub siteId → spoke rejects with 403

**Verification:**

Run: `bun test packages/sync/src/__tests__/eager-push.test.ts`
Run: `bun test packages/sync/src/__tests__/reachability.test.ts`
Expected: All tests pass.

Run: `bun test packages/sync`
Expected: All existing + new tests pass.

**Commit:** `test(sync): add eager push and reachability tracker tests`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_C -->
