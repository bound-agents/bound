# Sync Encryption Implementation Plan — Phase 3: Server-Side Decryption

**Goal:** Hub decrypts incoming encrypted requests, encrypts responses, and enforces mandatory encryption for all sync traffic.

**Architecture:** Extend `createSyncAuthMiddleware` with encryption verification steps slotted before existing signature verification. The middleware reads the body as binary (ArrayBuffer), performs encryption header checks and fingerprint validation, then passes ciphertext bytes to `verifyRequest` for signature verification, then decrypts and sets plaintext as `rawBody`. A response hook encrypts outbound JSON. `createSyncRoutes` receives a `KeyManager` parameter; route handlers are unchanged (they still get plaintext JSON from `rawBody`).

**Tech Stack:** Existing encryption primitives from Phase 1, KeyManager from Phase 1, Hono middleware, bun:test

**Scope:** Phase 3 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC6: Server-Side Decryption
- **sync-encryption.AC6.1 Success:** Hub decrypts incoming request body and provides plaintext JSON to route handlers
- **sync-encryption.AC6.2 Success:** Verification order: encryption check -> fingerprint -> signature -> timestamp -> nonce -> decrypt
- **sync-encryption.AC6.3 Failure:** Corrupted ciphertext rejected with HTTP 400, generic hint in response, full error logged locally (R-SE11)
- **sync-encryption.AC6.4 Failure:** Malformed X-Nonce (wrong length, missing) rejected with HTTP 400 (R-SE21)

### sync-encryption.AC7: Response Encryption
- **sync-encryption.AC7.1 Success:** Hub encrypts response body with spoke's symmetric key and fresh nonce
- **sync-encryption.AC7.2 Success:** Response includes X-Encryption and X-Nonce headers
- **sync-encryption.AC7.3 Success:** Spoke decrypts response; successful AEAD decryption implicitly authenticates hub
- **sync-encryption.AC7.4 Edge:** Spoke detects plaintext error responses by absent X-Encryption header (R-SE22)

### sync-encryption.AC8: Mandatory Encryption Enforcement
- **sync-encryption.AC8.1 Failure:** Plaintext request (missing X-Encryption) rejected with HTTP 400 and upgrade message (R-SE10)
- **sync-encryption.AC8.2 Failure:** X-Nonce present without X-Encryption rejected as ambiguous (R-SE21)
- **sync-encryption.AC8.3 Failure:** X-Encryption present without X-Nonce rejected as malformed (R-SE21)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Extend createSyncAuthMiddleware with encryption verification and decryption

**Verifies:** sync-encryption.AC6.1, sync-encryption.AC6.2, sync-encryption.AC6.3, sync-encryption.AC6.4, sync-encryption.AC7.1, sync-encryption.AC7.2, sync-encryption.AC8.1, sync-encryption.AC8.2, sync-encryption.AC8.3

**Files:**
- Modify: `packages/sync/src/middleware.ts` (lines 1-59, substantial rewrite of the middleware function)

**Implementation:**

The middleware needs major changes. The new function signature adds `keyManager`:

```typescript
export function createSyncAuthMiddleware(
	keyring: KeyringConfig,
	keyManager?: KeyManager,
): MiddlewareHandler<AppContext>
```

When `keyManager` is provided (hub with encryption), the full encryption verification pipeline runs. When absent (single-node without keyring), fall through to existing signature-only verification.

**New verification order (per sync-encryption.AC6.2):**

