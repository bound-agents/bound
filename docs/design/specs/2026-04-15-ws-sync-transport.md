# RFC: WebSocket Sync Transport

**Supplements:** `sync-protocol.md`, `2026-03-25-service-channel.md`, `2026-04-03-sync-encryption.md`
**Date:** 2026-04-15
**Status:** Implemented

---

## 1. Problem Statement

### 1.1 HTTP Polling Creates Relay Latency

The HTTP-based sync protocol polls on a fixed interval (default 30 seconds, 1 second during active relay). Relay messages — tool calls, inference chunks, platform intake signals — accumulate in the hub's outbox between polls. Inference streaming suffers most: the target flushes chunks every 200ms but the requester only retrieves them once per sync cycle. For NAT spokes without eager push, this means 2-4 seconds between chunk batches — the user sees tokens arrive in bursts.

Even with eager push to addressable spokes, there are three failure modes: (1) the push endpoint may be unavailable (firewall, transient network partition) with no backoff — each failure wastes an HTTP round-trip; (2) eager push creates duplicate delivery (push + next sync pull) requiring inbox idempotency; (3) relay messages sent by the spoke still wait for the spoke's next poll before the hub sees them.

### 1.2 NAT Spokes Require Inbound Reachability for Eager Push

Eager push solves latency for addressable spokes but does nothing for NAT spokes. A laptop behind a consumer router has no inbound route. The hub cannot eager-push to it. The laptop's relay messages sit in the hub's outbox until the laptop's next poll. This asymmetry creates a two-tier cluster: fast relay for spokes with `sync_url`, slow relay for NAT spokes.

### 1.3 Polling Overhead During Quiescence

Quiescence reduces sync interval to 5 minutes when no user has interacted recently. Relay messages are rare during quiescence (autonomous tasks don't relay often, users aren't active), but the spoke still polls every 5 minutes. The connection to the hub remains idle most of the time, wasting one HTTP handshake + TLS round-trip every 5 minutes for a likely-empty response.

---

## 2. Proposal

### 2.1 Summary

Replace the HTTP polling loop (`sync-loop.ts`) and eager push mechanism (`eager-push.ts`) with persistent WebSocket connections from spokes to hub. Replication becomes event-driven: changelog writes and relay outbox writes trigger immediate frame sends over the WebSocket. The hub routes relay messages and fans out changelog entries to connected spokes in real time. Polling is eliminated. NAT spokes are first-class: they initiate outbound connections to the hub, so inbound reachability is no longer required.

Encryption is preserved: the WebSocket upgrade is authenticated with Ed25519 signatures (same as HTTP sync), and all frames are encrypted with XChaCha20-Poly1305 using the per-peer symmetric key derived via ECDH (same as HTTP sync body encryption). The frame structure is: `[1 byte type][24 bytes nonce][N bytes ciphertext]`. The nonce and ciphertext are the same format as the HTTP body encryption — only the framing differs.

Database tables (`change_log`, `relay_outbox`, `relay_inbox`) remain as durable buffers. The WebSocket is purely a transport layer. Disconnections are handled with exponential backoff reconnection and drain-on-reconnect to catch up missed entries from the last confirmed cursor. No changelog or relay data is lost during disconnections.

### 2.2 What This Replaces

The HTTP sync loop (`packages/sync/src/sync-loop.ts`), eager push (`packages/sync/src/eager-push.ts`), and reachability tracking (`packages/sync/src/reachability.ts`) are deleted entirely. HTTP sync routes (`/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay`) and the eager push endpoint (`/api/relay-deliver`) are removed. The `sync:trigger` event is removed from the event bus — push-on-write WebSocket listeners provide immediate delivery.

The WebSocket upgrade path (`/sync/ws`) is added to the sync listener. The sync config (`sync.json`) drops `interval_seconds` and `relay.eager_push`, and gains a `ws` section with `backpressure_limit`, `idle_timeout`, and `reconnect_max_interval` (all optional with defaults).

### 2.3 Design Principles

**Event-driven, not polled.** Changelog and relay writes trigger immediate WebSocket sends. No interval timers.

**Persistent connections.** One WSS connection per spoke to the hub, held open for the lifetime of the process. Bun ping/pong keepalive prevents NAT timeout.

