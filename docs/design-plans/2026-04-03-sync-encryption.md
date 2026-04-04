# Spoke-to-Hub Sync Encryption Design

## Summary

This design implements transport-layer encryption for all spoke-to-hub and hub-to-spoke sync traffic using XChaCha20-Poly1305 AEAD encryption. The encryption layer sits between JSON serialization and HTTP transmission, wrapping the existing Ed25519 signing protocol without changing application logic. Each host derives an X25519 key pair from its persistent Ed25519 identity keypair at startup, then computes shared secrets with all keyring peers via static ECDH. Request bodies are encrypted with peer-specific symmetric keys and random 192-bit nonces, with signatures covering the ciphertext rather than plaintext. A new `SyncTransport` class encapsulates the encrypt-sign-fetch-decrypt pipeline and replaces inline `fetch()` calls throughout the sync system.

Mandatory encryption enforcement rejects plaintext requests with HTTP 400 errors, and fingerprint-based key validation prevents misconfiguration. A SIGHUP signal handler enables hot-reloading of the keyring and other optional configs without process restarts. A new `boundcurl` CLI diagnostic tool (compiled as the 4th binary alongside `bound`, `boundctl`, and `bound-mcp`) provides authenticated, encrypted access to sync endpoints with an offline decrypt mode for captured traffic inspection. The implementation preserves all existing functionality -- single-node deployments without keyring are unaffected, and the full test suite must pass with zero regressions.

## Definition of Done

All spoke-to-hub and hub-to-spoke HTTP sync traffic is encrypted with XChaCha20-Poly1305 using X25519-derived shared secrets, layered on top of the existing Ed25519 signing protocol. Encryption is mandatory with no plaintext fallback. A SIGHUP-based config reload mechanism reloads the keyring and recomputes shared secrets without process restart. A `boundcurl` CLI diagnostic tool (compiled as 4th binary) provides authenticated, encrypted access to sync endpoints with an offline decrypt mode. All 22 requirements (R-SE1 through R-SE22) from the RFC are satisfied, with zero regressions to the existing test suite.

**Out of scope:** End-to-end spoke-to-spoke encryption, data-at-rest encryption, WebSocket encryption, forward secrecy (R-SE15), selective relay payload encryption (R-SE17).

## Acceptance Criteria

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
- **sync-encryption.AC3.4 Edge:** No X-Key-Fingerprint required on responses (R-SE8)

### sync-encryption.AC4: Request Body Encryption
- **sync-encryption.AC4.1 Success:** Request body encrypted with XChaCha20-Poly1305 using peer's symmetric key
- **sync-encryption.AC4.2 Success:** Random 192-bit nonce generated per message via crypto.getRandomValues()
- **sync-encryption.AC4.3 Success:** Empty bodies produce valid ciphertext (16-byte auth tag for zero-length plaintext)
- **sync-encryption.AC4.4 Edge:** Nonce collision probability is ~2^-97 after 2^48 messages (verified by design, not runtime)

### sync-encryption.AC5: Encrypted Request Headers
- **sync-encryption.AC5.1 Success:** X-Encryption: "xchacha20" header present on all encrypted requests
- **sync-encryption.AC5.2 Success:** X-Nonce header contains hex-encoded 192-bit nonce (48 hex chars)
- **sync-encryption.AC5.3 Success:** Content-Type set to application/octet-stream for encrypted bodies
- **sync-encryption.AC5.4 Success:** Ed25519 signature covers ciphertext, not plaintext (R-SE6)

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

### sync-encryption.AC9: Eager Push Encryption
- **sync-encryption.AC9.1 Success:** Hub encrypts eager push body with target spoke's symmetric key
- **sync-encryption.AC9.2 Success:** Spoke decrypts eager push using shared secret with hub
- **sync-encryption.AC9.3 Success:** Reachability tracking unaffected by encryption layer

