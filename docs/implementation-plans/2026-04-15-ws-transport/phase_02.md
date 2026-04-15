# WebSocket Sync Transport Implementation Plan — Phase 2

**Goal:** Hub accepts authenticated WS connections from spokes on the sync listener

**Architecture:** Create `ws-server.ts` with WS upgrade authentication (adapted from sync auth middleware), connection tracking via `Map<string, ServerWebSocket>`, and per-connection metadata (`ws.data`) containing siteId and symmetric key. Integrate into the sync listener's `Bun.serve()` by adding WebSocket config and upgrade routing at `/sync/ws`.

**Tech Stack:** TypeScript, Bun WebSocket API (`ServerWebSocket<T>`, `server.upgrade()`), existing Ed25519 signing + ECDH key derivation

**Scope:** Phase 2 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic
- **ws-transport.AC2.1 Success:** Spoke establishes WSS connection to hub at `/sync/ws` on startup
- **ws-transport.AC2.6 Failure:** Connection to non-existent hub enters reconnection loop without crashing
- **ws-transport.AC2.7 Failure:** Spoke with no `hub_url` configured does not attempt WS connection (it is the hub)

### ws-transport.AC3: Encryption preserved
- **ws-transport.AC3.3 Success:** WS upgrade request is authenticated via Ed25519 signature (X-Site-Id, X-Timestamp, X-Signature headers)
- **ws-transport.AC3.4 Failure:** Upgrade request with invalid signature is rejected (HTTP 401 before upgrade)
- **ws-transport.AC3.5 Failure:** Upgrade request from unknown siteId (not in keyring) is rejected

### ws-transport.AC6: Cross-cutting behaviors
- **ws-transport.AC6.3 Success:** Backpressure (send returns -1) pauses push-on-write; entries accumulate in DB; drain event resumes sending
- **ws-transport.AC6.4 Success:** Send returning 0 triggers connection close and reconnection

---

## Reference Files

The executor should read these files for context:

- `packages/sync/src/middleware.ts` — `createSyncAuthMiddleware()` auth logic to adapt for WS upgrade (5-step validation pipeline)
- `packages/sync/src/key-manager.ts` — `KeyManager.getSymmetricKey(siteId)` returns `Uint8Array | null`, `getFingerprint(siteId)` returns `string | null`
- `packages/sync/src/signing.ts` — `verifyRequest()` signature, accepts `string | Uint8Array` body
- `packages/web/src/server/index.ts` — `SyncAppConfig` type definition, `createSyncApp()` function
- `packages/web/src/server/start.ts` — `createSyncServer()` with `Bun.serve()` pattern (currently no WS config)
- `packages/sync/src/ws-frames.ts` — frame codec from Phase 1 (encodeFrame/decodeFrame)
- `packages/sync/src/__tests__/test-harness.ts` — test infrastructure for multi-instance sync tests
- `CLAUDE.md` — testing conventions

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: WsConnectionData type and authenticateWsUpgrade function

**Verifies:** ws-transport.AC3.3, ws-transport.AC3.4, ws-transport.AC3.5

**Files:**
- Create: `packages/sync/src/ws-server.ts`

**Implementation:**

Define the per-connection metadata type:

```typescript
export interface WsConnectionData {
	siteId: string;
	symmetricKey: Uint8Array;
	fingerprint: string;
	sendState: "ready" | "pressured";
	pendingDrain: (() => void) | null;
}
```

Implement `authenticateWsUpgrade()`:

```typescript
export function authenticateWsUpgrade(
	request: Request,
	keyring: KeyringConfig,
	keyManager: KeyManager,
	logger?: Logger,
): Result<WsConnectionData, { status: number; body: string }>
```

This function adapts the auth pipeline from `middleware.ts` for the WS upgrade context:

1. Validate Ed25519 signature headers (`X-Site-Id`, `X-Timestamp`, `X-Signature`) using `verifyRequest()` from `signing.ts`. The body for WS upgrade requests is empty string `""` (no request body on upgrade). The method is `"GET"` and path is `"/sync/ws"`.
2. If signature validation fails, return error result with appropriate HTTP status (401 for invalid signature, 403 for unknown site, 408 for stale timestamp).
3. Look up the symmetric key via `keyManager.getSymmetricKey(siteId)`. If null (unknown peer), return error with 403.
4. Look up fingerprint via `keyManager.getFingerprint(siteId)`. If null, return error with 403.
5. Return success result with populated `WsConnectionData` (sendState: `"ready"`, pendingDrain: `null`). Note: `hostName` was removed from `WsConnectionData` — it can be looked up from the hosts table by siteId when needed for logging, rather than being derived from the upgrade request.

