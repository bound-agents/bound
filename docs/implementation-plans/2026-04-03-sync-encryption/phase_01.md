# Sync Encryption Implementation Plan — Phase 1: Crypto Foundation

**Goal:** Establish cryptographic primitives and key management infrastructure for transport-layer encryption.

**Architecture:** Three layers — stateless crypto functions in `encryption.ts`, stateful key management in `key-manager.ts`, and noble library dependencies in `package.json`. Ed25519 identity keys are converted to X25519 for ECDH, then HKDF derives per-peer symmetric keys for XChaCha20-Poly1305 encryption.

**Tech Stack:** @noble/curves (X25519, Ed25519-to-Montgomery), @noble/ciphers (XChaCha20-Poly1305), @noble/hashes (HKDF-SHA256, SHA-256), bun:test

**Scope:** Phase 1 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC1: X25519 Key Derivation
- **sync-encryption.AC1.1 Success:** X25519 key pair is deterministically derived from Ed25519 identity at startup
- **sync-encryption.AC1.2 Success:** Same Ed25519 private key always produces same X25519 private key
- **sync-encryption.AC1.3 Success:** X25519 public key is derivable from Ed25519 public key alone (for keyring peers)
- **sync-encryption.AC1.4 Success:** Raw Ed25519 key bytes extracted via JWK export from crypto.subtle
- **sync-encryption.AC1.5 Failure:** Key derivation failure at startup produces FATAL log and process exit (R-SE19)

### sync-encryption.AC2: Shared Secret Computation
- **sync-encryption.AC2.1 Success:** ECDH shared secret is symmetric (A derives same secret with B as B derives with A)
- **sync-encryption.AC2.2 Success:** HKDF-SHA256 derives 256-bit symmetric key with salt "bound" and info "sync-v1"
- **sync-encryption.AC2.3 Success:** Shared secrets cached in memory per peer, keyed by siteId
- **sync-encryption.AC2.4 Success:** Derived keys and secrets are never written to disk or logged (R-SE13)

### sync-encryption.AC3: Key Fingerprints
- **sync-encryption.AC3.1 Success:** Fingerprint is first 8 bytes (16 hex chars) of SHA-256 of X25519 public key raw bytes
- **sync-encryption.AC3.2 Success:** Fingerprint sent in X-Key-Fingerprint header on requests
- **sync-encryption.AC3.3 Failure:** Fingerprint mismatch rejected with HTTP 400 before decryption attempted (R-SE12)

---

<!-- START_TASK_1 -->
### Task 1: Add noble crypto dependencies

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/sync/package.json` (line 8, inside `dependencies` block)

**Implementation:**

Add three dependencies to `packages/sync/package.json` in the `dependencies` object:

```json
{
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "@noble/ciphers": "^1.2.1",
    "@noble/curves": "^1.8.1",
    "@noble/hashes": "^1.7.1",
    "hono": "^4.0.0"
  }
}
```

**Verification:**

Run: `bun install`
Expected: Installs without errors, lockfile updated.

Run: `bun -e "import { ed25519, x25519 } from '@noble/curves/ed25519'; import { xchacha20poly1305 } from '@noble/ciphers/chacha'; import { hkdf } from '@noble/hashes/hkdf'; import { sha256 } from '@noble/hashes/sha2'; console.log('All noble imports OK')"`
Expected: Prints "All noble imports OK"

**Commit:** `chore(sync): add noble crypto dependencies`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Create encryption.ts — stateless crypto primitives

**Verifies:** sync-encryption.AC1.1, sync-encryption.AC1.2, sync-encryption.AC1.3, sync-encryption.AC1.4, sync-encryption.AC2.1, sync-encryption.AC2.2, sync-encryption.AC3.1, sync-encryption.AC4.1, sync-encryption.AC4.2, sync-encryption.AC4.3

**Files:**
- Create: `packages/sync/src/encryption.ts`

**Implementation:**

Create `packages/sync/src/encryption.ts` with 7 exported functions. All functions are stateless and independently testable.

```typescript
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

const HKDF_SALT = new TextEncoder().encode("bound");
const HKDF_INFO = new TextEncoder().encode("sync-v1");
const SYMMETRIC_KEY_LENGTH = 32;

/**
 * Extract raw Ed25519 key bytes from CryptoKey objects via JWK export.
 * Returns 32-byte private seed (from JWK "d" field) and 32-byte public point (from JWK "x" field).
 */