### sync-encryption.AC10: Error Response Format
- **sync-encryption.AC10.1 Success:** Encryption-layer errors (plaintext rejection, fingerprint mismatch, decryption failure, malformed headers) return plaintext JSON with Content-Type: application/json (R-SE22)
- **sync-encryption.AC10.2 Success:** Application-layer errors return encrypted JSON (encryption channel intact)
- **sync-encryption.AC10.3 Success:** Decryption failure response includes no oracle details (R-SE11)

### sync-encryption.AC11: Logging Discipline
- **sync-encryption.AC11.1 Success:** Normal operation logs ciphertext length, nonce, siteId, endpoint -- never plaintext bodies (R-SE20)
- **sync-encryption.AC11.2 Success:** BOUND_LOG_SYNC_PLAINTEXT=1 enables plaintext body logging with startup WARNING
- **sync-encryption.AC11.3 Success:** Encryption-layer failures logged at WARN (plaintext rejection, fingerprint mismatch) or ERROR (decryption failure)

### sync-encryption.AC12: SIGHUP Config Reload
- **sync-encryption.AC12.1 Success:** SIGHUP reloads all optional configs (keyring, network, platforms, sync, mcp, overlay, cron_schedules)
- **sync-encryption.AC12.2 Success:** KeyManager recomputes shared secrets for added/changed keyring peers
- **sync-encryption.AC12.3 Success:** Unchanged peers keep cached secrets (no unnecessary recomputation)
- **sync-encryption.AC12.4 Success:** Removed peers have secrets evicted
- **sync-encryption.AC12.5 Failure:** Bad config file is non-fatal: logs error, keeps previous config value
- **sync-encryption.AC12.6 Edge:** Concurrent SIGHUP signals do not cause race conditions (reload-in-progress flag)

### sync-encryption.AC13: boundcurl CLI
- **sync-encryption.AC13.1 Success:** Request mode sends authenticated, encrypted request and prints decrypted JSON response
- **sync-encryption.AC13.2 Success:** Decrypt mode with explicit --nonce decrypts stdin as ciphertext
- **sync-encryption.AC13.3 Success:** Decrypt mode without --nonce interprets first 24 bytes of stdin as nonce, remainder as ciphertext
- **sync-encryption.AC13.4 Success:** Binary compiles as dist/boundcurl alongside existing 3 binaries

### sync-encryption.AC14: Integration
- **sync-encryption.AC14.1 Success:** Full sync cycle (push/pull/ack/relay) completes between two encrypted hosts
- **sync-encryption.AC14.2 Success:** Data round-trips correctly through encrypt-transmit-decrypt pipeline
- **sync-encryption.AC14.3 Success:** Keyring mismatch between hosts produces clear fingerprint rejection diagnostic
- **sync-encryption.AC14.4 Success:** Hub migration (set-hub) works -- spoke switches to new hub's cached secret without restart

### sync-encryption.AC15: Compatibility
- **sync-encryption.AC15.1 Success:** Existing signing tests pass unchanged (signature covers ciphertext)
- **sync-encryption.AC15.2 Success:** Existing test suite (700+ tests) shows zero regressions
- **sync-encryption.AC15.3 Success:** Single-node deployments without keyring are unaffected

## Glossary

