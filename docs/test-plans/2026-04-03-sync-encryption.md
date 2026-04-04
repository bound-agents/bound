# Sync Encryption — Human Test Plan

**Implementation plan:** `docs/implementation-plans/2026-04-03-sync-encryption/`
**Automated test coverage:** 55/55 acceptance criteria PASS (1579 tests, 0 failures, 130 files)
**Generated:** 2026-04-04

---

## Prerequisites

- Two-host deployment (hub + spoke) with `keyring.json` configured on both
- Both hosts compiled and running: `bun run build && ./dist/bound start`
- `bun test --recursive` passing (1579 pass, 0 fail, 4 skip)
- Access to both hosts' log output (stdout or log file)
- Access to both hosts' `config/` directories for file edits

## Phase 1: Binary Build Verification

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Run `bun run build` from project root | Build completes without errors |
| 1.2 | Run `ls -la dist/` | Four binaries exist: `bound`, `boundctl`, `bound-mcp`, `boundcurl` |
| 1.3 | Run `./dist/boundcurl --help` | Prints usage information showing request mode and decrypt mode |
| 1.4 | Verify each binary is executable: `file dist/boundcurl` | Shows executable binary format |

## Phase 2: Debug Logging Verification (AC11.2)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Stop the hub process | Process exits cleanly |
| 2.2 | Set `BOUND_LOG_SYNC_PLAINTEXT=1` and restart hub | Startup WARNING logged: message about plaintext logging being enabled |
| 2.3 | Trigger a sync cycle from spoke (send any request) | Hub logs show decrypted plaintext body at debug level alongside ciphertext metadata |
| 2.4 | Stop hub, unset `BOUND_LOG_SYNC_PLAINTEXT`, restart | No startup warning about plaintext logging |
| 2.5 | Trigger another sync cycle from spoke | Hub logs show ciphertext length, nonce, siteId, endpoint -- but NO plaintext bodies |

## Phase 3: End-to-End Encrypted Sync

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | On spoke, create a new thread via the web UI at `http://localhost:PORT/` | Thread created successfully |
| 3.2 | Send a message in the new thread | Agent responds normally |
| 3.3 | Wait for sync cycle to complete (check spoke logs for "sync cycle completed") | Sync succeeds; logs show encrypted transport (no plaintext payloads in logs) |
| 3.4 | On hub, navigate to `http://localhost:HUB_PORT/` | Hub web UI loads |
| 3.5 | Verify the spoke's thread and messages appear on hub | Thread title, message content, and agent response match spoke exactly |
| 3.6 | On hub, create a memory entry: send a message asking the agent to memorize something | Agent confirms memorization |
| 3.7 | Wait for sync cycle | Sync succeeds |
| 3.8 | On spoke, verify the memory exists: ask the agent to recall it | Agent recalls the memorized content correctly |

## Phase 4: boundcurl Diagnostic Tool

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | From spoke host, run `./dist/boundcurl POST http://HUB:PORT/sync/pull --data '{"since_seq":0}'` | Prints decrypted JSON response showing sync pull data (events array, source_seq_end) |
| 4.2 | Capture the raw encrypted response by running `curl` directly with the same URL (no encryption headers) | Hub returns HTTP 400 with `{"error":"plaintext_rejected","message":"Upgrade to a version with sync encryption"}` |
| 4.3 | Test decrypt mode: pipe encrypted data to `./dist/boundcurl --decrypt --peer HUB_SITE_ID --nonce NONCE_HEX` | Decrypted plaintext JSON printed to stdout |

## Phase 5: SIGHUP Keyring Reload

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | On hub, note the current `keyring.json` content | Baseline captured |
| 5.2 | Add a new (fake) peer entry to hub's `config/keyring.json` with a valid Ed25519 public key | File saved |
| 5.3 | Send SIGHUP to hub process: `kill -HUP $(pgrep -f "bound start")` | Hub logs: "Reloading optional configs"; logs new peer being added to KeyManager |
| 5.4 | Remove the fake peer from `config/keyring.json` | File saved |
| 5.5 | Send SIGHUP again | Hub logs: reload message; removed peer evicted from KeyManager |
| 5.6 | Verify spoke can still sync after hub's SIGHUP | Sync cycle succeeds normally |
| 5.7 | Write intentionally invalid JSON to hub's `config/keyring.json` | File saved with syntax error |
| 5.8 | Send SIGHUP | Hub logs: error parsing keyring.json; previous keyring preserved; sync still works |
| 5.9 | Restore valid `config/keyring.json` and send SIGHUP | Hub accepts the restored config |