export async function extractRawEd25519Keys(
	keypair: { publicKey: CryptoKey; privateKey: CryptoKey },
): Promise<{ pubRaw: Uint8Array; privRaw: Uint8Array }> {
	const [pubJwk, privJwk] = await Promise.all([
		crypto.subtle.exportKey("jwk", keypair.publicKey),
		crypto.subtle.exportKey("jwk", keypair.privateKey),
	]);

	if (!pubJwk.x || !privJwk.d) {
		throw new Error("Failed to extract raw Ed25519 key bytes from JWK export");
	}

	const pubRaw = base64urlToBytes(pubJwk.x);
	const privRaw = base64urlToBytes(privJwk.d);
	return { pubRaw, privRaw };
}

/**
 * Convert Ed25519 public key (32 bytes) to X25519 public key (32 bytes).
 * Uses the birational map from Edwards to Montgomery form.
 */
export function ed25519ToX25519Public(ed25519PubRaw: Uint8Array): Uint8Array {
	return ed25519.ExtendedPoint.fromHex(ed25519PubRaw).toX25519();
}

/**
 * Convert Ed25519 private key seed (32 bytes) to X25519 private key (32 bytes).
 * Hashes the seed and applies scalar clamping per RFC 7748.
 */
export function ed25519ToX25519Private(ed25519PrivRaw: Uint8Array): Uint8Array {
	return ed25519.utils.toMontgomerySecret(ed25519PrivRaw);
}

/**
 * Compute ECDH shared secret and derive symmetric key via HKDF-SHA256.
 * Salt: "bound", Info: "sync-v1", Output: 32 bytes.
 */
export function deriveSharedSecret(
	localX25519Priv: Uint8Array,
	peerX25519Pub: Uint8Array,
): Uint8Array {
	const rawSecret = x25519.getSharedSecret(localX25519Priv, peerX25519Pub);
	return hkdf(sha256, rawSecret, HKDF_SALT, HKDF_INFO, SYMMETRIC_KEY_LENGTH);
}

/**
 * Compute fingerprint: first 8 bytes (16 hex chars) of SHA-256 of X25519 public key.
 */
export function computeFingerprint(x25519PubRaw: Uint8Array): string {
	const hash = sha256(x25519PubRaw);
	return Buffer.from(hash.slice(0, 8)).toString("hex");
}

/**
 * Encrypt plaintext with XChaCha20-Poly1305.
 * Generates a random 24-byte nonce. Returns ciphertext (includes 16-byte auth tag) and nonce.
 */
export function encryptBody(
	plaintext: Uint8Array,
	symmetricKey: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
	const nonce = crypto.getRandomValues(new Uint8Array(24));
	const cipher = xchacha20poly1305(symmetricKey, nonce);
	const ciphertext = cipher.encrypt(plaintext);
	return { ciphertext, nonce };
}

/**
 * Decrypt ciphertext with XChaCha20-Poly1305.
 * Ciphertext must include 16-byte auth tag appended by encrypt.
 * Throws on authentication failure (tampered/corrupted data).
 */
export function decryptBody(
	ciphertext: Uint8Array,
	nonce: Uint8Array,
	symmetricKey: Uint8Array,
): Uint8Array {
	const cipher = xchacha20poly1305(symmetricKey, nonce);
	return cipher.decrypt(ciphertext);
}

/** Decode base64url string to Uint8Array. */
function base64urlToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
	return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}
