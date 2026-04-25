# Sync Encryption Implementation Plan — Phase 2: Client-Side Encryption

**Goal:** Encrypt all outbound sync requests from spoke to hub using XChaCha20-Poly1305 via the SyncTransport class.

**Architecture:** New `SyncTransport` class wraps the encrypt-sign-fetch-decrypt pipeline. `signRequest()` extended to accept `string | Uint8Array` so signatures cover ciphertext bytes. `SyncClient` refactored to use injected `SyncTransport` instead of inline `fetch()` calls. Bootstrap in `start.ts` wires `KeyManager` and `SyncTransport` into the sync initialization sequence.

**Tech Stack:** Existing encryption primitives from Phase 1, Bun CryptoHasher (already accepts Uint8Array), Hono fetch

**Scope:** Phase 2 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC4: Request Body Encryption
- **sync-encryption.AC4.1 Success:** Request body encrypted with XChaCha20-Poly1305 using peer's symmetric key
- **sync-encryption.AC4.2 Success:** Random 192-bit nonce generated per message via crypto.getRandomValues()
- **sync-encryption.AC4.3 Success:** Empty bodies produce valid ciphertext (16-byte auth tag for zero-length plaintext)

### sync-encryption.AC5: Encrypted Request Headers
- **sync-encryption.AC5.1 Success:** X-Encryption: "xchacha20" header present on all encrypted requests
- **sync-encryption.AC5.2 Success:** X-Nonce header contains hex-encoded 192-bit nonce (48 hex chars)
- **sync-encryption.AC5.3 Success:** Content-Type set to application/octet-stream for encrypted bodies
- **sync-encryption.AC5.4 Success:** Ed25519 signature covers ciphertext, not plaintext (R-SE6)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Extend signRequest to accept string | Uint8Array body

**Verifies:** sync-encryption.AC5.4

**Files:**
- Modify: `packages/sync/src/signing.ts` (line 19, body parameter type; lines 27-29, body hashing)

**Implementation:**

Change the `body` parameter type from `string` to `string | Uint8Array` in **both** `signRequest()` and `verifyRequest()`. Bun's `CryptoHasher.update()` already accepts both `string` and `BufferSource` (which includes `Uint8Array`), so the hashing code needs no change — just the type annotations.

In `signRequest()` at line 19, change:
```typescript
body: string,
```
to:
```typescript
body: string | Uint8Array,
```

In `verifyRequest()` at line 49, change:
```typescript
body: string,
```
to:
```typescript
body: string | Uint8Array,
```

Both changes are needed because Phase 3's middleware passes ciphertext `Uint8Array` to `verifyRequest()` for signature verification over ciphertext. The `CryptoHasher.update()` call already handles both types. Existing callers that pass strings continue to work (backward compatible).

**Testing:**

Tests must verify:
- **sync-encryption.AC5.4:** Call `signRequest` with a `Uint8Array` body. Call `verifyRequest` with the same `Uint8Array` body. Verify signature validates successfully — proving signatures work over binary ciphertext.
- **Backward compatibility:** Call `signRequest` with a string body (existing behavior). Verify it still works identically.
- **Consistency:** Sign a string body and sign `TextEncoder.encode(sameString)` as Uint8Array. Verify both produce the same signature (SHA-256 of string and its UTF-8 bytes should match since CryptoHasher normalizes).

Extend existing test file `packages/sync/src/__tests__/signing.test.ts` with a new describe block for Uint8Array support.

**Verification:**

Run: `bun test packages/sync/src/__tests__/signing.test.ts`
Expected: All existing tests pass plus new Uint8Array tests pass.

**Commit:** `feat(sync): extend signRequest to accept Uint8Array body`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for signRequest Uint8Array support

**Verifies:** sync-encryption.AC5.4

**Files:**
- Modify: `packages/sync/src/__tests__/signing.test.ts` (add new describe block after existing tests)

**Testing:**

Add a new `describe("signRequest with Uint8Array body")` block to the existing signing test file. Tests:

- **Binary body round-trip:** Generate keypair, sign a `Uint8Array` body, verify signature with the same `Uint8Array`. Verify `result.ok === true`.
- **String-to-bytes equivalence:** Sign `"hello world"` as string and `new TextEncoder().encode("hello world")` as Uint8Array. Verify both produce the same `X-Signature` header value.
- **Empty Uint8Array:** Sign `new Uint8Array(0)`. Verify signature validates.

Note: The `verifyRequest` type change (also to `string | Uint8Array`) was included in Task 1 above. Ensure both functions are tested with `Uint8Array` bodies.

