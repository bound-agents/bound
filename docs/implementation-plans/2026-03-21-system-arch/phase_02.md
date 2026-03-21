# Bound System Architecture - Phase 2: Sync Protocol

**Goal:** Two Bound instances on localhost can exchange changesets via HTTP push/pull/ack and converge on identical database state. All 7 multi-instance sync test scenarios pass.

**Architecture:** `@bound/sync` package implementing event-sourced sync with Ed25519-signed HTTP endpoints. Spoke-initiated three-phase protocol (push → pull → ack) using LWW and append-only reducers. Peer cursors track replication progress. Change log pruning reclaims space after confirmed delivery.

**Tech Stack:** Bun 1.2+, Hono (sync HTTP routes), Ed25519 via `crypto.subtle` (Web Crypto API), `Bun.CryptoHasher` (SHA-256 body hashing), bun:sqlite transactions

**Scope:** 8 phases from original design (phase 2 of 8)

**Codebase verified:** 2026-03-22 — Phase 1 plan provides all required foundations (types, change_log table, sync_state table, hosts table, transactional outbox, config loader for keyring.json/sync.json, DI container).

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC3: Phased build order produces working vertical slices
- **system-arch.AC3.2 Success:** Phase 2 completes with two instances syncing changesets on localhost

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.2 Success:** Core, agent, and sync packages have integration tests using real SQLite databases
- **system-arch.AC4.3 Success:** Sync integration tests run two bound instances on different ports with different configs on the same machine
- **system-arch.AC4.4 Success:** Multi-instance sync tests validate: basic replication, bidirectional sync, LWW conflict resolution, append-only dedup, change_log pruning, reconnection catch-up, hub promotion

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: @bound/sync package setup

**Files:**
- Create: `packages/sync/package.json`
- Create: `packages/sync/tsconfig.json`
- Create: `packages/sync/src/index.ts`
- Modify: `tsconfig.json` (root) — add sync to references

**Step 1: Create package.json**

```json
{
  "name": "@bound/sync",
  "version": "0.0.1",
  "description": "Event-sourced sync protocol with Ed25519 authentication, LWW/append-only reducers, and HTTP push/pull/ack endpoints for distributed Bound instances",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@bound/shared": "workspace:*",
    "@bound/core": "workspace:*",
    "hono": "^4.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../shared" },
    { "path": "../core" }
  ]
}
```

**Step 3: Update root tsconfig.json references**

Add `{ "path": "packages/sync" }` to the root tsconfig.json references array.

**Step 4: Create barrel export**

`packages/sync/src/index.ts` — Empty barrel export, will be populated as tasks are completed.

**Step 5: Verify operationally**

Run: `bun install`
Expected: Installs without errors, hono dependency resolved.

**Step 6: Commit**

```bash
git add packages/sync/ tsconfig.json bun.lockb
git commit -m "chore(sync): initialize @bound/sync package"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Ed25519 keypair management

**Verifies:** (foundation for system-arch.AC4.3 — instances need distinct identities)

**Files:**
- Create: `packages/sync/src/crypto.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/crypto.ts` — Ed25519 key lifecycle using Web Crypto API (`crypto.subtle`):

Functions to implement:

- `generateKeypair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>` — Generates an Ed25519 keypair using `crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])`.

- `exportPublicKey(key: CryptoKey): Promise<string>` — Exports public key as base64-encoded SPKI format. Prefix with `"ed25519:"` per spec convention (e.g., `"ed25519:MCowBQYDK2VwAyEA..."`).

- `exportPrivateKey(key: CryptoKey): Promise<Uint8Array>` — Exports private key as PKCS#8 raw bytes for file storage.

- `importPublicKey(encoded: string): Promise<CryptoKey>` — Imports from the `"ed25519:..."` string format. Strips prefix, base64-decodes, imports as SPKI.

- `importPrivateKey(bytes: Uint8Array): Promise<CryptoKey>` — Imports private key from PKCS#8 bytes.

- `deriveSiteId(publicKey: CryptoKey): Promise<string>` — First 16 bytes of SHA-256 of the SPKI-exported public key, hex-encoded. Uses `Bun.CryptoHasher("sha256")`.

- `ensureKeypair(dataDir: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey; siteId: string }>` — Checks for `data/host.key` and `data/host.pub`. If absent, generates new keypair and writes files (`host.key` with mode 0600, `host.pub` readable). If present, loads existing keypair and derives site_id. This implements spec §8.4 startup ordering.

**Testing:**
- Generate a keypair, export both keys, reimport them, verify they produce the same site_id
- `deriveSiteId` produces a 32-character hex string (16 bytes)
- `ensureKeypair` creates files on first call, reuses them on second call
- Deterministic: same key always produces same site_id

Test file: `packages/sync/src/__tests__/crypto.test.ts` (unit)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add Ed25519 keypair management`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Request signing and verification

