# Sync Encryption Implementation Plan — Phase 5: Error Handling and Logging

**Goal:** Implement the full error taxonomy and logging discipline for the encryption layer, including startup fatal paths, encryption-layer error classification, and the plaintext logging debug feature.

**Architecture:** Consolidate error responses across middleware (Phase 3) into the 4 defined error classes. Add structured logging throughout the encryption pipeline (middleware, transport, key-manager). Introduce `BOUND_LOG_SYNC_PLAINTEXT=1` env var for debug-mode plaintext body logging with startup WARNING. KeyManager init failure triggers FATAL log + process exit.

**Tech Stack:** Logger interface from @bound/shared (debug/info/warn/error), Hono middleware, process.env, bun:test

**Scope:** Phase 5 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC10: Error Response Format
- **sync-encryption.AC10.1 Success:** Encryption-layer errors (plaintext rejection, fingerprint mismatch, decryption failure, malformed headers) return plaintext JSON with Content-Type: application/json (R-SE22)
- **sync-encryption.AC10.2 Success:** Application-layer errors return encrypted JSON (encryption channel intact)
- **sync-encryption.AC10.3 Success:** Decryption failure response includes no oracle details (R-SE11)

### sync-encryption.AC11: Logging Discipline
- **sync-encryption.AC11.1 Success:** Normal operation logs ciphertext length, nonce, siteId, endpoint -- never plaintext bodies (R-SE20)
- **sync-encryption.AC11.2 Success:** BOUND_LOG_SYNC_PLAINTEXT=1 enables plaintext body logging with startup WARNING
- **sync-encryption.AC11.3 Success:** Encryption-layer failures logged at WARN (plaintext rejection, fingerprint mismatch) or ERROR (decryption failure)

---

<!-- START_TASK_1 -->
### Task 1: Standardize encryption error responses in middleware

**Verifies:** sync-encryption.AC10.1, sync-encryption.AC10.2, sync-encryption.AC10.3

**Files:**
- Modify: `packages/sync/src/middleware.ts` (error response sections from Phase 3)

**Implementation:**

Review and standardize all encryption-layer error responses in the middleware (implemented in Phase 3) to match the 4 defined error classes exactly:

```typescript
// R-SE10: Plaintext rejection (WARN level)
{ error: "plaintext_rejected", message: "Plaintext sync requests are not accepted. Upgrade to a version with sync encryption." }
// Status: 400, Content-Type: application/json (Hono c.json() ensures this)

// R-SE11: Decryption failure (ERROR level)
{ error: "decryption_failed", site_id: string, hint: "Check that keyring.json is identical on both hosts." }
// Status: 400 — NO oracle details (no specific crypto error message)

// R-SE12: Fingerprint mismatch (WARN level)
{ error: "key_mismatch", site_id: string, expected_fingerprint: string, received_fingerprint: string }
// Status: 400

// R-SE21: Malformed headers (WARN level)
{ error: "malformed_encryption_headers", message: string }
// Status: 400
```

Verify that:
1. All 4 error types use `c.json()` which sets `Content-Type: application/json` (R-SE22).
2. These errors are returned **before** the response encryption hook runs (they bypass `await next()`), so they're always plaintext.
3. Application-layer errors (from route handlers) go through `await next()` and then the response encryption hook, so they're encrypted.
4. The decryption failure error does NOT include the actual crypto error message (no oracle — R-SE11). The catch block in Phase 3's middleware uses a generic hint regardless of the specific failure.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `fix(sync): standardize encryption error response format`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add structured logging to encryption pipeline

**Verifies:** sync-encryption.AC11.1, sync-encryption.AC11.3

**Files:**
- Modify: `packages/sync/src/middleware.ts` (add logger parameter and log statements)
- Modify: `packages/sync/src/transport.ts` (add logger parameter and log statements)
- Modify: `packages/sync/src/routes.ts` (pass logger to middleware)

**Implementation:**

Add a `logger` parameter to `createSyncAuthMiddleware`:

```typescript
export function createSyncAuthMiddleware(
	keyring: KeyringConfig,
	keyManager?: KeyManager,
	logger?: Logger,
): MiddlewareHandler<AppContext>
```

Add logging at these points in the middleware:

```typescript
// Normal operation: log metadata, never plaintext (R-SE20)
// After successful decryption:
logger?.info("Encrypted request decrypted", {
	siteId: result.value.siteId,
	endpoint: path,
	ciphertextLength: bodyBytes.length,
	nonce: nonceHex,
});

// After response encryption:
logger?.info("Response encrypted", {
	siteId: spokeSiteId,
	endpoint: path,
	ciphertextLength: responseCiphertext.length,
	nonce: responseNonceHex,
});

// Encryption-layer failures at appropriate levels:
// WARN for plaintext rejection (AC11.3):
logger?.warn("Plaintext sync request rejected", { siteId: siteIdHeader, endpoint: path });

// WARN for fingerprint mismatch (AC11.3):
logger?.warn("Key fingerprint mismatch", {
	siteId: siteIdHeader,
	expected: expectedFingerprint,
	received: fingerprint,
});

// ERROR for decryption failure (AC11.3):
logger?.error("Decryption failed", {
	siteId: result.value.siteId,
	endpoint: path,
	ciphertextLength: bodyBytes.length,
});

// WARN for malformed headers (AC11.3):
logger?.warn("Malformed encryption headers", {
	siteId: siteIdHeader,
	encryption: encryption,
	nonceLength: nonceHex?.length,
});
```

In `SyncTransport`, add an optional logger parameter:

```typescript
constructor(
	private keyManager: KeyManager,
	private privateKey: CryptoKey,
	private siteId: string,
	private logger?: Logger,
) {}
```

Log in `send()`:
```typescript
this.logger?.info("Sending encrypted request", {
	endpoint: path,
	targetSiteId,
	ciphertextLength: ciphertext.length,
	nonce: nonceHex,
});
```

Pass logger through from `routes.ts` to the middleware:
```typescript
app.use("/sync/*", createSyncAuthMiddleware(keyring, keyManager, logger));
app.use("/api/relay-deliver", createSyncAuthMiddleware(keyring, keyManager, logger));
```

