# WebSocket Sync Transport Implementation Plan — Phase 7

**Goal:** Delete all HTTP sync infrastructure — the entire sync-loop polling mechanism, eager push, reachability tracker, HTTP sync routes, and associated tests

**Architecture:** Surgical removal of HTTP sync code. Delete 5 source files, 1 route file, 20 test files. Remove imports and references across cli, web, and sync packages. Simplify sync config schema by removing `interval_seconds` and `relay.eager_push`. Remove `boundcurl` diagnostic binary. All sync traffic now flows exclusively over WS.

**Tech Stack:** N/A (deletion phase)

**Scope:** Phase 7 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC1: All HTTP-based sync removed
- **ws-transport.AC1.1 Success:** No `/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay` HTTP routes exist
- **ws-transport.AC1.2 Success:** No `/api/relay-deliver` HTTP endpoint exists
- **ws-transport.AC1.3 Success:** `sync-loop.ts`, `eager-push.ts`, `reachability.ts` modules are deleted
- **ws-transport.AC1.5 Success:** Build succeeds with no references to removed modules

---

## Reference Files

The executor should read these files before making changes:

- `packages/sync/src/index.ts` — current exports (remove eager-push, sync-loop, reachability exports)
- `packages/cli/src/commands/start/sync.ts` — sync initialization to gut (SyncClient, startSyncLoop)
- `packages/cli/src/commands/start/server.ts` — eager push config and listener to remove
- `packages/cli/src/commands/start/relay.ts` — ReachabilityTracker usage to remove
- `packages/web/src/server/index.ts` — createSyncApp, SyncAppConfig, EagerPushConfig references
- `packages/web/src/server/start.ts` — createSyncServer references
- `packages/shared/src/config-schemas.ts` — sync config schema to simplify
- `packages/cli/src/boundcurl.ts` — diagnostic tool to evaluate

---

<!-- START_TASK_1 -->
### Task 1: Delete HTTP sync source files

**Verifies:** ws-transport.AC1.3

**Files to delete:**
- Delete: `packages/sync/src/eager-push.ts`
- Delete: `packages/sync/src/sync-loop.ts`
- Delete: `packages/sync/src/reachability.ts`
- Delete: `packages/sync/src/routes.ts`
- Delete: `packages/sync/src/transport.ts`
- Delete: `packages/sync/src/middleware.ts`

**Implementation:**

