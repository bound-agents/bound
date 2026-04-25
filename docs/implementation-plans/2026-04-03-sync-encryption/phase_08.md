# Sync Encryption Implementation Plan — Phase 8: Integration Tests and Compatibility

**Goal:** Verify the complete encryption system works end-to-end across multi-host sync scenarios, and confirm zero regressions to the existing test suite.

**Architecture:** Integration tests spin up multiple in-process hosts (hub + spokes) with real Ed25519 keypairs, KeyManagers, SyncTransports, and encrypted Hono servers on random ports. Tests exercise the full sync cycle (push/pull/ack/relay), keyring mismatch diagnostics, encrypted eager push, and SIGHUP-triggered keyring changes. Compatibility is verified by running the complete existing test suite.

**Tech Stack:** bun:test, real crypto, real HTTP (Bun.serve), random ports, multi-host setup pattern from sync-e2e.test.ts

**Scope:** Phase 8 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC14: Integration
- **sync-encryption.AC14.1 Success:** Full sync cycle (push/pull/ack/relay) completes between two encrypted hosts
- **sync-encryption.AC14.2 Success:** Data round-trips correctly through encrypt-transmit-decrypt pipeline
- **sync-encryption.AC14.3 Success:** Keyring mismatch between hosts produces clear fingerprint rejection diagnostic
- **sync-encryption.AC14.4 Success:** Hub migration (set-hub) works -- spoke switches to new hub's cached secret without restart

### sync-encryption.AC15: Compatibility
- **sync-encryption.AC15.1 Success:** Existing signing tests pass unchanged (signature covers ciphertext)
- **sync-encryption.AC15.2 Success:** Existing test suite (700+ tests) shows zero regressions
- **sync-encryption.AC15.3 Success:** Single-node deployments without keyring are unaffected

---

<!-- START_TASK_1 -->
### Task 1: Full encrypted sync cycle integration test

**Verifies:** sync-encryption.AC14.1, sync-encryption.AC14.2

**Files:**
- Create: `packages/sync/src/__tests__/encrypted-sync.integration.test.ts`

**Testing:**

Follow the multi-host pattern from `packages/sync/src/__tests__/sync-e2e.test.ts`. Create two fully-wired hosts (hub + spoke) with:
- Real Ed25519 keypairs via `ensureKeypair()`
- Real KeyManagers initialized with mutual keyring
- Real SyncTransports for encrypted communication
- Real Hono HTTP servers on random ports with encrypted middleware
- Real SyncClients with transport injected

Test setup helper:
```typescript
async function createEncryptedHost(name: string, keyring: KeyringConfig, dir: string) {
	const kp = await ensureKeypair(dir);
	const km = new KeyManager(kp, kp.siteId);
	await km.init(keyring);
	const transport = new SyncTransport(km, kp.privateKey, kp.siteId);
	// ... create DB, schema, Hono app with createSyncRoutes(..., km) ...
	// ... Bun.serve on random port ...
	return { kp, km, transport, db, server, port, siteId: kp.siteId, cleanup };
}
```

Tests:

- **Full sync cycle:** Insert rows on spoke (users, threads, messages, semantic_memory). Run `syncClient.syncCycle()`. Verify rows appear on hub's database. Then insert rows on hub. Run sync from spoke. Verify spoke pulls hub's rows. Covers push/pull/ack phases.
- **Data round-trip integrity:** Insert a row with Unicode content, special characters, and large JSON. Sync it. Verify byte-exact content match on the other side (encrypt-transmit-decrypt preserves data perfectly).
- **Relay phase:** Insert relay outbox entries on spoke. Run sync cycle. Verify relay entries arrive in hub's inbox. Verify hub can route relay to another spoke.
- **Multiple sync cycles:** Run 5 sync cycles with new data each time. Verify all data syncs correctly (no accumulation of encryption state issues).

**Verification:**

Run: `bun test packages/sync/src/__tests__/encrypted-sync.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encrypted sync cycle integration tests`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Keyring mismatch integration test

**Verifies:** sync-encryption.AC14.3

**Files:**
- Create: `packages/sync/src/__tests__/keyring-mismatch.integration.test.ts`

**Testing:**

Create two hosts where one has a different keypair than what the other's keyring expects. This simulates a keyring misconfiguration.

Tests:

- **Fingerprint rejection:** Hub has spoke A's real public key in keyring. Spoke B (different keypair) sends a request claiming to be from spoke A's siteId but with a different fingerprint. Verify HTTP 400 with `key_mismatch` error containing `expected_fingerprint` and `received_fingerprint`.
- **Unknown site rejection:** A host not in the keyring at all sends an encrypted request. Verify HTTP 403 with `unknown_site` error (existing signing behavior).
- **Diagnostic clarity:** Capture the error response from a fingerprint mismatch. Verify it contains enough information for an operator to diagnose the problem: the site_id, expected fingerprint, and received fingerprint.
- **Modified key in keyring:** Start with correct keyring. Replace one host's public_key with a different key. Reload via KeyManager.reloadKeyring(). Verify the old host's requests now fail with fingerprint mismatch.

**Verification:**

Run: `bun test packages/sync/src/__tests__/keyring-mismatch.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add keyring mismatch diagnostic integration tests`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Encrypted eager push integration test

**Verifies:** sync-encryption.AC9.1, sync-encryption.AC9.2 (end-to-end verification)

**Files:**
- Create: `packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts`

**Testing:**

Create hub + spoke with full encryption. Hub sends relay entries to spoke via `eagerPushToSpoke` with transport configured.

Tests:

- **Encrypted delivery:** Hub calls `eagerPushToSpoke` with relay entries. Spoke's `/api/relay-deliver` endpoint receives and decrypts them. Verify entries are inserted into spoke's relay_inbox correctly.
- **Round-trip with relay processing:** Hub pushes relay entries to spoke. Spoke processes them (via RelayProcessor or equivalent). Verify the processed results are correct.
- **Reachability tracking after encryption:** Push to reachable spoke — verify success and tracker records it. Push to unreachable spoke — verify failure and tracker records it. Push to same spoke again — verify it skips due to unreachable status.

**Verification:**

Run: `bun test packages/sync/src/__tests__/eager-push-encrypted.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add encrypted eager push integration tests`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: SIGHUP reload integration test

**Verifies:** sync-encryption.AC12.2, sync-encryption.AC12.4, sync-encryption.AC14.4

**Files:**
- Create: `packages/sync/src/__tests__/sighup-reload.integration.test.ts`

**Testing:**

Test keyring hot-reload with live encryption. Create hub + spoke, verify sync works. Then modify keyring (add/remove peers) and trigger reload.

Tests:

- **Add peer via reload:** Start with hub + spoke A. Generate keypair for spoke B. Reload hub's keyring with spoke B added. Verify hub can now encrypt/decrypt with spoke B (new shared secret computed).
- **Remove peer via reload:** Start with hub + spoke A + spoke B. Reload hub's keyring with spoke B removed. Verify hub can no longer find symmetric key for spoke B (`getSymmetricKey` returns null). Verify hub still works with spoke A.
- **Hub migration (AC14.4):** Start spoke connected to hub A. Create hub B with same keyring. Reload spoke's config to point to hub B. Verify spoke can sync with hub B without restart (SyncClient.updateHubUrl + KeyManager already has B's secret from keyring).
- **Unchanged peer stability:** Reload keyring with no changes. Verify existing sync sessions continue working without interruption.

**Verification:**

Run: `bun test packages/sync/src/__tests__/sighup-reload.integration.test.ts`
Expected: All tests pass.

**Commit:** `test(sync): add SIGHUP keyring reload integration tests`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Compatibility verification — full regression test

**Verifies:** sync-encryption.AC15.1, sync-encryption.AC15.2, sync-encryption.AC15.3

**Files:**
- No new files — runs existing test suite

**Testing:**

Run the complete test suite to verify zero regressions. This covers:

- **sync-encryption.AC15.1 (signing tests):** Existing `packages/sync/src/__tests__/signing.test.ts` must pass unchanged. The signRequest/verifyRequest type extension to `string | Uint8Array` is backward compatible — all existing callers pass strings.
- **sync-encryption.AC15.2 (full suite):** All 700+ tests across all packages must pass. Key areas to watch:
  - `packages/sync` — all existing sync tests (e2e, unit, integration)
  - `packages/core` — schema tests (no changes to core)
  - `packages/agent` — agent loop tests (no changes to agent)
  - `packages/cli` — CLI tests (boundcurl added, existing unchanged)
- **sync-encryption.AC15.3 (single-node):** Existing tests that don't configure a keyring should continue to work identically. The `transport` parameter is optional everywhere, and `keyManager` is optional in middleware.

**Verification:**

Run: `bun test --recursive`
Expected: All tests pass. Zero failures. Zero regressions.

Run: `bun run typecheck`
Expected: All packages typecheck clean.

**Commit:** `test: verify zero regressions after sync encryption implementation`
<!-- END_TASK_5 -->