**Verifies:** (foundation for system-arch.AC4.3 — instances authenticate to each other)

**Files:**
- Create: `packages/sync/src/signing.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/signing.ts` — HTTP request signing per spec §13.4 (Signed HTTP Protocol):

Functions to implement:

- `signRequest(privateKey: CryptoKey, siteId: string, method: string, path: string, body: string): Promise<{ "X-Site-Id": string; "X-Timestamp": string; "X-Signature": string; "X-Agent-Version": string }>` — Constructs the signing base: `"${method}\n${path}\n${timestamp}\n${sha256(body)}"`, signs with Ed25519, returns the four required headers. Timestamp is ISO 8601 current time. Version is read from package.json or a constant.

- `verifyRequest(keyring: KeyringConfig, method: string, path: string, headers: Record<string, string>, body: string): Promise<Result<{ siteId: string; hostName: string }, SignatureError>>` — Verifies a signed request:
  1. Extract `X-Site-Id`, `X-Timestamp`, `X-Signature` from headers
  2. Look up the public key in the keyring by matching site_id to a host entry
  3. Check timestamp freshness (±5 min tolerance)
  4. Reconstruct signing base and verify Ed25519 signature
  5. Return `ok({ siteId, hostName })` or `err(SignatureError)` with specific error type:
     - `"unknown_site"` → 403
     - `"invalid_signature"` → 401
     - `"stale_timestamp"` → 408

- `SignatureError` type: `{ code: "unknown_site" | "invalid_signature" | "stale_timestamp"; message: string }`

- `detectClockSkew(localTimestamp: string, remoteTimestamp: string): number | null` — Returns skew in seconds if > 30s threshold, null otherwise. Used for the `X-Clock-Skew` warning header per spec §8.4.

**Testing:**
- Sign a request, verify it with the corresponding public key — should succeed
- Verify with wrong public key — should fail with `invalid_signature`
- Verify with stale timestamp (>5 min old) — should fail with `stale_timestamp`
- Verify with site_id not in keyring — should fail with `unknown_site`
- Clock skew detection: timestamps 45s apart → returns skew value; timestamps 10s apart → returns null

