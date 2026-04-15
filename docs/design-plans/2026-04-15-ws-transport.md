# WebSocket Sync Transport Design

## Summary

This design migrates Bound's sync infrastructure from HTTP polling to persistent WebSocket connections between spoke nodes and the hub. Currently, spokes poll the hub every 30 seconds (or 1 second during active relay traffic) to synchronize changelog entries and relay messages, resulting in 2-4 second latency for inference streaming chunks. The new architecture establishes bidirectional WSS connections from each spoke to the hub's sync listener, encrypts all frames with XChaCha20-Poly1305 using existing ECDH key agreement, and pushes changelog entries and relay messages immediately upon write. This event-driven approach eliminates polling entirely, reduces inference streaming latency to sub-millisecond, and solves NAT traversal problems since spokes initiate connections. Database tables remain as durable buffers, ensuring no messages are lost during disconnections, with reconnection logic providing automatic drain and catch-up.

## Definition of Done

1. **All HTTP-based sync removed** — no more sync-loop polling, no eager-push HTTP endpoint, no `/api/relay-deliver`. The entire `sync-loop.ts` polling mechanism is gone.
2. **Persistent WebSocket connections** from spokes to hub carry all sync traffic — changelog replication (replacing push/pull/ack) and relay messages (tool calls, inference streaming, platform deliver, broadcasts) are all event-driven over WS.
3. **Encryption preserved** — WS frames use XChaCha20-Poly1305 with per-peer symmetric keys (same ECDH key agreement), authenticated at connection handshake.
4. **NAT spokes fully supported** — since spokes initiate the connection, nodes behind NAT get the same latency as directly-addressable nodes.
5. **Inference streaming latency dramatically reduced** — chunks pushed immediately over WS instead of waiting for sync cycle polling.

## Acceptance Criteria

### ws-transport.AC1: All HTTP-based sync removed
- **ws-transport.AC1.1 Success:** No `/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay` HTTP routes exist
- **ws-transport.AC1.2 Success:** No `/api/relay-deliver` HTTP endpoint exists
- **ws-transport.AC1.3 Success:** `sync-loop.ts`, `eager-push.ts`, `reachability.ts` modules are deleted
- **ws-transport.AC1.4 Success:** `sync:trigger` event is removed from EventMap with no remaining emitters or listeners
- **ws-transport.AC1.5 Success:** Build succeeds with no references to removed modules

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic
- **ws-transport.AC2.1 Success:** Spoke establishes WSS connection to hub at `/sync/ws` on startup
- **ws-transport.AC2.2 Success:** Changelog entries replicate bidirectionally within 100ms of write
- **ws-transport.AC2.3 Success:** Relay messages (tool_call, inference, intake, platform_deliver, event_broadcast) route correctly through hub via WS
- **ws-transport.AC2.4 Success:** Broadcast relay (`target_site_id === "*"`) fans out to all connected spokes except source
- **ws-transport.AC2.5 Success:** Hub-local relay dispatches to RelayProcessor (request kinds) or relay_inbox (response kinds)
- **ws-transport.AC2.6 Failure:** Connection to non-existent hub enters reconnection loop without crashing
- **ws-transport.AC2.7 Failure:** Spoke with no `hub_url` configured does not attempt WS connection (it is the hub)

### ws-transport.AC3: Encryption preserved
- **ws-transport.AC3.1 Success:** WS frames are XChaCha20-Poly1305 encrypted with per-peer symmetric key derived via ECDH
- **ws-transport.AC3.2 Success:** Each frame uses a random 24-byte nonce
- **ws-transport.AC3.3 Success:** WS upgrade request is authenticated via Ed25519 signature (X-Site-Id, X-Timestamp, X-Signature headers)
- **ws-transport.AC3.4 Failure:** Upgrade request with invalid signature is rejected (HTTP 401 before upgrade)
- **ws-transport.AC3.5 Failure:** Upgrade request from unknown siteId (not in keyring) is rejected
- **ws-transport.AC3.6 Failure:** Frame with tampered ciphertext fails decryption and is discarded (connection not killed)

