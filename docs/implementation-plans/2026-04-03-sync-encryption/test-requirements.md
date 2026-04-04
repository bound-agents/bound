# Sync Encryption Test Requirements

This document maps every acceptance criterion (AC1 through AC15) to either an automated test or documented human verification. Cross-references the 8 implementation phases to identify the test file covering each AC.

---

## Automated Tests

| AC | Description | Test Type | Expected Test File | Phase |
|----|-------------|-----------|-------------------|-------|
| sync-encryption.AC1.1 | X25519 key pair deterministically derived from Ed25519 identity at startup | unit | `packages/sync/src/__tests__/encryption.test.ts` | 1 |
| sync-encryption.AC1.2 | Same Ed25519 private key always produces same X25519 private key | unit | `packages/sync/src/__tests__/encryption.test.ts` | 1 |
| sync-encryption.AC1.3 | X25519 public key derivable from Ed25519 public key alone | unit | `packages/sync/src/__tests__/encryption.test.ts` | 1 |
| sync-encryption.AC1.4 | Raw Ed25519 key bytes extracted via JWK export | unit | `packages/sync/src/__tests__/encryption.test.ts` | 1 |
| sync-encryption.AC1.5 | Key derivation failure produces FATAL log and process exit | unit | `packages/sync/src/__tests__/key-manager.test.ts` | 1 (unit), 5 (wiring) |
| sync-encryption.AC2.1 | ECDH shared secret is symmetric (A's secret == B's secret) | unit | `packages/sync/src/__tests__/encryption.test.ts`, `packages/sync/src/__tests__/key-manager.test.ts` | 1 |
| sync-encryption.AC2.2 | HKDF-SHA256 derives 256-bit key with salt "bound" and info "sync-v1" | unit | `packages/sync/src/__tests__/encryption.test.ts` | 1 |
| sync-encryption.AC2.3 | Shared secrets cached in memory per peer, keyed by siteId | unit | `packages/sync/src/__tests__/key-manager.test.ts` | 1 |
| sync-encryption.AC2.4 | Derived keys and secrets never written to disk or logged | unit | `packages/sync/src/__tests__/key-manager.test.ts` | 1 |
| sync-encryption.AC3.1 | Fingerprint is first 8 bytes (16 hex chars) of SHA-256 of X25519 public key | unit | `packages/sync/src/__tests__/encryption.test.ts`, `packages/sync/src/__tests__/key-manager.test.ts` | 1 |
| sync-encryption.AC3.2 | Fingerprint sent in X-Key-Fingerprint header on requests | unit | `packages/sync/src/__tests__/transport.test.ts` | 2 |
| sync-encryption.AC3.3 | Fingerprint mismatch rejected with HTTP 400 before decryption | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC3.4 | No X-Key-Fingerprint required on responses | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC4.1 | Request body encrypted with XChaCha20-Poly1305 using peer's symmetric key | unit | `packages/sync/src/__tests__/encryption.test.ts`, `packages/sync/src/__tests__/transport.test.ts` | 1, 2 |
| sync-encryption.AC4.2 | Random 192-bit nonce generated per message | unit | `packages/sync/src/__tests__/encryption.test.ts`, `packages/sync/src/__tests__/transport.test.ts` | 1, 2 |
| sync-encryption.AC4.3 | Empty bodies produce valid ciphertext (16-byte auth tag) | unit | `packages/sync/src/__tests__/encryption.test.ts`, `packages/sync/src/__tests__/transport.test.ts` | 1, 2 |
| sync-encryption.AC4.4 | Nonce collision probability ~2^-97 after 2^48 messages | n/a | n/a | n/a |
| sync-encryption.AC5.1 | X-Encryption: "xchacha20" header present on encrypted requests | unit | `packages/sync/src/__tests__/transport.test.ts` | 2 |
| sync-encryption.AC5.2 | X-Nonce header is hex-encoded 48 chars | unit | `packages/sync/src/__tests__/transport.test.ts` | 2 |
| sync-encryption.AC5.3 | Content-Type set to application/octet-stream | unit | `packages/sync/src/__tests__/transport.test.ts` | 2 |
| sync-encryption.AC5.4 | Ed25519 signature covers ciphertext, not plaintext | unit | `packages/sync/src/__tests__/signing.test.ts`, `packages/sync/src/__tests__/transport.test.ts` | 2 |
| sync-encryption.AC6.1 | Hub decrypts incoming request body, provides plaintext JSON to route handlers | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC6.2 | Verification order: encryption check -> fingerprint -> signature -> timestamp -> nonce -> decrypt | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC6.3 | Corrupted ciphertext rejected with HTTP 400, generic hint, full error logged locally | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts`, `packages/sync/src/__tests__/encryption-errors.test.ts` | 3, 5 |
| sync-encryption.AC6.4 | Malformed X-Nonce rejected with HTTP 400 | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC7.1 | Hub encrypts response body with spoke's symmetric key and fresh nonce | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC7.2 | Response includes X-Encryption and X-Nonce headers | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC7.3 | Spoke decrypts response; AEAD decryption implicitly authenticates hub | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC7.4 | Spoke detects plaintext error responses by absent X-Encryption header | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts`, `packages/sync/src/__tests__/transport.test.ts` | 3, 5 |
| sync-encryption.AC8.1 | Plaintext request rejected with HTTP 400 and upgrade message | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC8.2 | X-Nonce present without X-Encryption rejected as ambiguous | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC8.3 | X-Encryption present without X-Nonce rejected as malformed | unit | `packages/sync/src/__tests__/encrypted-middleware.test.ts` | 3 |
| sync-encryption.AC9.1 | Hub encrypts eager push body with target spoke's symmetric key | unit, integration | `packages/sync/src/__tests__/eager-push-encrypted.test.ts`, `packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts` | 4, 8 |
| sync-encryption.AC9.2 | Spoke decrypts eager push using shared secret with hub | unit, integration | `packages/sync/src/__tests__/eager-push-encrypted.test.ts`, `packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts` | 4, 8 |
| sync-encryption.AC9.3 | Reachability tracking unaffected by encryption layer | unit | `packages/sync/src/__tests__/eager-push-encrypted.test.ts` | 4 |
| sync-encryption.AC10.1 | Encryption-layer errors return plaintext JSON with Content-Type: application/json | unit | `packages/sync/src/__tests__/encryption-errors.test.ts` | 5 |
| sync-encryption.AC10.2 | Application-layer errors return encrypted JSON | unit | `packages/sync/src/__tests__/encryption-errors.test.ts` | 5 |
| sync-encryption.AC10.3 | Decryption failure response includes no oracle details | unit | `packages/sync/src/__tests__/encryption-errors.test.ts` | 5 |
| sync-encryption.AC11.1 | Normal operation logs ciphertext length, nonce, siteId, endpoint -- never plaintext bodies | unit | `packages/sync/src/__tests__/encryption-errors.test.ts` | 5 |
| sync-encryption.AC11.3 | Encryption-layer failures logged at WARN or ERROR per type | unit | `packages/sync/src/__tests__/encryption-errors.test.ts` | 5 |
| sync-encryption.AC12.1 | SIGHUP reloads all optional configs | unit | `packages/cli/src/__tests__/sighup.test.ts` | 6 |
| sync-encryption.AC12.2 | KeyManager recomputes shared secrets for added/changed peers | unit, integration | `packages/cli/src/__tests__/sighup.test.ts`, `packages/sync/src/__tests__/sighup-reload.integration.test.ts` | 6, 8 |
| sync-encryption.AC12.3 | Unchanged peers keep cached secrets | unit | `packages/cli/src/__tests__/sighup.test.ts` | 6 |
| sync-encryption.AC12.4 | Removed peers have secrets evicted | unit, integration | `packages/cli/src/__tests__/sighup.test.ts`, `packages/sync/src/__tests__/sighup-reload.integration.test.ts` | 6, 8 |
| sync-encryption.AC12.5 | Bad config file is non-fatal: logs error, keeps previous value | unit | `packages/cli/src/__tests__/sighup.test.ts` | 6 |
| sync-encryption.AC12.6 | Concurrent SIGHUP signals do not cause race conditions | unit | `packages/cli/src/__tests__/sighup.test.ts` | 6 |
| sync-encryption.AC13.1 | Request mode sends encrypted request and prints decrypted JSON response | unit | `packages/cli/src/__tests__/boundcurl.test.ts` | 7 |
| sync-encryption.AC13.2 | Decrypt mode with explicit --nonce decrypts stdin as ciphertext | unit | `packages/cli/src/__tests__/boundcurl.test.ts` | 7 |
| sync-encryption.AC13.3 | Decrypt mode without --nonce interprets first 24 bytes as nonce | unit | `packages/cli/src/__tests__/boundcurl.test.ts` | 7 |
| sync-encryption.AC13.4 | Binary compiles as dist/boundcurl alongside existing 3 binaries | build | n/a (verified by `bun run build`) | 7 |
| sync-encryption.AC14.1 | Full sync cycle (push/pull/ack/relay) completes between two encrypted hosts | integration | `packages/sync/src/__tests__/encrypted-sync.integration.test.ts` | 8 |
| sync-encryption.AC14.2 | Data round-trips correctly through encrypt-transmit-decrypt pipeline | integration | `packages/sync/src/__tests__/encrypted-sync.integration.test.ts` | 8 |
| sync-encryption.AC14.3 | Keyring mismatch produces clear fingerprint rejection diagnostic | integration | `packages/sync/src/__tests__/keyring-mismatch.integration.test.ts` | 8 |
| sync-encryption.AC14.4 | Hub migration works -- spoke switches to new hub's secret without restart | integration | `packages/sync/src/__tests__/sighup-reload.integration.test.ts` | 8 |
| sync-encryption.AC15.1 | Existing signing tests pass unchanged | regression | `packages/sync/src/__tests__/signing.test.ts` (existing, unmodified) | 8 |
| sync-encryption.AC15.2 | Existing test suite (700+ tests) shows zero regressions | regression | All existing test files via `bun test --recursive` | 8 |
| sync-encryption.AC15.3 | Single-node deployments without keyring are unaffected | regression | All existing tests that omit keyring/transport (optional params default to undefined) | 8 |