- **AEAD (Authenticated Encryption with Associated Data)**: Encryption scheme that simultaneously provides confidentiality, integrity, and authenticity. XChaCha20-Poly1305 is an AEAD cipher -- successful decryption proves the message was not tampered with.
- **XChaCha20-Poly1305**: AEAD cipher combining XChaCha20 stream cipher with Poly1305 message authentication. Uses 256-bit keys and 192-bit nonces (larger nonce space than ChaCha20 eliminates collision risk with random generation).
- **X25519**: Elliptic curve Diffie-Hellman key exchange protocol over Curve25519. Used to derive shared secrets between peers from their public keys.
- **Ed25519**: EdDSA signature scheme over Curve25519. Bound's existing identity and signing protocol. Mathematically related to X25519, enabling deterministic derivation of X25519 keys from Ed25519 keys.
- **ECDH (Elliptic Curve Diffie-Hellman)**: Key agreement protocol where two parties derive a shared secret from their private keys and each other's public keys without transmitting the secret.
- **HKDF (HMAC-based Key Derivation Function)**: RFC 5869 standard for deriving cryptographic keys from shared secrets. Takes a salt and info string to produce domain-separated keys from raw ECDH output.
- **Nonce**: Number used once. Cryptographic parameter that must be unique per encryption operation with the same key. XChaCha20 uses 192-bit nonces (24 bytes) generated randomly per message.
- **Fingerprint**: Short hash of a public key for human-readable identity verification. This design uses the first 8 bytes (16 hex characters) of SHA-256(X25519 public key).
- **SIGHUP**: Unix signal traditionally meaning "hangup" but commonly repurposed for config reload. Bound uses SIGHUP to trigger hot-reload of optional configs including keyring.
- **Keyring**: Configuration file (`keyring.json`) mapping peer site IDs to their Ed25519 public keys. Used to derive shared secrets for encryption.
- **Spoke**: A cluster node that connects to the hub for synchronization. Runs agent loops and may process relay messages.
- **Hub**: The central sync coordinator. All spokes connect to the hub for push/pull/ack/relay phases. Only one hub per cluster.
- **Eager push**: Optimization where the hub pushes relay messages directly to spokes via HTTP POST to their sync_url instead of waiting for the next sync cycle pull.
- **Transport boundary**: The network communication layer. This design encrypts "at the transport boundary" -- after serialization but before HTTP, and after HTTP reception but before deserialization.
- **@noble/curves, @noble/ciphers, @noble/hashes**: Audited TypeScript cryptography libraries by Paul Miller. Provide X25519 ECDH, XChaCha20-Poly1305, and HKDF implementations. Zero dependencies, pure JS.

## Architecture

### Overview

Encryption operates at the transport boundary (R-SE7): after JSON serialization but before HTTP transmission on the client side, and after HTTP reception but before JSON parsing on the server side. Application logic above the transport layer is unaware of encryption.

Three new modules in `packages/sync/src/` implement the encryption layer:

- **`encryption.ts`** — Stateless cryptographic primitives: encrypt, decrypt, HKDF key derivation, Ed25519-to-X25519 conversion, fingerprint computation. Zero state, independently testable.
- **`key-manager.ts`** — `KeyManager` class that owns X25519 key derivation, ECDH shared secret computation, and per-peer symmetric key caching. Created once at startup, supports keyring hot-reload via SIGHUP.
- **`transport.ts`** — `SyncTransport` class that wraps the encrypt-sign-fetch-decrypt pipeline. Replaces raw `fetch()` calls in `SyncClient` and `eagerPushToSpoke`.

Existing modules are minimally modified:

- **`signing.ts`** — `signRequest()` extended to accept `string | Uint8Array` body (currently string-only). `verifyRequest()` unchanged since middleware provides body bytes.
- **`middleware.ts`** — Extended with decryption steps slotted into the verification order: encryption header check, fingerprint validation, signature verification (existing), timestamp check (existing), body decryption.
- **`crypto.ts`** — Unchanged. Continues to own Ed25519 key generation, import/export, and siteId derivation.
- **`sync-loop.ts`** — `SyncClient` uses injected `SyncTransport` instead of inline `fetch()` calls.
- **`eager-push.ts`** — `eagerPushToSpoke` uses `SyncTransport` for encrypted delivery.

New CLI entry point:

- **`packages/cli/src/boundcurl.ts`** — Standalone diagnostic tool compiled as `dist/boundcurl`. Loads keypair and keyring, creates one-shot `KeyManager` and `SyncTransport` for request mode, or decrypts captured traffic in offline mode.

SIGHUP handler:

- **`packages/cli/src/sighup.ts`** — Registers `process.on("SIGHUP")` at startup. Reloads all optional configs, propagates keyring changes to `KeyManager`.

### Data Flow

**Client (spoke sending to hub):**