### ws-transport.AC4: NAT spokes fully supported
- **ws-transport.AC4.1 Success:** Spoke behind NAT (no `sync_url` in hosts table) connects to hub and receives relay messages at same latency as non-NAT spokes
- **ws-transport.AC4.2 Success:** Spoke without inbound-reachable IP receives inference stream_chunk frames over WS
- **ws-transport.AC4.3 Success:** Bun ping/pong keepalive prevents NAT connection timeout (configurable `idle_timeout`)

### ws-transport.AC5: Inference streaming latency reduced
- **ws-transport.AC5.1 Success:** Inference stream_chunk frames arrive at spoke within 50ms of hub writing to relay_outbox (excluding network RTT)
- **ws-transport.AC5.2 Success:** RELAY_STREAM state consumes chunks via `relay:inbox` event listener (no database polling)
- **ws-transport.AC5.3 Success:** RELAY_WAIT state consumes tool results via `relay:inbox` event listener (no database polling)
- **ws-transport.AC5.4 Success:** Per-host inference timeout (`inference_timeout_ms`) still triggers failover

### ws-transport.AC6: Cross-cutting behaviors
- **ws-transport.AC6.1 Success:** Spoke reconnects with exponential backoff (1s-60s cap) with jitter on connection drop
- **ws-transport.AC6.2 Success:** Reconnect drain synchronizes missed changelog entries and relay messages from last confirmed HLC cursor
- **ws-transport.AC6.3 Success:** Backpressure (send returns -1) pauses push-on-write; entries accumulate in DB; drain event resumes sending
- **ws-transport.AC6.4 Success:** Send returning 0 triggers connection close and reconnection
- **ws-transport.AC6.5 Success:** `relay_outbox`/`relay_inbox` tables remain as durable buffers throughout
- **ws-transport.AC6.6 Failure:** Hub disconnection does not lose relay messages — entries remain in spoke's outbox with `delivered = 0`

## Glossary

- **Change-log outbox pattern**: Bound's transaction pattern where writes to synced tables are wrapped with a changelog entry in a single transaction, creating a durable record for replication
- **ECDH (Elliptic Curve Diffie-Hellman)**: Key agreement protocol that derives shared symmetric encryption keys between peers from their public keys, used here to convert Ed25519 identity keys to X25519 for encryption
- **Ed25519**: Modern elliptic curve signature algorithm used for authenticating sync connections; each Bound node has an Ed25519 keypair as its cryptographic identity
- **HLC (Hybrid Logical Clock)**: Causally-ordered timestamp format (`ISO-8601_hex-counter_site-id`) that preserves ordering across distributed nodes without requiring clock synchronization; string comparison maintains causal order
- **Hub**: Central Bound node that coordinates sync and relay routing between spokes; detected by absence of `hub_url` in config
- **LWW (Last-Write-Wins)**: Conflict resolution strategy for synced tables where the row with the newest `modified_at` timestamp wins during replication
- **Spoke**: Bound node that connects to a hub for sync and relay services; detected by presence of `hub_url` in config
- **Relay**: Bound's RPC-over-sync mechanism for routing tool calls, inference requests, and platform messages across cluster nodes through the hub
- **XChaCha20-Poly1305**: Authenticated encryption cipher combining XChaCha20 stream cipher with Poly1305 MAC; provides confidentiality and integrity with 24-byte nonces preventing collisions
- **Backpressure**: Flow control mechanism where `ws.send()` returns -1 when the socket buffer is full, signaling the application to pause writes until a `drain` event fires
- **Bun**: JavaScript/TypeScript runtime used throughout Bound; its `Bun.serve()` provides WebSocket support via uWebSockets backend
- **NAT (Network Address Translation)**: Networking technique where internal IPs are mapped to external ones, preventing direct inbound connections; spokes behind NAT cannot be reached via HTTP but can establish outbound WS connections
- **RELAY_WAIT / RELAY_STREAM**: Agent loop states where the agent waits for relay responses; WAIT handles tool call results, STREAM handles inference chunk streaming
- **Microtask coalescer**: Event loop technique that batches multiple synchronous operations (changelog writes) within a single tick before sending, reducing frame count during bursts