```

**Key design decisions:**
- `extractRawEd25519Keys` uses JWK export (not PKCS8/SPKI parsing) because Web Crypto JWK format exposes raw 32-byte keys directly as base64url fields `d` (private seed) and `x` (public point).
- `ed25519ToX25519Public` uses `ExtendedPoint.fromHex().toX25519()` rather than `ed25519.utils.toMontgomery()` — both produce the same result but the ExtendedPoint method is the documented approach in noble-curves for point-level conversion.
- `encryptBody` generates nonce internally (caller never provides nonce) to prevent nonce reuse mistakes.
- `base64urlToBytes` is a private helper for JWK decoding — JWK uses base64url encoding per RFC 7517.

**Verification:**

Run: `bun -e "import { encryptBody, decryptBody } from './packages/sync/src/encryption'; const key = crypto.getRandomValues(new Uint8Array(32)); const pt = new TextEncoder().encode('hello'); const { ciphertext, nonce } = encryptBody(pt, key); const dec = decryptBody(ciphertext, nonce, key); console.log(new TextDecoder().decode(dec))"`
Expected: Prints "hello"

**Commit:** `feat(sync): add encryption.ts with stateless crypto primitives`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for encryption.ts

**Verifies:** sync-encryption.AC1.1, sync-encryption.AC1.2, sync-encryption.AC1.3, sync-encryption.AC1.4, sync-encryption.AC2.1, sync-encryption.AC2.2, sync-encryption.AC3.1, sync-encryption.AC4.1, sync-encryption.AC4.2, sync-encryption.AC4.3

**Files:**
- Create: `packages/sync/src/__tests__/encryption.test.ts`

**Testing:**

Follow existing test patterns from `packages/sync/src/__tests__/crypto.test.ts` and `signing.test.ts`. Use real Ed25519 keypairs generated via `generateKeypair()` from `packages/sync/src/crypto.ts`. No mocking.

Tests must verify each AC listed:

- **sync-encryption.AC1.1:** Generate Ed25519 keypair, extract raw keys, convert to X25519. Verify both X25519 keys are 32 bytes.
- **sync-encryption.AC1.2:** Extract raw keys from same keypair twice. Verify `ed25519ToX25519Private` produces identical output both times (deterministic).
- **sync-encryption.AC1.3:** Extract only the public key raw bytes. Verify `ed25519ToX25519Public` produces a valid 32-byte X25519 public key without needing private key.
- **sync-encryption.AC1.4:** Call `extractRawEd25519Keys`, verify `pubRaw` and `privRaw` are both `Uint8Array` of length 32.
- **sync-encryption.AC2.1 (ECDH symmetry):** Generate two keypairs (A, B). Derive shared secret A→B and B→A. Verify they are byte-identical.
- **sync-encryption.AC2.2:** Verify `deriveSharedSecret` output is exactly 32 bytes. Verify it differs from the raw ECDH output (i.e., HKDF was applied, not just raw x25519).
- **sync-encryption.AC3.1:** Compute fingerprint of a known X25519 public key. Verify it is a 16-character hex string. Verify same key always produces same fingerprint (deterministic).
- **sync-encryption.AC4.1 (encrypt/decrypt round-trip):** Encrypt a JSON body, decrypt it, verify plaintext matches original.
- **sync-encryption.AC4.2:** Encrypt two messages with same key. Verify nonces differ (random generation).
- **sync-encryption.AC4.3 (empty body):** Encrypt empty `Uint8Array(0)`. Verify ciphertext is exactly 16 bytes (auth tag only). Decrypt and verify result is empty.

Additional edge case tests:
- **Tampered ciphertext:** Flip a byte in ciphertext, verify `decryptBody` throws.
- **Wrong key:** Encrypt with key A, attempt decrypt with key B, verify throws.
- **Wrong nonce:** Encrypt with nonce A, attempt decrypt with nonce B, verify throws.

**Verification:**

Run: `bun test packages/sync/src/__tests__/encryption.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encryption.ts unit tests`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-5) -->
<!-- START_TASK_4 -->
### Task 4: Create key-manager.ts — KeyManager class

**Verifies:** sync-encryption.AC1.5, sync-encryption.AC2.3, sync-encryption.AC2.4, sync-encryption.AC3.1

**Files:**
- Create: `packages/sync/src/key-manager.ts`

**Implementation:**

Create `packages/sync/src/key-manager.ts` with the `KeyManager` class. The class owns X25519 key derivation, ECDH shared secret computation, and per-peer symmetric key caching.

```typescript
import type { KeyringConfig } from "@bound/shared";
import {
	computeFingerprint,
	deriveSharedSecret,
	ed25519ToX25519Private,
	ed25519ToX25519Public,
	extractRawEd25519Keys,
} from "./encryption.js";

interface PeerCrypto {
	symmetricKey: Uint8Array;
	fingerprint: string;
}

export class KeyManager {
	private localX25519Priv: Uint8Array | null = null;
	private localX25519Pub: Uint8Array | null = null;
	private localFingerprint: string | null = null;
	private peers: Map<string, PeerCrypto> = new Map();

	constructor(
		private readonly localKeypair: { publicKey: CryptoKey; privateKey: CryptoKey },
		private readonly siteId: string,
	) {}

	/**
	 * Initialize the KeyManager: derive X25519 keys from Ed25519 identity,
	 * then compute shared secrets for all keyring peers.
	 * Must be called before any other method.
	 * Throws on key derivation failure (caller should treat as FATAL per R-SE19).
	 */
	async init(keyring: KeyringConfig): Promise<void> {
		const { pubRaw, privRaw } = await extractRawEd25519Keys(this.localKeypair);

		this.localX25519Priv = ed25519ToX25519Private(privRaw);
		this.localX25519Pub = ed25519ToX25519Public(pubRaw);
		this.localFingerprint = computeFingerprint(this.localX25519Pub);

		this.computePeerSecrets(keyring);
	}