Delete these six files. They contain:
- `eager-push.ts`: `EagerPushConfig`, `eagerPushToSpoke()` — HTTP direct push delivery
- `sync-loop.ts`: `SyncClient`, `startSyncLoop()`, `resolveHubUrl()` — HTTP polling sync
- `reachability.ts`: `ReachabilityTracker` — HTTP reachability tracking for eager push
- `routes.ts`: `createSyncRoutes()` — HTTP `/sync/push`, `/sync/pull`, `/sync/ack`, `/sync/relay`, `/api/relay-deliver` routes
- `transport.ts`: `SyncTransport` — HTTP encrypt/sign/fetch/decrypt pipeline (no consumers after sync-loop and eager-push are deleted)
- `middleware.ts`: `createSyncAuthMiddleware()` — HTTP Hono middleware for sync route auth (replaced by `authenticateWsUpgrade()` in Phase 2's `ws-server.ts`)

Note: `routes.ts` is fully HTTP-sync-specific. The WS transport handles all routing via frame dispatch in `ws-server.ts` and `ws-transport.ts`. The `middleware.ts` auth logic has been adapted into `authenticateWsUpgrade()` in Phase 2 — the original Hono middleware is no longer needed since there are no HTTP sync routes.

**Verification:**
Run: `ls packages/sync/src/{eager-push,sync-loop,reachability,routes}.ts 2>&1`
Expected: "No such file" for all four

**Commit:** `refactor(sync): delete HTTP sync source files (eager-push, sync-loop, reachability, routes)`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Delete HTTP sync test files

**Verifies:** ws-transport.AC1.3 (associated tests)

**Files to delete (20 test files):**
- Delete: `packages/sync/src/__tests__/eager-push.test.ts`
- Delete: `packages/sync/src/__tests__/eager-push-encrypted.test.ts`
- Delete: `packages/sync/src/__tests__/sync-loop.test.ts`
- Delete: `packages/sync/src/__tests__/routes.test.ts`
- Delete: `packages/sync/src/__tests__/reachability.test.ts`
- Delete: `packages/sync/src/__tests__/sync-e2e.test.ts`
- Delete: `packages/sync/src/__tests__/sync-failure-alert.test.ts`
- Delete: `packages/sync/src/__tests__/encrypted-sync.integration.test.ts`
- Delete: `packages/sync/src/__tests__/hub-spoke-e2e.integration.test.ts`
- Delete: `packages/sync/src/__tests__/relay.integration.test.ts`
- Delete: `packages/sync/src/__tests__/relay-e2e.integration.test.ts`
- Delete: `packages/sync/src/__tests__/relay-stream-delivery.integration.test.ts`
- Delete: `packages/sync/src/__tests__/relay-drain.integration.test.ts`
- Delete: `packages/sync/src/__tests__/event-broadcast.integration.test.ts`
- Delete: `packages/sync/src/__tests__/intake-pipeline.integration.test.ts`
- Delete: `packages/sync/src/__tests__/multi-instance.integration.test.ts`
- Delete: `packages/sync/src/__tests__/sighup-reload.integration.test.ts`
- Delete: `packages/sync/src/__tests__/transport.test.ts`
- Delete: `packages/sync/src/__tests__/encrypted-middleware.test.ts`
- Delete: `packages/sync/src/__tests__/keyring-mismatch.integration.test.ts`

**Tests to KEEP** (non-HTTP-specific):
- `encryption.test.ts`, `key-manager.test.ts`, `signing.test.ts` — crypto tests
- `reducers.test.ts`, `changeset.test.ts`, `peer-cursor.test.ts`, `pruning.test.ts` — core sync logic
- `ws-frames.test.ts`, `ws-server.test.ts`, `ws-client.test.ts`, `ws-transport.test.ts` — new WS tests
- `test-harness.ts` — shared test infrastructure (may need updating)

**Verification:**
Run: `ls packages/sync/src/__tests__/*.ts | wc -l` (should be fewer than before)

**Commit:** `test(sync): delete 20 HTTP sync test files`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Remove HTTP sync imports and references from cli package

**Verifies:** ws-transport.AC1.5

**Files:**
- Modify: `packages/cli/src/commands/start/sync.ts` — remove SyncClient, startSyncLoop imports and usage
- Modify: `packages/cli/src/commands/start/server.ts` — remove eagerPushConfig, ReachabilityTracker, eager push listener
- Modify: `packages/cli/src/commands/start/relay.ts` — remove ReachabilityTracker import and usage

**Implementation:**

1. **`packages/cli/src/commands/start/sync.ts`**: This file currently creates `SyncTransport`, `SyncClient`, and calls `startSyncLoop()`. After removal:
   - Remove `SyncClient` and `startSyncLoop` imports
   - Remove `SyncTransport` creation (it was used by SyncClient for HTTP transport)
   - Keep the WsSyncClient creation (added in Phase 3)
   - The function `initSync()` should now only create the WsSyncClient for spoke mode
   - If `hub_url` is absent (hub mode), the function returns early (hub doesn't connect to itself)

2. **`packages/cli/src/commands/start/server.ts`**:
   - Remove `eagerPushToSpoke` import from `@bound/sync`
   - Remove `ReachabilityTracker` import from `@bound/sync`
   - Remove `eagerPushConfig` object creation (lines ~122-135)
   - Remove the `sync:trigger` listener for eager push (already removed in Phase 6, but verify)
   - Remove `eagerPushConfig` from the `SyncAppConfig` passed to `createSyncServer()`

3. **`packages/cli/src/commands/start/relay.ts`**:
   - Remove `ReachabilityTracker` import
   - Remove `ReachabilityTracker` instantiation and any usage

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `refactor(cli): remove HTTP sync imports and references (SyncClient, eager push, reachability)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Remove HTTP sync from web package and sync package exports

**Verifies:** ws-transport.AC1.1, ws-transport.AC1.2, ws-transport.AC1.5

**Files:**
- Modify: `packages/web/src/server/index.ts` — remove `EagerPushConfig` from `SyncAppConfig`, remove `createSyncRoutes` usage
- Modify: `packages/sync/src/index.ts` — remove deleted module exports

**Implementation:**

1. **`packages/web/src/server/index.ts`**:
   - Remove `EagerPushConfig` from `SyncAppConfig` interface (the `eagerPushConfig?` field)
   - In `createSyncApp()`, remove the call to `createSyncRoutes()` and the route registration
   - The sync Hono app may still need auth middleware for the `/sync/ws` upgrade route, or this can be handled directly in the Bun.serve() fetch handler (Phase 2). Evaluate if `createSyncApp()` is still needed — if only WS upgrade remains, it may be simpler to handle it directly in `createSyncServer()`.

2. **`packages/sync/src/index.ts`**:
   - Remove exports from deleted modules:
     - `SyncClient`, `startSyncLoop`, `resolveHubUrl`, `SyncResult`, `SyncError`, `RelayResult` from sync-loop
     - `createSyncRoutes` from routes
     - `ReachabilityTracker` from reachability
     - `EagerPushConfig`, `eagerPushToSpoke` from eager-push
     - `SyncTransport`, `TransportResponse` from transport
     - `createSyncAuthMiddleware` from middleware

**Verification:**
Run: `tsc -p packages/sync --noEmit && tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `refactor(sync,web): remove HTTP sync route registration and deleted module exports`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Simplify sync config schema

**Verifies:** ws-transport.AC1.5

**Files:**
- Modify: `packages/shared/src/config-schemas.ts` — remove `interval_seconds` and `relay.eager_push`

**Implementation:**

In the sync config schema:
- Remove `sync_interval_seconds` (HTTP polling interval — no longer needed)
- Remove `relay.eager_push` (HTTP eager push flag — no longer needed)
- KEEP: `hub` (URL of hub — still needed for WS connection)
- KEEP: `relay.inference_timeout_ms` (still needed for WS relay timeout)
- KEEP: `relay.max_payload_bytes` (still needed for frame size limits)
- KEEP: `relay.drain_timeout_seconds` (still needed for WS drain)

The `ws` config section (backpressure_limit, idle_timeout, reconnect_max_interval) will be added in Phase 8.

**Verification:**
Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All tests pass (no config references to removed fields in test code)

**Commit:** `refactor(shared): remove interval_seconds and relay.eager_push from sync config schema`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Handle boundcurl binary

**Verifies:** ws-transport.AC1.5

**Files:**
- Evaluate: `packages/cli/src/boundcurl.ts`

**Implementation:**

`boundcurl` is an HTTP sync diagnostic tool that tests encrypted `/sync/*` endpoints. With WS transport, HTTP sync endpoints no longer exist.

Options:
1. **Delete entirely** — if no WS diagnostic tooling is needed now (keep it simple, add later if needed)
2. **Adapt for WS** — connect via WS, send test frames, verify responses

Recommended: **Delete for now.** A WS diagnostic tool can be built later if needed. The test infrastructure in Phase 1-5 already covers WS frame validation.

- Delete: `packages/cli/src/boundcurl.ts`
- Modify build script to stop compiling `boundcurl` binary (check `scripts/build.ts` or `package.json` build config)
- Remove from `dist/boundcurl` compilation target

**Verification:**
Run: `bun run build`
Expected: Build succeeds without boundcurl

**Commit:** `refactor(cli): remove boundcurl HTTP sync diagnostic tool`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Update test harness and verify clean build

**Verifies:** ws-transport.AC1.5

**Files:**
- Modify: `packages/sync/src/__tests__/test-harness.ts` — remove any HTTP-sync-specific helpers (keep what WS tests need)

**Implementation:**

Review `test-harness.ts`:
- Keep: keypair generation, database setup, keyring creation helpers (used by WS tests)
- Remove: any helpers that create HTTP sync servers, SyncClient instances, or sync loop infrastructure
- Remove: `createTestInstance()` if it creates HTTP sync infrastructure (or update it to create WS infrastructure)

After cleanup, run a full build and test suite:

**Verification:**
Run: `bun run build`
Expected: Build succeeds, no references to deleted modules

Run: `grep -r "sync-loop\|eager-push\|reachability\|createSyncRoutes\|relay-deliver" packages/ --include="*.ts" -l`
Expected: No matches in production code (may still appear in comments or documentation)

Run: `bun test --recursive`
Expected: All remaining tests pass

**Commit:** `refactor(sync): clean up test harness and verify build after HTTP sync removal`
<!-- END_TASK_7 -->
