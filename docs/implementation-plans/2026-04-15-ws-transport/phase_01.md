# WebSocket Sync Transport Implementation Plan — Phase 1

**Goal:** Binary frame encoding/decoding with XChaCha20-Poly1305 encryption, independent of connection management

**Architecture:** Create a frame codec module (`ws-frames.ts`) that wraps existing `encryptBody()`/`decryptBody()` primitives into a wire-format binary protocol. Each frame is `[1 byte type][24 bytes nonce][N bytes ciphertext]`. The codec is stateless and testable in isolation.

**Tech Stack:** TypeScript, `@noble/ciphers` (via existing `encryption.ts` wrapper), `bun:test`

**Scope:** Phase 1 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC3: Encryption preserved
- **ws-transport.AC3.1 Success:** WS frames are XChaCha20-Poly1305 encrypted with per-peer symmetric key derived via ECDH
- **ws-transport.AC3.2 Success:** Each frame uses a random 24-byte nonce
- **ws-transport.AC3.6 Failure:** Frame with tampered ciphertext fails decryption and is discarded (connection not killed)

---

## Reference Files

The executor should read these files for context:

- `packages/sync/src/encryption.ts` — `encryptBody()` / `decryptBody()` signatures and crypto primitives
- `packages/sync/src/key-manager.ts` — `KeyManager.getSymmetricKey()` returns `Uint8Array | null`
- `packages/sync/src/index.ts` — current exports (ws-frames exports will be added here)
- `packages/sync/src/__tests__/encryption.test.ts` — testing patterns for crypto roundtrips
- `packages/sync/src/__tests__/test-harness.ts` — shared test infrastructure
- `CLAUDE.md` — testing conventions (temp DB paths with `randomBytes(4).toString("hex")`, biome formatting)

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: WsMessageType enum and frame type definitions

**Verifies:** None (type infrastructure for subsequent tasks)

**Files:**
- Create: `packages/sync/src/ws-frames.ts`

**Implementation:**

Define the `WsMessageType` enum matching the design's message type table, plus TypeScript discriminated unions for decoded frame payloads.

Message types from design:
| Type | Byte | Direction | Purpose |
|------|------|-----------|---------|
| `changelog_push` | `0x01` | Both | Push new change_log entries |
| `changelog_ack` | `0x02` | Both | Confirm receipt up to HLC cursor |
| `relay_send` | `0x03` | Both | Relay outbox entries for hub to route |
| `relay_deliver` | `0x04` | Hub→Spoke | Relay inbox entries routed to this spoke |
| `relay_ack` | `0x05` | Both | Confirm relay entries delivered/processed |
| `drain_request` | `0x06` | Both | Request full drain of pending entries |
| `drain_complete` | `0x07` | Both | Drain finished |
| `error` | `0xFF` | Both | Transport-level error |

The module should export:
- `WsMessageType` enum with the byte values above
- `WsFrame` discriminated union type keyed on `type` field, where each variant carries the appropriate payload type
- Payload types for each message type (e.g., `ChangelogPushPayload`, `ChangelogAckPayload`, etc.) — these are JSON-serializable objects that will be encrypted inside frames
- A `WsFrameError` type for decode failures

Use the sync package's existing patterns: `type` keyword for wire protocol types, `import type` for type-only imports, `.js` extensions on relative imports.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add WsMessageType enum and frame type definitions`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: encodeFrame and decodeFrame implementation

**Verifies:** ws-transport.AC3.1, ws-transport.AC3.2, ws-transport.AC3.6

**Files:**
- Modify: `packages/sync/src/ws-frames.ts` (add encode/decode functions)

**Implementation:**

Add two functions to `ws-frames.ts`:

`encodeFrame(type: WsMessageType, payload: unknown, symmetricKey: Uint8Array): Uint8Array`
1. JSON-stringify the payload and encode to UTF-8 (`new TextEncoder().encode(...)`)
2. Call `encryptBody(plaintext, symmetricKey)` from `./encryption.js` — returns `{ ciphertext, nonce }` (nonce is 24 bytes, random per call)
3. Allocate a `Uint8Array` of size `1 + 24 + ciphertext.length`
4. Write: `[type byte][nonce (24 bytes)][ciphertext]`
5. Return the frame

