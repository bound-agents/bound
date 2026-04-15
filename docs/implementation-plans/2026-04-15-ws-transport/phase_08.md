# WebSocket Sync Transport Implementation Plan — Phase 8

**Goal:** Clean configuration schema, SIGHUP hot-reload support for WS settings, updated documentation, and verified `boundctl set-hub` drain over WS

**Architecture:** Add a `ws` section to the sync config schema with optional fields for `backpressure_limit`, `idle_timeout`, and `reconnect_max_interval`. Wire SIGHUP reload to update WS client/server config at runtime. Update CLAUDE.md to reflect the new WS-based sync architecture. Verify `boundctl set-hub` drain works over WS connections.

**Tech Stack:** TypeScript, Zod config validation, existing SIGHUP handler

**Scope:** Phase 8 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase addresses polish and operational readiness. No new functional ACs — all functional ACs were covered in Phases 1-7.

**Verifies:** None (infrastructure/configuration/documentation phase)

---

## Reference Files

The executor should read these files for context:

- `packages/shared/src/config-schemas.ts` lines 136-159 — current `relaySchema` and `syncSchema` definitions
- `packages/cli/src/sighup.ts` — `registerSighupHandler()` at line 135, `reloadConfigs()` at line 28
- `packages/cli/src/commands/start/index.ts` lines 52-76 — SIGHUP registration call site
- `packages/cli/src/commands/set-hub.ts` — drain logic at lines 75-104
- `CLAUDE.md` — sync-related sections: Sync Encryption (lines ~115-129), Relay Transport (lines ~131-148), Sync Protocol (lines ~160-168), Web Server (lines ~170-184)

---

<!-- START_TASK_1 -->
### Task 1: Add `ws` config section to sync schema

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/shared/src/config-schemas.ts` — add `wsSchema` and extend `syncSchema`

**Implementation:**

Add a new Zod schema for WS configuration alongside the existing `relaySchema`:

```typescript
export const wsSchema = z.object({
	backpressure_limit: z.number().int().positive().default(2097152),  // 2MB default
	idle_timeout: z.number().int().positive().default(120),            // 120s default
	reconnect_max_interval: z.number().int().positive().default(60),   // 60s default
});

export type WsConfig = z.infer<typeof wsSchema>;
```

Extend `syncSchema` (after Phase 7's removal of `interval_seconds` and `eager_push`):

```typescript
export const syncSchema = z.object({
	hub: z.string().min(1),
	relay: relaySchema.optional(),
	ws: wsSchema.optional(),        // NEW: WebSocket transport config
});
```

All `ws` fields are optional with sensible defaults. When `ws` is omitted entirely, the WS transport uses the defaults coded in Phase 2 (server) and Phase 3 (client).

**Verification:**
Run: `tsc -p packages/shared --noEmit`
Expected: No type errors

**Commit:** `feat(shared): add ws config section to sync schema with backpressure, idle_timeout, reconnect defaults`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire WS config into client and server

**Verifies:** None (infrastructure wiring)

**Files:**
- Modify: `packages/cli/src/commands/start/sync.ts` — read ws config and pass to WsSyncClient
- Modify: `packages/web/src/server/start.ts` — read ws config and pass to WS server handlers

**Implementation:**

1. In `packages/cli/src/commands/start/sync.ts`, when creating `WsSyncClient`:
   - Read `syncConfig.ws` (if present)
   - Pass `reconnectMaxInterval` from `ws.reconnect_max_interval`
   - Pass `backpressureLimit` from `ws.backpressure_limit`

2. In `packages/web/src/server/start.ts`, when creating WS server via `createWsHandlers()`:
   - Read `wsConfig` from the sync config
   - Pass `idleTimeout` from `ws.idle_timeout`
   - Pass `backpressureLimit` from `ws.backpressure_limit`

Both should fall back to defaults when `ws` section is absent (which is handled by the Zod defaults already).

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(cli): wire ws config into WsSyncClient and WS server handlers`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: SIGHUP hot-reload for WS config

**Verifies:** None (operational readiness)

**Files:**
- Modify: `packages/cli/src/sighup.ts` — add WS config reload callback

**Implementation:**

In `reloadConfigs()` in `packages/cli/src/sighup.ts`:

After reloading optional configs, check if `sync.ws` changed:

1. Compare new `ws` config against previous (simple JSON stringify comparison is sufficient).
2. If changed, invoke a new `onWsConfigChanged` callback parameter (similar to existing `onMcpConfigChanged` pattern).
3. The callback updates the WsSyncClient's reconnect interval and backpressure limit. For `idle_timeout`, the server-side WS handler would need to be restarted (or the timeout is applied per new connections). Document this limitation: `idle_timeout` changes take effect on next connection, not active connections.