```
JSON body (string)
  -> TextEncoder.encode() -> plaintext bytes
  -> encryptBody(plaintext, symmetricKey) -> { ciphertext, nonce }
  -> signRequest(privateKey, siteId, method, path, ciphertext) -> signing headers
  -> fetch(url, { body: ciphertext, headers: { ...signHeaders, X-Encryption, X-Nonce, X-Key-Fingerprint } })
```

**Server (hub receiving from spoke):**

```
HTTP request (binary body)
  -> Check X-Encryption header present (reject plaintext: R-SE10)
  -> Validate X-Key-Fingerprint against derived key (reject mismatch: R-SE12)
  -> Verify Ed25519 signature over ciphertext (reject forgery: existing)
  -> Check timestamp freshness (reject replay: existing)
  -> Validate X-Nonce format (reject malformed: R-SE21)
  -> decryptBody(ciphertext, nonce, symmetricKey) -> plaintext bytes (reject corruption: R-SE11)
  -> TextDecoder.decode() -> JSON string
  -> Route handler receives plaintext JSON (unchanged)
```

**Response (hub to spoke):**

```
JSON response (string)
  -> encryptBody(plaintext, symmetricKey) -> { ciphertext, nonce }
  -> Set X-Encryption and X-Nonce response headers
  -> No X-Key-Fingerprint on responses (R-SE8, implicit auth via AEAD)
```

### Key Hierarchy

```
Ed25519 keypair (on disk: data/host.key, data/host.pub)
  |
  +-> JWK export -> raw 32-byte seed (private), raw 32-byte point (public)
  |
  +-> ed25519.utils.toMontgomerySecret(privRaw) -> X25519 private key (32 bytes, memory-only)
  +-> ed25519.utils.toMontgomery(pubRaw) -> X25519 public key (32 bytes, memory-only)
  |
  +-> x25519.getSharedSecret(localPriv, peerPub) -> raw ECDH shared secret (32 bytes)
  |
  +-> hkdf(sha256, sharedSecret, "bound", "sync-v1", 32) -> symmetric key (32 bytes, cached per peer)
  |
  +-> XChaCha20-Poly1305(symmetricKey, randomNonce) -> per-message encryption
```

### Contracts

**KeyManager interface:**

```typescript
interface PeerCrypto {
  symmetricKey: Uint8Array;  // 32 bytes, HKDF-derived
  fingerprint: string;       // 16 hex chars (8 bytes of SHA-256)
}

class KeyManager {
  constructor(localKeypair: { publicKey: CryptoKey; privateKey: CryptoKey }, keyring: KeyringConfig);
  getSymmetricKey(siteId: string): Uint8Array | null;
  getFingerprint(siteId: string): string | null;
  getLocalFingerprint(): string;
  reloadKeyring(newKeyring: KeyringConfig): void;
}
```

**SyncTransport interface:**

```typescript
interface TransportResponse {
  status: number;
  body: string;         // decrypted plaintext JSON
  headers: Headers;
}

class SyncTransport {
  constructor(keyManager: KeyManager, privateKey: CryptoKey, siteId: string);
  send(method: string, url: string, path: string, body: string, targetSiteId: string): Promise<TransportResponse>;
}
```

**Encryption primitives:**

```typescript
function encryptBody(plaintext: Uint8Array, symmetricKey: Uint8Array): { ciphertext: Uint8Array; nonce: Uint8Array };
function decryptBody(ciphertext: Uint8Array, nonce: Uint8Array, symmetricKey: Uint8Array): Uint8Array;
function deriveSharedSecret(localX25519Priv: Uint8Array, peerX25519Pub: Uint8Array): Uint8Array;
function ed25519ToX25519Public(ed25519PubRaw: Uint8Array): Uint8Array;
function ed25519ToX25519Private(ed25519PrivRaw: Uint8Array): Uint8Array;
function computeFingerprint(x25519PubRaw: Uint8Array): string;
function extractRawEd25519Keys(keypair: { publicKey: CryptoKey; privateKey: CryptoKey }): Promise<{ pubRaw: Uint8Array; privRaw: Uint8Array }>;
```

**New HTTP headers (request):**

