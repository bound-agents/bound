# Test Requirements: WebSocket Sync Transport

Maps each acceptance criterion to automated tests or documented human verification.

---

## Summary

| AC | Automated | Human | Phase | Notes |
|----|-----------|-------|-------|-------|
| AC1.1 | grep verification | -- | 7 | Route deletion confirmed by grep + build |
| AC1.2 | grep verification | -- | 7 | Endpoint deletion confirmed by grep + build |
| AC1.3 | unit (file deletion) | -- | 7 | Module deletion confirmed by ls + build |
| AC1.4 | unit + grep | -- | 6 | Event removal confirmed by typecheck + grep |
| AC1.5 | integration (build) | -- | 7 | Full build succeeds with no dead references |
| AC2.1 | integration | -- | 2, 3 | Real Bun.serve + WS client lifecycle |
| AC2.2 | integration | -- | 4 | Bidirectional replication timing |
| AC2.3 | integration | -- | 5 | Relay routing: unicast, broadcast, hub-local |
| AC2.4 | integration | -- | 5 | Broadcast fan-out to all spokes except source |
| AC2.5 | integration | -- | 5 | Request vs response kind dispatch |
| AC2.6 | integration | -- | 3 | Non-existent hub reconnection loop |
| AC2.7 | integration | -- | 3 | Hub node skips WS client creation |
| AC3.1 | unit | -- | 1 | Frame roundtrip for all 8 types |
| AC3.2 | unit | -- | 1 | Nonce uniqueness per frame |
| AC3.3 | unit + integration | -- | 2 | Auth header validation + full lifecycle |
| AC3.4 | unit + integration | -- | 2 | Invalid signature rejected before upgrade |
| AC3.5 | unit + integration | -- | 2 | Unknown siteId rejected |
| AC3.6 | unit | -- | 1 | Tampered ciphertext returns error result |
| AC4.1 | integration | -- | 5 | NAT spoke (no sync_url) receives relay |
| AC4.2 | integration | -- | 5 | NAT spoke receives inference chunks |
| AC4.3 | integration | -- | 3 | Short idle_timeout keepalive survival |
| AC5.1 | integration | -- | 5 | Stream chunk latency < 50ms (localhost) |
| AC5.2 | unit | -- | 6 | Event-driven chunk consumption |
| AC5.3 | unit | -- | 6 | Event-driven tool result consumption |
| AC5.4 | unit | -- | 6 | Timeout triggers failover |
| AC6.1 | integration | -- | 3 | Exponential backoff timing verification |
| AC6.2 | integration | -- | 4 | Reconnect drain catches missed entries |
| AC6.3 | integration | -- | 2, 3 | Backpressure pauses + drain resumes |
| AC6.4 | integration | -- | 2 | Send returning 0 triggers close |
| AC6.5 | integration | -- | 4 | Relay tables untouched by changelog path |
| AC6.6 | integration | -- | 4 | Hub disconnect preserves outbox entries |

---

## Automated Tests

### ws-transport.AC1: All HTTP-based sync removed

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC1.1 No `/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay` routes exist | grep + build | N/A (Phase 7, Task 7 verification step) | 7 |
| AC1.2 No `/api/relay-deliver` endpoint exists | grep + build | N/A (Phase 7, Task 7 verification step) | 7 |
| AC1.3 `sync-loop.ts`, `eager-push.ts`, `reachability.ts` deleted | file check + build | N/A (Phase 7, Task 1 verification step) | 7 |
| AC1.4 `sync:trigger` removed from EventMap, no emitters or listeners | unit (typecheck) + grep | N/A (Phase 6, Tasks 4-5 verification steps) | 6 |
| AC1.5 Build succeeds with no references to removed modules | integration (build) | N/A (Phase 7, Task 7 verification step) | 7 |

**Testing approach:** AC1 criteria are structural deletion checks. Each is verified by a combination of `grep` searches across the codebase and a clean `bun run build` + `bun test --recursive`. TypeScript's type system enforces that removing `sync:trigger` from EventMap causes compile errors at any remaining emit/listen sites, so the typecheck is the authoritative test for AC1.4. No dedicated test file is needed -- the build pipeline itself is the test.