**Verification:**

Run: `bun test packages/sync/src/__tests__/signing.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add signing tests for Uint8Array body support`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->
<!-- START_TASK_3 -->
### Task 3: Create SyncTransport class

**Verifies:** sync-encryption.AC4.1, sync-encryption.AC4.2, sync-encryption.AC4.3, sync-encryption.AC5.1, sync-encryption.AC5.2, sync-encryption.AC5.3, sync-encryption.AC5.4

**Files:**
- Create: `packages/sync/src/transport.ts`

**Implementation:**

Create `packages/sync/src/transport.ts` with the `SyncTransport` class. This class encapsulates the encrypt-sign-fetch-decrypt pipeline, replacing inline `fetch()` calls.

```typescript
import { encryptBody, decryptBody } from "./encryption.js";
import { signRequest } from "./signing.js";
import type { KeyManager } from "./key-manager.js";

export interface TransportResponse {
	status: number;
	body: string;
	headers: Headers;
}

export class SyncTransport {
	constructor(
		private keyManager: KeyManager,
		private privateKey: CryptoKey,
		private siteId: string,
	) {}

	/**
	 * Send an encrypted, signed request to a sync peer.
	 *
	 * Pipeline: JSON string -> encode -> encrypt -> sign(ciphertext) -> fetch -> decrypt response
	 *
	 * @param method HTTP method (POST for all sync endpoints)
	 * @param url Full URL (e.g., "http://hub:3000/sync/push")
	 * @param path URL path component for signature (e.g., "/sync/push")
	 * @param body JSON string to encrypt and send
	 * @param targetSiteId Site ID of the target host (for symmetric key lookup)
	 */
	async send(
		method: string,
		url: string,
		path: string,
		body: string,
		targetSiteId: string,
	): Promise<TransportResponse> {
		const symmetricKey = this.keyManager.getSymmetricKey(targetSiteId);
		if (!symmetricKey) {
			throw new Error(`No symmetric key for peer ${targetSiteId}`);
		}

		// Encrypt
		const plaintext = new TextEncoder().encode(body);
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

		// Sign the ciphertext (R-SE6: signature covers ciphertext, not plaintext)
		const signHeaders = await signRequest(
			this.privateKey,
			this.siteId,
			method,
			path,
			ciphertext,
		);

		// Fetch with encryption headers
		const nonceHex = Buffer.from(nonce).toString("hex");
		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": this.keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: ciphertext,
		});

		// Decrypt response if encrypted
		const responseBody = await this.decryptResponse(response, targetSiteId);

		return {
			status: response.status,
			body: responseBody,
			headers: response.headers,
		};
	}

	/**
	 * Decrypt response body if X-Encryption header is present.
	 * If absent (e.g., plaintext error response per R-SE22), return raw text.
	 */
	private async decryptResponse(
		response: Response,
		targetSiteId: string,
	): Promise<string> {
		const encryption = response.headers.get("X-Encryption");

		if (!encryption) {
			// Plaintext response (error responses per R-SE22)
			return response.text();
		}

		const nonceHex = response.headers.get("X-Nonce");
		if (!nonceHex || nonceHex.length !== 48) {
			throw new Error(
				`Invalid X-Nonce in response: expected 48 hex chars, got ${nonceHex?.length ?? "null"}`,
			);
		}

		const symmetricKey = this.keyManager.getSymmetricKey(targetSiteId);
		if (!symmetricKey) {
			throw new Error(`No symmetric key for peer ${targetSiteId} to decrypt response`);
		}

		const nonce = Buffer.from(nonceHex, "hex");
		const ciphertext = new Uint8Array(await response.arrayBuffer());
		const plaintext = decryptBody(ciphertext, nonce, symmetricKey);
		return new TextDecoder().decode(plaintext);
	}
}
```

**Key design decisions:**
- `send()` takes the same `body: string` that SyncClient currently passes to `signRequest()`. Encryption is transparent to SyncClient.
- Signature covers **ciphertext** (R-SE6), not plaintext. This is critical — signRequest receives ciphertext bytes.
- Response decryption handles both encrypted responses (has `X-Encryption` header) and plaintext error responses (no `X-Encryption` header, per R-SE22).
- Nonce is hex-encoded (48 chars for 24 bytes) in both request and response headers.
- `Content-Type: application/octet-stream` replaces `application/json` for encrypted bodies.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

**Commit:** `feat(sync): add SyncTransport encrypt-sign-fetch-decrypt pipeline`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Tests for SyncTransport