```
X-Encryption: "xchacha20"
X-Nonce: hex-encoded 192-bit random nonce (48 hex chars)
X-Key-Fingerprint: hex-encoded SHA-256(X25519 pubkey)[0:8] (16 hex chars)
Content-Type: application/octet-stream
```

**New HTTP headers (response):**

```
X-Encryption: "xchacha20"
X-Nonce: hex-encoded 192-bit random nonce (48 hex chars)
```

**Encryption-layer error responses (plaintext JSON, R-SE22):**

```typescript
// R-SE10: Plaintext rejection
{ error: "plaintext_rejected", message: "Plaintext sync requests are not accepted. Upgrade to a version with sync encryption." }

// R-SE11: Decryption failure
{ error: "decryption_failed", site_id: string, hint: "Check that keyring.json is identical on both hosts." }

// R-SE12: Fingerprint mismatch
{ error: "key_mismatch", site_id: string, expected_fingerprint: string, received_fingerprint: string }

// R-SE21: Malformed headers
{ error: "malformed_encryption_headers", message: string }
```

## Existing Patterns

**Signing protocol (`signing.ts`):** The existing `signRequest()` / `verifyRequest()` pattern is preserved. Encryption wraps around signing — the signature covers ciphertext bytes. `signRequest()` needs only a minor change: accept `string | Uint8Array` for the body parameter so it can hash ciphertext bytes directly instead of requiring a string.

**Middleware authentication (`middleware.ts`):** The existing `createSyncAuthMiddleware` pattern is extended, not replaced. New encryption checks slot into the verification order before the existing signature and timestamp checks. The middleware continues to set `c.set("rawBody", ...)` for route handlers, but now the value is decrypted plaintext rather than the raw request body.

**Config loading (`config-loader.ts`):** The SIGHUP reload reuses `loadOptionalConfigs()` which already exists. No new config loading logic needed — the reload handler calls the same function used at startup.

**CLI tool pattern (`boundctl.ts`):** `boundcurl` follows the same lightweight startup pattern as `boundctl`: load keypair via `ensureKeypair()`, load config files directly, no full `AppContext` needed. Arg parsing follows the same positional + flag pattern.

**Binary compilation (`scripts/build.ts`):** Adding the 4th binary follows the exact same `bun build --compile` pattern used for the existing 3 binaries.

**Key storage (`crypto.ts`):** Ed25519 keys remain stored as PKCS8/SPKI on disk. X25519 keys are derived in memory at startup and never persisted (R-SE13). Raw key bytes extracted via JWK export from `crypto.subtle` for compatibility with `@noble/curves`.

**No new patterns introduced.** All new code follows existing project conventions. The only new external dependencies are `@noble/curves`, `@noble/ciphers`, and `@noble/hashes` in `packages/sync`.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Crypto Foundation

**Goal:** Establish the cryptographic primitives and key management infrastructure that all subsequent phases depend on.

**Components:**

- `@noble/curves`, `@noble/ciphers`, `@noble/hashes` added to `packages/sync/package.json`
- `packages/sync/src/encryption.ts` — all stateless crypto functions: `encryptBody`, `decryptBody`, `deriveSharedSecret`, `ed25519ToX25519Public`, `ed25519ToX25519Private`, `computeFingerprint`, `extractRawEd25519Keys`
- `packages/sync/src/key-manager.ts` — `KeyManager` class with constructor (derives all peer secrets from keyring), `getSymmetricKey()`, `getFingerprint()`, `getLocalFingerprint()`, `reloadKeyring()`

**Dependencies:** None (first phase)

**Covers:** sync-encryption.AC1.x (key derivation), sync-encryption.AC2.x (shared secrets), sync-encryption.AC3.x (fingerprints)

**Done when:** Encrypt/decrypt round-trips succeed, ECDH symmetry verified (A's secret == B's secret), KeyManager derives and caches secrets for all keyring peers, all unit tests pass
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Client-Side Encryption

**Goal:** Encrypt all outbound sync requests from spoke to hub.

**Components:**