**Verification commands (Phase 7, Task 7):**
```bash
# AC1.1, AC1.2
grep -r "sync/push\|sync/pull\|sync/ack\|sync/relay\|relay-deliver" packages/ --include="*.ts" -l
# Expected: no matches in production code

# AC1.3
ls packages/sync/src/{sync-loop,eager-push,reachability,routes,transport,middleware}.ts 2>&1
# Expected: "No such file" for all six

# AC1.4
grep -r "sync:trigger\|sync:completed" packages/ --include="*.ts"
# Expected: no matches

# AC1.5
bun run build && bun test --recursive
# Expected: zero errors
```

---

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC2.1 Spoke establishes WSS connection to hub at `/sync/ws` | integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Task 5), `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 2, 3 |
| AC2.2 Changelog entries replicate bidirectionally within 100ms of write | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 4, Task 4) | 4 |
| AC2.3 Relay messages route correctly through hub via WS | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC2.4 Broadcast relay fans out to all connected spokes except source | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC2.5 Hub-local relay dispatches to RelayProcessor (request kinds) or relay_inbox (response kinds) | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC2.6 Non-existent hub enters reconnection loop without crashing | integration | `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 3 |
| AC2.7 Spoke with no `hub_url` does not attempt WS connection | integration | `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 3 |

**AC2.1 test details:**
- `ws-server.test.ts` full lifecycle test: start `Bun.serve()` with WS handlers, connect a WS client with valid auth headers, verify connection appears in `WsConnectionManager`, send/receive binary frame, close and verify removal.
- `ws-client.test.ts` successful connection test: create hub server + spoke client with matching keyring, call `connect()`, verify `connected` becomes true and `onConnected` fires.

**AC2.2 test details:**
- `ws-transport.test.ts` bidirectional replication test: create two `WsTransport` instances (hub + spoke) with real databases, wire sendFrame callbacks, write a row via `insertRow()` on hub, measure time to spoke seeing the entry, verify < 100ms.
- Additional tests: echo suppression (entry does not bounce back), microtask batching (10 synchronous writes produce 1 frame).

**AC2.3 test details:**
- Unicast routing: Spoke A sends `relay_send` targeting Spoke B, hub routes via `relay_deliver`, Spoke B's `relay_inbox` has the entry and `relay:inbox` event fires.

**AC2.4 test details:**
- Broadcast fan-out: Spoke A sends broadcast (`target_site_id === "*"`), hub delivers to Spoke B and Spoke C but NOT Spoke A.

**AC2.5 test details:**
- Two tests: (1) Spoke sends `tool_call` (request kind) targeting hub, verify it appears in hub's `relay_inbox`. (2) Spoke sends `result` (response kind) targeting hub, verify it goes to `relay_inbox` (NOT executeImmediate).

**AC2.6 test details:**
- `ws-client.test.ts`: create client pointing to a port with no server, call `connect()`, verify `onclose` fires, reconnect timer is set, no crash.

**AC2.7 test details:**
- `ws-client.test.ts`: verified at integration point -- `WsSyncClient` is only created inside `if (syncConfig.hub)` block. Unit test confirms `connected` is false when `close()` is called before `connect()`.

---

### ws-transport.AC3: Encryption preserved

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC3.1 WS frames encrypted with XChaCha20-Poly1305 per-peer symmetric key | unit | `packages/sync/src/__tests__/ws-frames.test.ts` (Phase 1, Task 3) | 1 |
| AC3.2 Each frame uses a random 24-byte nonce | unit | `packages/sync/src/__tests__/ws-frames.test.ts` (Phase 1, Task 3) | 1 |
| AC3.3 WS upgrade authenticated via Ed25519 signature headers | unit + integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Tasks 2 and 5) | 2 |
| AC3.4 Invalid signature rejected before upgrade (HTTP 401) | unit + integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Tasks 2 and 5) | 2 |
| AC3.5 Unknown siteId rejected | unit + integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Tasks 2 and 5) | 2 |
| AC3.6 Tampered ciphertext fails decryption and is discarded | unit | `packages/sync/src/__tests__/ws-frames.test.ts` (Phase 1, Task 3) | 1 |

**AC3.1 test details:**
- Roundtrip for all 8 message types: encode a frame with representative payload and symmetric key, decode it, verify type matches and payload deep-equals original.
- Wrong key rejects: encode with key A, decode with key B, verify decryption failure.
- Large payload roundtrip: encode payload near 2MB to verify no size issues.

**AC3.2 test details:**
- Encode same payload twice with same key, extract nonce bytes (offset 1..25) from each frame, verify they differ.

**AC3.3 test details:**
- `ws-server.test.ts` Task 2 unit: generate hub + spoke keypairs, build keyring, create Request with valid signature headers via `signRequest()`, call `authenticateWsUpgrade()`, verify `{ ok: true }` with correct siteId, symmetricKey, and fingerprint.
- `ws-server.test.ts` Task 5 integration: start real `Bun.serve()`, connect with valid auth headers, verify upgrade succeeds.

**AC3.4 test details:**
- Unit: tamper with X-Signature header, verify `{ ok: false }` with status 401.
- Integration: connect with invalid signature headers, verify HTTP 401 response (no WS upgrade).

**AC3.5 test details:**
- Unit: sign request with keypair NOT in keyring, verify `{ ok: false }` with status 403.
- Integration: connect with unknown keypair, verify HTTP 403.

**AC3.6 test details:**
- Encode valid frame, flip byte in ciphertext region (offset 25+), decode, verify `{ ok: false, error: "decryption_failed" }`. Function does NOT throw.

---

### ws-transport.AC4: NAT spokes fully supported

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC4.1 NAT spoke (no `sync_url`) receives relay at same latency | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC4.2 NAT spoke receives inference stream_chunk frames over WS | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC4.3 Bun ping/pong keepalive prevents NAT timeout | integration | `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 3 |

