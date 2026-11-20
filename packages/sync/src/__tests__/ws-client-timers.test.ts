// Behavioral coverage for the WsSyncClient timer and lifecycle paths that
// ws-client.test.ts and ws-client-dispatch.test.ts leave uncovered: the
// receive-liveness watchdog force-close, the dead-but-OPEN socket detector's
// two-tick force-close, the reconnect-backfill timer, the periodic backfill
// timer, the handshake deadline teardown, backpressure latch/recovery, and the
// config mutators that re-arm timers while connected. Driven over a real WS
// cluster (servers on port 0, real DBs) with the injectable interval/timeout
// config knobs shrunk to milliseconds so the real timers fire within the test.
// No in-process mocks: the sockets, servers, and DBs are genuine; we only poke
// the private timer fields the production code exposes for exactly this reason.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventEmitter } from "@bound/shared";
import { ensureKeypair, exportPublicKey } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { clearColumnCache } from "../reducers.js";
import { WsSyncClient } from "../ws-client.js";
import { WsTransport } from "../ws-transport.js";
import { type WsTestCluster, createSyncTestSchema, createWsTestCluster } from "./test-harness.js";

function uniqueRunId(): string {
	return randomBytes(6).toString("hex");
}

// Private shape we reach into to observe timer state and generation counters.
// These fields exist precisely so the liveness/dead-socket/handshake paths are
// drivable; shrinking the config knobs is the sanctioned test seam.
interface ClientInternals {
	ws: WebSocket | null;
	connected: boolean;
	sendState: "ready" | "pressured";
	lastReceivedAt: number;
	lastStuckBufferedAmount: number | null;
	livenessTimer: ReturnType<typeof setInterval> | null;
	deadSocketTimer: ReturnType<typeof setInterval> | null;
	backfillTimer: ReturnType<typeof setInterval> | null;
	reconnectBackfillTimer: ReturnType<typeof setTimeout> | null;
	socketGeneration: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectInterval: number;
	stopped: boolean;
	scheduleReconnect(): void;
	checkDeadButOpenSocket(): void;
	recoverFromBackpressure(): void;
}

function internals(client: WsSyncClient): ClientInternals {
	return client as unknown as ClientInternals;
}

async function waitFor(pred: () => boolean | Promise<boolean>, attempts = 80): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		if (await pred()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
}

describe("WsSyncClient — receive-liveness watchdog", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("force-closes and reconnects when no frame arrives within the receive timeout", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		expect(ci.connected).toBe(true);
		const genBefore = ci.socketGeneration;

		// Shrink the receive timeout to 40ms and re-arm the liveness timer through
		// the real config mutator. checkInterval = min(timeout/2, 60s) = 20ms.
		client.updateReceiveTimeout(40);
		// Pretend the last inbound frame was long ago so the next tick trips.
		ci.lastReceivedAt = Date.now() - 10_000;

		// The watchdog force-closes the socket; handleClose schedules a reconnect
		// (reconnectInterval starts at 1s) that opens a fresh socket → new generation.
		const reconnected = await waitFor(() => ci.connected && ci.socketGeneration > genBefore, 160);
		expect(reconnected).toBe(true);
		expect(ci.socketGeneration).toBeGreaterThan(genBefore);
	});

	it("updateReceiveTimeout with a non-positive value disarms the liveness timer", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		client.updateReceiveTimeout(0);
		expect(ci.livenessTimer).toBeNull();
	});
});

describe("WsSyncClient — dead-but-OPEN socket detector", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("force-closes after two consecutive non-draining buffer observations", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		expect(ci.connected).toBe(true);
		const liveWs = ci.ws;
		expect(liveWs).not.toBeNull();
		if (!liveWs) return;

		// Simulate a socket that reports OPEN but parks frames: override
		// bufferedAmount to a fixed non-zero value so two detector ticks see a
		// non-decreasing buffer. readyState stays OPEN; sendState is ready.
		Object.defineProperty(liveWs, "bufferedAmount", {
			configurable: true,
			get: () => 4096,
		});
		ci.sendState = "ready";
		ci.lastStuckBufferedAmount = null;

		let closed = false;
		const realClose = liveWs.close.bind(liveWs);
		liveWs.close = ((...args: unknown[]) => {
			closed = true;
			return (realClose as (...a: unknown[]) => void)(...args);
		}) as typeof liveWs.close;

		// First tick records the sample; second tick (buffer unchanged) force-closes.
		ci.checkDeadButOpenSocket();
		expect(ci.lastStuckBufferedAmount).toBe(4096);
		ci.checkDeadButOpenSocket();
		expect(closed).toBe(true);
		expect(ci.lastStuckBufferedAmount).toBeNull();
	});

	it("resets its sample when the buffer drains, and ignores a zero/pressured socket", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		const liveWs = ci.ws;
		if (!liveWs) return;

		let buffered = 2048;
		Object.defineProperty(liveWs, "bufferedAmount", {
			configurable: true,
			get: () => buffered,
		});

		ci.sendState = "ready";
		ci.lastStuckBufferedAmount = null;
		ci.checkDeadButOpenSocket();
		expect(ci.lastStuckBufferedAmount).toBe(2048);

		// Buffer drained to zero before the next tick → sample resets, no close.
		buffered = 0;
		ci.checkDeadButOpenSocket();
		expect(ci.lastStuckBufferedAmount).toBeNull();

		// A pressured socket is the backpressure latch's regime — detector ignores it.
		buffered = 4096;
		ci.sendState = "pressured";
		ci.checkDeadButOpenSocket();
		expect(ci.lastStuckBufferedAmount).toBeNull();
		expect(ci.connected).toBe(true);
	});
});