- `packages/sync/src/transport.ts` — `SyncTransport` class with `send()` method implementing encrypt-sign-fetch-decrypt pipeline
- `packages/sync/src/signing.ts` — extend `signRequest()` to accept `string | Uint8Array` body parameter
- `packages/sync/src/sync-loop.ts` — `SyncClient` refactored to use injected `SyncTransport` instead of inline `fetch()` for all 4 phases (push, pull, ack, relay)
- `packages/cli/src/commands/start.ts` — wire `KeyManager` and `SyncTransport` creation into bootstrap sequence

**Dependencies:** Phase 1 (encryption primitives and KeyManager)

**Covers:** sync-encryption.AC4.x (request encryption), sync-encryption.AC5.x (header protocol)

**Done when:** SyncClient sends encrypted requests with correct headers (X-Encryption, X-Nonce, X-Key-Fingerprint, Content-Type: application/octet-stream), signature covers ciphertext, all unit tests pass
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Server-Side Decryption

**Goal:** Hub decrypts incoming requests and encrypts responses, enforcing mandatory encryption.

**Components:**

- `packages/sync/src/middleware.ts` — extended `createSyncAuthMiddleware` with encryption verification order: encryption header check, fingerprint validation, signature verification, timestamp check, nonce validation, body decryption, response encryption hook
- `packages/sync/src/routes.ts` — middleware factory receives `KeyManager` parameter
- `packages/web/src/server/index.ts` — pass `KeyManager` to sync route creation

**Dependencies:** Phase 1 (KeyManager), Phase 2 (client sends encrypted)

**Covers:** sync-encryption.AC6.x (server decryption), sync-encryption.AC7.x (response encryption), sync-encryption.AC8.x (mandatory enforcement)

**Done when:** Hub correctly decrypts requests, encrypts responses, rejects plaintext (R-SE10), rejects fingerprint mismatch (R-SE12), rejects corrupted ciphertext (R-SE11), rejects malformed headers (R-SE21), route handlers receive plaintext JSON unchanged, all unit tests pass
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Eager Push Encryption

**Goal:** Hub-to-spoke eager push relay delivery uses the same encryption scheme.

**Components:**

- `packages/sync/src/eager-push.ts` — refactored to use `SyncTransport` for encrypted delivery to spokes
- `packages/cli/src/commands/start.ts` — `EagerPushConfig` extended with `SyncTransport` (or `KeyManager` + signing key to construct per-spoke transport)

**Dependencies:** Phase 2 (SyncTransport), Phase 3 (spoke can decrypt)

**Covers:** sync-encryption.AC9.x (eager push encryption)

**Done when:** Eager push sends encrypted payloads to spokes, spokes decrypt correctly, reachability tracking unaffected, all unit tests pass
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Error Handling and Logging

**Goal:** Implement the full error taxonomy and logging discipline specified in the RFC.

**Components:**

- `packages/sync/src/middleware.ts` — ensure all 4 encryption-layer error classes return plaintext JSON (R-SE22), application-layer errors return encrypted JSON
- `packages/sync/src/transport.ts` — client-side handling of plaintext error responses (detect absent X-Encryption header, parse as JSON error)
- Logging updates across sync modules — ciphertext length, nonce, siteId, endpoint logged at normal levels; plaintext body logging gated behind `BOUND_LOG_SYNC_PLAINTEXT=1` env var with startup WARNING (R-SE20)
- Startup fatal path — `KeyManager` constructor failure triggers FATAL log + process exit (R-SE19)

**Dependencies:** Phase 3 (middleware error paths), Phase 4 (eager push error paths)

**Covers:** sync-encryption.AC10.x (error responses), sync-encryption.AC11.x (logging discipline)

**Done when:** Each error class produces correct HTTP status, response format, and log level; plaintext logging env var works with warning; startup fails cleanly on key derivation error; all unit tests pass
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: SIGHUP Config Reload

**Goal:** Process reloads all optional configs on SIGHUP signal, including keyring with shared secret recomputation.

**Components:**