```typescript
return async (c: Context<AppContext>, next) => {
	const method = c.req.method;
	const path = c.req.path;

	// Read body as binary (not text) to support encrypted payloads
	const bodyBytes = new Uint8Array(await c.req.arrayBuffer());

	const headers: Record<string, string> = {};
	c.req.raw.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});

	const encryption = headers["x-encryption"];
	const nonceHex = headers["x-nonce"];
	const fingerprint = headers["x-key-fingerprint"];

	if (keyManager) {
		// Step 1: Encryption check — reject plaintext (R-SE10)
		if (!encryption) {
			if (nonceHex) {
				// X-Nonce without X-Encryption is ambiguous (R-SE21, AC8.2)
				return c.json(
					{ error: "malformed_encryption_headers", message: "X-Nonce present without X-Encryption" },
					400,
				);
			}
			return c.json(
				{ error: "plaintext_rejected", message: "Plaintext sync requests are not accepted. Upgrade to a version with sync encryption." },
				400,
			);
		}

		// Step 2: Validate X-Encryption value and X-Nonce presence (R-SE21, AC8.3)
		if (encryption !== "xchacha20") {
			return c.json(
				{ error: "malformed_encryption_headers", message: `Unsupported encryption: ${encryption}` },
				400,
			);
		}
		if (!nonceHex || nonceHex.length !== 48) {
			return c.json(
				{ error: "malformed_encryption_headers", message: "X-Nonce must be 48 hex characters (24 bytes)" },
				400,
			);
		}

		// Step 3: Fingerprint validation (R-SE12, AC3.3)
		const siteIdHeader = headers["x-site-id"];
		if (siteIdHeader && fingerprint) {
			const expectedFingerprint = keyManager.getFingerprint(siteIdHeader);
			if (expectedFingerprint && fingerprint !== expectedFingerprint) {
				return c.json(
					{
						error: "key_mismatch",
						site_id: siteIdHeader,
						expected_fingerprint: expectedFingerprint,
						received_fingerprint: fingerprint,
					},
					400,
				);
			}
		}

		// Step 4: Signature verification over ciphertext (existing, body is now Uint8Array)
		// verifyRequest needs to accept string | Uint8Array body (extended in Phase 2)
		const bodyForVerification = bodyBytes; // ciphertext bytes
		const result = await verifyRequest(keyring, method, path, headers, bodyForVerification);

		if (!result.ok) {
			const error = result.error;
			let statusCode: 401 | 403 | 408 | 500 = 500;
			if (error.code === "unknown_site") statusCode = 403;
			else if (error.code === "invalid_signature") statusCode = 401;
			else if (error.code === "stale_timestamp") statusCode = 408;
			return c.json({ error: error.message }, statusCode);
		}

		c.set("siteId", result.value.siteId);
		c.set("hostName", result.value.hostName);

		// Step 5: Decrypt body (R-SE11, AC6.3)
		const symmetricKey = keyManager.getSymmetricKey(result.value.siteId);
		if (!symmetricKey) {
			return c.json(
				{ error: "decryption_failed", site_id: result.value.siteId, hint: "Check that keyring.json is identical on both hosts." },
				400,
			);
		}

		try {
			const nonce = Buffer.from(nonceHex, "hex");
			const plaintext = decryptBody(bodyBytes, nonce, symmetricKey);
			c.set("rawBody", new TextDecoder().decode(plaintext));
		} catch {
			return c.json(
				{ error: "decryption_failed", site_id: result.value.siteId, hint: "Check that keyring.json is identical on both hosts." },
				400,
			);
		}
	} else {
		// No encryption — existing signature-only path for single-node
		const body = new TextDecoder().decode(bodyBytes);
		c.set("rawBody", body);

		const result = await verifyRequest(keyring, method, path, headers, body);
		if (!result.ok) {
			const error = result.error;
			let statusCode: 401 | 403 | 408 | 500 = 500;
			if (error.code === "unknown_site") statusCode = 403;
			else if (error.code === "invalid_signature") statusCode = 401;
			else if (error.code === "stale_timestamp") statusCode = 408;
			return c.json({ error: error.message }, statusCode);
		}
		c.set("siteId", result.value.siteId);
		c.set("hostName", result.value.hostName);
	}

	// Clock skew detection (unchanged)
	const remoteTimestamp = headers["x-timestamp"];
	if (remoteTimestamp) {
		const now = new Date().toISOString();
		const skew = detectClockSkew(now, remoteTimestamp);
		if (skew !== null) {
			c.header("X-Clock-Skew", skew.toString());
		}
	}

	// Response encryption hook — encrypt outbound response if keyManager is present
	await next();

	if (keyManager) {
		const spokeSiteId = c.get("siteId");
		if (spokeSiteId) {
			const spokeKey = keyManager.getSymmetricKey(spokeSiteId);
			// Guard: skip if already encrypted (prevent double-encryption)
			const existingContentType = c.res.headers.get("Content-Type");
			if (spokeKey && existingContentType !== "application/octet-stream") {
				// Clone response to avoid consuming the body stream
				const responseBody = await c.res.clone().text();
				const responsePlaintext = new TextEncoder().encode(responseBody);
				const { ciphertext: responseCiphertext, nonce: responseNonce } = encryptBody(responsePlaintext, spokeKey);
				const responseNonceHex = Buffer.from(responseNonce).toString("hex");

				c.res = new Response(responseCiphertext, {
					status: c.res.status,
					headers: {
						"X-Encryption": "xchacha20",
						"X-Nonce": responseNonceHex,
						"Content-Type": "application/octet-stream",
					},
				});
			}
		}
	}
};
```