**Verifies:** sync-encryption.AC4.1, sync-encryption.AC4.2, sync-encryption.AC4.3, sync-encryption.AC5.1, sync-encryption.AC5.2, sync-encryption.AC5.3, sync-encryption.AC5.4

**Files:**
- Create: `packages/sync/src/__tests__/transport.test.ts`

**Testing:**

Create a test that uses real crypto (KeyManager with real keypairs) and a local Hono server to verify the full transport pipeline. Follow the pattern from `packages/sync/src/__tests__/sync-e2e.test.ts` which spins up real HTTP servers on random ports.

Test setup:
- Generate two Ed25519 keypairs (spoke + hub)
- Build keyring with both
- Create KeyManager for spoke, init with keyring
- Create SyncTransport for spoke
- Start a Hono server that receives the request and verifies headers

Tests must verify each AC:

- **sync-encryption.AC4.1:** Send a JSON body via transport. On the server side, verify the received body is NOT the original JSON (it's encrypted ciphertext). Decrypt it with hub's symmetric key and verify it matches original.
- **sync-encryption.AC4.2:** Send two requests. Verify `X-Nonce` headers differ (random nonce per message).
- **sync-encryption.AC4.3:** Send an empty body `""`. Verify server receives valid ciphertext (should be 16 bytes — auth tag only). Decrypt and verify empty result.
- **sync-encryption.AC5.1:** Verify request has `X-Encryption: "xchacha20"` header.
- **sync-encryption.AC5.2:** Verify request has `X-Nonce` header that is exactly 48 hex characters.
- **sync-encryption.AC5.3:** Verify request has `Content-Type: application/octet-stream`.
- **sync-encryption.AC5.4:** Extract `X-Signature` from request. Verify signature validates against the **ciphertext** body (not the original JSON plaintext). Use `verifyRequest` from signing.ts with the raw ciphertext bytes as the body.

Additional tests:
- **Response decryption:** Server sends encrypted response with `X-Encryption` and `X-Nonce` headers. Verify transport.send() returns decrypted JSON body.
- **Plaintext error response:** Server sends plaintext JSON error (no `X-Encryption` header). Verify transport returns the raw error text.
- **Unknown peer:** Call `send()` with an unknown targetSiteId. Verify it throws "No symmetric key for peer".

**Verification:**

Run: `bun test packages/sync/src/__tests__/transport.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add SyncTransport unit tests`
<!-- END_TASK_4 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->
<!-- START_TASK_5 -->
### Task 5: Refactor SyncClient to use SyncTransport

**Verifies:** sync-encryption.AC4.1, sync-encryption.AC5.1, sync-encryption.AC5.3

**Files:**
- Modify: `packages/sync/src/sync-loop.ts` (constructor at lines 47-62, push at lines 218-250, pull at lines 252-292, ack at lines 294-324, relay at lines 326-421)

**Implementation:**

Add an optional `transport?: SyncTransport` parameter to the `SyncClient` constructor. When provided, all 4 sync phases use `transport.send()` instead of inline `fetch()`. When not provided (single-node without keyring), existing behavior is preserved.

Constructor change (add after line 55):
```typescript
constructor(
	private db: Database,
	private siteId: string,
	private privateKey: CryptoKey,
	private hubUrl: string,
	private logger: Logger,
	private eventBus: TypedEventEmitter,
	private keyring: KeyringConfig,
	private transport?: SyncTransport,  // New optional parameter
)
```

For each of the 4 fetch() calls (push, pull, ack, relay), replace the inline fetch pattern with a conditional:

**Before (push example, lines 222-232):**
```typescript
const body = serializeChangeset(changeset);
const headers = await signRequest(this.privateKey, this.siteId, "POST", "/sync/push", body);
const response = await fetch(`${this.hubUrl}/sync/push`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		...headers,
	},
	body,
});
```

**After (push):**
```typescript
const body = serializeChangeset(changeset);
if (this.transport && this.hubSiteId) {
	const tr = await this.transport.send("POST", `${this.hubUrl}/sync/push`, "/sync/push", body, this.hubSiteId);
	if (tr.status !== 200) throw new Error(`Push failed: ${tr.status}`);
	return JSON.parse(tr.body);
} else {
	const headers = await signRequest(this.privateKey, this.siteId, "POST", "/sync/push", body);
	const response = await fetch(`${this.hubUrl}/sync/push`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body,
	});
	// ... existing response handling ...
}
```

**After (pull) — the most complex response handling:**
```typescript
const body = JSON.stringify({ since_seq: sinceSeq });
if (this.transport && this.hubSiteId) {
	const tr = await this.transport.send("POST", `${this.hubUrl}/sync/pull`, "/sync/pull", body, this.hubSiteId);
	if (tr.status !== 200) throw new Error(`Pull failed: ${tr.status}`);
	return deserializeChangeset(tr.body);  // tr.body is already decrypted string
} else {
	// ... existing fetch + response.text() + deserializeChangeset() ...
}
```

**After (relay) — JSON response parsing:**
```typescript
const body = JSON.stringify(relayRequest);
if (this.transport && this.hubSiteId) {
	const tr = await this.transport.send("POST", `${this.hubUrl}/sync/relay`, "/sync/relay", body, this.hubSiteId);
	return JSON.parse(tr.body) as RelayResponse;  // tr.body is already decrypted string
} else {
	// ... existing fetch + response.json() ...
}
```

Apply the same pattern to ack (simple — just checks status).

**Important:** `this.hubSiteId` (private property at line ~73) is resolved by the existing `resolveHubSiteId()` method and cached. Use `this.hubSiteId` directly in the transport path instead of calling `resolveHubSiteId()` each time.

**Key design decisions:**
- Transport is optional to preserve backward compatibility for single-node deployments.
- `this.hubSiteId` is already cached from `resolveHubSiteId()` — use it directly.
- Response body handling: `TransportResponse.body` is already a decrypted string. For `pull`, pass `tr.body` directly to `deserializeChangeset()`. For `relay`, `JSON.parse(tr.body)`. For `push`/`ack`, just check status.

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

Run: `bun test packages/sync`
Expected: All existing sync tests pass (they don't provide transport, so they use the existing fetch path).

**Commit:** `refactor(sync): SyncClient uses optional SyncTransport`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Wire KeyManager and SyncTransport into start.ts

**Verifies:** sync-encryption.AC4.1, sync-encryption.AC5.1

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (lines 1111-1128, sync initialization section)
- Modify: `packages/sync/src/index.ts` (add SyncTransport export)

**Implementation:**

First, add the SyncTransport export to `packages/sync/src/index.ts`:
```typescript
export { SyncTransport } from "./transport.js";
export type { TransportResponse } from "./transport.js";
```

Then, in `packages/cli/src/commands/start.ts`, between keyring loading (line 1111) and SyncClient creation (line 1115), add KeyManager and SyncTransport initialization:

```typescript
// After line 1114 (keyring loading):
const keyringResult = appContext.optionalConfig.keyring;
const keyring = keyringResult?.ok
	? (keyringResult.value as import("@bound/shared").KeyringConfig)
	: { hosts: {} };

// New: Initialize KeyManager and SyncTransport if keyring has peers
let transport: import("@bound/sync").SyncTransport | undefined;
const hasKeyringPeers = Object.keys(keyring.hosts).length > 0;
if (hasKeyringPeers) {
	const { KeyManager, SyncTransport } = await import("@bound/sync");
	const keyManager = new KeyManager(keypair, appContext.siteId);
	try {
		await keyManager.init(keyring);
		appContext.logger.info(
			`Encryption initialized: ${Object.keys(keyring.hosts).length} peers, local fingerprint ${keyManager.getLocalFingerprint()}`,
		);
		transport = new SyncTransport(keyManager, keypair.privateKey, appContext.siteId);
	} catch (err) {
		appContext.logger.fatal("Failed to initialize encryption key manager", { error: err });
		process.exit(1);
	}
}

// Modified SyncClient creation — pass transport as 8th arg:
const syncClient = new SyncClient(
	appContext.db,
	appContext.siteId,
	keypair.privateKey,
	syncConfig.hub,
	appContext.logger,
	appContext.eventBus,
	keyring,
	transport,  // undefined when no keyring peers (single-node)
);
```

**Key design decisions:**
- KeyManager is only created when keyring has peers (`hasKeyringPeers`). Single-node deployments without keyring skip encryption entirely.
- `keyManager.init()` failure triggers `process.exit(1)` per sync-encryption.AC1.5 (FATAL on key derivation failure).
- Local fingerprint is logged at startup for operator verification.
- `transport` is `undefined` for single-node, preserving existing behavior.
- The `keyManager` reference needs to be stored somewhere accessible for Phase 6 (SIGHUP reload). Store it in a variable in the same scope that will be accessible to the SIGHUP handler.

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

Run: `bun test packages/sync`
Expected: All sync tests pass (no regression — transport is optional).

**Commit:** `feat(cli): wire KeyManager and SyncTransport into bootstrap`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

<!-- Task 7 removed: SyncTransport export is already covered in Task 6. -->