- `packages/cli/src/sighup.ts` — `registerSighupHandler()` function: reloads all optional configs via existing `loadOptionalConfigs()`, diffs keyring, calls `keyManager.reloadKeyring()`, updates ConfigService, logs results
- `packages/cli/src/commands/start.ts` — register handler after KeyManager creation, before sync loop start
- `packages/sync/src/key-manager.ts` — `reloadKeyring()` implementation: evict removed peers, derive new/changed peers, preserve unchanged

**Dependencies:** Phase 1 (KeyManager.reloadKeyring), Phase 3 (middleware uses KeyManager lookups)

**Covers:** sync-encryption.AC12.x (config reload)

**Done when:** SIGHUP triggers full optional config reload, KeyManager recomputes secrets for changed peers, unchanged peers keep cached secrets, concurrent reload prevented, bad config non-fatal (logs error, keeps previous), all unit tests pass
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: boundcurl CLI Tool

**Goal:** Standalone diagnostic binary for authenticated, encrypted sync endpoint access.

**Components:**

- `packages/cli/src/boundcurl.ts` — entry point with two modes:
  - Request mode: load keypair + keyring, create one-shot KeyManager + SyncTransport, send encrypted request, pretty-print decrypted response
  - Decrypt mode: load keypair + keyring, derive shared secret for --peer, decrypt stdin (nonce-prefixed or explicit --nonce)
- `packages/cli/package.json` — add `boundcurl` bin entry
- `scripts/build.ts` — add 4th `bun build --compile` step for `dist/boundcurl`

**Dependencies:** Phase 1 (KeyManager), Phase 2 (SyncTransport)

**Covers:** sync-encryption.AC13.x (boundcurl)

**Done when:** `boundcurl POST /sync/pull --data '...'` sends encrypted request and prints decrypted response; `boundcurl --decrypt --peer X < file` decrypts captured traffic; both nonce modes work; binary compiles successfully; all tests pass
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: Integration Tests and Compatibility

**Goal:** Verify the complete encryption system works end-to-end across multi-host sync scenarios.

**Components:**

- `packages/sync/src/__tests__/encrypted-sync.integration.test.ts` — full sync cycle (push/pull/ack/relay) between two in-process encrypted hosts
- `packages/sync/src/__tests__/keyring-mismatch.integration.test.ts` — modified key triggers fingerprint rejection before decryption
- `packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts` — hub-to-spoke eager push round-trip
- `packages/sync/src/__tests__/sighup-reload.integration.test.ts` — process reload via SIGHUP with keyring change
- Compatibility verification: existing signing tests pass unchanged (R-SE6 — signature covers ciphertext)
- Full existing test suite regression check

**Dependencies:** All previous phases (full system assembled)

**Covers:** sync-encryption.AC14.x (integration), sync-encryption.AC15.x (compatibility)

**Done when:** All integration tests pass, all existing tests pass with zero regressions, encrypted sync cycle completes successfully between two hosts, keyring mismatch produces clear diagnostic
<!-- END_PHASE_8 -->

## Additional Considerations

**Reverse proxy compatibility:** Encrypted sync requests use `Content-Type: application/octet-stream` instead of `application/json`. Reverse proxies, WAFs, or middleware that inspect or transform request bodies based on Content-Type may need configuration updates. This should be noted in deployment documentation.

**Performance:** XChaCha20-Poly1305 encryption/decryption is sub-millisecond for payloads under 2MB (the configured `sync.relay.max_payload_bytes` limit). No performance budget was specified, and the overhead is negligible relative to network latency and LLM inference times.

**Single-node deployments:** A single-node deployment without a keyring does not sync and therefore never encounters the encryption layer. The KeyManager is only created when sync is configured. No impact on single-node operation.

**Bedrock caching interaction:** The Anthropic prompt caching system operates on the content of LLM messages, not on sync transport. Encryption at the sync layer does not affect cache hit rates or caching behavior.

**`signRequest()` body type change:** Extending `signRequest()` to accept `Uint8Array` in addition to `string` is backward-compatible. Existing callers pass strings and continue to work. The function hashes the body bytes regardless of input type.