**Key design decisions:**
- Logger is optional (backward compatible with tests that don't provide it).
- Normal operation logs: ciphertext length, nonce (hex), siteId, endpoint. NEVER plaintext body content.
- Log levels follow the design: WARN for rejected-but-expected errors, ERROR for unexpected failures.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add structured logging to encryption pipeline`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Implement BOUND_LOG_SYNC_PLAINTEXT env var

**Verifies:** sync-encryption.AC11.2

**Files:**
- Modify: `packages/sync/src/middleware.ts` (add plaintext logging behind env var)
- Modify: `packages/cli/src/commands/start.ts` (add startup WARNING when env var is set)

**Implementation:**

At the top of `middleware.ts`, read the env var:

```typescript
const LOG_SYNC_PLAINTEXT = process.env.BOUND_LOG_SYNC_PLAINTEXT === "1";
```

After successful decryption in the middleware, add:

```typescript
if (LOG_SYNC_PLAINTEXT) {
	const decryptedBody = c.get("rawBody") as string;
	logger?.debug("Decrypted request body (PLAINTEXT LOGGING ENABLED)", {
		siteId: result.value.siteId,
		endpoint: path,
		body: decryptedBody,
	});
}
```

In `start.ts`, after KeyManager initialization (Phase 2 Task 6), add a startup warning:

```typescript
if (process.env.BOUND_LOG_SYNC_PLAINTEXT === "1") {
	appContext.logger.warn(
		"BOUND_LOG_SYNC_PLAINTEXT=1 is set. Decrypted sync request bodies will be logged. " +
		"This should only be used for debugging and NEVER in production.",
	);
}
```

**Key design decisions:**
- Uses `debug` level for plaintext body logging (only visible when LOG_LEVEL=debug).
- Startup WARNING is `warn` level (always visible in normal operation).
- The env var check is a simple string comparison, consistent with existing `BIND_HOST` pattern.

**Verification:**

Manual verification:
1. Run with `BOUND_LOG_SYNC_PLAINTEXT=1` — verify startup WARNING logged.
2. Send encrypted request — verify plaintext body appears in debug logs.
3. Run without the env var — verify no plaintext bodies in logs.

**Commit:** `feat(sync): add BOUND_LOG_SYNC_PLAINTEXT debug logging`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Ensure startup FATAL on KeyManager init failure

**Verifies:** sync-encryption.AC1.5 (final wiring)

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (KeyManager init error handling from Phase 2 Task 6)

**Implementation:**

This was partially addressed in Phase 2 Task 6, but verify and harden the error handling:

```typescript
try {
	await keyManager.init(keyring);
	appContext.logger.info(
		`Encryption initialized: ${Object.keys(keyring.hosts).length} peers, local fingerprint ${keyManager.getLocalFingerprint()}`,
	);
} catch (err) {
	// R-SE19: Key derivation failure is FATAL
	appContext.logger.error("FATAL: Failed to initialize encryption key manager. Sync encryption requires valid Ed25519 keys.", {
		error: err instanceof Error ? err.message : String(err),
	});
	process.exit(1);
}
```

Note: The Logger interface has no `fatal()` method. Use `error()` with "FATAL:" prefix in the message, followed by `process.exit(1)`. This matches the existing pattern in `packages/cli/src/bound.ts`.

**Verification:**

Manual verification: Corrupt the host.key file and attempt to start with keyring configured. Verify the process exits with FATAL log.

**Commit:** `fix(cli): ensure FATAL exit on encryption key derivation failure`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Tests for error handling and logging

**Verifies:** sync-encryption.AC10.1, sync-encryption.AC10.2, sync-encryption.AC10.3, sync-encryption.AC11.1, sync-encryption.AC11.3

**Files:**
- Create: `packages/sync/src/__tests__/encryption-errors.test.ts`

**Testing:**

Create a test file that verifies the complete error taxonomy. Use a Hono app with encrypted middleware and a mock logger that captures log calls.

Mock logger setup:
```typescript
function createCapturingLogger() {
	const logs: { level: string; message: string; context?: Record<string, unknown> }[] = [];
	return {
		logger: {
			debug: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: "debug", message: msg, context: ctx }),
			info: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: "info", message: msg, context: ctx }),
			warn: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: "warn", message: msg, context: ctx }),
			error: (msg: string, ctx?: Record<string, unknown>) => logs.push({ level: "error", message: msg, context: ctx }),
		} as Logger,
		logs,
	};
}
```

Tests:

- **sync-encryption.AC10.1 (plaintext JSON errors):** For each of the 4 error types (plaintext_rejected, decryption_failed, key_mismatch, malformed_encryption_headers), verify the response has `Content-Type: application/json` and the response body is parseable JSON.
- **sync-encryption.AC10.2 (encrypted app errors):** Trigger an application-layer error (e.g., invalid JSON in encrypted request body). Verify the error response has `X-Encryption` header (it went through the response encryption hook).
- **sync-encryption.AC10.3 (no oracle):** Trigger decryption failure by sending ciphertext encrypted with wrong key. Verify the error response contains `hint` field but NOT the actual crypto error message (no "authentication tag mismatch" or similar).
- **sync-encryption.AC11.1 (normal logging):** Send a successful encrypted request. Verify logger was called with `info` level, and the log context contains `ciphertextLength`, `nonce`, `siteId`, `endpoint`. Verify no log entry contains the plaintext body content.
- **sync-encryption.AC11.3 (failure log levels):** For each error type, verify the log level matches: plaintext rejection = WARN, fingerprint mismatch = WARN, decryption failure = ERROR, malformed headers = WARN.

**Verification:**

Run: `bun test packages/sync/src/__tests__/encryption-errors.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encryption error handling and logging tests`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Client-side handling of plaintext error responses

**Verifies:** sync-encryption.AC7.4

**Files:**
- Modify: `packages/sync/src/transport.ts` (decryptResponse method, already handles absent X-Encryption)

**Implementation:**

Verify that `SyncTransport.decryptResponse()` (implemented in Phase 2 Task 3) correctly handles plaintext error responses:

1. When `X-Encryption` header is absent, return raw text (already implemented).
2. When status code indicates an encryption-layer error (400 with known error types), parse as JSON and provide structured error info.
3. Add logging for error responses:

```typescript
private async decryptResponse(response: Response, targetSiteId: string): Promise<string> {
	const encryption = response.headers.get("X-Encryption");

	if (!encryption) {
		// Plaintext response — encryption-layer error (R-SE22)
		const text = await response.text();
		if (response.status >= 400) {
			this.logger?.warn("Received plaintext error response", {
				status: response.status,
				targetSiteId,
			});
		}
		return text;
	}

	// ... existing decryption logic ...
}
```

This is primarily a verification task — Phase 2 already implemented the core logic. This task ensures logging is in place and the error path works correctly.

**Verification:**

Run: `bun test packages/sync/src/__tests__/transport.test.ts`
Expected: All tests pass (including plaintext error response tests from Phase 2).

**Commit:** `feat(sync): add logging for plaintext error responses in transport`
<!-- END_TASK_6 -->