## Architecture

Replace the entire HTTP-based sync system (polling sync loop + eager push) with persistent WebSocket connections between spokes and hub. Spokes initiate WSS connections to the hub's sync listener. All sync traffic — changelog replication and relay message delivery — flows as encrypted binary frames over these connections. DB tables (change_log, relay_outbox, relay_inbox) remain as durable buffers; the WebSocket is purely a transport layer.

### Connection Lifecycle

Spokes connect to `wss://{hub_host}:{SYNC_PORT}/sync/ws` on the hub's sync listener. The hub's `Bun.serve()` upgrades the HTTP request after validating the spoke's Ed25519 identity via custom headers (`X-Site-Id`, `X-Timestamp`, `X-Signature`). On successful upgrade, the hub derives the per-peer XChaCha20-Poly1305 symmetric key via existing KeyManager ECDH and stores `{ siteId, symmetricKey, fingerprint }` in Bun's per-connection `ws.data` metadata.

A hub-side `Map<string, ServerWebSocket>` keyed by siteId tracks active connections. Connection state replaces `ReachabilityTracker` — a spoke is reachable iff its WebSocket is in the map. Bun's automatic ping/pong (configurable `idleTimeout`, default 120s) handles NAT keepalive.

### Message Framing

All WS frames are binary (Uint8Array). Frame format:

```
[1 byte: message type] [24 bytes: nonce] [N bytes: ciphertext]
```

The message type byte is plaintext for routing before decryption. The ciphertext is XChaCha20-Poly1305 encrypted JSON payload using the per-peer symmetric key. The nonce is random per frame (24-byte nonce space makes collisions negligible).

Message types:

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

The plaintext type byte leaks nothing sensitive (equivalent to HTTP path visibility). Authentication is established at the connection level.

### Changelog Replication (Event-Driven)

Both sides push changelog entries immediately as they're created via `changelog_push` frames. No pull phase needed.

When `insertRow()`/`updateRow()`/`softDelete()` creates a change_log entry, a push-on-write listener sends it over the WS connection if connected. A microtask-based coalescer batches entries within the same event loop tick to prevent frame explosion during bursts while keeping single-write latency near-zero.

The receiving side replays entries through existing LWW/append-only reducers (same `replayEvents()` logic). After successful replay, it sends `changelog_ack` with the highest HLC received. HLC cursors (`sync_state.last_received`/`last_sent`) track progress per-peer, same as today. Echo suppression by `site_id` is unchanged.

### Relay Message Delivery

Relay messages are still written to relay_outbox (durability), but delivery is immediate over WS.

**Spoke→Hub (`relay_send`):** When `writeOutbox()` creates a relay entry, a listener sends it as a `relay_send` frame. The hub routes using the same logic as today's `/sync/relay` handler:
- Broadcast (`target_site_id === "*"`): fan out to all connected spokes except source
- Hub-local (`target_site_id === hubSiteId`): dispatch to RelayProcessor (request kinds) or insert into relay_inbox (response kinds)
- Forward (target is another spoke): write to hub's outbox, immediately deliver via target spoke's WS connection if connected

**Hub→Spoke (`relay_deliver`):** Hub sends frames containing `RelayInboxEntry[]`. Spoke inserts into relay_inbox and emits a local `relay:inbox` event so agent loop handlers wake immediately.

**Relay ack (`relay_ack`):** After spoke confirms inbox insertion, it sends `relay_ack` with entry IDs. Hub marks outbox entries as delivered.

### Agent Loop Changes

RELAY_WAIT and RELAY_STREAM states switch from 500ms database polling to event-driven handlers.

**RELAY_WAIT (tool calls):** Listens for `relay:inbox` events matching its `ref_id`. Timeout and failover logic (30s per host) stays the same, driven by timer + event listener instead of a poll loop.

**RELAY_STREAM (inference):** Listens for `relay:inbox` events matching its `stream_id`. Each `stream_chunk` event triggers a DB read and yield to the streaming consumer. `stream_end` completes the stream. Per-host timeout (`inference_timeout_ms`, default 300s) still applies.