`decodeFrame(frame: Uint8Array, symmetricKey: Uint8Array): Result<WsFrame, WsFrameError>`
1. Validate minimum frame size: `1 + 24 + 16 = 41` bytes (type + nonce + minimum ciphertext with auth tag). If too short, return error result.
2. Extract type byte at offset 0. If not a known `WsMessageType` value, return error result with `"unknown_type"`.
3. Extract 24-byte nonce at offset 1..25
4. Extract ciphertext at offset 25..end
5. Call `decryptBody(ciphertext, nonce, symmetricKey)` — this throws on auth failure (tampered ciphertext). Catch the error and return error result with `"decryption_failed"` (AC3.6: frame discarded, not connection killed).
6. Decode the plaintext UTF-8 bytes to string, JSON.parse into payload
7. If JSON.parse fails, return error result with `"invalid_payload"`
8. Return success result with the appropriate `WsFrame` discriminated union variant

Use the `Result<T, E>` pattern from `@bound/shared` for the return type. Follow the existing error handling patterns in the sync package (structured error codes, not thrown exceptions for expected failures).

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): implement encodeFrame and decodeFrame with XChaCha20-Poly1305`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Frame codec tests

**Verifies:** ws-transport.AC3.1, ws-transport.AC3.2, ws-transport.AC3.6

**Files:**
- Create: `packages/sync/src/__tests__/ws-frames.test.ts`

**Testing:**

Tests must verify each AC listed above. Follow patterns from `packages/sync/src/__tests__/encryption.test.ts` for crypto testing.

Generate a test symmetric key using `deriveSharedSecret()` from `encryption.ts` with two generated keypairs (see existing encryption tests for pattern), or use `randomBytes(32)` for a simpler approach since the codec doesn't care about key derivation.

Test cases:

- **ws-transport.AC3.1 — Roundtrip for all 8 message types:** For each `WsMessageType`, encode a frame with a representative payload and symmetric key, then decode it. Verify the decoded type matches, payload deep-equals the original. This proves XChaCha20-Poly1305 encryption/decryption works end-to-end.

- **ws-transport.AC3.2 — Random nonce per frame:** Encode the same payload twice with the same key. Extract the nonce bytes (offset 1..25) from each frame. Verify they differ (random 24-byte nonce per call).

- **ws-transport.AC3.6 — Tampered ciphertext rejected:** Encode a valid frame, flip a byte in the ciphertext region (offset 25+), attempt to decode. Verify the result is `{ ok: false }` with error `"decryption_failed"`. The function should NOT throw — it returns an error result.

Additional test cases for robustness:
- **Frame too short:** Pass a `Uint8Array` of length < 41 bytes. Verify error result with `"frame_too_short"`.
- **Unknown message type:** Construct a frame with type byte `0xAA` (not in enum). Verify error result with `"unknown_type"`.
- **Invalid JSON payload:** Encode a frame normally, then replace the ciphertext with encrypted non-JSON bytes (encrypt raw bytes that aren't valid JSON). Verify error result with `"invalid_payload"`.
- **Wrong key rejects:** Encode with key A, decode with key B. Verify decryption failure.
- **Large payload roundtrip:** Encode a payload near the 2MB limit to verify no size-related issues.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-frames.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add ws-frames codec tests for all message types and error cases`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Export ws-frames from sync package index

**Verifies:** None (infrastructure wiring)

**Files:**
- Modify: `packages/sync/src/index.ts` — add exports for ws-frames types and functions

**Implementation:**

Add to `packages/sync/src/index.ts`:
- Export the `WsMessageType` enum
- Export the `WsFrame` type and all payload types
- Export `encodeFrame` and `decodeFrame` functions
- Export `WsFrameError` type

Follow the existing export style in the file (grouped by module with comments).

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

Run: `bun test packages/sync/src/__tests__/ws-frames.test.ts`
Expected: All tests still pass

**Commit:** `feat(sync): export ws-frames types and functions from package index`
<!-- END_TASK_4 -->