Note: Unlike the HTTP middleware, WS upgrade does NOT decrypt a request body — there is none. Encryption headers (`X-Encryption`, `X-Nonce`) are not required on the upgrade request. The symmetric key is derived for use on subsequent frames.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add WsConnectionData type and authenticateWsUpgrade`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: authenticateWsUpgrade tests

**Verifies:** ws-transport.AC3.3, ws-transport.AC3.4, ws-transport.AC3.5

**Files:**
- Create: `packages/sync/src/__tests__/ws-server.test.ts`

**Testing:**

Test cases:

- **ws-transport.AC3.3 — Valid signature accepted:** Generate two Ed25519 keypairs (hub + spoke), build a keyring with both, init KeyManager. Create a Request with valid signature headers (use `signRequest()` from `signing.ts` with the spoke's private key, method `"GET"`, path `"/sync/ws"`, body `""`). Call `authenticateWsUpgrade()`. Verify result is `{ ok: true }` with correct siteId, symmetricKey (Uint8Array), and fingerprint (16-char hex).

- **ws-transport.AC3.4 — Invalid signature rejected:** Same setup, but tamper with the X-Signature header. Verify result is `{ ok: false }` with status 401.

- **ws-transport.AC3.5 — Unknown siteId rejected:** Sign the request with a keypair NOT in the keyring. Verify result is `{ ok: false }` with status 403.

- **Stale timestamp rejected:** Sign with a timestamp more than 5 minutes old. Verify rejection.

- **Missing headers rejected:** Request with no X-Site-Id header. Verify rejection.

Follow test patterns from `packages/sync/src/__tests__/encryption.test.ts` and `packages/sync/src/__tests__/key-manager.test.ts` for keypair generation and keyring setup.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-server.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add authenticateWsUpgrade tests for auth accept/reject scenarios`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->

<!-- START_TASK_3 -->
### Task 3: WsConnectionManager class

**Verifies:** None (infrastructure for connection tracking, tested via integration in Task 5)

**Files:**
- Modify: `packages/sync/src/ws-server.ts` — add WsConnectionManager class

**Implementation:**

Add a `WsConnectionManager` class that tracks active WS connections by siteId:

```typescript
export class WsConnectionManager {
	private connections = new Map<string, ServerWebSocket<WsConnectionData>>();

	add(siteId: string, ws: ServerWebSocket<WsConnectionData>): void;
	remove(siteId: string): void;
	get(siteId: string): ServerWebSocket<WsConnectionData> | undefined;
	getAll(): Map<string, ServerWebSocket<WsConnectionData>>;
	has(siteId: string): boolean;
	get size(): number;
}
```

- `add()`: Stores the connection. If a connection for this siteId already exists, close the old one (code 1008 "Policy violation" — duplicate connection) before storing the new one.
- `remove()`: Deletes the connection from the map.
- `get()`: Returns the connection or undefined.
- `getAll()`: Returns the full map (for broadcast iteration).
- `has()`: Returns whether a connection exists for this siteId. This replaces `ReachabilityTracker` — a spoke is reachable iff its WS connection is in this map.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add WsConnectionManager for tracking active spoke connections`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: createWsHandlers factory function

**Verifies:** None (infrastructure for Bun WS lifecycle, tested via integration in Task 5)

**Files:**
- Modify: `packages/sync/src/ws-server.ts` — add createWsHandlers function

**Implementation:**

Create a factory function that returns the Bun WebSocket handler config:

```typescript
export interface WsServerConfig {
	connectionManager: WsConnectionManager;
	logger?: Logger;
	idleTimeout?: number;          // seconds, default 120
	backpressureLimit?: number;    // bytes, default 2097152 (2MB)
}

export function createWsHandlers(config: WsServerConfig): {
	websocket: WebSocketHandler<WsConnectionData>;
	handleUpgrade: (req: Request, server: Server) => Response | undefined;
}
```

The returned object has:

**`handleUpgrade(req, server)`**: Called from the sync server's `fetch` handler when the path is `/sync/ws` and the request has `upgrade: websocket` header.
1. Call `authenticateWsUpgrade()` to validate the spoke's identity
2. If auth fails, return `new Response(errorBody, { status })` 
3. If auth succeeds, call `server.upgrade(req, { data: wsConnectionData })` 
4. If upgrade fails, return `new Response("WebSocket upgrade failed", { status: 500 })`
5. On success, return `undefined` (Bun convention)

**`websocket` handlers**:
- `open(ws)`: Log connection, call `connectionManager.add(ws.data.siteId, ws)`
- `message(ws, message)`: Validate binary frame (not string — reject text frames with close code 1003). For now, just log receipt — frame dispatch to actual handlers comes in Phase 4/5. Cast `message` to `Uint8Array` (Bun sends `Buffer` which is a `Uint8Array` subclass).
- `close(ws, code, reason)`: Log disconnection, call `connectionManager.remove(ws.data.siteId)`
- `drain(ws)`: Set `ws.data.sendState = "ready"`. If `ws.data.pendingDrain` is set, call it and clear it. (Backpressure resume logic.)
- `idleTimeout`: From config, default 120
- `backpressureLimit`: From config, default 2097152

**Server-side send wrapper (ws-transport.AC6.3, ws-transport.AC6.4):** The `sendFrame` function passed to `WsTransport.addPeer()` (Phase 4) wraps `ws.send(frame)` and checks the return value:
- `>= 1`: Success, continue sending.
- `-1` (backpressure): Set `ws.data.sendState = "pressured"`. Stop sending from DB; entries accumulate in tables. Resume on `drain` event (AC6.3).
- `0` (dropped/failed): Close the socket via `ws.close(1011, "Send failed")` and trigger reconnection (AC6.4). This is treated as a connection error.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add createWsHandlers factory for Bun WS lifecycle`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: WsConnectionManager and WS lifecycle tests