Test file: `packages/sync/src/__tests__/signing.test.ts` (unit)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add Ed25519 request signing and verification`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 4-6) -->
<!-- START_TASK_4 -->
### Task 4: LWW and append-only reducers

**Verifies:** system-arch.AC4.4 (LWW conflict resolution, append-only dedup)

**Files:**
- Create: `packages/sync/src/reducers.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/reducers.ts` — Merge rules for replaying received events:

The spec defines two reducers (§8.1) plus a dynamic column selection strategy (§8.7):

- `applyAppendOnlyReducer(db: Database, event: ChangeLogEntry): { applied: boolean }` — For the `messages` table. Executes: `INSERT INTO messages (...) VALUES (...) ON CONFLICT(id) DO NOTHING`. Returns `{ applied: true }` if the row was inserted, `{ applied: false }` if it already existed (duplicate). Special handling for redaction: if the incoming event has `modified_at IS NOT NULL`, use the hybrid reducer from spec §5.4: `ON CONFLICT(id) DO UPDATE SET content = excluded.content, modified_at = excluded.modified_at WHERE excluded.modified_at IS NOT NULL AND (messages.modified_at IS NULL OR excluded.modified_at > messages.modified_at)`.

- `applyLWWReducer(db: Database, event: ChangeLogEntry): { applied: boolean }` — For all other synced tables. Implements the dynamic reducer (§8.7): inspect the incoming event's `row_data` JSON keys, build an INSERT...ON CONFLICT DO UPDATE statement that only SETs columns present in BOTH the event JSON AND the local schema. Unknown columns in the event are silently ignored. Missing columns (present locally but absent from event) are left untouched. The `WHERE excluded.modified_at > table.modified_at` clause ensures LWW semantics.

- `applyEvent(db: Database, event: ChangeLogEntry): { applied: boolean }` — Dispatches to the correct reducer based on `event.table_name` using the `TableReducerMap` from `@bound/shared`.

- `replayEvents(db: Database, events: ChangeLogEntry[]): { applied: number; skipped: number }` — Applies an array of events in order. Each event application is wrapped in the outbox pattern (the replayed event also produces a local change_log entry with the ORIGINAL site_id preserved, enabling relay to other peers).

Helper:
- `getTableColumns(db: Database, tableName: string): string[]` — Queries `PRAGMA table_info(tableName)` to get current column names. Cache this per table for performance.

**Testing:**
Tests must verify AC4.4 (LWW conflict resolution, append-only dedup):
- system-arch.AC4.4 (LWW): Insert row on host A, create event, replay on host B. Both have same row. Then update on both with different values and different timestamps — the later timestamp wins after replay.
- system-arch.AC4.4 (append-only dedup): Insert same message on two hosts (same UUID). Replay events in both directions. Each host has exactly one copy (no duplicates).
- Dynamic reducer: replay an event with an extra column not in the local schema — column is ignored, rest of row applied. Replay event missing a column that exists locally — local column value preserved.
- Redaction: append-only message replayed normally. Then redaction event (same id, modified_at set) updates content.

Test file: `packages/sync/src/__tests__/reducers.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add LWW and append-only reducers with dynamic column handling`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Changeset serialization and peer cursor management

**Verifies:** system-arch.AC4.4 (basic replication)

**Files:**
- Create: `packages/sync/src/changeset.ts`
- Create: `packages/sync/src/peer-cursor.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/changeset.ts` — Changeset types and serialization:

- `Changeset` type: `{ events: ChangeLogEntry[]; source_site_id: string; source_seq_start: number; source_seq_end: number }` — A batch of events from a peer, with metadata about the sequence range.

- `fetchOutboundChangeset(db: Database, peerSiteId: string, siteId: string): Changeset` — Fetches local events where `seq > sync_state.last_sent` for this peer. These are events to PUSH to the peer. The `siteId` parameter filters to include events from ALL sites (not just local) — the hub relays events from all spokes.

- `fetchInboundChangeset(db: Database, requesterSiteId: string, sinceSeq: number): Changeset` — Fetches local events where `seq > sinceSeq AND site_id != requesterSiteId` (echo suppression per §8.1). These are events to return in response to a PULL request.

- `serializeChangeset(changeset: Changeset): string` — JSON serialization of the changeset for HTTP transport.

- `deserializeChangeset(json: string): Result<Changeset, Error>` — Parse and validate incoming changeset JSON.

`packages/sync/src/peer-cursor.ts` — Peer cursor tracking via sync_state table:

- `getPeerCursor(db: Database, peerSiteId: string): SyncState | null` — Read current cursor state for a peer.

- `updatePeerCursor(db: Database, peerSiteId: string, updates: Partial<Pick<SyncState, "last_received" | "last_sent" | "sync_errors">>): void` — Update cursor after successful sync. Sets `last_sync_at` to current timestamp. Uses UPSERT to create the entry on first sync.

- `resetSyncErrors(db: Database, peerSiteId: string): void` — Reset `sync_errors` to 0 after a successful sync.

- `incrementSyncErrors(db: Database, peerSiteId: string): void` — Increment `sync_errors` counter on failure.

- `getMinConfirmedSeq(db: Database): number` — Returns the minimum `last_received` across all peers. Events with `seq <=` this value have been confirmed by all peers and can be pruned.

**Testing:**
- system-arch.AC4.4 (basic replication): Create events on host A, fetch outbound changeset, verify it contains the right events. Deserialize/serialize round-trip preserves data.
- Echo suppression: fetch inbound changeset with a requester site_id — events from that site_id are excluded.
- Peer cursor: update cursor, read it back, verify values match.
- Min confirmed seq: with two peers at seq 5 and seq 10, returns 5.

Test file: `packages/sync/src/__tests__/changeset.test.ts` (integration — real SQLite)
Test file: `packages/sync/src/__tests__/peer-cursor.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add changeset serialization and peer cursor management`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Sync loop orchestration

**Verifies:** system-arch.AC3.2, system-arch.AC4.4 (reconnection catch-up)

**Files:**
- Create: `packages/sync/src/sync-loop.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/sync-loop.ts` — The spoke-initiated sync cycle:

- `SyncClient` class:
  ```typescript
  class SyncClient {
    constructor(
      private db: Database,
      private siteId: string,
      private privateKey: CryptoKey,
      private hubUrl: string,
      private logger: Logger,
      private eventBus: TypedEventEmitter,
    ) {}

    async syncCycle(): Promise<Result<SyncResult, SyncError>> { ... }
  }
  ```

  `syncCycle()` implements the three-phase protocol (§8.3):
  1. **PUSH:** Fetch outbound changeset for hub peer. If non-empty, POST to `${hubUrl}/sync/push` with signed request headers. Hub replays events and returns confirmation.
  2. **PULL:** POST to `${hubUrl}/sync/pull` with `{ since_seq: last_received }` and signed headers. Hub returns inbound changeset (with echo suppression). Apply events through reducers locally.
  3. **ACK:** POST to `${hubUrl}/sync/ack` with `{ last_received: new_cursor }` and signed headers. Both sides update peer cursors.

  On success: update `sync_state` cursors, reset sync_errors, emit `sync:completed` event.
  On failure: increment sync_errors, log error, return err.

- `SyncResult` type: `{ pushed: number; pulled: number; duration_ms: number }`
- `SyncError` type: `{ phase: "push" | "pull" | "ack"; status?: number; message: string }`

- `startSyncLoop(client: SyncClient, intervalSeconds: number): { stop: () => void }` — Starts a polling loop that calls `syncCycle()` at the configured interval. Implements exponential backoff on failure (cap at 5 min per §8.6). Returns a stop function for graceful shutdown.

- `resolveHubUrl(db: Database, syncConfig: SyncConfig, keyring: KeyringConfig): string` — Hub URL resolution per §8.5: first check `cluster_config.cluster_hub` in DB, then fall back to `sync.json.hub`, resolve URL from hosts table or keyring.

**Testing:**
- system-arch.AC4.4 (reconnection catch-up): Start a sync loop, stop it, make changes on the "hub" side, restart the loop — the client catches up on the next cycle.
- Hub URL resolution: test fallback chain (cluster_config → sync.json → keyring)

Note: Full multi-instance testing is in Task 9. This task's tests verify the sync client logic with mocked HTTP responses.

Test file: `packages/sync/src/__tests__/sync-loop.test.ts` (unit — mock HTTP)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add sync loop with three-phase push/pull/ack protocol`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 7-9) -->
<!-- START_TASK_7 -->
### Task 7: Hono sync HTTP endpoints