New event on `TypedEventEmitter`:

```typescript
"relay:inbox": { ref_id?: string; stream_id?: string; kind: RelayKind }
```

The `sync:trigger` event is removed entirely. All 17 emit sites become unnecessary — the push-on-write WS listeners provide immediate delivery.

### Backpressure Handling

Each WS connection tracks `sendState: "ready" | "pressured"` and a `pendingDrain: (() => void) | null` resume callback.

**Send behavior (all frame types):**
- `ws.send(frame)` returns **> 0**: success, continue
- Returns **-1** (enqueued, pressured): set `sendState = "pressured"`. Push-on-write listeners stop sending; new entries accumulate in DB tables (the durable buffer)
- Returns **0** (dropped/failed): treat as connection error, close socket, trigger reconnection

**Drain handler:** On Bun's `drain` event, set `sendState = "ready"`, then flush undelivered entries from DB tables.

**Reconnect drain (bulk catch-up):** Flow-controlled loop reads batches from DB (100 changelog entries / 50 relay entries per batch), sends each frame, checks return value. On -1, stores a resume callback in `pendingDrain` that continues from the current DB cursor. `drain` event invokes `pendingDrain()` to resume. Repeats until drained, then sends `drain_complete`.

Bun's `backpressureLimit` set to 2MB (matches existing `sync.relay.max_payload_bytes` default).

**Key invariant:** No application-level frame buffering beyond what Bun enqueues. DB tables ARE the buffer. Backpressure = "stop reading from DB, resume on drain."

### Reconnection

Spoke-side exponential backoff: 1s → 2s → 4s → ... capped at 60s, with jitter (random 0-25% of interval). Retries indefinitely — no fallback to HTTP.

On successful reconnect, the spoke re-authenticates (Ed25519 signed upgrade). Then both sides drain to catch up:

1. Spoke sends `drain_request` with its `last_sent` HLC cursor
2. Hub responds with changelog entries since that cursor + undelivered relay_outbox entries targeting this spoke
3. Hub sends `drain_request` with its `last_sent` cursor for this spoke
4. Spoke responds with its changelog entries since that cursor + undelivered relay_outbox entries
5. Both sides send `drain_complete` when done

Hub keeps relay_outbox entries during disconnection (durable). The outbox `delivered = 0` flag is the source of truth.

### Configuration

Sync config (`sync.json`) changes:

```typescript
{
  hub_url: string,                      // KEPT — spoke connects here
  // interval_seconds: REMOVED
  // relay.eager_push: REMOVED
  relay: {
    inference_timeout_ms: number,       // KEPT (default 300000)
    max_payload_bytes: number,          // KEPT (default 2097152)
    drain_timeout_seconds: number,      // KEPT
  },
  ws: {
    backpressure_limit: number,         // NEW (default 2097152)
    idle_timeout: number,               // NEW, seconds (default 120)
    reconnect_max_interval: number,     // NEW, seconds (default 60)
  }
}
```

The `ws` section is optional with sensible defaults. Hub detection: a node with no `hub_url` is the hub (accepts WS connections); a node with `hub_url` is a spoke (initiates WS connection).

## Existing Patterns

Investigation found the existing WebSocket handler at `packages/web/src/server/websocket.ts` — a JSON text-frame pub/sub system for the Svelte SPA. The sync WS transport has fundamentally different concerns (binary encrypted frames, peer identity, relay routing), so the two implementations remain separate. No shared extraction needed.

The existing sync encryption layer (`packages/sync/src/encryption.ts`, `signing.ts`, `key-manager.ts`) carries over directly. `encryptBody()` / `decryptBody()` work on `Uint8Array` payloads, which maps cleanly to WS binary frames. `KeyManager`'s per-peer symmetric key derivation is reused as-is — keys are derived once at connection time and stored in `ws.data`.

The existing relay routing logic in `packages/sync/src/routes.ts` (broadcast fan-out, hub-local dispatch, spoke forwarding) is preserved conceptually but moves from HTTP route handlers to WS frame handlers.