In `packages/cli/src/commands/start/index.ts`, when registering SIGHUP:
- Pass an `onWsConfigChanged` callback that updates the WsSyncClient and WS server config.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `feat(cli): add SIGHUP hot-reload support for ws config section`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Verify boundctl set-hub drain works over WS

**Verifies:** None (operational verification)

**Files:**
- Modify: `packages/cli/src/commands/set-hub.ts` — verify drain logic works with WS transport

**Implementation:**

Review `set-hub.ts` drain logic (lines 75-104). The drain mechanism:
1. Sets `relay_draining` flag in `host_meta`
2. Polls `relay_outbox` for pending entries with `delivered = 0`
3. Waits until all entries are delivered or timeout

With WS transport, outbox entries are delivered immediately via push-on-write (Phase 5). The drain loop should already work — it polls `relay_outbox.delivered` which the WS transport sets to `1` when acknowledged.

Verify:
- The drain polls `relay_outbox` — no change needed (it's checking the DB, not the transport)
- The WS transport's relay ack handler marks entries as `delivered` via `markDelivered()`
- The `drain_timeout_seconds` config field was preserved in Phase 7

If the drain logic directly called HTTP sync functions (e.g., `SyncClient.relay()`), it would need updating. But since it polls the DB, it should work as-is.

Write a brief integration test or manual verification note.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: No type errors

**Commit:** `chore(cli): verify boundctl set-hub drain works with WS transport`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update CLAUDE.md

**Verifies:** None (documentation)

**Files:**
- Modify: `CLAUDE.md` — update Sync Protocol, Relay Transport, Web Server, and Sync Encryption sections

**Implementation:**

Update the following sections in `CLAUDE.md`:

1. **Sync Protocol section** (~lines 160-168):
   - Replace "Four-phase: push -> pull -> ack -> relay" with WS transport description
   - Describe WS frame protocol: binary frames with `[type byte][24-byte nonce][ciphertext]`
   - List the 8 message types (changelog_push/ack, relay_send/deliver/ack, drain_request/complete, error)
   - Describe push-on-write with microtask coalescing
   - Describe reconnection with exponential backoff (1s-60s cap, jitter)
   - HLC cursors still tracked in `sync_state`

2. **Relay Transport section** (~lines 131-148):
   - Replace HTTP relay phase description with WS relay routing
   - Remove references to eager push (deleted)
   - Remove references to relay-aware fast sync interval (deleted)
   - Update: relay messages flow as encrypted WS frames, not HTTP sync phases
   - Keep: relay kinds, payload limit, idempotency, metrics, drain

3. **Web Server section** (~lines 170-184):
   - Update sync listener description: now serves `/sync/ws` WS upgrade endpoint instead of HTTP routes
   - Remove `/api/relay-deliver` endpoint reference
   - Add: WS upgrade authentication at `/sync/ws` (Ed25519 signed headers)
   - Keep: web listener description unchanged

4. **Sync Encryption section** (~lines 115-129):
   - Update to describe WS frame encryption (same crypto, different framing)
   - Remove references to SyncTransport HTTP pipeline
   - Add: per-connection symmetric key stored in `ws.data`, frame-level encryption
   - Keep: ECDH key agreement, KeyManager, SIGHUP hot-reload

5. **Add WS Config** to the Configuration section:
   - Document the new `ws` section in sync config: `backpressure_limit`, `idle_timeout`, `reconnect_max_interval`
   - Document that all fields are optional with defaults

6. **Remove references to deleted infrastructure:**
   - Remove mentions of `sync-loop.ts`, `eager-push.ts`, `reachability.ts`
   - Remove mentions of `sync:trigger` event
   - Remove mentions of `boundcurl` binary (if referenced)
   - Update the binaries list: `dist/bound`, `dist/boundctl`, `dist/bound-mcp` (remove `dist/boundcurl`)

**Verification:**
Read updated CLAUDE.md, verify no references to deleted HTTP sync infrastructure remain.

**Commit:** `docs: update CLAUDE.md for WS sync transport architecture`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Final build and test verification

**Verifies:** None (final verification)

**Files:** None (verification only)

**Implementation:**

Run the complete verification suite:

1. Typecheck all packages:
   ```bash
   bun run typecheck
   ```

2. Lint:
   ```bash
   bun run lint
   ```

3. Run all tests:
   ```bash
   bun test --recursive
   ```

4. Build:
   ```bash
   bun run build
   ```

5. Grep for any remaining references to deleted infrastructure:
   ```bash
   grep -r "sync-loop\|eager-push\|reachability\|sync:trigger\|relay-deliver\|boundcurl" packages/ --include="*.ts" -l
   ```

All must pass with zero errors.

**Verification:**
Expected: All typecheck, lint, test, build pass. No references to deleted modules.

**Commit:** None (verification only, no changes)
<!-- END_TASK_6 -->