**AC4.1 test details:**
- Create spoke with NO `sync_url` in hosts table (simulating NAT). Spoke connects to hub via WS (outbound). Send relay message targeting this spoke. Verify spoke receives it at same latency as a spoke with `sync_url`.

**AC4.2 test details:**
- Same NAT spoke setup. Hub writes `stream_chunk` outbox entries targeting this spoke. Verify spoke receives them over WS via `relay:inbox` events.

**AC4.3 test details:**
- Connect with short `idleTimeout` (e.g., 2s), verify connection stays alive (Bun auto-sends pings). Note: this test is inherently timing-dependent and may need a generous assertion window.

---

### ws-transport.AC5: Inference streaming latency reduced

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC5.1 Stream chunks arrive within 50ms of hub writing to relay_outbox | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 5, Task 4) | 5 |
| AC5.2 RELAY_STREAM consumes chunks via `relay:inbox` event (no polling) | unit | `packages/agent/src/__tests__/relay-event-driven.test.ts` (Phase 6, Task 3) | 6 |
| AC5.3 RELAY_WAIT consumes tool results via `relay:inbox` event (no polling) | unit | `packages/agent/src/__tests__/relay-event-driven.test.ts` (Phase 6, Task 3) | 6 |
| AC5.4 Per-host inference timeout still triggers failover | unit | `packages/agent/src/__tests__/relay-event-driven.test.ts` (Phase 6, Task 3) | 6 |

**AC5.1 test details:**
- Hub writes `stream_chunk` outbox entry targeting spoke. Measure time from write to spoke's `relay:inbox` event. Verify < 50ms (localhost, excluding network RTT).

**AC5.2 test details:**
- Set up RELAY_STREAM with a stream_id. Emit `relay:inbox` events with matching stream_id. Verify chunks are yielded in order as events arrive (no 500ms polling delay).

**AC5.3 test details:**
- Two tests: (1) Set up RELAY_WAIT with ref_id, emit matching `relay:inbox` event after short delay, verify response consumed without polling delay. (2) Insert relay_inbox entry BEFORE starting RELAY_WAIT, verify found immediately on initial DB check.