**Backpressure-aware.** The WebSocket send buffer is bounded. When full, push-on-write listeners stop sending and entries accumulate in DB tables (the durable buffer). A `drain` event resumes sending. No application-level frame buffering.

**Encryption preserved.** XChaCha20-Poly1305 frame encryption with per-peer symmetric keys (same ECDH derivation as HTTP sync). Frame type byte is plaintext for routing; payload is ciphertext.

**NAT spokes are first-class.** Spokes initiate connections (outbound always works through NAT). No inbound `sync_url` needed. Relay latency is symmetric across all spokes.

**Transparent to application logic.** Reducers, routing, idempotency, and relay processor see no change. Encryption/decryption and send/receive happen at the transport boundary.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-WS` (WebSocket Sync).

### 3.1 Ubiquitous

**R-WS1.** The system shall establish a persistent WebSocket connection from each spoke to the hub at `/sync/ws` on startup. The connection shall use WSS (WebSocket Secure) when the hub URL is HTTPS and WS when HTTP. The WebSocket upgrade request shall be authenticated with Ed25519 signature headers (`X-Site-Id`, `X-Timestamp`, `X-Signature`, `X-Agent-Version`) using the same signing scheme as HTTP sync. The hub shall verify the signature and derive the per-peer XChaCha20-Poly1305 symmetric key before accepting the upgrade. If signature verification fails or the site ID is not in the keyring, the hub shall reject the upgrade with HTTP 401 or 403 (same status codes as HTTP sync authentication failures).

**R-WS2.** The system shall encrypt all WebSocket frames with XChaCha20-Poly1305 using the per-peer symmetric key derived at connection time. Frame format: `[1 byte type][24 bytes nonce][N bytes ciphertext]`. The type byte is plaintext (for routing before decryption); the nonce is random per frame; the ciphertext is the JSON payload encrypted with the symmetric key and the nonce. The receiving side shall decrypt the frame and discard it (not close the connection) if decryption fails. Frame encryption and decryption shall reuse the same `encryptBody` / `decryptBody` functions from HTTP sync body encryption.

**R-WS3.** The system shall send a `changelog_push` frame immediately when a `changelog:written` event fires. A microtask coalescer shall batch entries written within the same event loop tick into a single frame (preventing frame explosion during transaction bursts). The batch shall be sent to all connected peers with echo suppression (excluding entries whose `site_id` matches the destination peer). The receiving side shall replay entries through the existing reducers (`replayEvents`), update `sync_state.last_received` to the highest HLC in the batch, and send a `changelog_ack` frame with the new cursor. The sender shall update `sync_state.last_sent` on receiving the ack.

**R-WS4.** The system shall send a `relay_send` frame immediately when a `relay:outbox-written` event fires. On a spoke, the frame is sent to the hub; the hub routes the entry per the existing relay routing logic (broadcast, hub-local, or forward to target spoke). On the hub, routing destinations that are currently connected receive a `relay_deliver` frame immediately; destinations that are disconnected receive the entry on their next reconnect drain. The receiving spoke shall insert the entry into `relay_inbox` and emit a `relay:inbox` event. The hub shall send a `relay_ack` frame with delivered entry IDs; the spoke marks those entries as `delivered = 1` in `relay_outbox`.

**R-WS5.** The system shall enter RELAY_WAIT and RELAY_STREAM states when the orchestrator needs to wait for relay responses. RELAY_WAIT shall register a `relay:inbox` event listener matching `ref_id` and yield when the listener fires (instead of polling `relay_inbox` every 500ms). RELAY_STREAM shall register a `relay:inbox` event listener matching `stream_id` and yield chunks as events arrive. Timeout logic (30s per host for RELAY_WAIT, `inference_timeout_ms` for RELAY_STREAM) shall remain unchanged but fire based on wall-clock timeout + listener activity instead of poll iterations. Cancel during RELAY_WAIT or RELAY_STREAM shall send a `cancel` relay frame and stop waiting.

**R-WS6.** The system shall reconnect with exponential backoff when the WebSocket connection closes or errors. Initial interval: 1 second. Backoff: double the interval on each attempt, capped at `reconnect_max_interval` (default 60s from sync config `ws.reconnect_max_interval`). Jitter: 0-25% of the interval. Reconnection shall continue indefinitely until `close()` is called or the spoke is shut down. On successful reconnection, the spoke shall call `drainChangelog` and `drainRelayOutbox` to send entries missed during disconnection (starting from the last confirmed cursor). The hub shall call `drainRelayInbox` to deliver entries targeting the spoke that accumulated while it was offline.

**R-WS7.** The system shall track backpressure state per WebSocket connection. When `ws.send(frame)` returns `-1` (buffer full), the connection shall enter `pressured` state and stop sending frames. New changelog and relay entries shall accumulate in the DB tables (durable buffer). When Bun fires the `drain` event, the connection shall resume sending: call `drainChangelog` and `drainRelayOutbox` to flush buffered entries from the database. When `ws.send()` returns `0` (send failed, connection broken), the connection shall close and enter reconnection. The backpressure limit is configurable: `ws.backpressureLimit` in sync config (default 2MB, same as `relay.max_payload_bytes`).

**R-WS8.** The system shall configure Bun WebSocket `idleTimeout` from sync config `ws.idle_timeout` (default 120 seconds). Bun's automatic ping/pong keepalive shall prevent NAT connection timeout for idle connections. A connection with no traffic for longer than `idleTimeout` shall close and reconnect. This ensures connections are periodically refreshed even during quiescence.

**R-WS9.** The system shall remove the `sync:trigger` event from the event bus and all emit sites. The 17 existing emitters (in `agent-loop.ts`, `relay-processor.ts`, `mcp-bridge.ts`, `emit.ts`, Discord connectors, `start/server.ts`) shall be deleted. Push-on-write WebSocket listeners provide immediate delivery; no sync-loop wakeup signal is needed. The `sync:completed` event is also removed (it was paired with `sync:trigger` for logging).

**R-WS10.** The system shall delete the HTTP sync loop (`packages/sync/src/sync-loop.ts`), eager push (`packages/sync/src/eager-push.ts`), and reachability tracker (`packages/sync/src/reachability.ts`). HTTP sync routes (`/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay` in `packages/sync/src/routes.ts`) and the eager push endpoint (`/api/relay-deliver`) shall be removed. The `interval_seconds` and `relay.eager_push` fields shall be removed from the sync config schema. The `sync` section in `packages/web/src/server/index.ts` (the `SyncAppConfig`) shall drop the `EagerPushConfig` and `createSyncClient` wiring. The `boundcurl` utility remains (for manual WebSocket frame inspection in decrypt-mode); its HTTP request mode is adapted for WebSocket debugging.

**R-WS11.** The system shall include the `ws` section in sync config schema with optional fields: `backpressure_limit` (bytes, default 2097152), `idle_timeout` (seconds, default 120), `reconnect_max_interval` (seconds, default 60). When these fields are omitted, defaults apply. The existing `relay.inference_timeout_ms`, `relay.max_payload_bytes`, and `relay.drain_timeout_seconds` fields are kept unchanged (they still apply to relay message behavior, independent of transport).

**R-WS12.** The system shall maintain the hub detection logic: a node with no `hub_url` in sync config is the hub (accepts WebSocket connections at `/sync/ws`); a node with `hub_url` is a spoke (initiates WebSocket connection to `hub_url`). The hub does not create a `WsSyncClient` instance.

### 3.2 State-Driven

**R-WS13.** When the WebSocket connection is open and not pressured, the system shall send frames immediately on `changelog:written` and `relay:outbox-written` events. When the connection is pressured (R-WS7), frames shall not be sent and entries shall accumulate in the database. When the connection is closed, entries shall accumulate and be drained on reconnect.

**R-WS14.** When the hub migrates (`boundctl set-hub`), the spoke shall close its current WebSocket connection and open a new one to the new hub URL. The spoke shall drain changelog and relay outbox to the new hub on the first connection. The hub migration drain protocol (from the service channel spec) is unchanged: the old hub drains its relay outbox before switching. The WebSocket transport does not introduce additional hub migration complexity — relay entries are still durably buffered in DB tables during the switch.

### 3.3 Optional

**R-WS15.** The system shall log WebSocket connection state transitions at INFO level: `"WebSocket connected to hub"`, `"WebSocket disconnected, reconnecting in Xs"`, `"WebSocket drain complete, N changelog entries and M relay entries sent"`. Frame send/receive shall not be logged (too high frequency). Connection failures shall log at WARN level with the error message.

### 3.4 Acceptance Criteria

Acceptance criteria map 1:1 to automated tests. Each R-WS requirement with observable behavior has at least one success scenario and one failure-mode scenario.

#### ws-transport.AC1: All HTTP-based sync removed

- **AC1.1 Success.** No `/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay` HTTP routes exist.
- **AC1.2 Success.** No `/api/relay-deliver` HTTP endpoint exists.
- **AC1.3 Success.** `sync-loop.ts`, `eager-push.ts`, `reachability.ts` modules are deleted.
- **AC1.4 Success.** `sync:trigger` event is removed from EventMap with no remaining emitters or listeners.
- **AC1.5 Success.** Build succeeds with no references to removed modules.

#### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic

- **AC2.1 Success.** Spoke establishes WSS connection to hub at `/sync/ws` on startup.
- **AC2.2 Success.** Changelog entries replicate bidirectionally within 100ms of write.
- **AC2.3 Success.** Relay messages (tool_call, inference, intake, platform_deliver, event_broadcast) route correctly through hub via WebSocket.
- **AC2.4 Success.** Broadcast relay (`target_site_id === "*"`) fans out to all connected spokes except source.
- **AC2.5 Success.** Hub-local relay dispatches to RelayProcessor (request kinds) or relay_inbox (response kinds).
- **AC2.6 Failure.** Connection to non-existent hub enters reconnection loop without crashing.
- **AC2.7 Failure.** Spoke with no `hub_url` configured does not attempt WebSocket connection (it is the hub).

#### ws-transport.AC3: Encryption preserved

- **AC3.1 Success.** WebSocket frames are XChaCha20-Poly1305 encrypted with per-peer symmetric key derived via ECDH.
- **AC3.2 Success.** Each frame uses a random 24-byte nonce.
- **AC3.3 Success.** WebSocket upgrade request is authenticated via Ed25519 signature (X-Site-Id, X-Timestamp, X-Signature headers).
- **AC3.4 Failure.** Upgrade request with invalid signature is rejected (HTTP 401 before upgrade).
- **AC3.5 Failure.** Upgrade request from unknown siteId (not in keyring) is rejected.
- **AC3.6 Failure.** Frame with tampered ciphertext fails decryption and is discarded (connection not killed).

#### ws-transport.AC4: NAT spokes fully supported

- **AC4.1 Success.** Spoke behind NAT (no `sync_url` in hosts table) connects to hub and receives relay messages at same latency as non-NAT spokes.
- **AC4.2 Success.** Spoke without inbound-reachable IP receives inference stream_chunk frames over WebSocket.
- **AC4.3 Success.** Bun ping/pong keepalive prevents NAT connection timeout (configurable `idle_timeout`).

#### ws-transport.AC5: Inference streaming latency reduced

- **AC5.1 Success.** Inference stream_chunk frames arrive at spoke within 50ms of hub writing to relay_outbox (excluding network RTT).
- **AC5.2 Success.** RELAY_STREAM state consumes chunks via `relay:inbox` event listener (no database polling).
- **AC5.3 Success.** RELAY_WAIT state consumes tool results via `relay:inbox` event listener (no database polling).
- **AC5.4 Success.** Per-host inference timeout (`inference_timeout_ms`) still triggers failover.

#### ws-transport.AC6: Cross-cutting behaviors

- **AC6.1 Success.** Spoke reconnects with exponential backoff (1s-60s cap) with jitter on connection drop.
- **AC6.2 Success.** Reconnect drain synchronizes missed changelog entries and relay messages from last confirmed HLC cursor.
- **AC6.3 Success.** Backpressure (send returns -1) pauses push-on-write; entries accumulate in DB; drain event resumes sending.
- **AC6.4 Success.** Send returning 0 triggers connection close and reconnection.
- **AC6.5 Success.** `relay_outbox`/`relay_inbox` tables remain as durable buffers throughout.
- **AC6.6 Failure.** Hub disconnection does not lose relay messages — entries remain in spoke's outbox with `delivered = 0`.

---

## 4. Implementation Notes

### 4.1 Frame Types

All WebSocket frames are binary (`Uint8Array`). Frame format: `[1 byte type][24 bytes nonce][N bytes ciphertext]`.

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

The plaintext type byte leaks nothing sensitive (equivalent to HTTP path visibility). Authentication is established at connection level.

### 4.2 Microtask Coalescer

Changelog replication batches entries written within the same event loop tick to prevent frame explosion during transaction bursts. The coalescer:

1. On first `changelog:written` event in a tick, schedule a microtask.
2. Accumulate entries until the microtask fires.
3. In the microtask, send all accumulated entries as one `changelog_push` frame.

This keeps single-write latency near-zero (microtasks fire before the next I/O) while reducing frame count during bursts (e.g., a transaction writing 10 rows produces 1 frame, not 10).

### 4.3 Backpressure Handling

Each WebSocket connection tracks `sendState: "ready" | "pressured"` and a `pendingDrain` callback.

**Send path:**
- `ws.send(frame)` returns `> 0`: success, continue.
- Returns `-1` (buffer full): set `sendState = "pressured"`. Stop sending; entries accumulate in DB.
- Returns `0` (send failed): close connection, enter reconnection.

**Drain handler:**
- On Bun `drain` event: set `sendState = "ready"`, call `drainChangelog` and `drainRelayOutbox` to flush buffered entries.

**Reconnect drain:**
- Flow-controlled loop reads batches from DB (100 changelog entries / 50 relay entries per batch), sends each frame, checks return value.
- On `-1`, store resume callback in `pendingDrain`, wait for `drain` event to continue.
- Repeat until drained, then send `drain_complete` frame.

Bun's `backpressureLimit` is set to 2MB (matches `relay.max_payload_bytes`). No application-level frame buffering beyond what Bun enqueues.

### 4.4 Reconnection

Spoke-side exponential backoff: 1s → 2s → 4s → ... capped at 60s (configurable `ws.reconnect_max_interval`), with jitter (random 0-25% of interval). Retries indefinitely until `close()` called.

On successful reconnect:
1. Spoke re-authenticates (Ed25519 signed upgrade).
2. Spoke sends `drain_request` with its `last_sent` HLC cursor.
3. Hub responds with changelog entries since that cursor + undelivered relay_outbox entries targeting this spoke.
4. Hub sends `drain_request` with its `last_sent` cursor for this spoke.
5. Spoke responds with its changelog entries since that cursor + undelivered relay_outbox entries.
6. Both sides send `drain_complete` when done.

Hub keeps relay_outbox entries during disconnection (durable). The `delivered = 0` flag is the source of truth.

### 4.5 Agent Loop Event Listeners

RELAY_WAIT and RELAY_STREAM states switch from polling (`sleep(sync_interval / 2)` loop checking `relay_inbox`) to event-driven.

**RELAY_WAIT:**
```typescript
// Register listener before writing outbox entry
eventBus.on("relay:inbox", handler);
// Write outbox entry
// Handler wakes when relay:inbox event fires with matching ref_id
// Timeout logic runs on timer + listener activity
```

**RELAY_STREAM:**
```typescript
// Register listener for stream_id
eventBus.on("relay:inbox", handler);
// Write inference request with stream_id
// Handler yields chunks as relay:inbox events arrive
// Timeout resets on each chunk batch
```

The `relay:inbox` event payload: `{ ref_id?: string; stream_id?: string; kind: RelayKind }`. Handler filters on `ref_id` or `stream_id` as appropriate.

### 4.6 Interaction with HTTP Sync Encryption

WebSocket frame encryption reuses the same `encryptBody` / `decryptBody` functions from HTTP sync body encryption. The per-peer symmetric key is derived once at connection time (during WebSocket upgrade) and stored in Bun's `ws.data` metadata. The frame nonce is random per frame (24 bytes). The ciphertext is the JSON payload encrypted with the symmetric key and nonce.

The WebSocket upgrade authentication uses the same Ed25519 signature scheme as HTTP sync requests: `X-Site-Id`, `X-Timestamp`, `X-Signature`, `X-Agent-Version` headers. The hub verifies the signature and derives the symmetric key before accepting the upgrade.

### 4.7 Hub Connection Tracking

The hub maintains a `Map<string, ServerWebSocket>` keyed by `siteId`. When a spoke connects:
1. Verify signature, derive symmetric key.
2. Store `{ siteId, symmetricKey, fingerprint }` in `ws.data`.
3. Add connection to the map.

When a spoke disconnects:
4. Remove from map.
5. Relay messages targeting this spoke accumulate in the hub's relay_outbox (durable).

Bun's automatic ping/pong (configurable `idleTimeout`) handles NAT keepalive.

### 4.8 Configuration

Sync config (`sync.json`) changes:

```json
{
  "hub_url": "https://polaris.example.com",
  "relay": {
    "inference_timeout_ms": 300000,
    "max_payload_bytes": 2097152,
    "drain_timeout_seconds": 60
  },
  "ws": {
    "backpressure_limit": 2097152,
    "idle_timeout": 120,
    "reconnect_max_interval": 60
  }
}
```

The `ws` section is optional with defaults. `interval_seconds` and `relay.eager_push` are removed.

---

## 5. Open Questions

**Q1.** Future optimization: WebSocket compression (permessage-deflate). The frame payload is JSON (highly compressible), and inference prompts can be large (200k tokens = ~1MB JSON). Bun supports `perMessageDeflate: true` on the server side; clients can negotiate it during upgrade. Deferred until payload size becomes a bottleneck in production.

**Q2.** Future enhancement: selective encryption of relay payloads. The hub currently decrypts all traffic. End-to-end spoke-to-spoke encryption for relay payloads (while leaving routing headers readable by the hub) would provide limited confidentiality without requiring the hub to become a blind forwarder. Deferred until the threat model justifies the complexity.

---

## 6. Migration

No data migration required. The WebSocket transport is a drop-in replacement for HTTP sync at the protocol level. Changelog and relay tables are unchanged. The HLC cursor and `sync_state` table are unchanged. The WebSocket connection is established at startup (replacing the sync loop timer).

Spokes running the WebSocket transport cannot sync with hubs running the HTTP transport (the hub's `/sync/ws` endpoint doesn't exist). This is a coordinated upgrade: deploy the WebSocket transport to the hub first, then to spokes. During the deploy gap, spokes fail to connect and enter reconnection backoff (logged at WARN level). After all spokes upgrade, connections succeed and sync resumes. No coordinator or feature flag needed — the spoke either connects to `/sync/ws` (WebSocket hub) or fails with a clear error.

For single-host deployments, the upgrade is a single restart with the new version.

---

## 7. Glossary

- **Backpressure** — Flow control mechanism where `ws.send()` returns `-1` when the socket buffer is full, signaling the application to pause writes until a `drain` event fires.
- **Bun** — JavaScript/TypeScript runtime used throughout Bound; its `Bun.serve()` provides WebSocket support via uWebSockets backend with automatic ping/pong keepalive.
- **ECDH (Elliptic Curve Diffie-Hellman)** — Key agreement protocol that derives shared symmetric encryption keys between peers from their public keys; used to convert Ed25519 identity keys to X25519 for encryption.
- **Event-driven replication** — Sync pattern where writes to `change_log` or `relay_outbox` trigger immediate sends over the WebSocket (via `changelog:written` or `relay:outbox-written` events), replacing polling.
- **HLC (Hybrid Logical Clock)** — Causally-ordered timestamp format (`ISO-8601_hex-counter_site-id`) that preserves ordering across distributed nodes without requiring clock synchronization; string comparison maintains causal order.
- **Hub** — Central Bound node that coordinates sync and relay routing between spokes; detected by absence of `hub_url` in config.
- **Microtask coalescer** — Event loop technique that batches multiple synchronous operations (changelog writes) within a single tick before sending, reducing frame count during bursts.
- **NAT (Network Address Translation)** — Networking technique where internal IPs are mapped to external ones, preventing direct inbound connections; spokes behind NAT cannot be reached via HTTP but can establish outbound WebSocket connections.
- **Relay** — Bound's RPC-over-sync mechanism for routing tool calls, inference requests, and platform messages across cluster nodes through the hub.
- **Spoke** — Bound node that connects to a hub for sync and relay services; detected by presence of `hub_url` in config.
- **XChaCha20-Poly1305** — Authenticated encryption cipher combining XChaCha20 stream cipher with Poly1305 MAC; provides confidentiality and integrity with 24-byte nonces preventing collisions.
- **WebSocket** — Full-duplex communication protocol over a single TCP connection; provides persistent bidirectional messaging with lower overhead than HTTP request/response pairs.
