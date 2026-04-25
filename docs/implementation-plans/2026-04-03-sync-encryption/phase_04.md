# Sync Encryption Implementation Plan — Phase 4: Eager Push Encryption

**Goal:** Hub-to-spoke eager push relay delivery uses the same XChaCha20-Poly1305 encryption scheme as regular sync traffic.

**Architecture:** Refactor `eagerPushToSpoke` to use `SyncTransport` instead of inline `fetch()` with `signRequest()`. The `EagerPushConfig` interface is extended with an optional `transport` field. When provided, the hub encrypts eager push payloads with the target spoke's symmetric key. The spoke's middleware (from Phase 3) already handles decryption of incoming requests on the `/api/relay-deliver` endpoint.

**Tech Stack:** SyncTransport from Phase 2, existing eager-push patterns, bun:test

**Scope:** Phase 4 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC9: Eager Push Encryption
- **sync-encryption.AC9.1 Success:** Hub encrypts eager push body with target spoke's symmetric key
- **sync-encryption.AC9.2 Success:** Spoke decrypts eager push using shared secret with hub
- **sync-encryption.AC9.3 Success:** Reachability tracking unaffected by encryption layer

---

<!-- START_TASK_1 -->
### Task 1: Extend EagerPushConfig with optional SyncTransport

**Verifies:** sync-encryption.AC9.1

**Files:**
- Modify: `packages/sync/src/eager-push.ts` (lines 7-14, EagerPushConfig interface; lines 37-52, request sending logic)
- Modify: `packages/cli/src/commands/start.ts` (lines 839-849, eagerPushConfig creation)

**Implementation:**

Add optional `transport` field to `EagerPushConfig` at line 14:

```typescript
export interface EagerPushConfig {
	privateKey: CryptoKey;
	siteId: string;
	db: Database;
	keyring: KeyringConfig;
	reachabilityTracker: ReachabilityTracker;
	logger: Logger;
	transport?: SyncTransport;  // New: optional encrypted transport
}
```

In `eagerPushToSpoke` (lines 37-52), replace the inline fetch pattern with a conditional that uses SyncTransport when available:

**Before (lines 37-52):**
```typescript
const body = JSON.stringify({ entries });
const headers = await signRequest(config.privateKey, config.siteId, "POST", "/api/relay-deliver", body);
const response = await fetch(`${host.sync_url}/api/relay-deliver`, {
	method: "POST",
	headers: { ...headers, "Content-Type": "application/json" },
	body,
	signal: AbortSignal.timeout(5000),
});
```

**After:**
```typescript
const body = JSON.stringify({ entries });
let response: Response | TransportResponse;

if (config.transport) {
	response = await config.transport.send(
		"POST",
		`${host.sync_url}/api/relay-deliver`,
		"/api/relay-deliver",
		body,
		targetSiteId,
	);
} else {
	const headers = await signRequest(config.privateKey, config.siteId, "POST", "/api/relay-deliver", body);
	response = await fetch(`${host.sync_url}/api/relay-deliver`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body,
		signal: AbortSignal.timeout(5000),
	});
}
```

Note: `SyncTransport.send()` should be extended with an optional `signal?: AbortSignal` parameter (to be added to `transport.ts` as part of this task). The signal is forwarded to the internal `fetch()` call. This keeps timeout handling consistent with the existing `AbortSignal.timeout(5000)` pattern:

```typescript
if (config.transport) {
	response = await config.transport.send(
		"POST",
		`${host.sync_url}/api/relay-deliver`,
		"/api/relay-deliver",
		body,
		targetSiteId,
		AbortSignal.timeout(5000),
	);
}
```

In `transport.ts`, add `signal` as an optional 6th parameter to `send()` and forward it to `fetch()`:
```typescript
async send(method, url, path, body, targetSiteId, signal?: AbortSignal): Promise<TransportResponse> {
	// ... existing encrypt/sign logic ...
	const response = await fetch(url, { method, headers: { ... }, body: ciphertext, signal });
	// ...
}
```

In `packages/cli/src/commands/start.ts` (lines 839-849), add `transport` to the eagerPushConfig object when encryption is initialized:

```typescript
const eagerPushConfig =
	keyring && appContext.siteId
		? {
				privateKey: keypair.privateKey,
				siteId: appContext.siteId,
				db: appContext.db,
				keyring,
				reachabilityTracker,
				logger: appContext.logger,
				transport,  // From Phase 2 Task 6 — undefined when no encryption
			}
		: undefined;
```

**Key design decisions:**
- `transport` is optional in EagerPushConfig to preserve backward compatibility.
- Reachability tracking (success/failure recording, skip-if-unreachable) is entirely outside the transport conditional and remains unchanged.
- The timeout handling differs between encrypted and plaintext paths (Promise.race vs AbortSignal). This is acceptable since the effect is the same (5s timeout).

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

Run: `bun test packages/sync/src/__tests__/eager-push.test.ts`
Expected: Existing tests pass (no transport provided, uses plaintext path).

**Commit:** `feat(sync): add encryption support to eager push`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for encrypted eager push

**Verifies:** sync-encryption.AC9.1, sync-encryption.AC9.2, sync-encryption.AC9.3

**Files:**
- Create: `packages/sync/src/__tests__/eager-push-encrypted.test.ts`

**Testing:**

Set up two hosts (hub + spoke) with real keypairs, KeyManagers, and SyncTransport. Start a Hono server on the spoke side with encrypted middleware on `/api/relay-deliver`. Use `eagerPushToSpoke` from the hub with transport configured.

Tests must verify each AC:

- **sync-encryption.AC9.1:** Call `eagerPushToSpoke` with transport configured. On the spoke server, intercept the raw request before middleware processing. Verify the body is NOT plaintext JSON (it's encrypted ciphertext). Verify the request has `X-Encryption: "xchacha20"` and `X-Nonce` headers.
- **sync-encryption.AC9.2:** Full round-trip: hub sends encrypted eager push, spoke middleware decrypts, route handler receives plaintext `{ entries: [...] }`. Verify the entries match what was sent.
- **sync-encryption.AC9.3:** Send an eager push to an unreachable spoke (server not running). Verify `eagerPushToSpoke` returns `false` and the reachability tracker records a failure. Then send to a reachable spoke. Verify it returns `true` and the reachability tracker records success. This proves reachability tracking is unaffected by encryption.

Additional tests:
- **Without transport (backward compat):** Call `eagerPushToSpoke` without transport in config. Verify it sends plaintext (existing behavior).
- **Timeout:** If the spoke server delays response beyond 5 seconds, verify the push times out and returns false.

**Verification:**

Run: `bun test packages/sync/src/__tests__/eager-push-encrypted.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encrypted eager push tests`
<!-- END_TASK_2 -->