**AC5.4 test details:**
- Two tests: (1) RELAY_WAIT with very short timeout (100ms), no event emitted, verify timeout fires and failover executes. (2) RELAY_STREAM: deliver first chunk, then stop -- verify per-host timeout fires after `inference_timeout_ms`.

---

### ws-transport.AC6: Cross-cutting behaviors

| Criterion | Test Type | Test File | Phase |
|-----------|-----------|-----------|-------|
| AC6.1 Exponential backoff (1s-60s cap) with jitter on reconnect | integration | `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 3 |
| AC6.2 Reconnect drain syncs missed entries from last HLC cursor | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 4, Task 4) | 4 |
| AC6.3 Backpressure pauses push-on-write; drain resumes | integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Task 5), `packages/sync/src/__tests__/ws-client.test.ts` (Phase 3, Task 3) | 2, 3 |
| AC6.4 Send returning 0 triggers close and reconnection | integration | `packages/sync/src/__tests__/ws-server.test.ts` (Phase 2, Task 5) | 2 |
| AC6.5 `relay_outbox`/`relay_inbox` remain as durable buffers | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 4, Task 4) | 4 |
| AC6.6 Hub disconnect preserves relay messages in spoke outbox | integration | `packages/sync/src/__tests__/ws-transport.test.ts` (Phase 4, Task 4) | 4 |

**AC6.1 test details:**
- Mock `setTimeout` to capture delay values. Trigger multiple reconnection attempts. Verify delays follow exponential pattern (approximately 1s, 2s, 4s, 8s...) with jitter (0-25%), capped at 60s. Verify successful reconnection resets interval to 1s.

**AC6.2 test details:**
- Write 5 entries on hub while spoke is disconnected. Then register peer and call `drainChangelog()`. Verify all 5 entries are sent and replayed on spoke. Verify HLC cursors advance correctly.

**AC6.3 test details:**
- Server-side (Phase 2, Task 5): `sendFrame` wrapper behavior when `ws.send()` returns -1 -- verify `sendState` becomes `"pressured"`.
- Client-side (Phase 3, Task 3): verify `send()` returns false when not connected, returns true when connected. (Full backpressure via `bufferedAmount` is difficult to force in unit tests.)

**AC6.4 test details:**
- Phase 2, Task 5: simulate `ws.send()` returning 0 in the server-side `sendFrame` wrapper. Verify the connection is closed (code 1011) and removed from `WsConnectionManager`.

**AC6.5 test details:**
- After changelog replication, verify `relay_outbox` and `relay_inbox` tables have no unexpected rows (changelog path does not touch relay tables).

**AC6.6 test details:**
- Write entries on spoke, disconnect (`removePeer`). Write more entries while disconnected. Verify they accumulate in `change_log`. Reconnect and drain. Verify all entries arrive at hub.

---

## Human Verification

No acceptance criteria require human verification. All criteria are testable through automated unit tests, integration tests, or build verification steps.

| Criterion | Verification Approach | Justification |
|-----------|----------------------|---------------|
| (none) | -- | All ACs are structural (file/route deletion), behavioral (frame encode/decode, event-driven handlers), or timing-based (latency thresholds) -- all automatable. |

---

## Test File Summary

| Test File | Phase Created | ACs Covered |
|-----------|---------------|-------------|
| `packages/sync/src/__tests__/ws-frames.test.ts` | 1 | AC3.1, AC3.2, AC3.6 |
| `packages/sync/src/__tests__/ws-server.test.ts` | 2 | AC2.1, AC3.3, AC3.4, AC3.5, AC6.3, AC6.4 |
| `packages/sync/src/__tests__/ws-client.test.ts` | 3 | AC2.1, AC2.6, AC2.7, AC4.3, AC6.1, AC6.3 |
| `packages/sync/src/__tests__/ws-transport.test.ts` | 4, 5 | AC2.2, AC2.3, AC2.4, AC2.5, AC4.1, AC4.2, AC5.1, AC6.2, AC6.5, AC6.6 |
| `packages/agent/src/__tests__/relay-event-driven.test.ts` | 6 | AC5.2, AC5.3, AC5.4 |
| Build + grep verification (no file) | 7 | AC1.1, AC1.2, AC1.3, AC1.4, AC1.5 |