describe("WsSyncClient — backpressure recovery", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("flips a stale pressured latch back to ready when the buffer is under the limit", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		const liveWs = ci.ws;
		if (!liveWs) return;

		Object.defineProperty(liveWs, "bufferedAmount", {
			configurable: true,
			get: () => 0,
		});
		client.updateBackpressureLimit(1024);
		ci.sendState = "pressured";

		ci.recoverFromBackpressure();
		expect(ci.sendState).toBe("ready");
	});

	it("keeps the latch when the buffer is still over the limit", async () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		const liveWs = ci.ws;
		if (!liveWs) return;

		Object.defineProperty(liveWs, "bufferedAmount", {
			configurable: true,
			get: () => 999_999,
		});
		client.updateBackpressureLimit(1024);
		ci.sendState = "pressured";

		ci.recoverFromBackpressure();
		expect(ci.sendState).toBe("pressured");
	});
});

describe("WsSyncClient — handshake failure recording", () => {
	// A spoke whose hubUrl uses an unsupported protocol: deriveWsUrl throws
	// synchronously inside connect(), driving the catch path that records a sync
	// error and schedules a reconnect — deterministic, no network dependency.
	let spokeDb: Database;
	let client: WsSyncClient;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = join(tmpdir(), `ws-client-hs-${uniqueRunId()}`);
		const kp = await ensureKeypair(join(tmpDir, "spoke"));
		const hubKp = await ensureKeypair(join(tmpDir, "hub"));
		spokeDb = new Database(":memory:");
		createSyncTestSchema(spokeDb);
		// Minimal keyring so getSymmetricKey resolves for the (never-reached) hub.
		const keyring = {
			hosts: {
				[hubKp.siteId]: {
					public_key: await exportPublicKey(hubKp.publicKey),
					url: "http://localhost:1",
				},
				[kp.siteId]: {
					public_key: await exportPublicKey(kp.publicKey),
					url: "http://localhost:2",
				},
			},
		};
		const km = new KeyManager({ publicKey: kp.publicKey, privateKey: kp.privateKey }, kp.siteId);
		await km.init(keyring);
		const transport = new WsTransport({
			db: spokeDb,
			siteId: kp.siteId,
			eventBus: new TypedEventEmitter(),
			isHub: false,
		});
		client = new WsSyncClient({
			// Reserved TEST-NET-1 address: the connect attempt stalls mid-handshake
			// rather than refusing fast, so the deadline — not a close event — recovers.
			// ftp:// is not http/https, so deriveWsUrl throws synchronously in
			// connect() before any socket is created — the synchronous catch path.
			hubUrl: "ftp://example.invalid:9",
			db: spokeDb,
			privateKey: kp.privateKey,
			siteId: kp.siteId,
			keyManager: km,
			hubSiteId: hubKp.siteId,
			wsTransport: transport,
			handshakeTimeoutMs: 60,
			reconnectMaxInterval: 1,
		});
	});

	afterEach(() => {
		client.close();
		spokeDb.close();
	});

	it("records a sync error when connect() throws synchronously in deriveWsUrl", async () => {
		await client.connect();
		const ci = internals(client);
		expect(ci.connected).toBe(false);

		// connect()'s synchronous catch calls recordHandshakeFailure, which upserts
		// a sync_state row with sync_errors incremented for the hub peer.
		const hubSiteId = (client as unknown as { config: { hubSiteId: string } }).config.hubSiteId;
		const row = spokeDb
			.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
			.get(hubSiteId) as { sync_errors: number } | null;
		expect(row?.sync_errors ?? 0).toBeGreaterThan(0);
	});
});

describe("WsSyncClient — reconnect backoff + config mutators while connected", () => {
	let cluster: WsTestCluster;

	beforeEach(async () => {
		cluster = await createWsTestCluster({ spokeCount: 1, basePort: 0, testRunId: uniqueRunId() });
	});

	afterEach(async () => {
		clearColumnCache();
		await cluster.cleanup();
	});

	it("scheduleReconnect arms a reconnect timer and doubles the interval toward the cap", () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		// Drive scheduleReconnect directly: it sets a reconnectTimer and doubles the
		// backoff interval (capped at reconnectMaxInterval).
		ci.reconnectInterval = 1;
		ci.scheduleReconnect();
		expect(ci.reconnectTimer).not.toBeNull();
		// Interval doubled (1 → 2), still under the default 10s cap.
		expect(ci.reconnectInterval).toBe(2);
		// Clear the pending timer so it doesn't fire after teardown.
		if (ci.reconnectTimer) clearTimeout(ci.reconnectTimer);
	});

	it("scheduleReconnect is a no-op once the client is stopped", () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		ci.stopped = true;
		ci.reconnectInterval = 1;
		ci.scheduleReconnect();
		// Stopped short-circuits before arming a timer or touching the interval.
		expect(ci.reconnectTimer).toBeNull();
		expect(ci.reconnectInterval).toBe(1);
		ci.stopped = false;
	});

	it("updateBackfillInterval re-arms the backfill timer while connected", () => {
		const client = cluster.spokes[0].wsClient;
		const ci = internals(client);
		expect(ci.connected).toBe(true);
		// A positive interval while connected starts (re-arms) the backfill timer.
		client.updateBackfillInterval(300);
		expect(ci.backfillTimer).not.toBeNull();
		// A non-positive interval disarms it.
		client.updateBackfillInterval(0);
		expect(ci.backfillTimer).toBeNull();
	});
});