	getSymmetricKey(siteId: string): Uint8Array | null {
		return this.peers.get(siteId)?.symmetricKey ?? null;
	}

	getFingerprint(siteId: string): string | null {
		return this.peers.get(siteId)?.fingerprint ?? null;
	}

	getLocalFingerprint(): string {
		if (!this.localFingerprint) {
			throw new Error("KeyManager not initialized");
		}
		return this.localFingerprint;
	}

	/**
	 * Reload keyring: evict removed peers, derive new/changed peers,
	 * preserve unchanged peers (no unnecessary recomputation).
	 * Uses fingerprint-keyed map for O(n) lookup of existing peers.
	 */
	reloadKeyring(newKeyring: KeyringConfig): void {
		if (!this.localX25519Priv) {
			throw new Error("KeyManager not initialized");
		}

		// Build fingerprint -> PeerCrypto + siteId map from old peers for O(n) lookup
		const oldByFingerprint = new Map<string, { siteId: string; peer: PeerCrypto }>();
		for (const [siteId, peer] of this.peers) {
			oldByFingerprint.set(peer.fingerprint, { siteId, peer });
		}

		const newPeers = new Map<string, PeerCrypto>();

		for (const [hostName, hostConfig] of Object.entries(newKeyring.hosts)) {
			// Skip self
			if (hostName === this.siteId) continue;

			const peerX25519Pub = this.deriveX25519PubFromEd25519Encoded(hostConfig.public_key);
			const fingerprint = computeFingerprint(peerX25519Pub);

			// Preserve unchanged peers (same fingerprint = same key = same shared secret)
			const existing = oldByFingerprint.get(fingerprint);
			if (existing) {
				newPeers.set(hostName, existing.peer);
				continue;
			}

			// Derive new shared secret for new/changed peer
			const symmetricKey = deriveSharedSecret(this.localX25519Priv, peerX25519Pub);
			newPeers.set(hostName, { symmetricKey, fingerprint });
		}

		this.peers = newPeers;
	}

	private computePeerSecrets(keyring: KeyringConfig): void {
		if (!this.localX25519Priv) {
			throw new Error("KeyManager not initialized");
		}

		this.peers.clear();

		for (const [hostName, hostConfig] of Object.entries(keyring.hosts)) {
			// Skip self
			if (hostName === this.siteId) continue;

			const peerX25519Pub = this.deriveX25519PubFromEd25519Encoded(hostConfig.public_key);
			const fingerprint = computeFingerprint(peerX25519Pub);
			const symmetricKey = deriveSharedSecret(this.localX25519Priv, peerX25519Pub);

			this.peers.set(hostName, { symmetricKey, fingerprint });
		}
	}