---

## Human Verification

| AC | Description | Why Not Automated | Verification Approach |
|----|-------------|-------------------|----------------------|
| sync-encryption.AC4.4 | Nonce collision probability ~2^-97 after 2^48 messages | Mathematical property of 192-bit random nonces, not a runtime behavior | Verified by design: XChaCha20 uses 192-bit nonces with `crypto.getRandomValues()`. Birthday bound for collision is ~2^96 messages. No test needed. |
| sync-encryption.AC11.2 | `BOUND_LOG_SYNC_PLAINTEXT=1` enables plaintext body logging with startup WARNING | Requires process-level env var and inspecting log output at runtime; unit testing env var reads is brittle and low-value | Start process with `BOUND_LOG_SYNC_PLAINTEXT=1`. Verify startup WARNING is logged. Send an encrypted sync request. Verify decrypted body appears in debug-level logs. Restart without the env var. Verify no plaintext bodies appear in logs. |
| sync-encryption.AC13.4 | Binary compiles as `dist/boundcurl` alongside existing 3 binaries | Build output verification, not a behavioral test | Run `bun run build`. Verify `dist/boundcurl` exists and is executable. Verify `dist/bound`, `dist/boundctl`, `dist/bound-mcp` still exist. Verify `./dist/boundcurl --help` prints usage. |