**Verifies:** system-arch.AC3.2

**Files:**
- Create: `packages/sync/src/routes.ts`
- Create: `packages/sync/src/middleware.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/middleware.ts` — Hono middleware for sync request authentication:

- `createSyncAuthMiddleware(keyring: KeyringConfig): MiddlewareHandler` — Returns Hono middleware that:
  1. Extracts `X-Site-Id`, `X-Timestamp`, `X-Signature` headers
  2. Calls `verifyRequest()` from `signing.ts`
  3. On success: sets `c.set("siteId", siteId)` and `c.set("hostName", hostName)` for route handlers
  4. On failure: returns appropriate HTTP status (401, 403, 408) with JSON error body
  5. On clock skew detection: adds `X-Clock-Skew` response header

`packages/sync/src/routes.ts` — Hono router with sync endpoints:

- `createSyncRoutes(db: Database, siteId: string, keyring: KeyringConfig, eventBus: TypedEventEmitter, logger: Logger): Hono` — Returns a Hono app with:

  **POST /sync/push** — Receive events from a spoke:
  1. Parse incoming changeset from request body
  2. Replay events through reducers (producing local change_log entries with original site_id)
  3. Update peer cursor (`last_received` for the pushing spoke)
  4. Return `{ ok: true, received: number }`

  **POST /sync/pull** — Return events to a spoke:
  1. Read `since_seq` from request body
  2. Fetch inbound changeset with echo suppression (exclude requester's site_id)
  3. Return serialized changeset

  **POST /sync/ack** — Spoke confirms receipt:
  1. Read `last_received` from request body
  2. Update peer cursor (`last_sent` for the acknowledging spoke)
  3. Return `{ ok: true }`

All routes use the sync auth middleware. All routes return JSON. Errors return structured JSON with appropriate HTTP status codes.

**Testing:**
- Start a Hono app with sync routes, make authenticated requests using signed headers
- Push events → verify they're applied to the local database
- Pull events → verify echo suppression works (requester's own events excluded)
- Ack → verify peer cursors are updated
- Unauthenticated requests return 401

Test file: `packages/sync/src/__tests__/routes.test.ts` (integration — real Hono + real SQLite)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add Hono sync HTTP endpoints with auth middleware`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Change log pruning

**Verifies:** system-arch.AC4.4 (change_log pruning)

**Files:**
- Create: `packages/sync/src/pruning.ts`
- Modify: `packages/sync/src/index.ts` — add exports

**Implementation:**

`packages/sync/src/pruning.ts` — Change log cleanup per spec §5.15:

- `pruneChangeLog(db: Database, mode: "multi-host" | "single-host"): { deleted: number }`:
  - **Multi-host mode:** Get min confirmed seq across all peers via `getMinConfirmedSeq()`. Hard-delete `change_log` entries where `seq <= minSeq`. This is safe because all peers have confirmed receipt.
  - **Single-host mode:** No peers consume the change_log. Truncate the entire table: `DELETE FROM change_log`. Safe because there are no peers to fall behind.
  - Returns count of deleted rows.

- `determinePruningMode(db: Database): "multi-host" | "single-host"` — Check if `sync_state` table has any rows. If empty → single-host. If has rows → multi-host.

- `startPruningLoop(db: Database, intervalMs: number): { stop: () => void }` — Periodic pruning. Default interval: 1 hour for single-host, after every successful sync cycle for multi-host.

**Testing:**
- system-arch.AC4.4 (change_log pruning): Create events, set up peer cursors showing all peers at seq 5, prune, verify events 1-5 are deleted but 6+ remain.
- Single-host mode: create events, prune, verify all events deleted.
- After pruning, new events still get correct seq numbers (AUTOINCREMENT continues).

Test file: `packages/sync/src/__tests__/pruning.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/sync/`
Expected: All tests pass

**Commit:** `feat(sync): add change log pruning for single and multi-host modes`
<!-- END_TASK_8 -->

<!-- START_TASK_9 -->
### Task 9: Multi-instance integration test harness

**Verifies:** system-arch.AC3.2, system-arch.AC4.2, system-arch.AC4.3, system-arch.AC4.4

**Files:**
- Create: `packages/sync/src/__tests__/multi-instance.integration.test.ts`
- Create: `packages/sync/src/__tests__/test-harness.ts`

**Implementation:**

`packages/sync/src/__tests__/test-harness.ts` — Utility for spawning two configured instances:

```typescript
interface TestInstance {
  db: Database;
  siteId: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  syncClient: SyncClient;
  cleanup: () => void;
}

async function createTestInstance(config: {
  name: string;
  port: number;
  dbPath: string;
  role: "hub" | "spoke";
  hubPort?: number;
}): Promise<TestInstance> {
  // 1. Generate Ed25519 keypair for this instance
  // 2. Create SQLite database with full schema
  // 3. Create Hono app with sync routes
  // 4. Start Bun.serve on the configured port
  // 5. If spoke: create SyncClient pointing at hub
  // 6. Return instance handle with cleanup function
}
```

Per the design plan (§Testing Strategy):
- Instance A ("laptop"): DB at `/tmp/bound-test-a/bound.db`, port 3100, role: hub
- Instance B ("cloud-vm"): DB at `/tmp/bound-test-b/bound.db`, port 3200, role: spoke → hub at localhost:3100

Both instances must share a keyring containing each other's public keys.

`packages/sync/src/__tests__/multi-instance.integration.test.ts` — The 7 critical sync test scenarios from the design plan:

1. **Basic replication:** Insert a row (e.g., semantic_memory) on Instance A. Run sync from Instance B. Verify Instance B has the same row.

2. **Bidirectional sync:** Insert different rows on each instance. Run sync from B to A. Verify both instances have all rows.

3. **LWW conflict resolution:** Insert same key on both instances with different values. Instance A's `modified_at` is 1 second later. Sync. Verify both instances have Instance A's value (later timestamp wins).

4. **Append-only dedup:** Insert a message with the same UUID on both instances (simulating the same message arriving from two paths). Sync. Verify each instance has exactly one copy.

5. **Change log pruning:** Sync successfully. Prune on Instance A (all events confirmed by B). Verify pruned events are gone but new events still work. Verify sync still works after pruning (B doesn't re-request pruned events).

6. **Reconnection catch-up:** Make multiple changes on A while B is "disconnected" (not syncing). Then sync B. Verify B catches up and has all changes. Verify the cursor correctly tracks where B left off.

7. **Hub promotion:** Start with A as hub, B as spoke. Change `cluster_config.cluster_hub` to B. Sync. Verify B now accepts push/pull requests. Verify A can sync to B as the new hub.

Each test:
- Creates fresh instances with temp databases
- Runs the scenario
- Asserts correctness on both databases
- Cleans up (stops servers, deletes temp files)

Use `beforeEach`/`afterEach` for instance lifecycle management.

**Verification:**
Run: `bun test packages/sync/src/__tests__/multi-instance.integration.test.ts`
Expected: All 7 scenarios pass

**Commit:** `test(sync): add multi-instance integration test harness with all 7 sync scenarios`
<!-- END_TASK_9 -->
<!-- END_SUBCOMPONENT_C -->