## Phase 6: Hub Migration

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | Start a third host (hub2) with its own keypair | hub2 running with its own Ed25519 identity |
| 6.2 | Update spoke's `config/keyring.json` to include hub2's public key and URL | File saved |
| 6.3 | Update spoke's `config/sync.json` to point hub URL at hub2 | File saved |
| 6.4 | Send SIGHUP to spoke: `kill -HUP $(pgrep -f "bound start")` | Spoke logs: keyring reloaded, new hub key computed |
| 6.5 | Wait for next sync cycle | Spoke syncs with hub2 successfully; data arrives on hub2 |
| 6.6 | Verify spoke's data from original hub is still intact locally | All threads, messages, memories present on spoke |

## Phase 7: Keyring Mismatch Diagnostic Clarity

| Step | Action | Expected |
|------|--------|----------|
| 7.1 | On spoke, temporarily edit `config/keyring.json` to replace hub's public key with a different valid Ed25519 key | File saved with wrong key |
| 7.2 | Send SIGHUP to spoke | Spoke reloads keyring with wrong hub key |
| 7.3 | Wait for sync cycle | Sync fails; spoke logs show HTTP 400 from hub |
| 7.4 | Check hub logs | Hub logs WARN "Key fingerprint mismatch" with expected and received fingerprints |
| 7.5 | Restore correct public key in spoke's keyring, send SIGHUP | Spoke reloads correct keyring |
| 7.6 | Wait for sync cycle | Sync succeeds again |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC4.4 (Nonce collision probability) | Mathematical property of 192-bit random nonces, not testable at runtime | Verified by design: XChaCha20 uses 192-bit nonces via `crypto.getRandomValues()`. Birthday bound for collision is ~2^96 messages. No test needed. |
| AC11.2 (BOUND_LOG_SYNC_PLAINTEXT) | Requires process-level env var and inspecting log output | Phase 2 steps above |
| AC13.4 (boundcurl binary) | Build output verification | Phase 1 steps above |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1-AC1.5 | encryption.test.ts, key-manager.test.ts | -- |
| AC2.1-AC2.4 | encryption.test.ts, key-manager.test.ts | -- |
| AC3.1-AC3.4 | encryption.test.ts, key-manager.test.ts, transport.test.ts, encrypted-middleware.test.ts, encryption-errors.test.ts | -- |
| AC4.1-AC4.3 | encryption.test.ts, transport.test.ts | -- |
| AC4.4 | -- | Design review (192-bit nonce) |
| AC5.1-AC5.4 | transport.test.ts, signing.test.ts | -- |
| AC6.1-AC6.4 | encrypted-middleware.test.ts, encryption-errors.test.ts | -- |
| AC7.1-AC7.4 | encrypted-middleware.test.ts, transport.test.ts | -- |
| AC8.1-AC8.3 | encrypted-middleware.test.ts | -- |
| AC9.1-AC9.3 | eager-push-encrypted.test.ts | -- |
| AC10.1-AC10.3 | encryption-errors.test.ts, encrypted-middleware.test.ts | -- |
| AC11.1, AC11.3 | encryption-errors.test.ts | -- |
| AC11.2 | -- | Phase 2 |
| AC12.1-AC12.6 | sighup.test.ts, sighup-reload.integration.test.ts | Phase 5 |
| AC13.1-AC13.3 | boundcurl.test.ts | Phase 4 |
| AC13.4 | -- | Phase 1 |
| AC14.1-AC14.2 | encrypted-sync.integration.test.ts | Phase 3 |
| AC14.3 | keyring-mismatch.integration.test.ts | Phase 7 |
| AC14.4 | sighup-reload.integration.test.ts | Phase 6 |
| AC15.1 | signing.test.ts | -- |
| AC15.2 | Full suite (1579 pass) | -- |
| AC15.3 | Backward compat test in encrypted-middleware.test.ts | -- |
