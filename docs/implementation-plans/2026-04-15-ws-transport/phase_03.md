# WebSocket Sync Transport Implementation Plan — Phase 3

**Goal:** Spokes establish and maintain persistent WS connections to hub with authenticated upgrade, exponential backoff reconnection, and backpressure handling

**Architecture:** Create `ws-client.ts` with a `WsSyncClient` class that manages a single persistent WebSocket connection from spoke to hub. Uses Bun's `new WebSocket(url, { headers })` with Ed25519 signed auth headers. Reconnection uses exponential backoff with jitter (1s-60s cap). Backpressure tracked via `bufferedAmount` on client side. Integrates into spoke startup as a replacement for the HTTP sync path.

**Tech Stack:** TypeScript, Bun WebSocket client API (supports custom headers), existing Ed25519 signing

**Scope:** Phase 3 of 8 from original design

**Codebase verified:** 2026-04-15

---

## Acceptance Criteria Coverage

This phase implements and tests:

### ws-transport.AC2: Persistent WebSocket connections carry all sync traffic
- **ws-transport.AC2.1 Success:** Spoke establishes WSS connection to hub at `/sync/ws` on startup
- **ws-transport.AC2.6 Failure:** Connection to non-existent hub enters reconnection loop without crashing
- **ws-transport.AC2.7 Failure:** Spoke with no `hub_url` configured does not attempt WS connection (it is the hub)

### ws-transport.AC4: NAT spokes fully supported
- **ws-transport.AC4.3 Success:** Bun ping/pong keepalive prevents NAT connection timeout (configurable `idle_timeout`)

### ws-transport.AC6: Cross-cutting behaviors
- **ws-transport.AC6.1 Success:** Spoke reconnects with exponential backoff (1s-60s cap) with jitter on connection drop

---

## Reference Files

The executor should read these files for context:

- `packages/sync/src/signing.ts` — `signRequest()` for creating auth headers on upgrade
- `packages/sync/src/key-manager.ts` — `KeyManager` for symmetric key derivation
- `packages/sync/src/ws-frames.ts` — frame codec from Phase 1
- `packages/sync/src/ws-server.ts` — hub-side WS server from Phase 2 (connection manager, auth)
- `packages/sync/src/sync-loop.ts` — existing `SyncClient` constructor and `startSyncLoop()` for integration reference
- `packages/cli/src/commands/start/sync.ts` — sync initialization, where WS client replaces HTTP sync
- `packages/cli/src/commands/start/server.ts` — spoke startup bootstrap sequence
- `packages/sync/src/__tests__/test-harness.ts` — test infrastructure for multi-instance tests

---

## Important: Client vs Server Backpressure