**Verifies:** ws-transport.AC3.3, ws-transport.AC3.4, ws-transport.AC3.5

**Files:**
- Modify: `packages/sync/src/__tests__/ws-server.test.ts` — add connection manager and integration tests

**Testing:**

Test cases for WsConnectionManager:
- **Add and retrieve connection:** Add a mock connection, verify `get()` returns it, `has()` returns true, `size` is 1.
- **Remove connection:** Add then remove, verify `has()` returns false, `size` is 0.
- **Duplicate siteId replaces old connection:** Add two connections with same siteId. Verify the first one's `close()` was called (code 1008), and `get()` returns the second.
- **getAll returns all connections:** Add multiple connections, verify map size and contents.
- **ws-transport.AC6.4 — Send returning 0 triggers close:** In the server-side `sendFrame` wrapper, simulate `ws.send()` returning 0. Verify the connection is closed (code 1011) and removed from the connection manager.

Integration test (requires a real Bun server):
- **Full lifecycle test:** Start a `Bun.serve()` with the WS handlers. Use the test harness to create hub + spoke keypairs and keyring. Connect a WebSocket client with valid auth headers. Verify connection is accepted and appears in `connectionManager`. Send a binary frame, verify `message` handler receives it. Close connection, verify `connectionManager.remove` was called.
- **Invalid auth rejected before upgrade:** Connect with invalid signature headers. Verify HTTP 401 response (not a WS upgrade).
- **Unknown site rejected:** Connect with a keypair not in keyring. Verify HTTP 403.

For the integration test, use `Bun.serve()` on a random port. For the WebSocket client, use the `WebSocket` constructor (Bun's built-in client) with custom headers. Note: Standard `WebSocket` API does not support custom headers. For testing, you may need to use `fetch()` with upgrade headers to verify the 401/403 rejection, and for the success case, verify the connection manager state after the open callback fires.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-server.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add WsConnectionManager and WS lifecycle integration tests`
<!-- END_TASK_5 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_TASK_6 -->
### Task 6: Integrate WS handlers into sync server

**Verifies:** ws-transport.AC2.1 (partial — hub side of connection establishment)

**Files:**
- Modify: `packages/web/src/server/index.ts` — add WS fields to `SyncAppConfig`
- Modify: `packages/web/src/server/start.ts` — add websocket config and upgrade routing to sync server's `Bun.serve()`
- Modify: `packages/sync/src/index.ts` — export ws-server types and functions

**Implementation:**

1. In `packages/web/src/server/index.ts`, extend `SyncAppConfig`:
   ```typescript
   export interface SyncAppConfig {
     // ... existing fields ...
     wsConfig?: {
       idleTimeout?: number;
       backpressureLimit?: number;
     };
   }
   ```

2. In `packages/web/src/server/start.ts`, modify `createSyncServer()`:
   - Import `WsConnectionManager`, `createWsHandlers` from `@bound/sync`
   - Create a `WsConnectionManager` instance
   - Create WS handlers via `createWsHandlers({ connectionManager, logger, ...wsConfig })`
   - Add WS upgrade routing in the `Bun.serve()` fetch handler: check if path is `/sync/ws` and `request.headers.get("upgrade") === "websocket"`, then call `handleUpgrade(request, server)`
   - Pass the `websocket` handler config to `Bun.serve()`
   - Expose the `WsConnectionManager` on the returned `WebServer` interface (or via a getter) so Phase 4/5 can use it for sending frames

3. In `packages/sync/src/index.ts`, add exports:
   - `WsConnectionData`, `WsConnectionManager`, `WsServerConfig`, `createWsHandlers`, `authenticateWsUpgrade`

**Verification:**
Run: `tsc -p packages/sync --noEmit && tsc -p packages/web --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All existing tests still pass (no regressions)

**Commit:** `feat(web): integrate WS handlers into sync server at /sync/ws`
<!-- END_TASK_6 -->