**Key design decisions:**
- Body is read as `ArrayBuffer` and converted to `Uint8Array` (line ~6) instead of `c.req.text()`. This supports binary ciphertext.
- `verifyRequest` must accept `string | Uint8Array` body — this was extended in Phase 2 Task 1 for `signRequest`, and the same change is needed for `verifyRequest`. The body parameter in `verifyRequest` (signing.ts line 49) should also be changed to `string | Uint8Array`.
- Encryption-layer error responses are **plaintext JSON** (R-SE22) — they use `c.json()` before decryption.
- Application-layer errors (from route handlers after `await next()`) go through the response encryption hook, so they are encrypted.
- The response encryption hook runs **after** the route handler via `await next()`. It reads the response body, encrypts it, and replaces `c.res` with a new encrypted Response.
- `KeyManager` is optional — when absent, existing signature-only flow is preserved for single-node deployments.

**Note:** The `verifyRequest` type extension to `string | Uint8Array` was already done in Phase 2 Task 1 (both `signRequest` and `verifyRequest` were extended together). No additional signing.ts changes needed in this phase.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add encryption verification and response encryption to middleware`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for encrypted middleware

**Verifies:** sync-encryption.AC6.1, sync-encryption.AC6.2, sync-encryption.AC6.3, sync-encryption.AC6.4, sync-encryption.AC7.1, sync-encryption.AC7.2, sync-encryption.AC7.3, sync-encryption.AC7.4, sync-encryption.AC8.1, sync-encryption.AC8.2, sync-encryption.AC8.3

**Files:**
- Create: `packages/sync/src/__tests__/encrypted-middleware.test.ts`

**Testing:**

Set up a Hono app with `createSyncAuthMiddleware(keyring, keyManager)` and a simple echo route that returns `c.get("rawBody")`. Use real keypairs, real KeyManager, and SyncTransport to send encrypted requests.

Tests must verify each AC:

- **sync-encryption.AC6.1:** Send encrypted request via SyncTransport. Verify route handler receives decrypted plaintext JSON in `rawBody`.
- **sync-encryption.AC6.2:** (Covered implicitly by the success/failure ordering in other tests)
- **sync-encryption.AC6.3:** Send request with valid headers but corrupted ciphertext (flip a byte). Verify HTTP 400 with `{ error: "decryption_failed" }` and generic hint. Verify no plaintext in error response.
- **sync-encryption.AC6.4:** Send request with `X-Encryption: "xchacha20"` but `X-Nonce` of wrong length (e.g., 46 chars). Verify HTTP 400 with `malformed_encryption_headers`. Also test missing `X-Nonce` entirely.
- **sync-encryption.AC7.1:** Send encrypted request. Verify response body is encrypted (not plaintext JSON). Decrypt with spoke's symmetric key and verify it matches the route handler's return value.
- **sync-encryption.AC7.2:** Verify response has `X-Encryption: "xchacha20"` and `X-Nonce` (48 hex chars) headers.
- **sync-encryption.AC7.3:** Full round-trip: SyncTransport sends encrypted request, middleware decrypts, route responds, middleware encrypts response, SyncTransport decrypts response. Verify final plaintext matches expected.
- **sync-encryption.AC7.4:** Force a route handler error (e.g., invalid JSON parse). The error response should be encrypted (application-layer error). Separately, test that encryption-layer errors (fingerprint mismatch) are plaintext JSON.
- **sync-encryption.AC8.1:** Send plaintext request (no `X-Encryption` header) to encrypted middleware. Verify HTTP 400 with `plaintext_rejected` error.
- **sync-encryption.AC8.2:** Send request with `X-Nonce` but no `X-Encryption`. Verify HTTP 400 with `malformed_encryption_headers`.
- **sync-encryption.AC8.3:** Send request with `X-Encryption` but no `X-Nonce`. Verify HTTP 400 with `malformed_encryption_headers`.

**Verification:**

Run: `bun test packages/sync/src/__tests__/encrypted-middleware.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encrypted middleware unit tests`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Pass KeyManager to createSyncRoutes and web server

**Verifies:** sync-encryption.AC6.1

**Files:**
- Modify: `packages/sync/src/routes.ts` (line 15, add `keyManager` parameter; line 35, pass to middleware)
- Modify: `packages/web/src/server/index.ts` (lines 99-109, pass `keyManager` to createSyncRoutes)

**Implementation:**

In `packages/sync/src/routes.ts`, add `keyManager?: KeyManager` as a parameter to `createSyncRoutes`:

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
	keyManager?: KeyManager,  // New parameter
): Hono<AppContext>
```