The push-on-write pattern for changelog entries mirrors the existing `sync:trigger` → immediate-sync pattern, but eliminates the sync loop intermediary.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: WS Frame Protocol & Crypto Adaptation
**Goal:** Binary frame encoding/decoding with XChaCha20-Poly1305 encryption, independent of connection management

**Components:**
- Frame codec in `packages/sync/src/ws-frames.ts` — message type enum, `encodeFrame(type, payload, symmetricKey)` → `Uint8Array`, `decodeFrame(frame, symmetricKey)` → `{ type, payload }`
- Reuses `encryptBody()` / `decryptBody()` from `packages/sync/src/encryption.ts`
- Frame type constants and TypeScript discriminated union for decoded messages

**Dependencies:** None

**Done when:** Frame encode/decode round-trips correctly for all 8 message types, encryption/decryption verified, malformed frames rejected gracefully
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Hub-Side WS Server
**Goal:** Hub accepts authenticated WS connections from spokes on the sync listener

**Components:**
- WS server handler in `packages/sync/src/ws-server.ts` — upgrade authentication (Ed25519 signature validation on upgrade request), connection tracking (`Map<string, ServerWebSocket>`), `ws.data` metadata setup with symmetric key, frame dispatch to handler functions
- WS upgrade route at `/sync/ws` on the sync listener in `packages/web/src/server/index.ts`
- Adapted auth logic from `packages/sync/src/middleware.ts` for WS upgrade (validate signature headers, derive symmetric key)

**Dependencies:** Phase 1 (frame codec)

**Done when:** Hub accepts WSS connections from authenticated spokes, rejects invalid signatures, tracks connections by siteId, handles open/close/error lifecycle
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Spoke-Side WS Client
**Goal:** Spokes establish and maintain persistent WS connections to hub

**Components:**
- WS client in `packages/sync/src/ws-client.ts` — connection establishment with Ed25519 signed headers, reconnection with exponential backoff + jitter (1s–60s cap, indefinite retry), frame send with backpressure tracking (`sendState`, `pendingDrain`), `drain` handler for resume
- Integration in `packages/cli/src/commands/start/server.ts` — spoke startup creates WS client instead of SyncClient/startSyncLoop

**Dependencies:** Phase 1 (frame codec), Phase 2 (hub server to connect to)

**Done when:** Spoke connects to hub, reconnects on drop with backoff, sends/receives encrypted frames, backpressure pauses sending and resumes on drain
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Changelog Replication over WS
**Goal:** Event-driven changelog push replaces HTTP push/pull/ack cycle

**Components:**
- Push-on-write listener in `packages/sync/src/ws-transport.ts` — hooks into change_log writes, microtask coalescer for burst batching, sends `changelog_push` frames
- Receive handler for `changelog_push` — replays through existing reducers (`replayEvents()` in `packages/sync/src/reducers.ts`), sends `changelog_ack` with highest HLC
- HLC cursor tracking — updates `sync_state.last_received`/`last_sent` per peer
- Drain logic for reconnection — sends entries since peer's last confirmed HLC

**Dependencies:** Phase 3 (WS client connected to hub)

**Done when:** Changelog entries replicate bidirectionally over WS with <100ms latency, HLC cursors advance correctly, reconnect drain catches up missed entries, echo suppression works
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Relay Delivery over WS
**Goal:** Relay messages route through hub via WS instead of HTTP sync relay phase

**Components:**
- Relay send listener in `packages/sync/src/ws-transport.ts` — hooks into `writeOutbox()`, sends `relay_send` frames
- Hub-side relay router — receives `relay_send`, applies routing logic (broadcast/hub-local/forward), sends `relay_deliver` to target spoke's WS connection
- Spoke-side relay receive handler — inserts into relay_inbox, emits `relay:inbox` event on `TypedEventEmitter`
- `relay_ack` exchange for delivery confirmation
- New `relay:inbox` event in `packages/shared/src/events.ts`

**Dependencies:** Phase 4 (changelog replication working, proves bidirectional WS transport)

