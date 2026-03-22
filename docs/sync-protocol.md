# Sync Protocol

The `@bound/sync` package implements event-sourced synchronisation between distributed Bound instances. Each instance maintains a local SQLite change log and exchanges changesets with a designated hub over HTTP. All transport is authenticated with Ed25519 request signatures; merge conflicts are resolved through deterministic LWW or append-only reducers.

---

## Table of Contents

1. [Overview](#overview)
2. [Ed25519 Keypair Management](#ed25519-keypair-management)
3. [Request Signing](#request-signing)
4. [Reducers](#reducers)
5. [Changesets and Peer Cursors](#changesets-and-peer-cursors)
6. [Three-Phase Sync Protocol](#three-phase-sync-protocol)
7. [HTTP Endpoints](#http-endpoints)
8. [Change Log Pruning](#change-log-pruning)

---

## Overview

Bound uses a hub-and-spoke topology. Each spoke instance runs a `SyncClient` that periodically executes a three-phase cycle against its hub:

1. **Push** — the spoke serialises every change log entry the hub has not yet seen and POSTs it to `/sync/push`.
2. **Pull** — the spoke requests all entries the hub holds that the spoke has not yet seen via `/sync/pull`.
3. **Ack** — the spoke confirms the highest sequence number it received via `/sync/ack`, allowing the hub to eventually prune its change log.

Every HTTP request in the sync protocol is signed with the caller's Ed25519 private key. The receiving side authenticates the request by verifying the signature against the caller's public key, which it retrieves from a shared `keyring` configuration file. This means no pre-shared passwords or TLS client certificates are required — identity is entirely key-based.

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

All sync HTTP requests carry four custom headers that together constitute a signed proof of identity. The scheme is intentionally simple — no HTTP Signatures draft, no JWT — to keep the dependency surface small.

### Signing Scheme

The signed message (the "signing base") is a newline-separated concatenation of four fields:

```
<METHOD>\n<PATH>\n<ISO-TIMESTAMP>\n<SHA-256-HEX-OF-BODY>
```

For example:

```
POST
/sync/push
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

Computes the signing base from the provided arguments, signs it, and returns the four headers ready to spread into a `fetch` call.

```typescript
const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", body);

await fetch(`${hubUrl}/sync/push`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...headers,
  },
  body,
});
```

#### `verifyRequest(keyring, method, path, headers, body): Promise<Result<{ siteId: string; hostName: string }, SignatureError>>`

Verifies an incoming request. The steps are:

1. Extract `X-Site-Id`, `X-Timestamp`, and `X-Signature` from the headers (case-insensitive lookup).
2. Look up the site ID in `keyring.hosts`. If not found, return `{ code: "unknown_site" }`.
3. Check that the timestamp is within **5 minutes** of the server's local time. If not, return `{ code: "stale_timestamp" }`.
4. Reconstruct the signing base and verify the signature with the host's public key. If verification fails, return `{ code: "invalid_signature" }`.
5. On success, return `{ siteId, hostName }`.

```typescript
const result = await verifyRequest(keyring, "POST", "/sync/push", headers, body);
if (!result.ok) {
  // result.error.code is "unknown_site" | "invalid_signature" | "stale_timestamp"
}
```

#### `detectClockSkew(localTimestamp: string, remoteTimestamp: string): number | null`

Compares two ISO timestamps and returns the absolute skew in **seconds** if it exceeds 30 seconds, or `null` otherwise. Called by the auth middleware to populate the `X-Clock-Skew` response header as an advisory signal to the client.

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
- **Row exists** — compares `modified_at` fields. The update is applied only if `event.row_data.modified_at` is strictly greater than the stored value. Columns not in the schema are ignored; only non-`id` columns are updated.

Returns `{ applied: true }` if the underlying SQL statement changed at least one row.

```typescript
const result = applyLWWReducer(db, {
  seq: 42,
  table_name: "bookmarks",
  row_id: "abc123",
  site_id: "a3f1c8b2...",
  timestamp: "2026-03-23T14:00:00.000Z",
  row_data: JSON.stringify({ id: "abc123", url: "https://example.com", modified_at: "2026-03-23T14:00:00.000Z" }),
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

Iterates a list of `ChangeLogEntry` records in order, calling `applyEvent` for each. When an event is applied successfully, a new change log entry is written to the local `change_log` table (via `createChangeLogEntry`) with the **original** `site_id` preserved. This is important: the log must record where each change originated so that echo suppression works correctly during a subsequent pull.

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

A `Changeset` is the unit of exchange in the sync protocol.

```typescript
interface Changeset {
  events: ChangeLogEntry[];
  source_site_id: string;
  source_seq_start: number;
  source_seq_end: number;
}
```

`source_seq_start` and `source_seq_end` are the first and last `seq` values in the `events` array. When `events` is empty, `source_seq_end` equals the cursor value that was passed in (i.e. no progress was made) and `source_seq_start` is `cursor + 1`.

#### `fetchOutboundChangeset(db, peerSiteId, siteId): Changeset`

Builds the changeset that the local instance will push to a peer. Reads `sync_state.last_sent` for `peerSiteId` (defaulting to `0`) and returns every `change_log` entry with `seq > last_sent`, regardless of which site originally created the entry. The rationale is that the hub should receive the full history, not just locally-originated entries.

```typescript
const outbound = fetchOutboundChangeset(db, hubSiteId, localSiteId);
// outbound.events contains everything the hub hasn't seen yet
```

#### `fetchInboundChangeset(db, requesterSiteId, sinceSeq): Changeset`

Builds the changeset the hub will return to a spoke during a pull. Selects entries with `seq > sinceSeq` and **excludes any entry whose `site_id` equals `requesterSiteId`**. This echo suppression prevents a spoke from receiving back its own changes that have been relayed through the hub.

```typescript
const inbound = fetchInboundChangeset(db, spokeSiteId, sinceSeq);
// entries originally created by spokeSiteId are excluded
```

#### `serializeChangeset(changeset): string`

JSON-serialises a `Changeset` for transmission.

#### `deserializeChangeset(json): Result<Changeset, Error>`

Parses a JSON string and returns a `Result`. Returns `err` on malformed JSON without throwing.

### Peer Cursors

**Source:** `packages/sync/src/peer-cursor.ts`

Peer cursors track synchronisation progress per peer in the `sync_state` table. Each row holds a `peer_site_id` (primary key) along with `last_received`, `last_sent`, `last_sync_at`, and `sync_errors`.

| Field | Meaning |
|---|---|
| `last_received` | Highest `seq` this instance has received from the peer |
| `last_sent` | Highest `seq` this instance has sent to (or confirmed by) the peer |
| `last_sync_at` | ISO timestamp of the most recent successful cursor update |
| `sync_errors` | Count of consecutive sync failures for this peer |

#### `getPeerCursor(db, peerSiteId): SyncState | null`

Returns the full `SyncState` row for a peer, or `null` if none exists.

#### `updatePeerCursor(db, peerSiteId, updates): void`

Upserts `sync_state` for the given peer. Accepted fields in `updates` are `last_received`, `last_sent`, and `sync_errors`. `last_sync_at` is always set to the current time. On insert, any field omitted from `updates` defaults to `0`.

```typescript
updatePeerCursor(db, hubSiteId, { last_sent: outbound.source_seq_end });
updatePeerCursor(db, hubSiteId, { last_received: newLastReceived });
```

#### `resetSyncErrors(db, peerSiteId): void`

Sets `sync_errors` to `0` for the given peer. Called after a successful sync cycle.

#### `incrementSyncErrors(db, peerSiteId): void`

Atomically increments `sync_errors` by 1, inserting the row first if it does not exist.

#### `getMinConfirmedSeq(db): number`

Returns `MIN(last_received)` across all rows in `sync_state`, or `0` if the table is empty. Used by the pruning logic to determine the lowest sequence number that every peer has confirmed receiving — entries at or below this threshold are safe to delete.

---

## Three-Phase Sync Protocol

**Source:** `packages/sync/src/sync-loop.ts`

### `SyncClient`

`SyncClient` encapsulates the logic for a single spoke's synchronisation against one hub.

```typescript
const client = new SyncClient(
  db,
  siteId,
  privateKey,
  hubUrl,
  logger,
  eventBus,
  keyring,
);
```

On construction, `SyncClient` resolves the hub's site ID by scanning `keyring.hosts` for the entry whose `url` matches `hubUrl`. This site ID is used as the `peer_site_id` key for all cursor operations.

#### `syncCycle(): Promise<Result<SyncResult, SyncError>>`

Executes one full push/pull/ack cycle. The phases run in order; any failure aborts the cycle and returns an `err` result without advancing the cursor.

**Phase 1 — Push:**
1. Call `fetchOutboundChangeset(db, peerSiteId, siteId)` to build the outbound batch.
2. If the batch is non-empty, POST it to `/sync/push` with a signed request.
3. On success, advance `sync_state.last_sent` to `outbound.source_seq_end`.

**Phase 2 — Pull:**
1. Read `sync_state.last_received` for the hub peer (default `0`).
2. POST `{ since_seq }` to `/sync/pull` with a signed request.
3. Deserialise the response body as a `Changeset`.
4. Call `replayEvents` to apply the received entries locally.

**Phase 3 — Ack:**
1. POST `{ last_received: newLastReceived }` to `/sync/ack` with a signed request.
2. On success, advance `sync_state.last_received` and call `resetSyncErrors`.

On success, emits a `sync:completed` event on the `eventBus`:

```typescript
eventBus.emit("sync:completed", {
  pushed: number,
  pulled: number,
  duration_ms: number,
});
```

The `SyncResult` type:

```typescript
interface SyncResult {
  pushed: number;
  pulled: number;
  duration_ms: number;
}
```

The `SyncError` type:

```typescript
interface SyncError {
  phase: "push" | "pull" | "ack";
  status?: number;  // HTTP status code, if the failure was an HTTP error
  message: string;
}
```

### `startSyncLoop(client, intervalSeconds): { stop: () => void }`

Starts a recurring sync loop that calls `client.syncCycle()`. Uses recursive `setTimeout` rather than `setInterval` so the interval can vary dynamically based on failure state.

**Exponential backoff:** After each failed cycle, the delay before the next attempt is computed as:

```
nextInterval = min(baseInterval * 2^consecutiveFailures, 300_000ms)
```

The maximum interval is 5 minutes. After any successful cycle, `consecutiveFailures` resets to `0` and the base interval resumes.

```typescript
const loop = startSyncLoop(client, 30); // sync every 30 seconds when healthy

// Later, during shutdown:
loop.stop();
```

Calling `stop()` sets a flag that prevents any further cycles from being scheduled and cancels any pending timer.

### `resolveHubUrl(db, syncConfig, keyring): string`

Determines the hub URL from available configuration sources in priority order:

1. `cluster_config` table row with `key = "cluster_hub"` (dynamic, runtime-set).
2. `syncConfig.hub` from the static `sync.json` configuration.
3. The first `url` found in `keyring.hosts` (fallback of last resort).

Throws if no URL can be determined from any source.

```typescript
const hubUrl = resolveHubUrl(db, syncConfig, keyring);
```

---

## HTTP Endpoints

**Sources:** `packages/sync/src/routes.ts`, `packages/sync/src/middleware.ts`

The hub exposes three endpoints, all under the `/sync/` path prefix, mounted as a Hono application. All three are protected by the auth middleware.

### Auth Middleware

**`createSyncAuthMiddleware(keyring): MiddlewareHandler`**

Applied to `/sync/*`. For every request it:

1. Reads the raw request body and caches it in the Hono context as `rawBody` so route handlers can access it without consuming the stream a second time.
2. Calls `verifyRequest` with the keyring, method, path, lowercased headers, and body.
3. On failure, returns immediately with the appropriate HTTP status:

| Error code | Status |
|---|---|
| `unknown_site` | `403 Forbidden` |
| `invalid_signature` | `401 Unauthorized` |
| `stale_timestamp` | `408 Request Timeout` |

4. On success, sets `siteId` and `hostName` in the Hono context for use by route handlers.
5. Calls `detectClockSkew`. If skew exceeds 30 seconds, the response carries an advisory `X-Clock-Skew` header (value in seconds) so the client can detect and diagnose NTP drift.

### `POST /sync/push`

Receives a changeset from a spoke and applies it to the hub's local database.

**Request body:** A serialised `Changeset` object.

**Behaviour:**
1. Parse `changeset.events` from the raw body.
2. Call `replayEvents(db, events)` to apply each entry through the appropriate reducer.
3. If any events were received, advance `sync_state.last_received` for the pushing spoke to the `seq` of the last event.

**Response:**
```json
{ "ok": true, "received": 3 }
```

`received` is the count of events that were actually applied (skipped duplicates are not counted).

### `POST /sync/pull`

Returns events to a spoke that the spoke has not yet seen.

**Request body:**
```json
{ "since_seq": 42 }
```

`since_seq` defaults to `0` if omitted.

**Behaviour:**
1. Read the requesting spoke's site ID from context.
2. Call `fetchInboundChangeset(db, requesterSiteId, sinceSeq)`, which applies echo suppression.

**Response:** A serialised `Changeset` object.

### `POST /sync/ack`

Records that the spoke has successfully received and applied events up to a given sequence number.

**Request body:**
```json
{ "last_received": 55 }
```

**Behaviour:**
1. Call `updatePeerCursor(db, ackingSiteId, { last_sent: lastReceived })`.

The hub records this as `last_sent` because, from its perspective, it has successfully delivered events through `lastReceived` to this peer.

**Response:**
```json
{ "ok": true }
```

### Registering the Routes

```typescript
import { createSyncRoutes } from "@bound/sync";

const syncApp = createSyncRoutes(db, siteId, keyring, eventBus, logger);
app.route("/", syncApp);
```

---

## Change Log Pruning

**Source:** `packages/sync/src/pruning.ts`

The `change_log` table grows indefinitely unless pruned. The pruning strategy depends on whether the instance has any peers.

### `determinePruningMode(db): "multi-host" | "single-host"`

Checks whether `sync_state` contains any rows:

- **No rows** — returns `"single-host"`. The instance has no known peers; the change log serves no replication purpose and can be cleared entirely.
- **One or more rows** — returns `"multi-host"`. Entries must be retained until all peers have confirmed receipt.

### `pruneChangeLog(db, mode, logger?): { deleted: number }`

Deletes change log entries according to the mode.

**Single-host mode:** Unconditionally deletes all rows from `change_log`.

```typescript
pruneChangeLog(db, "single-host", logger);
// All change_log rows removed
```

**Multi-host mode:** Calls `getMinConfirmedSeq` to find the lowest `last_received` value across all peers. Deletes only entries with `seq <= minSeq`. If `minSeq` is `0` (no peer has acknowledged anything yet), no rows are deleted.

```typescript
pruneChangeLog(db, "multi-host", logger);
// Only entries confirmed by every peer are removed
```

Returns `{ deleted: N }` where `N` is the number of rows removed.

### `startPruningLoop(db, intervalMs, logger?): { stop: () => void }`

Starts a `setInterval`-based loop that calls `determinePruningMode` and `pruneChangeLog` on each tick.

```typescript
const pruner = startPruningLoop(db, 60_000, logger); // prune every minute

// During shutdown:
pruner.stop();
```

Unlike the sync loop, the pruning loop does not apply exponential backoff — pruning failures are non-fatal and the fixed interval is sufficient.

### Safety Invariant

The combination of `getMinConfirmedSeq` (taking the minimum across all peers) and the ack mechanism ensures that an entry is only deleted after every registered peer has sent an `/sync/ack` confirming a sequence number at or above that entry's `seq`. A peer that falls behind — for example due to an extended outage — will hold the minimum at a low value and effectively block pruning until it catches up.