	/**
	 * Derive X25519 public key from an ed25519:-prefixed public key string.
	 * Reuses the import path from crypto.ts (SPKI base64 with ed25519: prefix).
	 */
	private deriveX25519PubFromEd25519Encoded(encodedPubKey: string): Uint8Array {
		// Strip "ed25519:" prefix and decode base64 SPKI
		const prefix = "ed25519:";
		if (!encodedPubKey.startsWith(prefix)) {
			throw new Error(`Invalid public key format: missing '${prefix}' prefix`);
		}
		const spkiBase64 = encodedPubKey.slice(prefix.length);
		const spkiBytes = Uint8Array.from(atob(spkiBase64), (c) => c.charCodeAt(0));

		// SPKI for Ed25519 is 44 bytes: 12-byte header + 32-byte public key
		// The raw public key is the last 32 bytes
		const rawPubKey = spkiBytes.slice(-32);

		return ed25519ToX25519Public(rawPubKey);
	}

}
```

**Key design decisions:**
- **Design contract deviation:** The design document's "Contracts" section shows `KeyManager` taking `keyring` in the constructor. This implementation uses a two-step pattern: synchronous `constructor(keypair, siteId)` + async `init(keyring)`. The rationale is that `extractRawEd25519Keys()` requires async JWK export via `crypto.subtle.exportKey()`, which cannot happen in a constructor. The public interface (`getSymmetricKey`, `getFingerprint`, `getLocalFingerprint`, `reloadKeyring`) matches the design contract exactly.
- Constructor is synchronous; `init()` is async (JWK export requires await). This follows the pattern where construction is cheap and initialization may fail.
- `init()` failure should be treated as FATAL by the caller (sync-encryption.AC1.5). The KeyManager itself throws; the startup code catches and exits.
- Keyring hosts are keyed by siteId (matches the existing `KeyringConfig.hosts` structure where keys map to `{ public_key, url }`).
- `reloadKeyring()` preserves unchanged peers by comparing fingerprints — avoids unnecessary ECDH recomputation.
- SPKI parsing extracts the raw 32-byte public key from the last 32 bytes of the SPKI encoding (Ed25519 SPKI is always 44 bytes: 12-byte ASN.1 header + 32-byte key).
- X25519 private key and symmetric keys exist only in memory (never written to disk or logged per sync-encryption.AC2.4).

**Verification:**

Run: `bun -e "import { KeyManager } from './packages/sync/src/key-manager'; console.log('KeyManager imported OK')"`
Expected: Prints "KeyManager imported OK"

**Commit:** `feat(sync): add KeyManager class for peer key management`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Tests for key-manager.ts

**Verifies:** sync-encryption.AC1.5, sync-encryption.AC2.1, sync-encryption.AC2.3, sync-encryption.AC2.4, sync-encryption.AC3.1

**Files:**
- Create: `packages/sync/src/__tests__/key-manager.test.ts`

**Testing:**

Follow existing patterns from `packages/sync/src/__tests__/signing.test.ts`. Generate real Ed25519 keypairs via `generateKeypair()` from `packages/sync/src/crypto.ts`. Build real keyring configs. No mocking.

Tests must verify each AC listed:

- **sync-encryption.AC1.5 (FATAL on failure):** Pass a keypair with a non-exportable key (or a mock that throws on JWK export). Verify `init()` throws. (Note: the caller handles process exit; KeyManager just throws.)
- **sync-encryption.AC2.1 (ECDH symmetry via KeyManager):** Create two KeyManagers (A and B) with each other in their keyrings. After `init()`, verify `A.getSymmetricKey(B_siteId)` equals `B.getSymmetricKey(A_siteId)` byte-for-byte.
- **sync-encryption.AC2.3 (caching):** After `init()` with a keyring of 2 peers, verify `getSymmetricKey(siteId)` returns non-null for each peer. Verify `getSymmetricKey("unknown")` returns null.
- **sync-encryption.AC2.4 (no disk/log leakage):** This is verified by design (no file I/O in KeyManager). Include a test that KeyManager has no `fs`, `writeFile`, or `console.log` calls — or simply verify the class has no side effects beyond its in-memory state. A structural assertion that `getSymmetricKey` returns `Uint8Array` (not string, not logged representation) suffices.
- **sync-encryption.AC3.1 (fingerprint via KeyManager):** After init, verify `getFingerprint(siteId)` returns a 16-char hex string. Verify `getLocalFingerprint()` returns a 16-char hex string. Verify they differ (different keys = different fingerprints).

Additional tests:
- **reloadKeyring — add peer:** Init with 1 peer, reload with 2 peers. Verify new peer's symmetric key is available.
- **reloadKeyring — remove peer:** Init with 2 peers, reload with 1 peer. Verify removed peer's symmetric key returns null.
- **reloadKeyring — unchanged peer preserved:** Init with 2 peers, capture symmetric key reference, reload with same keyring. Verify the Uint8Array reference is the same object (not recomputed).
- **reloadKeyring — changed peer recomputed:** Init with peer B, reload with a different public key for peer B's siteId. Verify symmetric key changed.
- **Self-exclusion:** Include local host in keyring. Verify KeyManager does not compute a symmetric key for its own siteId.
- **getLocalFingerprint before init:** Verify throws with "KeyManager not initialized".

**Verification:**

Run: `bun test packages/sync/src/__tests__/key-manager.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add KeyManager unit tests`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Export new modules from index.ts

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/sync/src/index.ts` (add exports at end of file, after line 14)

**Implementation:**

Add the following export lines to the end of `packages/sync/src/index.ts`:

```typescript
export {
	encryptBody,
	decryptBody,
	deriveSharedSecret,
	ed25519ToX25519Public,
	ed25519ToX25519Private,
	computeFingerprint,
	extractRawEd25519Keys,
} from "./encryption.js";
export { KeyManager } from "./key-manager.js";
```

**Verification:**

Run: `tsc -p packages/sync --noEmit`
Expected: No type errors.

Run: `bun test packages/sync`
Expected: All existing sync tests still pass (zero regressions) plus new encryption and key-manager tests pass.

**Commit:** `feat(sync): export encryption and key-manager modules`
<!-- END_TASK_6 -->
