# RFC: Spoke-to-Hub Sync Encryption

**Supplements:** `2026-03-20-base.md` §8.4, §13.4; `2026-03-25-service-channel.md` §3 (Architecture), §4 (Wire Format)
**Date:** 2026-04-03
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Sync Traffic Is Authenticated but Not Confidential

The sync protocol (§8.4, §13.4) authenticates every inter-host HTTP request with Ed25519 signatures. The signature covers method, path, timestamp, and a SHA-256 hash of the body, ensuring integrity and preventing impersonation. The body itself — serialized JSON containing changelog entries, relay payloads, and relay inbox messages — travels in plaintext.

On a trusted network (localhost, private LAN, VPN), this is sufficient. On an untrusted network (public Wi-Fi, shared hosting, internet transit without TLS), a passive observer sees the full content of every sync cycle:

- **Changelog entries** containing `row_data` for all synced tables: messages (full conversation text), semantic_memory (the agent's entire knowledge base), tasks (schedules, results, payloads), threads (titles, summaries), users, files, hosts, skills, advisories, overlay_index, and cluster_config.
- **Relay payloads** including inference requests (full LLM prompts with system instructions, conversation history, and tool definitions), inference responses (model output), tool call arguments and results, process delegation payloads, and platform delivery content.
- **Relay routing metadata** including target site IDs, relay kinds, stream IDs, and idempotency keys.

The signing headers (`X-Site-Id`, `X-Timestamp`, `X-Signature`) are also plaintext, revealing which hosts are communicating and when sync cycles occur. This is acceptable — the headers contain no sensitive content, and traffic analysis is out of scope for this RFC.

### 1.2 TLS Is Insufficient as the Sole Mitigation

TLS (HTTPS) provides transport-layer encryption and is the standard recommendation for protecting HTTP traffic. However, relying exclusively on TLS for sync confidentiality has three weaknesses in the deployment scenarios the system targets:

**CA trust chain dependency.** TLS authentication relies on the system CA store or operator-managed certificates. A compromised or coerced CA can issue fraudulent certificates for the hub's hostname, enabling MITM. The system already has a self-contained identity model (Ed25519 keyring) that is independent of the CA ecosystem — but the signing protocol only uses it for authentication, not encryption.

**TLS termination exposure.** When the hub sits behind a reverse proxy, load balancer, or CDN that terminates TLS, the proxy sees plaintext request bodies before forwarding to the hub process. The sync traffic — including all conversation content and memory — is visible to the proxy operator. Application-layer encryption eliminates this exposure: the proxy forwards opaque ciphertext to the hub, which decrypts with its own key material.

**Deployment friction.** Obtaining and renewing TLS certificates for spoke-to-hub communication requires either public DNS (for ACME/Let's Encrypt), self-signed CA infrastructure (with distribution to all spokes), or a tunnel service. For a laptop-to-VPS deployment — the primary multi-host scenario — this is achievable but adds operational overhead that many operators will skip. The keyring already distributes cryptographic identity to all hosts; extending it to provide encryption requires zero additional infrastructure.

### 1.3 Scope: Spoke-to-Hub Only

This RFC covers encryption of spoke-to-hub and hub-to-spoke HTTP traffic. It does not address:

- **End-to-end spoke-to-spoke encryption.** The hub decrypts all traffic it receives. Relay payloads routed through the hub are visible to the hub in plaintext after decryption. This is a deliberate design choice: the hub must inspect relay messages to perform routing (reading `target_site_id`, `kind`), apply reducers (LWW conflict resolution on changelog entries), record relay metrics (`relay_cycles`), and execute broadcast fan-out (`event_broadcast` with target `*`). End-to-end encryption between spokes would require rearchitecting the hub from an active participant to a blind forwarder, which is out of scope.
- **Data at rest encryption.** The SQLite database is stored unencrypted. SQLCipher or similar is orthogonal to transport encryption and is not addressed here.
- **WebSocket encryption.** The `/ws` endpoint serves the localhost-only web UI and is not part of inter-host communication.

### 1.4 Timing: Clean Break

The system has not yet deployed a second node. Encryption can be introduced as a mandatory protocol feature rather than an optional upgrade. No backward-compatible plaintext fallback or rolling upgrade mechanism is required. This simplifies the protocol and eliminates the risk of downgrade attacks.

---

## 2. Proposal

### 2.1 Summary

Layer authenticated encryption on top of the existing Ed25519 signing protocol. Each spoke and the hub derive an X25519 key pair from their Ed25519 identity at startup. Spoke-hub pairs compute a static ECDH shared secret from their respective X25519 keys — the spoke uses its X25519 private key and the hub's X25519 public key; the hub uses its X25519 private key and the spoke's X25519 public key. Both arrive at the same shared secret. Request and response bodies are encrypted with XChaCha20-Poly1305 using the shared secret and a random 192-bit nonce.

The signing protocol (§13.4) remains unchanged. Signing headers continue to authenticate identity and provide replay protection. The encrypted body replaces the plaintext JSON body. The hub uses the `X-Site-Id` header (plaintext) to look up the correct shared secret for decryption.

### 2.2 What This Changes

| Section | Change |
|---|---|
| §8.4 (Authentication) | Extended with X25519 key derivation at startup. Keypair management produces both Ed25519 (signing) and X25519 (encryption) keys from the same seed material. |
| §13.4 (Signed HTTP Protocol) | Request and response bodies are encrypted. New headers: `X-Encryption: xchacha20`, `X-Nonce`, `X-Key-Fingerprint`. |
| §8.3 (Event Exchange Protocol) | Push, pull, ack, and relay phase bodies are encrypted/decrypted at the transport boundary. Internal changeset serialization is unchanged. |
| Eager push (`/api/relay-deliver`) | Same encryption scheme as sync phases. |
| Keyring (`config/keyring.json`) | Extended with X25519 public keys (derived, not manually configured). |
| CLI | New `boundcurl` diagnostic tool for inspecting encrypted sync traffic. |

### 2.3 Design Principles

**Encryption is mandatory, not negotiable.** Once deployed, all inter-host HTTP traffic must be encrypted. There is no plaintext mode, no feature flag, and no downgrade path. A spoke that sends plaintext to an encryption-expecting hub receives a clear rejection. This eliminates configuration drift as a failure mode.

**Identity and encryption share one root.** The X25519 encryption key is deterministically derived from the Ed25519 signing key. One keypair generates both capabilities. The operator never manages encryption keys separately — the existing `host.key`/`host.pub` and keyring workflow is the only key management surface.

**The hub is trusted.** The hub decrypts all spoke traffic and has full visibility into sync content. This preserves the existing hub role: active participant in conflict resolution, relay routing, and metric recording. The encryption protects against network-level adversaries, not a compromised hub.

**Encrypt the body, sign the envelope.** The signing headers (`X-Site-Id`, `X-Timestamp`, `X-Signature`, `X-Agent-Version`) remain plaintext. They authenticate the sender and the encrypted body (the signature covers the SHA-256 of the ciphertext, not the plaintext). The hub verifies the signature before attempting decryption, so invalid or unknown senders are rejected without any decryption work.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-SE` (Sync Encryption). Numbering is independent.

### 3.1 Ubiquitous

**R-SE1.** The system shall derive an X25519 key pair from the host's Ed25519 identity key pair at startup. The derivation shall be deterministic: the same Ed25519 private key always produces the same X25519 private key. The X25519 public key shall be computable from the Ed25519 public key. The derived X25519 keys shall not be persisted to disk — they are re-derived on each startup from the existing `data/host.key` and `data/host.pub` files.

**R-SE2.** The system shall compute a static ECDH shared secret for each spoke-hub pair. Each host derives shared secrets with every other host in the keyring at startup, using its own X25519 private key and the peer's X25519 public key (derived from the peer's Ed25519 public key in the keyring). The shared secret shall be passed through HKDF-SHA256 with a fixed application-specific salt (`"bound"`) and context info string (`"sync-v1"`) to produce a 256-bit symmetric key. (A non-empty salt follows RFC 5869's recommendation for the extract step, even though the X25519 shared secret has sufficient entropy for an empty salt to be safe.) Derived symmetric keys shall be cached in memory for the lifetime of the process and recomputed when the keyring is reloaded (R-SE14).

**R-SE3.** The system shall encrypt the body of every inter-host HTTP request and response using XChaCha20-Poly1305 with the derived symmetric key (R-SE2) and a random 192-bit nonce generated via `crypto.getRandomValues()`. The system shall not reuse a nonce with the same symmetric key; random generation with 192-bit nonces provides this property with overwhelming probability (collision at ~2^-97 after 2^48 messages). The nonce shall be transmitted in the `X-Nonce` header as a hex-encoded string. The ciphertext shall replace the plaintext JSON body. The `Content-Type` header shall be `application/octet-stream` for encrypted bodies. Empty bodies (e.g., ack phase) shall still be encrypted — XChaCha20-Poly1305 produces a 16-byte authentication tag even for zero-length plaintext, and the `X-Encryption` and `X-Nonce` headers shall be present.

**R-SE4.** The system shall include an `X-Encryption: xchacha20` header on every encrypted request and response to signal that the body is encrypted. A receiver that expects encryption and does not find this header shall reject the request with HTTP 400 and a diagnostic message indicating that plaintext sync is not accepted.

**R-SE5.** The system shall include an `X-Key-Fingerprint` header on every encrypted request. The fingerprint is the first 8 bytes (16 hex characters) of the SHA-256 hash of the sender's X25519 public key in raw form. The receiver shall compare this fingerprint against its locally derived X25519 public key for the claimed `X-Site-Id`. A mismatch shall produce an HTTP 400 response with a diagnostic message: `"Key fingerprint mismatch for site {site_id}: expected {expected}, got {actual}. Keyring may be out of sync."` This enables early detection of keyring inconsistencies before decryption is attempted.

**R-SE6.** The Ed25519 signature (§13.4) shall cover the ciphertext, not the plaintext. Specifically, the `BODY_SHA256` component of the signing base (`METHOD\nPATH\nTIMESTAMP\nBODY_SHA256`) shall be the SHA-256 hash of the encrypted body (ciphertext + authentication tag as transmitted on the wire). This ensures the hub can verify the signature before decrypting — rejecting unknown or tampered requests without spending decryption cycles. The XChaCha20-Poly1305 authentication tag provides a second integrity check on the plaintext after decryption.

**R-SE7.** The system shall encrypt and decrypt at the transport boundary only. Internal changeset serialization (`serializeChangeset`, `deserializeChangeset`), relay message construction, and all application logic shall continue to operate on plaintext JSON. Encryption is applied as the final step before `fetch()` and decryption as the first step after receiving the response body. This keeps the encryption layer independent of the sync protocol's data model.

**R-SE8.** Response bodies from the hub to the spoke shall be encrypted using the same shared secret and scheme. The hub includes `X-Encryption` and `X-Nonce` headers on its responses. `X-Key-Fingerprint` is not required on responses — the spoke implicitly authenticates the hub because only the hub possesses the X25519 private key needed to produce valid ciphertext under the shared secret. If the spoke successfully decrypts the response, the hub's identity is confirmed. The spoke decrypts the response body using the shared secret it derived for the hub. This ensures confidentiality in both directions.

### 3.2 Event-Driven

**R-SE10.** When the system receives an inter-host HTTP request without the `X-Encryption` header (plaintext body), it shall reject the request with HTTP 400 and the message: `"Plaintext sync requests are not accepted. Upgrade to a version with sync encryption."` The rejection shall be logged at WARN level with the sender's site ID. This enforces mandatory encryption with a clear upgrade signal.

**R-SE11.** When decryption of an incoming request body fails (invalid ciphertext, wrong key, corrupted nonce), the system shall reject the request with HTTP 400 and a structured error: `{ "error": "decryption_failed", "site_id": "{sender}", "hint": "Check that keyring.json is identical on both hosts." }` The system shall NOT include the decryption error details (which could serve as an oracle) in the response. The full error shall be logged locally at ERROR level for operator diagnosis.

**R-SE12.** When the `X-Key-Fingerprint` check fails (R-SE5), the system shall reject the request before attempting decryption. The response shall use HTTP 400 with a structured error: `{ "error": "key_mismatch", "site_id": "{sender}", "expected_fingerprint": "{expected}", "received_fingerprint": "{actual}" }`. This is safe to include in the response because key fingerprints are derived from public keys which are already distributed in the keyring.

### 3.3 State-Driven

**R-SE13.** While the system is running, derived X25519 keys and cached shared secrets shall be held in memory only. They shall not be written to disk, logged, or included in any diagnostic output. The `boundcurl` tool (R-SE9) derives keys transiently for each invocation and does not cache them.

**R-SE14.** While the keyring contains a host entry whose Ed25519 public key has changed (e.g., a host regenerated its keypair), the system shall re-derive the X25519 public key and recompute the shared secret for that host on the next process restart or SIGHUP config reload. Stale cached secrets for the old key shall be evicted. This also applies when the hub identity changes via `boundctl set-hub` — the spoke already has the new hub's key in the keyring (it is just another host entry), so the shared secret is already cached; the spoke only needs to switch which cached secret it uses for sync requests. Until the keyring is updated on all hosts, requests from the rekeyed host will fail fingerprint validation (R-SE5) with a clear diagnostic.

### 3.4 Optional / Deferred

**R-SE15.** Forward secrecy via ephemeral key exchange per sync cycle is deferred. Static ECDH means a compromised Ed25519 private key allows decryption of all past captured traffic encrypted with that key pair. Ephemeral ECDH (a fresh X25519 keypair per sync cycle, with the ephemeral public key signed by Ed25519 and included in the request) would provide forward secrecy at the cost of one additional round trip for key agreement and per-cycle key state on both sides. This is a future enhancement if the threat model warrants it.

**R-SE16.** Encryption of the WebSocket transport (`/ws`) is deferred. The WebSocket serves the localhost-only web UI (§2.3, R-U4) and is not part of inter-host communication. If the web UI is ever extended to support remote access, WebSocket encryption should be revisited.

**R-SE17.** Selective encryption of relay payload bodies (encrypting the inner payload for the target spoke while leaving routing headers readable by the hub) is deferred. This would provide limited end-to-end confidentiality for relay content without requiring the hub to become a blind forwarder. The hub would still see routing metadata but not payload content. This is architecturally compatible with the current design but adds encryption complexity (two layers: outer spoke-to-hub, inner spoke-to-spoke) and is deferred until a concrete threat model justifies it.

### 3.5 Tooling

**R-SE18.** The system shall include a `boundcurl` CLI tool that provides authenticated, encrypted HTTP access to sync endpoints for diagnostic purposes. It shall load the local host's keypair from `data/host.key`, derive the X25519 key, compute the shared secret for the target host (looked up from the keyring), encrypt the request body, sign the request, send it, decrypt the response, and display the plaintext JSON. Usage: `boundcurl POST /sync/push --data @payload.json [--config-dir ./config] [--data-dir ./data]`. The tool shall also support an offline decrypt mode: `boundcurl --decrypt --peer {site_id} [--nonce <hex>] < captured.bin`. In decrypt mode, if `--nonce` is omitted, the tool shall interpret the first 24 bytes of stdin as the nonce and the remainder as ciphertext (the "nonce-prefixed" wire format). If `--nonce` is provided, the entire stdin is treated as ciphertext. This accommodates both raw capture (where the operator extracts the body and supplies the nonce from the `X-Nonce` header separately) and a convenience format where `nonce || ciphertext` is a single blob. `boundcurl` is compiled as a fourth binary (`dist/boundcurl`) alongside `dist/bound`, `dist/boundctl`, and `dist/bound-mcp`.

### 3.6 Unwanted Behavior

**R-SE19.** The system shall not fall back to plaintext transmission if encryption fails. If key derivation fails at startup (e.g., the Ed25519-to-X25519 conversion is unsupported by the runtime's crypto implementation), the system shall log a FATAL error and refuse to start sync. A host that cannot encrypt cannot participate in the cluster.

**R-SE20.** The system shall not log plaintext request or response bodies during normal operation. Debug-level logging of sync traffic shall log ciphertext length, nonce, site ID, and endpoint — not the decrypted content. An explicit `BOUND_LOG_SYNC_PLAINTEXT=1` environment variable may enable plaintext body logging for local development only; this flag shall trigger a startup WARNING: `"Sync plaintext logging is enabled. Do not use in production."`

**R-SE21.** The system shall not accept partially encrypted requests. A request with `X-Encryption: xchacha20` but a missing or malformed `X-Nonce` header shall be rejected with HTTP 400 before any decryption is attempted. A request with `X-Nonce` but no `X-Encryption` header shall be rejected as ambiguous.

**R-SE22.** Error responses for encryption-layer failures (R-SE10 plaintext rejection, R-SE11 decryption failure, R-SE12 fingerprint mismatch) shall be sent as plaintext JSON with `Content-Type: application/json`. The encryption channel is broken in these cases — the hub may not be able to produce ciphertext the spoke can decrypt (e.g., keyring mismatch means different shared secrets). Error responses for application-layer failures (sync logic errors, malformed changesets) shall be encrypted normally, since the encryption channel is intact. The spoke shall detect plaintext error responses by the absence of the `X-Encryption` header and parse them as JSON directly.

---

## 4. Data Model Changes

### 4.1 Keyring Extension

The keyring schema (`config/keyring.json`) does not change structurally. X25519 public keys are derived from the Ed25519 public keys already present in the keyring — no additional fields are needed. The derivation is performed at startup when the keyring is loaded.

Internally, the loaded keyring representation gains a computed field per host:

| Field | Type | Source | Notes |
|---|---|---|---|
| `x25519PublicKey` | `CryptoKey` | Derived from `public_key` (Ed25519) | Used for ECDH shared secret computation |
| `sharedSecret` | `Uint8Array` (32 bytes) | ECDH + HKDF | Cached per peer, recomputed on keyring reload |
| `keyFingerprint` | `string` (16 hex chars) | SHA-256(X25519 public key raw)[0:8] | Sent in `X-Key-Fingerprint` header |

These fields are runtime-only and never serialized.

### 4.2 HTTP Protocol Extension

The signed HTTP protocol (§13.4) gains three new headers:

| Header | Direction | Value | Notes |
|---|---|---|---|
| `X-Encryption` | Request + Response | `"xchacha20"` | Signals encrypted body. Absence = plaintext (rejected). |
| `X-Nonce` | Request + Response | Hex-encoded 192-bit random nonce | Per-message, never reused. |
| `X-Key-Fingerprint` | Request only | Hex-encoded first 8 bytes of SHA-256(X25519 pubkey) | Enables pre-decryption keyring mismatch detection. |

Updated protocol summary:

```
Request headers (encrypted sync):
  X-Site-Id:          sender's site ID (hex)
  X-Timestamp:        ISO 8601 (+-5 min skew tolerance)
  X-Agent-Version:    sender's version string
  X-Signature:        Ed25519(key, method + path + timestamp + SHA256(ciphertext))
  X-Encryption:       "xchacha20"
  X-Nonce:            hex-encoded 192-bit random nonce
  X-Key-Fingerprint:  hex-encoded SHA256(X25519 pubkey)[0:8]
  Content-Type:       application/octet-stream

Response headers (encrypted sync):
  X-Encryption:       "xchacha20"
  X-Nonce:            hex-encoded 192-bit random nonce

Verification order:
  1. X-Encryption present? (reject plaintext)
  2. X-Key-Fingerprint matches derived key for X-Site-Id? (reject mismatch)
  3. X-Signature valid over ciphertext? (reject forgery)
  4. X-Timestamp fresh? (reject replay)
  5. Decrypt body with shared secret + X-Nonce (reject corruption)
  6. Process plaintext JSON (existing logic, unchanged)
```

### 4.3 Encrypted Endpoints

All endpoints using the signed HTTP protocol (§13.4) are encrypted:

| Endpoint | Direction | Notes |
|---|---|---|
| `POST /sync/push` | Spoke -> Hub | Changeset body |
| `POST /sync/pull` | Spoke -> Hub | Pull request + response body |
| `POST /sync/ack` | Spoke -> Hub | Ack body |
| Relay phase (within sync) | Spoke <-> Hub | Relay outbox/inbox exchange |
| `POST /api/relay-deliver` | Hub -> Spoke | Eager push relay messages |

Endpoints NOT encrypted (not inter-host):

| Endpoint | Reason |
|---|---|
| `GET/POST /api/*` (non-relay) | Localhost-only web UI API |
| `GET /ws` | Localhost-only WebSocket |
| `POST /hooks/:platform` | Platform webhook ingress (external services, own auth) |

---

## 5. Behavioral Descriptions

### 5.1 Startup Key Derivation

At startup, after loading the Ed25519 keypair (§8.4) and before starting the sync loop:

1. Derive the local X25519 private key from the Ed25519 private key using the birational map (RFC 7748 / libsodium `crypto_sign_ed25519_sk_to_curve25519`).
2. Derive the local X25519 public key from the Ed25519 public key using the corresponding public key conversion (`crypto_sign_ed25519_pk_to_curve25519`).
3. For each host in the keyring:
   a. Derive the peer's X25519 public key from their Ed25519 public key.
   b. Compute the raw ECDH shared secret: `X25519(local_private, peer_public)`.
   c. Derive the symmetric key: `HKDF-SHA256(ikm=shared_secret, salt=empty, info="bound-sync-v1", length=32)`.
   d. Compute the peer's key fingerprint: `SHA-256(peer_x25519_public_raw)[0:8]` as hex.
   e. Cache the symmetric key and fingerprint in memory, keyed by site ID.
4. Log at INFO level: `"Sync encryption initialized: {N} peer keys derived."`

If the Ed25519-to-X25519 conversion is unavailable in the runtime (R-SE19), log FATAL and exit. The conversion requires access to the raw Ed25519 key bytes — `crypto.subtle` does not expose this directly, so the implementation will need to use a library (e.g., `@noble/curves` or `tweetnacl`) for the conversion step.

### 5.2 Request Encryption Flow (Spoke)

When the `SyncClient` sends a request (push, pull, ack, relay phase):

1. Serialize the body to JSON (existing logic, unchanged).
2. Generate a random 192-bit nonce: `crypto.getRandomValues(new Uint8Array(24))`.
3. Encrypt the JSON body with XChaCha20-Poly1305 using the hub's symmetric key and the nonce. The output is ciphertext || authentication tag (combined, as produced by the AEAD).
4. Sign the request using the existing `signRequest()` function, passing the **ciphertext** as the body (so `BODY_SHA256` covers the encrypted bytes).
5. Set headers: existing signing headers + `X-Encryption`, `X-Nonce` (hex), `X-Key-Fingerprint`, `Content-Type: application/octet-stream`.
6. Send the request with the ciphertext as the body.

### 5.3 Request Decryption Flow (Hub)

When the hub receives an inter-host request (`/sync/*`, `/api/relay-deliver`):

1. Check for `X-Encryption` header. If absent, reject with HTTP 400 (R-SE10).
2. Read `X-Site-Id` to identify the sender. Look up the cached symmetric key and expected fingerprint.
3. Compare `X-Key-Fingerprint` against expected. If mismatch, reject with HTTP 400 (R-SE12).
4. Verify the Ed25519 signature over the ciphertext body (existing `verifyRequest()`, unchanged).
5. Read the 192-bit nonce from `X-Nonce` (hex-decode). Validate length (exactly 24 bytes). If malformed, reject with HTTP 400 (R-SE20).
6. Decrypt the body with XChaCha20-Poly1305 using the sender's symmetric key and the nonce.
7. If decryption fails (authentication tag mismatch), reject with HTTP 400 (R-SE11).
8. Parse the decrypted bytes as JSON. Proceed with existing sync logic.

Response encryption follows the same pattern in reverse: the hub encrypts its response body with the spoke's symmetric key and a fresh random nonce.

### 5.4 Eager Push Encryption

Eager push (`eagerPushToSpoke`) follows the same encryption scheme. The hub encrypts the push body with the target spoke's symmetric key. The spoke decrypts using the hub's symmetric key (which is the same shared secret — ECDH is symmetric). Headers and verification follow the same pattern as sync requests.

### 5.5 boundcurl Diagnostic Tool

`boundcurl` is a standalone CLI command (compiled alongside `bound`, `boundctl`, and `bound-mcp`) that provides human-readable access to encrypted sync endpoints. It is intended for operator debugging, not programmatic use.

**Modes:**

- **Request mode** (default): `boundcurl POST /sync/pull --data '{"since":0}' [--config-dir X] [--data-dir X]`
  - Loads keypair from data dir, keyring from config dir.
  - Derives X25519 key, computes shared secret with hub (from sync.json hub reference).
  - Encrypts body, signs request, sends to hub URL.
  - Decrypts response, pretty-prints JSON.

- **Decrypt mode**: `boundcurl --decrypt --peer {site_id} < captured.bin`
  - Reads ciphertext from stdin.
  - Derives shared secret with the named peer.
  - Decrypts and prints plaintext JSON.
  - Requires `X-Nonce` passed via `--nonce` flag.

---

## 6. Interaction with Existing Specifications

### 6.1 Base Spec (2026-03-20)

- **§8.4 (Authentication)**: Extended. Ed25519 keypair management at startup gains an X25519 derivation step. The `ensureKeypair()` function's contract expands: it continues to return `{ publicKey, privateKey, siteId }` for signing, and downstream consumers derive X25519 keys as needed. The keypair files on disk (`host.key`, `host.pub`) remain Ed25519-only.
- **§13.4 (Signed HTTP Protocol)**: Extended. Three new headers. Signing base is unchanged but the `BODY_SHA256` now hashes ciphertext. Verification order gains encryption-specific steps before the existing signature check.
- **§8.3 (Event Exchange Protocol)**: Unchanged at the semantic level. Push, pull, ack, and relay continue to exchange the same JSON structures. Encryption/decryption is transparent to changeset serialization and reducer logic.
- **§8.5 (Live Hub Migration)**: `boundctl set-hub` drains relay messages before switching. The drain mechanism is unaffected — messages are decrypted at the transport boundary and re-encrypted for the new hub. The shared secrets are recomputed when the keyring/sync config changes.

### 6.2 Service Channel Spec (2026-03-25)

- **Relay transport**: All relay kinds (tool_call, inference, process, intake, platform_deliver, event_broadcast, cancel, and their response kinds) are encrypted identically. The relay processor operates on decrypted payloads; encryption is invisible to relay routing logic.
- **Eager push**: Encrypted per R-SE3 and §5.4. The hub encrypts pushed messages with the target spoke's symmetric key.

### 6.3 Sync Protocol Design Doc

- **Request signing** (`packages/sync/src/signing.ts`): The `signRequest()` and `verifyRequest()` functions are unchanged. They continue to sign/verify over the body bytes — which are now ciphertext bytes. No modification needed.
- **Crypto module** (`packages/sync/src/crypto.ts`): Extended with X25519 derivation functions and ECDH shared secret computation. Existing Ed25519 functions are unchanged.

---

## 7. Cryptographic Choices

### 7.1 Why XChaCha20-Poly1305 over AES-256-GCM

Both are AEAD ciphers suitable for this use case. XChaCha20-Poly1305 is preferred for two reasons:

- **192-bit nonces** eliminate nonce collision risk. AES-GCM's 96-bit nonces have a birthday bound at ~2^32 messages per key. With static ECDH (one key per spoke-hub pair for the lifetime of the keypair), a high-frequency sync cycle (every 30 seconds for months) could approach this bound. XChaCha20's 192-bit random nonces have a collision probability of ~2^-97 at 2^48 messages — effectively zero.
- **No hardware dependency.** AES-GCM performance depends on AES-NI. XChaCha20 is fast in software on all architectures, including ARM (Raspberry Pi spokes) without AES acceleration.

### 7.2 Why Static ECDH (Not Ephemeral)

Static ECDH derives one shared secret per spoke-hub pair from their long-lived keys. Ephemeral ECDH would generate a fresh X25519 keypair per sync cycle.

Static ECDH is chosen because:

- **Zero round trips.** Shared secrets are derived at startup from the keyring. No handshake phase is needed.
- **Simpler protocol.** No ephemeral key negotiation, no session state, no key commitment schemes.
- **Acceptable tradeoff.** The cost is no forward secrecy: a compromised Ed25519 private key allows decryption of all past traffic captured with that keypair. This is accepted (R-SE15) because the Ed25519 private key is stored on disk with mode 0600, and the primary threat model is network-level adversaries, not host compromise.

### 7.3 Why HKDF

The raw ECDH output is a group element, not a uniformly random key. HKDF-SHA256 with a context string (`"bound-sync-v1"`) extracts a proper symmetric key and domain-separates it from any other use of the same shared secret (future-proofing for key derivation if additional protocols are added).

---

## 8. Testing Strategy

- **Unit tests**: X25519 derivation from known Ed25519 keys (test vectors). ECDH shared secret symmetry (A derives same secret as B). Encrypt-decrypt round trip. Fingerprint computation. Nonce uniqueness (statistical test over 10,000 generations). Rejection of missing/malformed headers.
- **Integration tests**: Full sync cycle (push/pull/ack/relay) with encryption enabled between two in-process hosts. Keyring mismatch detection (modify one host's key, verify fingerprint rejection). Decryption failure on corrupted ciphertext. Eager push with encryption.
- **Compatibility**: Verify that the signing protocol's signature verification passes when the body is ciphertext (not plaintext). This confirms R-SE6 — the signature covers ciphertext.
- **boundcurl**: Request mode against a running hub. Decrypt mode with captured traffic. Verify output matches expected plaintext.