At line 35, change:
```typescript
app.use("/sync/*", createSyncAuthMiddleware(keyring));
```
to:
```typescript
app.use("/sync/*", createSyncAuthMiddleware(keyring, keyManager));
```

And similarly at line 38 for the relay-deliver endpoint:
```typescript
app.use("/api/relay-deliver", createSyncAuthMiddleware(keyring, keyManager));
```

In `packages/web/src/server/index.ts`, add `keyManager` to the call at lines 99-109. The `appConfig` type needs to include `keyManager`. Add it to the server config type and pass it through from `start.ts`.

In `packages/cli/src/commands/start.ts`, the `keyManager` instance created in Phase 2 Task 6 needs to be passed to the web server config so it reaches `createSyncRoutes`. Find where the web server config is assembled (look for the object that becomes `appConfig` in index.ts) and add the `keyManager` property.

**Verification:**

Run: `tsc -p packages/sync --noEmit && tsc -p packages/web --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors.

Run: `bun test packages/sync`
Expected: All tests pass (existing tests pass keyManager as undefined, using signature-only path).

**Commit:** `feat(sync): pass KeyManager through routes to middleware`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update index.ts exports for Phase 3

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/sync/src/index.ts` (add createSyncAuthMiddleware if not already exported, verify KeyManager export)

**Implementation:**

Verify that `createSyncAuthMiddleware` is already exported (it is, at line 6). No additional exports needed for Phase 3 beyond what was added in Phases 1 and 2.

If `verifyRequest` needs to be exported for external use (it currently isn't), add:
```typescript
export { verifyRequest } from "./signing.js";
```

**Verification:**

Run: `bun test packages/sync`
Expected: All tests pass, zero regressions.

**Commit:** `chore(sync): verify Phase 3 exports`
<!-- END_TASK_4 -->