The design describes backpressure in terms of `ws.send()` returning `-1` (Bun's `ServerWebSocket` behavior). On the **client side**, `WebSocket.send()` returns `void` (standard API). The spoke client tracks backpressure via `ws.bufferedAmount` — when it exceeds the configured limit, the client pauses sending. The hub side (Phase 2) uses the `ServerWebSocket` return values.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: WsSyncClient class — connection establishment and auth

**Verifies:** ws-transport.AC2.1, ws-transport.AC2.7

**Files:**
- Create: `packages/sync/src/ws-client.ts`

**Implementation:**

Create a `WsSyncClient` class:

```typescript
export interface WsClientConfig {
	hubUrl: string;                  // e.g., "https://polaris.karashiiro.moe"
	privateKey: CryptoKey;
	siteId: string;
	keyManager: KeyManager;
	hubSiteId: string;
	logger?: Logger;
	reconnectMaxInterval?: number;   // seconds, default 60
	backpressureLimit?: number;      // bytes, default 2097152
}

export class WsSyncClient {
	private ws: WebSocket | null = null;
	private symmetricKey: Uint8Array | null = null;
	private sendState: "ready" | "pressured" = "ready";
	private reconnectInterval = 1;
	private reconnectTimer: Timer | null = null;
	private stopped = false;

	constructor(private config: WsClientConfig);

	async connect(): Promise<void>;
	send(frame: Uint8Array): boolean;
	close(): void;
	get connected(): boolean;

	// Event handlers — set by transport layer in Phase 4/5
	onMessage: ((data: Uint8Array) => void) | null = null;
	onConnected: (() => void) | null = null;
	onDisconnected: (() => void) | null = null;
}
```

The `connect()` method:
1. Derive the WS URL from `hubUrl`: replace `https://` with `wss://` (or `http://` with `ws://`), append `/sync/ws`. Use the sync port from the hub URL.
2. Sign the upgrade request using `signRequest(privateKey, siteId, "GET", "/sync/ws", "")` to get auth headers. Note: `signRequest()` is async (uses `crypto.subtle.sign`), so signing happens before the WebSocket constructor call.
3. Get symmetric key from `keyManager.getSymmetricKey(hubSiteId)`. Store in `this.symmetricKey`.
4. Create `new WebSocket(wsUrl, { headers: signedHeaders })`. **Note:** Bun's `WebSocket` constructor supports a non-standard `{ headers }` option (via `Bun.WebSocketOptions`), unlike browser WebSocket which does not support custom headers. This was verified against `bun-types@1.3.11` type definitions. If this API is unavailable in a future Bun version, the fallback would be to pass auth via query parameters or subprotocol.
5. Set `binaryType = "nodebuffer"` for binary frame handling.
6. Wire up event handlers: `onopen`, `onmessage`, `onclose`, `onerror`.
7. On `open`: reset reconnect interval to 1, set `sendState = "ready"`, call `this.onConnected?.()`.
8. On `message`: cast `event.data` to `Uint8Array`, call `this.onMessage?.(data)`.
9. On `close`: call `this.onDisconnected?.()`, schedule reconnection if not `stopped`.
10. On `error`: log error (connection errors trigger close, which handles reconnection).

The `send(frame)` method:
1. If `ws` is null or `readyState !== WebSocket.OPEN`, return `false`.
2. Check `ws.bufferedAmount` — if exceeds `backpressureLimit`, set `sendState = "pressured"`, return `false`.
3. Call `ws.send(frame)`.
4. Return `true`.

The `close()` method:
1. Set `stopped = true`.
2. Clear reconnect timer.
3. Close WebSocket if open.

AC2.7: `WsSyncClient` is only created when `hub_url` is configured (the spoke case). The hub (no `hub_url`) never instantiates this class. This is enforced at the integration point (Task 4), not in the client itself.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add WsSyncClient class with authenticated WS connection`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Exponential backoff reconnection with jitter

**Verifies:** ws-transport.AC6.1, ws-transport.AC2.6

**Files:**
- Modify: `packages/sync/src/ws-client.ts` — add reconnection logic

**Implementation:**

Add a private `scheduleReconnect()` method to `WsSyncClient`:

1. If `stopped`, do not reconnect.
2. Calculate delay: `reconnectInterval` seconds (starts at 1).
3. Add jitter: `delay += Math.random() * 0.25 * delay` (0-25% of interval).
4. Set `reconnectTimer = setTimeout(() => this.connect(), delay * 1000)`.
5. Double `reconnectInterval` for next attempt, cap at `config.reconnectMaxInterval` (default 60s).
6. Log: `"Reconnecting to hub in {delay}s (attempt interval: {reconnectInterval}s)"`.

Wire `scheduleReconnect()` into the `onclose` handler from Task 1 — when the connection drops and `stopped` is false, call `scheduleReconnect()`.

On successful `onopen`, reset `reconnectInterval` back to 1.

AC2.6: If the hub doesn't exist, `new WebSocket()` will fail with an error event followed by a close event. The close handler calls `scheduleReconnect()`, which retries indefinitely with backoff. No crash.

**Verification:**
Run: `tsc -p packages/sync --noEmit`
Expected: No type errors

**Commit:** `feat(sync): add exponential backoff reconnection with jitter to WsSyncClient`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: WsSyncClient tests

**Verifies:** ws-transport.AC2.1, ws-transport.AC2.6, ws-transport.AC6.1, ws-transport.AC4.3, ws-transport.AC6.3

**Files:**
- Create: `packages/sync/src/__tests__/ws-client.test.ts`

**Testing:**

These tests require a real Bun server running on a random port. Use the test harness from `packages/sync/src/__tests__/test-harness.ts` for keypair generation and keyring setup. Start a `Bun.serve()` with the Phase 2 WS handlers as the hub.

Test cases:

- **ws-transport.AC2.1 — Successful connection:** Create hub server + spoke client with matching keyring. Call `connect()`. Verify `connected` becomes true, `onConnected` callback fires, hub's `WsConnectionManager` shows the spoke.

- **ws-transport.AC2.6 — Non-existent hub reconnects:** Create client pointing to a port with no server. Call `connect()`. Verify the client enters reconnection loop (onclose fires, reconnect timer is set). Verify no crash.

- **ws-transport.AC6.1 — Exponential backoff with jitter:** Mock `setTimeout` to capture delay values. Trigger multiple reconnection attempts. Verify delays follow exponential pattern (approximately 1s, 2s, 4s, 8s...), each with some jitter, capped at 60s. Verify successful reconnection resets interval to 1.

- **ws-transport.AC4.3 — Keepalive:** Connect, wait for `idleTimeout` seconds. Verify the connection stays alive (Bun auto-sends pings). This may be hard to test with short timeouts — use a short `idleTimeout` (e.g., 2s) and verify the connection survives.

- **ws-transport.AC6.3 — Backpressure detection:** This is harder to test directly since client-side backpressure depends on `bufferedAmount`. At minimum, test that `send()` returns false when not connected, and returns true when connected.

- **Binary frame roundtrip:** Send a binary frame from client, verify hub receives it. Send a binary frame from hub, verify client receives it via `onMessage` callback.

- **Auth rejection:** Create client with mismatched keyring (spoke key not in hub's keyring). Verify connection fails and reconnection loop starts.

Clean up all servers and clients in `afterEach`.

**Verification:**
Run: `bun test packages/sync/src/__tests__/ws-client.test.ts`
Expected: All tests pass

**Commit:** `test(sync): add WsSyncClient connection, reconnection, and auth tests`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Integrate WsSyncClient into spoke startup

**Verifies:** ws-transport.AC2.1, ws-transport.AC2.7

**Files:**
- Modify: `packages/cli/src/commands/start/sync.ts` — create WsSyncClient for spoke mode alongside existing sync
- Modify: `packages/sync/src/index.ts` — export WsSyncClient and WsClientConfig

**Implementation:**

In `packages/cli/src/commands/start/sync.ts`, after the existing `SyncClient` creation:

1. Check if `syncConfig.hub` exists (spoke mode).
2. If spoke: Create `WsSyncClient` with config from `appContext`, `keypair`, `keyManager`, and `hubSiteId`.
3. Call `wsClient.connect()` to establish the persistent connection.
4. Store the client reference so it can be stopped on shutdown.
5. For now, the WS client runs **alongside** the existing HTTP sync loop — Phase 4/5 will wire up the message handlers, and Phase 7 will remove the HTTP path.

In `packages/sync/src/index.ts`, export:
- `WsSyncClient`, `WsClientConfig`

AC2.7: The `WsSyncClient` is only created inside the `if (syncConfig.hub)` block. Nodes without `hub_url` (hubs) never create it.

**Verification:**
Run: `tsc -p packages/sync --noEmit && tsc -p packages/cli --noEmit`
Expected: No type errors

Run: `bun test --recursive`
Expected: All existing tests still pass

**Commit:** `feat(cli): integrate WsSyncClient into spoke startup alongside HTTP sync`
<!-- END_TASK_4 -->