**Done when:** Relay messages route correctly (broadcast, hub-local, spoke-forward), relay_inbox populated and `relay:inbox` events emitted, delivery confirmed via ack
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Agent Loop Integration
**Goal:** RELAY_WAIT and RELAY_STREAM consume relay messages via events instead of polling

**Components:**
- Rewritten RELAY_WAIT in `packages/agent/src/agent-loop.ts` — event listener on `relay:inbox` matching `ref_id`, timer-based timeout/failover preserved
- Rewritten RELAY_STREAM in `packages/agent/src/agent-loop.ts` — event listener on `relay:inbox` matching `stream_id`, per-host timeout preserved
- Remove all `sync:trigger` emits (17 sites across `agent-loop.ts`, `relay-processor.ts`, `mcp-bridge.ts`, `emit.ts`, Discord connectors, `start/server.ts`)
- Remove `sync:trigger` and `sync:completed` from `EventMap` in `packages/shared/src/events.ts`

**Dependencies:** Phase 5 (relay delivery working over WS)

**Done when:** Remote tool calls complete via WS relay, inference streaming works with sub-second chunk latency, no `sync:trigger` references remain in codebase
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: HTTP Sync Removal
**Goal:** Delete all HTTP sync infrastructure

**Components:**
- Delete `packages/sync/src/eager-push.ts`, `packages/sync/src/sync-loop.ts`, `packages/sync/src/reachability.ts`
- Remove HTTP sync routes from `packages/sync/src/routes.ts` (`/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay`, `/api/relay-deliver`)
- Remove `EagerPushConfig` from `packages/web/src/server/index.ts` (`SyncAppConfig`)
- Remove sync loop startup from `packages/cli/src/commands/start/server.ts`
- Remove `interval_seconds` and `relay.eager_push` from sync config schema in `packages/shared`
- Update `packages/sync/src/index.ts` exports
- Delete tests: `eager-push.test.ts`, `eager-push-encrypted.test.ts`, rewrite/delete `sync-loop.test.ts` and HTTP route tests
- Evaluate `boundcurl` binary — remove or adapt for WS debugging

**Dependencies:** Phase 6 (everything working over WS, HTTP path no longer needed)

**Done when:** No HTTP sync code remains, all sync traffic flows over WS, build succeeds, existing non-sync tests pass
<!-- END_PHASE_7 -->

<!-- START_PHASE_8 -->
### Phase 8: Configuration & Polish
**Goal:** Clean configuration, documentation, operational readiness

**Components:**
- Updated sync config schema in `packages/shared` — new `ws` section with `backpressure_limit`, `idle_timeout`, `reconnect_max_interval` (all optional with defaults)
- Config validation and hot-reload support via SIGHUP handler in `packages/cli`
- Updated CLAUDE.md sections: Sync Protocol, Relay Transport, Web Server, Sync Encryption
- Verify `boundctl set-hub` drain works over WS

**Dependencies:** Phase 7 (HTTP sync removed, WS is sole transport)

**Done when:** Config schema validated, SIGHUP reloads WS config, CLAUDE.md accurate, set-hub drain functional over WS
<!-- END_PHASE_8 -->

## Additional Considerations

**Inference streaming latency:** The primary motivator. Current path: RelayProcessor writes stream_chunk → sync:trigger → sync loop wakes (1s fast interval) → HTTP relay phase sends to hub → hub routes to spoke outbox → spoke's next sync cycle pulls it (another 1s). Total: 2-4s per chunk minimum, worse for NAT spokes. New path: RelayProcessor writes stream_chunk → push-on-write listener sends WS frame → hub routes → WS frame to spoke → relay:inbox event. Total: sub-millisecond for each hop.

**Single point of failure:** The hub is already a SPOF in the current architecture. WS doesn't change this — if the hub is down, spokes can't sync regardless of transport. Entries accumulate in DB tables during hub downtime, same as today.

**Concurrent WS connections:** A hub with N spokes maintains N persistent connections. For the current cluster size this is trivial. Bun's uWebSockets backend handles millions of connections efficiently.

**Frame size limits:** Individual frames are bounded by `max_payload_bytes` (default 2MB), same as today's relay payload limit. Changelog push batches respect this limit.
