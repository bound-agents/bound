# Sync Protocol

The `@bound/sync` package implements event-sourced synchronisation between distributed Bound instances. Each instance maintains a local SQLite change log and exchanges changesets with a designated hub over a persistent WebSocket connection. The WebSocket upgrade is authenticated with an Ed25519 request signature and all frames are encrypted with XChaCha20-Poly1305 using a per-peer symmetric key derived via ECDH. Merge conflicts are resolved through deterministic LWW or append-only reducers.

---

## Table of Contents

1. [Overview](#overview)
2. [Ed25519 Keypair Management](#ed25519-keypair-management)
3. [Request Signing](#request-signing)
4. [Reducers](#reducers)
5. [Changesets and Peer Cursors](#changesets-and-peer-cursors)
6. [WebSocket Sync Protocol](#websocket-sync-protocol)
7. [WebSocket Frames](#websocket-frames)
8. [Change Log Pruning](#change-log-pruning)
9. [Relay Transport](#relay-transport)

---

## Overview

Bound uses a hub-and-spoke topology. Each spoke instance runs a `WsSyncClient` that maintains a persistent WebSocket connection to its hub at `/sync/ws`. Replication is event-driven rather than polled: whenever a local change log entry is written, a `changelog:written` event triggers the `WsTransport` to coalesce recent entries and send a `changelog_push` frame to every connected peer.

The exchange consists of four frame kinds that move in both directions:

1. **`changelog_push`** — sender transmits change log entries the peer has not yet seen. Entries originating from the destination peer are filtered out (echo suppression).
2. **`changelog_ack`** — receiver confirms the highest HLC it has applied, allowing the sender to advance its `last_sent` cursor and prune accordingly.
3. **`relay_send` / `relay_deliver`** — cross-host relay messages (tool calls, inference requests, broadcast events) are forwarded spoke→hub (`relay_send`) or hub→spoke (`relay_deliver`).
4. **`relay_ack`** — acknowledges delivery of relay entries so the outbox can be marked delivered.

On reconnection, the transport drains any changelog entries or relay outbox entries missed while disconnected, then resumes event-driven replication.

The WebSocket upgrade request is signed with the caller's Ed25519 private key. The receiving side authenticates the upgrade by verifying the signature against the caller's public key, which it retrieves from a shared `keyring` configuration file. This means no pre-shared passwords or TLS client certificates are required — identity is entirely key-based. Once the upgrade succeeds, subsequent frames are encrypted with the per-peer symmetric key and no further per-message signatures are used.

The change log is append-only at the SQLite level. Rows are never mutated in the log itself; instead, reducers apply log entries to the live application tables using either last-write-wins (LWW) or append-only semantics. The log accumulates until a pruning pass removes entries that all known peers have confirmed receiving.

---

## Ed25519 Keypair Management

**Source:** `packages/sync/src/crypto.ts`

Each Bound instance has exactly one Ed25519 identity keypair. The public key uniquely identifies the instance across the network; the site ID is derived from it so that the identifier is stable and reproducible from the key material alone.

### Functions

#### `generateKeypair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>`

Generates a new Ed25519 keypair using the Web Crypto API. Both keys are marked exportable.

```typescript
const { publicKey, privateKey } = await generateKeypair();
```

#### `exportPublicKey(key: CryptoKey): Promise<string>`

Exports a public key in SPKI format and returns it as a prefixed Base64 string.

```typescript
const encoded = await exportPublicKey(publicKey);
// "ed25519:MFIwEwYHKoZIzj0CAQYIKoZIzj0DAQcDOwAE..."
```

The `ed25519:` prefix is mandatory. `importPublicKey` will reject any string that does not begin with it.

#### `exportPrivateKey(key: CryptoKey): Promise<Uint8Array>`

Exports a private key in PKCS#8 format as raw bytes, suitable for writing directly to disk.

#### `importPublicKey(encoded: string): Promise<CryptoKey>`

Parses an `ed25519:<base64>` string and returns a `CryptoKey` with the `verify` usage.

```typescript
const publicKey = await importPublicKey("ed25519:MFIwEw...");
```

Throws if the string does not carry the `ed25519:` prefix.

#### `importPrivateKey(bytes: Uint8Array): Promise<CryptoKey>`

Parses raw PKCS#8 bytes and returns a `CryptoKey` with the `sign` usage.

#### `deriveSiteId(publicKey: CryptoKey): Promise<string>`

Derives a 32-character hex site ID by taking the first 16 bytes of the SHA-256 hash of the key's SPKI encoding.

```typescript
const siteId = await deriveSiteId(publicKey);
// "a3f1c8b2e4d07f91a3f1c8b2e4d07f91"
```

The site ID is used as the key into the keyring and as the `peer_site_id` in `sync_state`.

#### `ensureKeypair(dataDir: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey; siteId: string }>`

The primary entry point for key management. Checks `<dataDir>/host.key` and `<dataDir>/host.pub` for an existing keypair and loads it; if neither file exists, generates a new keypair, writes the private key as binary with mode `0600` and the public key as an `ed25519:`-prefixed text file, then returns both keys together with the derived site ID.

```typescript
const { publicKey, privateKey, siteId } = await ensureKeypair("/var/lib/bound");
// Subsequent calls with the same dataDir return the same siteId.
```

The `dataDir` is created recursively if it does not exist. The private key file is written with mode `0600` to restrict read access to the owning user.

---

## Request Signing

**Source:** `packages/sync/src/signing.ts`

The WebSocket upgrade request (and any other authenticated request built on the same primitive, such as command-line tooling) carries four custom headers that together constitute a signed proof of identity. The scheme is intentionally simple — no HTTP Signatures draft, no JWT — to keep the dependency surface small.

### Signing Scheme

The signed message (the "signing base") is a newline-separated concatenation of four fields:

```
<METHOD>\n<PATH>\n<ISO-TIMESTAMP>\n<SHA-256-HEX-OF-BODY>
```

For example, the signing base for the WebSocket upgrade request (method `GET`, path `/sync/ws`, empty body):

```
GET
/sync/ws
2026-03-23T14:05:00.000Z
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The signing base is UTF-8 encoded and signed with Ed25519. The resulting signature bytes are hex-encoded.

### Headers

| Header | Description |
|---|---|
| `X-Site-Id` | The sender's site ID (32-char hex) |
| `X-Timestamp` | The current time as an ISO 8601 string |
| `X-Signature` | Hex-encoded Ed25519 signature of the signing base |
| `X-Agent-Version` | Protocol version string (currently `0.0.1`) |

### Functions

#### `signRequest(privateKey, siteId, method, path, body): Promise<{ "X-Site-Id": string; "X-Timestamp": string; "X-Signature": string; "X-Agent-Version": string }>`

Computes the signing base from the provided arguments, signs it, and returns the four headers ready to attach to a WebSocket upgrade request (or other signed request).

```typescript
const headers = await signRequest(privateKey, siteId, "GET", "/sync/ws", "");

const ws = new WebSocket(wsUrl, { headers } as any);
```

#### `verifyRequest(keyring, method, path, headers, body): Promise<Result<{ siteId: string; hostName: string }, SignatureError>>`

Verifies an incoming request. The steps are:

1. Extract `X-Site-Id`, `X-Timestamp`, and `X-Signature` from the headers (case-insensitive lookup).
2. Look up the site ID in `keyring.hosts`. If not found, return `{ code: "unknown_site" }`.
3. Check that the timestamp is within **5 minutes** of the server's local time. If not, return `{ code: "stale_timestamp" }`.
4. Reconstruct the signing base and verify the signature with the host's public key. If verification fails, return `{ code: "invalid_signature" }`.
5. On success, return `{ siteId, hostName }`.

```typescript
const result = await verifyRequest(keyring, "GET", "/sync/ws", headers, "");
if (!result.ok) {
  // result.error.code is "unknown_site" | "invalid_signature" | "stale_timestamp"
}
```

#### `detectClockSkew(localTimestamp: string, remoteTimestamp: string): number | null`

Compares two ISO timestamps and returns the absolute skew in **seconds** if it exceeds 30 seconds, or `null` otherwise. Exposed as a utility for callers that want to diagnose NTP drift; the current WebSocket transport does not itself propagate clock skew back to peers.

```typescript
const skew = detectClockSkew(new Date().toISOString(), remoteTimestamp);
if (skew !== null) {
  // skew is in seconds
}
```

### `SignatureError`

```typescript
interface SignatureError {
  code: "unknown_site" | "invalid_signature" | "stale_timestamp";
  message: string;
}
```

---

## Reducers

**Source:** `packages/sync/src/reducers.ts`

Reducers apply incoming `ChangeLogEntry` records to the live application tables. Two strategies are supported. Which strategy applies to a given table is determined by `TABLE_REDUCER_MAP` from `@bound/shared` — the sync package consults this map at apply time rather than requiring callers to choose a strategy manually.

### Security

Before touching the database, every entry is validated:

- **Table name** — must be a key in `TABLE_REDUCER_MAP`. Any unknown table name causes the entry to be silently skipped.
- **Column names** — must match `/^[a-z_]+$/`. Columns with uppercase letters, digits, or special characters are excluded from inserts and updates, preventing SQL injection through column identifiers.

Column names for LWW tables are additionally cross-referenced against the live schema via `PRAGMA table_info`. Columns present in the event but absent from the schema are dropped before the statement is constructed.

### Column Cache

`getTableColumns` caches the result of `PRAGMA table_info` in a module-level object keyed by table name. Call `clearColumnCache()` between tests or after schema migrations to avoid stale results.

### `applyLWWReducer(db, event): { applied: boolean }`

Last-write-wins strategy. Behaviour depends on whether the row already exists:

- **Row does not exist** — inserts using only columns that are both present in the event and present in the schema.
- **Row exists** — compares `modified_at` fields. The update is applied only if `event.row_data.modified_at` is strictly greater than the stored value. Columns not in the schema are ignored; only non-PK columns are updated. The PK column is `id` for most tables, `site_id` for `hosts`, and `key` for `cluster_config`.

Returns `{ applied: true }` if the underlying SQL statement changed at least one row.

```typescript
const result = applyLWWReducer(db, {
  hlc: "2026-03-23T14:00:00.000Z-0000-a3f1c8b2e4d07f91",
  table_name: "users",
  row_id: "abc123",
  site_id: "a3f1c8b2...",
  timestamp: "2026-03-23T14:00:00.000Z",
  row_data: JSON.stringify({ id: "abc123", display_name: "Ada", modified_at: "2026-03-23T14:00:00.000Z" }),
});
// { applied: true }
```

### `applyAppendOnlyReducer(db, event): { applied: boolean }`

Append-only strategy, with a hybrid path for redaction events that include `modified_at`.

- **No `modified_at` in event** — standard append-only: `INSERT ... ON CONFLICT(id) DO NOTHING`. Once a row exists it is never updated.
- **`modified_at` present in event** — treated as a redaction. The row must already exist; `modified_at` is compared and the update is applied only if the incoming value is strictly newer. This enables targeted content redaction without violating the append-only invariant for normal inserts.

### `applyEvent(db, event): { applied: boolean }`

Dispatches to the correct reducer based on `TABLE_REDUCER_MAP[event.table_name]`. Use this function instead of calling the individual reducers directly.

```typescript
const { applied } = applyEvent(db, entry);
```

### `replayEvents(db, events): { applied: number; skipped: number }`

Iterates a list of `ChangeLogEntry` records in order, calling `applyEvent` for each. The entire batch runs inside a single SQLite transaction, which is rolled back if `applyEvent` throws. When an event is applied successfully, a new change log entry is written to the local `change_log` table (via `createChangeLogEntry`) with the **original** `site_id` and remote HLC preserved. This is important: the log must record where each change originated so that echo suppression works correctly when this instance later replicates to other peers.

```typescript
const { applied, skipped } = replayEvents(db, inbound.events);
console.log(`Applied ${applied}, skipped ${skipped}`);
```

### `getTableColumns(db, tableName): string[]`

Returns column names for a known synced table, hitting the cache when available. Throws on an unknown table name.

### `clearColumnCache(): void`

Clears the module-level column name cache. Intended for use in tests.

---

## Changesets and Peer Cursors

### Changesets

**Source:** `packages/sync/src/changeset.ts`

A `Changeset` is a bundle of change log entries together with the HLC range it covers. It is used by the reconnect-drain path and by any bulk-transfer tooling.

```typescript
interface Changeset {
  events: ChangeLogEntry[];
  source_site_id: string;
  source_hlc_start: string;
  source_hlc_end: string;
}
```

`source_hlc_start` and `source_hlc_end` are the first and last `hlc` values in the `events` array. When `events` is empty, both fields equal the cursor value that was passed in.

#### `fetchOutboundChangeset(db, peerSiteId, siteId): Changeset`

Builds the changeset that the local instance will push to a peer. Reads `sync_state.last_sent` for `peerSiteId` (defaulting to `HLC_ZERO`) and returns every `change_log` entry with `hlc > last_sent`, regardless of which site originally created the entry. The rationale is that the hub should receive the full history, not just locally-originated entries.

```typescript
const outbound = fetchOutboundChangeset(db, hubSiteId, localSiteId);
// outbound.events contains everything the hub hasn't seen yet
```

#### `fetchInboundChangeset(db, requesterSiteId, sinceHlc): Changeset`

Builds the changeset the hub will return to a spoke during a drain. Selects entries with `hlc > sinceHlc` and **excludes any entry whose `site_id` equals `requesterSiteId`**. This echo suppression prevents a spoke from receiving back its own changes that have been relayed through the hub.

```typescript
const inbound = fetchInboundChangeset(db, spokeSiteId, sinceHlc);
// entries originally created by spokeSiteId are excluded
```

#### `serializeChangeset(changeset): string` / `deserializeChangeset(json): Result<Changeset, Error>`

JSON serialises/deserialises a `Changeset`. `deserializeChangeset` returns `err` on malformed JSON without throwing.

#### `chunkChangeset(changeset, maxBytes = 10 MB): Changeset[]`

Splits a changeset into smaller chunks that each serialize under `maxBytes` (default 10 MB). Events are HLC-ordered; each chunk gets its own HLC range. Returns a single-element array if the changeset already fits.

### Peer Cursors

**Source:** `packages/sync/src/peer-cursor.ts`

Peer cursors track synchronisation progress per peer in the `sync_state` table. Each row holds a `peer_site_id` (primary key) along with `last_received`, `last_sent`, `last_sync_at`, and `sync_errors`.

| Field | Meaning |
|---|---|
| `last_received` | Highest `hlc` this instance has received from the peer |
| `last_sent` | Highest `hlc` this instance has sent to (or confirmed by) the peer |
| `last_sync_at` | ISO timestamp of the most recent successful cursor update |
| `sync_errors` | Count of consecutive sync failures for this peer |

#### `getPeerCursor(db, peerSiteId): SyncState | null`

Returns the full `SyncState` row for a peer, or `null` if none exists.

#### `updatePeerCursor(db, peerSiteId, updates): void`

Upserts `sync_state` for the given peer. Accepted fields in `updates` are `last_received`, `last_sent`, and `sync_errors`. `last_sync_at` is always set to the current time. On insert, omitted HLC fields default to `HLC_ZERO` and omitted `sync_errors` defaults to `0`.

```typescript
updatePeerCursor(db, hubSiteId, { last_sent: outbound.source_hlc_end });
updatePeerCursor(db, hubSiteId, { last_received: newLastReceivedHlc });
```

#### `resetSyncErrors(db, peerSiteId): void`

Sets `sync_errors` to `0` for the given peer. Called after a successful exchange with that peer.

#### `incrementSyncErrors(db, peerSiteId): void`

Atomically increments `sync_errors` by 1, inserting the row first if it does not exist.

#### `getMinConfirmedHlc(db): string`

Returns `MIN(last_received)` across all rows in `sync_state`, or `HLC_ZERO` if the table is empty. Used by the pruning logic to determine the lowest HLC that every peer has confirmed receiving — entries at or below this threshold are safe to delete.

---

## WebSocket Sync Protocol

**Sources:** `packages/sync/src/ws-client.ts`, `packages/sync/src/ws-server.ts`, `packages/sync/src/ws-transport.ts`

### `WsSyncClient`

`WsSyncClient` manages the persistent WebSocket connection from a spoke to its hub.

```typescript
const client = new WsSyncClient({
  hubUrl,         // e.g. "https://polaris.example.com"
  privateKey,
  siteId,
  keyManager,
  hubSiteId,
  wsTransport,    // optional: WsTransport instance for dispatching received frames
  logger,
  reconnectMaxInterval,  // seconds, default 60
  backpressureLimit,     // bytes, default 2097152 (2 MB)
});

await client.connect();
```

On `connect()`, the client:

1. Derives the WebSocket URL from `hubUrl` by rewriting `https://` → `wss://` (or `http://` → `ws://`) and replacing the path with `/sync/ws`.
2. Calls `signRequest(privateKey, siteId, "GET", "/sync/ws", "")` to build the signed upgrade headers.
3. Retrieves the per-peer XChaCha20-Poly1305 symmetric key from the `KeyManager` using the hub's site ID.
4. Opens the WebSocket with the signed headers.
5. On `open`, registers the hub as a peer in the `WsTransport` and drains any pending changelog and relay-outbox entries accumulated while disconnected.

**Reconnection:** After any disconnect (close or error), the client reconnects using exponential backoff with 0–25% jitter, starting at 1 second and doubling until `reconnectMaxInterval` (default 60 s). `close()` marks the client as stopped and cancels any pending reconnect timer.

**Backpressure:** `send()` checks `ws.bufferedAmount` against `backpressureLimit` before writing. If the limit is exceeded the client marks itself as `pressured` and returns `false` so callers can shed load.

### Hub Upgrade

On the server side, the sync listener mounts a WebSocket upgrade handler at `/sync/ws`. For each upgrade request it calls:

**`authenticateWsUpgrade(request, keyring, keyManager, logger)`**

1. Verifies the signed headers with `verifyRequest` (method `"GET"`, path `"/sync/ws"`, empty body).
2. Maps the signature error code to an HTTP status:

   | Error code | Status |
   |---|---|
   | `unknown_site` | `403 Forbidden` |
   | `invalid_signature` | `401 Unauthorized` |
   | `stale_timestamp` | `408 Request Timeout` |

3. Looks up the per-peer symmetric key and fingerprint via `KeyManager`. Missing entries fail with `403`.
4. Returns a `WsConnectionData` record containing `{ siteId, symmetricKey, fingerprint, sendState, pendingDrain }` which Bun attaches to the upgraded socket as `ws.data`.

The `WsConnectionManager` tracks one connection per `siteId`; a fresh upgrade from the same site closes the prior connection with code `1008` ("Duplicate connection").

### `WsTransport`

`WsTransport` is the event-driven replication engine. A single instance handles all peers on one process.

```typescript
const transport = new WsTransport({
  db,
  siteId,
  eventBus,
  logger,
  isHub: true,  // true on the hub, false on a spoke
});
transport.start();
```

On `start()`, `WsTransport` registers listeners for two event bus events:

- `changelog:written` — fired whenever the local `change_log` table gains a row. The handler loads the full entry and hands it to a `MicrotaskCoalescer` that batches entries arriving in the same microtask, then flushes each batch as a `changelog_push` frame to every connected peer (with echo suppression).
- `relay:outbox-written` — fired whenever a relay outbox entry is created. The handler routes the entry: on a spoke it sends a `relay_send` frame to the hub; on the hub it invokes the same routing logic as an incoming `relay_send` (broadcast, hub-local dispatch, or forward to another spoke).

### `drainChangelog(peerSiteId)` / `drainRelayOutbox(peerSiteId)` / `drainRelayInbox(spokesSiteId)`

Called when a peer connects or reconnects. `drainChangelog` queries `change_log WHERE hlc > last_sent AND site_id != peerSiteId`, batches the results in chunks of 100, and sends each as a `changelog_push` frame, updating `last_sent` after each successful batch and emitting a final `drain_complete` frame. `drainRelayOutbox` (spoke-side) resends all undelivered outbox entries. `drainRelayInbox` (hub-side) forwards entries from the hub's outbox targeting the reconnected spoke.

---

## WebSocket Frames

**Source:** `packages/sync/src/ws-frames.ts`

All sync traffic after the upgrade flows as binary WebSocket frames. Every frame is encrypted with XChaCha20-Poly1305 using the per-peer symmetric key derived by `KeyManager` during the upgrade.

### Frame Layout

```
[1 byte type][24 bytes nonce][N bytes ciphertext (includes 16-byte Poly1305 tag)]
```

The plaintext is UTF-8 encoded JSON. Minimum valid frame size is 41 bytes (1 + 24 + 16). `encodeFrame` / `decodeFrame` perform the encryption, decryption, and payload-shape validation.

### Message Types

| Byte | Name | Direction | Purpose |
|------|------|-----------|---------|
| `0x01` | `CHANGELOG_PUSH` | both | Batch of change log entries the sender wants the receiver to apply. |
| `0x02` | `CHANGELOG_ACK` | both | Confirms the highest HLC the receiver has applied. |
| `0x03` | `RELAY_SEND` | spoke → hub | Relay outbox entries awaiting routing by the hub. |
| `0x04` | `RELAY_DELIVER` | hub → spoke | Relay inbox entries being delivered to a spoke. |
| `0x05` | `RELAY_ACK` | both | Acknowledges delivery of relay entries by ID. |
| `0x06` | `DRAIN_REQUEST` | reserved | Request peer to drain missed entries. |
| `0x07` | `DRAIN_COMPLETE` | sender → peer | Signals end of a reconnect drain. |
| `0xff` | `ERROR` | either | Advisory error payload. |

### `CHANGELOG_PUSH`

```typescript
type ChangelogPushPayload = {
  entries: Array<{
    hlc: string;
    table_name: string;
    row_id: string;
    site_id: string;
    timestamp: string;
    row_data: Record<string, unknown>;
  }>;
};
```

On receipt, `WsTransport.handleChangelogPush` calls `replayEvents(db, entries)` to apply each entry through the appropriate reducer, updates `last_received` to the highest HLC in the batch, and sends a `CHANGELOG_ACK` back.

### `CHANGELOG_ACK`

```typescript
type ChangelogAckPayload = { cursor: string };  // HLC
```

On receipt, `WsTransport.handleChangelogAck` advances `sync_state.last_sent` for the acknowledging peer to `cursor`.

### `RELAY_SEND` / `RELAY_DELIVER` / `RELAY_ACK`

```typescript
type RelaySendPayload = { entries: Array<{ id, target_site_id, kind, ref_id, idempotency_key, stream_id, expires_at, payload }> };
type RelayDeliverPayload = { entries: Array<{ id, source_site_id, kind, ref_id, idempotency_key, stream_id, expires_at, payload }> };
type RelayAckPayload = { ids: string[] };
```

`RELAY_SEND` carries outbox entries from a spoke to the hub for routing (see [Relay Transport](#relay-transport)). The hub dispatches each entry by its `target_site_id`:

- `"*"` — fan out to every other connected spoke and insert one copy into the hub's own `relay_inbox`.
- Hub's own `site_id` — insert into the hub's `relay_inbox` for local processing.
- Another spoke — if that spoke is currently connected, send a `RELAY_DELIVER` to it immediately; otherwise write an entry into the hub's `relay_outbox` targeting the spoke, to be drained when it reconnects.

`RELAY_DELIVER` is the hub → spoke direction. The receiving spoke inserts the entries into its own `relay_inbox` and emits a `relay:inbox` event. `RELAY_ACK` carries a list of delivered entry IDs and causes `markDelivered` to run on the outbox.

### `DRAIN_COMPLETE`

Sent by the sender after a reconnect drain finishes successfully, allowing the peer to know the catch-up is complete. Payload is `{ success: boolean }`.

### Wiring the WebSocket Handler

```typescript
import { createWsHandlers, WsConnectionManager } from "@bound/sync";

const { websocket, handleUpgrade } = createWsHandlers({
  connectionManager: new WsConnectionManager(),
  keyring,
  keyManager,
  wsTransport,
  logger,
});

Bun.serve({
  port,
  fetch(req, server) {
    if (new URL(req.url).pathname === "/sync/ws") {
      return handleUpgrade(req, server);
    }
    // ...
  },
  websocket,
});
```

---

## Change Log Pruning

**Source:** `packages/sync/src/pruning.ts`

The `change_log` table grows indefinitely unless pruned. The pruning strategy depends on whether the instance has any peers.

### `determinePruningMode(db): "multi-host" | "single-host"`

Checks whether `sync_state` contains any rows:

- **No rows** — returns `"single-host"`. The instance has no known peers, but the change log is still retained (capped) so it remains available if multi-host sync is enabled later.
- **One or more rows** — returns `"multi-host"`. Entries must be retained until all peers have confirmed receipt.

### `pruneChangeLog(db, mode, logger?): { deleted: number }`

Deletes change log entries according to the mode.

**Single-host mode:** Retains the most recent `100_000` entries and deletes anything older. If the table holds fewer than the cap, no rows are deleted.

```typescript
pruneChangeLog(db, "single-host", logger);
// Older change_log rows removed once the 100k cap is exceeded
```

**Multi-host mode:** Calls `getMinConfirmedHlc` to find the lowest `last_received` HLC across all peers. Deletes entries with `hlc <= minHlc`. If `minHlc` is `HLC_ZERO` (no peer has acknowledged anything yet), no rows are deleted.

```typescript
pruneChangeLog(db, "multi-host", logger);
// Only entries confirmed by every peer are removed
```

Returns `{ deleted: N }` where `N` is the number of rows removed.

### `startPruningLoop(db, intervalMs, logger?): { stop: () => void }`

Starts a `setInterval`-based loop that on each tick calls `determinePruningMode` and `pruneChangeLog`, prunes the `relay_cycles` table (30-day retention), prunes acknowledged dispatch-queue entries (1-hour retention), and runs `PRAGMA incremental_vacuum(64)` to reclaim freed pages.

```typescript
const pruner = startPruningLoop(db, 60_000, logger); // prune every minute

// During shutdown:
pruner.stop();
```

Pruning failures are non-fatal and the fixed interval is sufficient; no backoff is applied.

### Safety Invariant

The combination of `getMinConfirmedHlc` (taking the minimum across all peers) and the `CHANGELOG_ACK` mechanism ensures that an entry is only deleted after every registered peer has sent an acknowledgement for an HLC at or above that entry's `hlc`. A peer that falls behind — for example due to an extended outage — will hold the minimum at a low value and effectively block pruning until it catches up.

---

## Relay Transport

The relay frames (`RELAY_SEND`, `RELAY_DELIVER`, `RELAY_ACK`) provide store-and-forward delivery for cross-host operations: MCP tool calls, remote LLM inference, and loop delegation. Relay traffic shares the same WebSocket connection as changelog replication.

### Tables

Three local-only tables (not synced via change_log):

| Table | Purpose |
|-------|---------|
| `relay_outbox` | Messages the local host wants to send to a specific remote host |
| `relay_inbox` | Messages received from remote hosts, awaiting processing |
| `relay_cycles` | Per-cycle metrics (latency, success, kind) |

All three tables carry a nullable `stream_id TEXT` column for correlating streaming inference chunks. The outbox and inbox both have partial indexes on `(stream_id)` where `stream_id IS NOT NULL`.

CRUD helpers (from `@bound/core`): `writeOutbox`, `insertInbox`, `readUnprocessed`, `markProcessed`, `readUndelivered`, `markDelivered`, `readInboxByStreamId`.

### Relay Kinds

**Request kinds** (requester → target):

| Kind | Purpose |
|------|---------|
| `tool_call` | Execute an MCP tool on the target |
| `resource_read` | Read an MCP resource on the target |
| `prompt_invoke` | Invoke an MCP prompt on the target |
| `cache_warm` | Warm cache on the target |
| `cancel` | Cancel an active inference stream or delegated loop (carries `ref_id`) |
| `inference` | Request LLM inference from the target (streaming response) |
| `process` | Delegate entire agent loop to the target |
| `intake` | Route an inbound platform message to the appropriate spoke for processing |
| `platform_deliver` | Route an outbound assistant response to the platform leader host for delivery |
| `event_broadcast` | Fan out a custom event to all spokes (target is `*`) |

**Response kinds** (target → requester):

| Kind | Purpose |
|------|---------|
| `result` | Tool call / resource read result |
| `error` | Error response for any request kind |
| `stream_chunk` | One batch of `StreamChunk` objects from a remote inference stream |
| `stream_end` | Final batch; closes the inference stream |
| `status_forward` | Agent loop state update from a delegated loop |

### Hub Routing

The hub acts as a relay router. When a spoke sends a `RELAY_SEND` frame, `WsTransport.handleRelaySend` processes each entry and dispatches it based on `target_site_id`:

1. **`"*"` (broadcast)** — fan out to every connected spoke except the originator by sending each a `RELAY_DELIVER`, and also insert one copy into the hub's own `relay_inbox`.
2. **Hub's own `site_id`** — insert into the hub's `relay_inbox` for local processing by the `RelayProcessor`.
3. **Another spoke** — if that spoke is currently connected, send a `RELAY_DELIVER` immediately; otherwise write the entry into the hub's own `relay_outbox` targeting the spoke, to be forwarded when it reconnects via `drainRelayInbox`.

After routing, the hub sends a `RELAY_ACK` back to the originating spoke containing the delivered IDs. An idempotency check on `(idempotency_key, target_site_id)` prevents duplicate routing when entries are replayed.

`stream_id` is propagated through all routing paths, so `readInboxByStreamId()` on the requester always finds its chunks.

**Routing for `intake`:** The receiving spoke's `RelayProcessor` selects the best host to handle the platform message using a five-tier algorithm:

1. **platform affinity** — if the intake carries a `platform` field, route to a host that advertises that platform.
2. **thread affinity** — the spoke that most recently processed this thread (tracked via `status_forward` messages passing through the hub).
3. **model match** — a spoke that advertises the model listed in `threads.model_hint` for this thread.
4. **tool match** — the spoke with the highest overlap between its registered MCP tools and the tools used in this thread.
5. **least-loaded fallback** — the spoke with the fewest pending undelivered `relay_outbox` entries.

Once a target is selected, the intake processor writes a `process` outbox entry targeting that spoke.

**Routing for `platform_deliver`:** The entry is routed to the spoke that currently holds the platform leader role for the relevant platform. Leadership is stored in the synced `cluster_config` table under the key `platform_leader:<platform>` (e.g., `platform_leader:discord`). The receiving spoke's `RelayProcessor` emits a local `platform:deliver` event, which the `PlatformConnectorRegistry` handles to send the message to the user.

**Routing for `event_broadcast`:** The target field is set to `*`. The hub fans out the entry to all connected spokes, excluding the originating source spoke. Each recipient's `RelayProcessor` fires the named event locally on its event bus. Used by the agent's `emit` command to propagate custom events across the cluster.

**Immediate delivery:** Because replication runs over a persistent WebSocket, relay entries are delivered to connected peers as soon as they are written — there is no separate polling cycle to wait for. The `relay_cycles.delivery_method` column records whether delivery went through the sync pipeline or an out-of-band eager push path; the current WebSocket transport uses `"sync"`.

### Inference Relay Flow

```
Requester                        Hub                       Target
    |                             |                            |
    | writeOutbox(inference)      |                            |
    | emit relay:outbox-written   |                            |
    |                             |                            |
    |------- RELAY_SEND --------->|                            |
    |                             |-------- RELAY_DELIVER ---->|
    |                             |      (routes to target)    |
    |                             |                            |-- insertInbox(inference)
    |                             |                            |-- RelayProcessor.executeInference()
    |                             |                            |   - calls local LLMBackend.chat()
    |                             |                            |   - flushes at 200ms or 4KB
    |                             |                            |   writeOutbox(stream_chunk / stream_end)
    |                             |                            |
    |                             |<-------- RELAY_SEND -------|
    |<------- RELAY_DELIVER ------| (routes to requester)      |
    |                             |                            |
    | readInboxByStreamId()       |                            |
    | yields StreamChunks         |                            |
```

The `InferenceRequestPayload` (defined in `@bound/llm`) carries:

```typescript
interface InferenceRequestPayload {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  system?: string;
  system_suffix?: string;
  max_tokens?: number;
  temperature?: number;
  cache_breakpoints?: number[];
  thinking?: { type: "enabled"; budget_tokens: number };
  timeout_ms: number;
  messages_file_ref?: string;  // set when messages were written to files table (>2MB payloads)
}
```

`stream_chunk` and `stream_end` payloads:

```typescript
interface StreamChunkPayload {
  chunks: StreamChunk[];  // one or more StreamChunk objects
  seq: number;            // monotonic, starting at 0
}
```

### Relay Metrics

`relay_cycles` records one row per relay operation:

| Column | Description |
|--------|-------------|
| `direction` | `"inbound"` (target receiving) or `"outbound"` (requester sending) |
| `peer_site_id` | Site ID of the other party |
| `kind` | Relay kind (e.g., `"inference"`, `"stream_chunk"`, `"stream_end"`) |
| `delivery_method` | `"sync"` or `"eager_push"` |
| `latency_ms` | Milliseconds from request to response (null for intermediate chunks) |
| `expired` | 1 if the entry was expired without execution |
| `success` | 1 if the operation completed successfully |
| `stream_id` | Stream ID for inference operations |

The `turns` table also records relay metrics per agent turn: `relay_target` (host_name of the inference provider) and `relay_latency_ms` (time to first chunk). Both are NULL for local inference.