---

## Test File Summary

| Test File | Type | Phase | AC Coverage |
|-----------|------|-------|-------------|
| `packages/sync/src/__tests__/encryption.test.ts` | unit | 1 | AC1.1, AC1.2, AC1.3, AC1.4, AC2.1, AC2.2, AC3.1, AC4.1, AC4.2, AC4.3 |
| `packages/sync/src/__tests__/key-manager.test.ts` | unit | 1 | AC1.5, AC2.1, AC2.3, AC2.4, AC3.1 |
| `packages/sync/src/__tests__/signing.test.ts` | unit | 2 (extended) | AC5.4 (Uint8Array body support) |
| `packages/sync/src/__tests__/transport.test.ts` | unit | 2 | AC3.2, AC4.1, AC4.2, AC4.3, AC5.1, AC5.2, AC5.3, AC5.4, AC7.4 |
| `packages/sync/src/__tests__/encrypted-middleware.test.ts` | unit | 3 | AC3.3, AC3.4, AC6.1, AC6.2, AC6.3, AC6.4, AC7.1, AC7.2, AC7.3, AC7.4, AC8.1, AC8.2, AC8.3 |
| `packages/sync/src/__tests__/eager-push-encrypted.test.ts` | unit | 4 | AC9.1, AC9.2, AC9.3 |
| `packages/sync/src/__tests__/encryption-errors.test.ts` | unit | 5 | AC10.1, AC10.2, AC10.3, AC11.1, AC11.3 |
| `packages/cli/src/__tests__/sighup.test.ts` | unit | 6 | AC12.1, AC12.2, AC12.3, AC12.4, AC12.5, AC12.6 |
| `packages/cli/src/__tests__/boundcurl.test.ts` | unit | 7 | AC13.1, AC13.2, AC13.3 |
| `packages/sync/src/__tests__/encrypted-sync.integration.test.ts` | integration | 8 | AC14.1, AC14.2 |
| `packages/sync/src/__tests__/keyring-mismatch.integration.test.ts` | integration | 8 | AC14.3 |
| `packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts` | integration | 8 | AC9.1, AC9.2 (end-to-end) |
| `packages/sync/src/__tests__/sighup-reload.integration.test.ts` | integration | 8 | AC12.2, AC12.4, AC14.4 |
| All existing test files | regression | 8 | AC15.1, AC15.2, AC15.3 |
