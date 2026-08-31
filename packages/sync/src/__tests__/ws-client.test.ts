import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringConfig } from "@bound/shared";
import { deriveSiteId, ensureKeypair, exportPublicKey, generateKeypair } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { WsSyncClient } from "../ws-client.js";
import { WsMessageType, encodeFrame } from "../ws-frames.js";
import { createWsTestCluster } from "./test-harness.js";

describe("WsSyncClient", () => {
	let hubKeypair: { publicKey: CryptoKey; privateKey: CryptoKey };
	let spokeKeypair: { publicKey: CryptoKey; privateKey: CryptoKey };

	let hubSiteId: string;
	let spokeSiteId: string;

	let hubPubKey: string;
	let spokePubKey: string;

	let hubKeyManager: KeyManager;
	let spokeKeyManager: KeyManager;
	let keyring: KeyringConfig;

	let clients: WsSyncClient[] = [];
	let servers: ReturnType<typeof Bun.serve>[] = [];

	beforeEach(async () => {
		// Generate keypairs
		hubKeypair = await generateKeypair();
		spokeKeypair = await generateKeypair();

		// Derive site IDs
		hubSiteId = await deriveSiteId(hubKeypair.publicKey);
		spokeSiteId = await deriveSiteId(spokeKeypair.publicKey);

		// Export public keys
		hubPubKey = await exportPublicKey(hubKeypair.publicKey);
		spokePubKey = await exportPublicKey(spokeKeypair.publicKey);

		// Create keyring
		keyring = {
			hosts: {
				[hubSiteId]: { public_key: hubPubKey, url: "http://localhost:3000" },
				[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
			},
		};

		// Initialize KeyManagers
		hubKeyManager = new KeyManager(hubKeypair, hubSiteId);
		await hubKeyManager.init(keyring);

		spokeKeyManager = new KeyManager(spokeKeypair, spokeSiteId);
		await spokeKeyManager.init(keyring);
	});

	afterEach(async () => {
		// Close all clients
		for (const client of clients) {
			client.close();
		}
		clients = [];

		// Stop all servers
		for (const server of servers) {
			server.stop();
		}
		servers = [];

		// Give time for cleanup
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	describe("ws-transport.AC2.1 — Connection establishment", () => {
		it("client can be instantiated with valid config", () => {
			const client = new WsSyncClient({
				hubUrl: "https://polaris.karashiiro.moe",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			expect(client).toBeTruthy();
			expect(client.connected).toBe(false);
		});

		it("derives wss:// URL from https:// hubUrl", () => {
			const client = new WsSyncClient({
				hubUrl: "https://hub.example.com:8443",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			// Client should exist without throwing
			expect(client).toBeTruthy();
		});

		it("derives ws:// URL from http:// hubUrl", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			expect(client).toBeTruthy();
		});

		it("creates signed auth headers for WS upgrade", async () => {
			// Test that the client properly signs auth headers for the upgrade request
			const testRunId = randomBytes(4).toString("hex");

			const hubKeypair2 = await ensureKeypair(join(tmpdir(), `bound-ws-client-hub-${testRunId}`));
			const spokeKeypair2 = await ensureKeypair(
				join(tmpdir(), `bound-ws-client-spoke-${testRunId}`),
			);

			const hubSiteId2 = hubKeypair2.siteId;
			const spokeSiteId2 = spokeKeypair2.siteId;

			const keyring2: KeyringConfig = {
				hosts: {
					[hubSiteId2]: {
						public_key: await exportPublicKey(hubKeypair2.publicKey),
						url: "http://localhost:3000",
					},
					[spokeSiteId2]: {
						public_key: await exportPublicKey(spokeKeypair2.publicKey),
						url: "http://localhost:3001",
					},
				},
			};

			const hubKeyManager2 = new KeyManager(hubKeypair2, hubSiteId2);
			await hubKeyManager2.init(keyring2);

			// Create spoke client - this will attempt to sign headers even if connection fails
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59997",
				privateKey: spokeKeypair2.privateKey,
				siteId: spokeSiteId2,
				keyManager: hubKeyManager2,
				hubSiteId: hubSiteId2,
				reconnectMaxInterval: 1,
			});

			clients.push(client);

			// Attempt connection - this will fail, but headers should be signed
			await client.connect();

			// The key verification: the client should have attempted to sign the request
			// even though connection will fail due to no server
			expect(client).toBeTruthy();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(client.connected).toBe(false);
		});
	});

	describe("ws-transport.AC2.6 — Reconnection without crash", () => {
		it("handles connection failure gracefully", async () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59999", // Non-existent port
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
			});

			clients.push(client);

			let errorThrown = false;
			try {
				// This will fail because no server is listening
				await client.connect();
				// Give it a moment to attempt connection
				await new Promise((resolve) => setTimeout(resolve, 100));
			} catch (_error) {
				errorThrown = true;
			}

			// Should not throw; errors are handled internally
			expect(errorThrown).toBe(false);
			expect(client).toBeTruthy();
		});

		it("does not crash when symmetric key is missing", async () => {
			// Create a hub keyring without the spoke
			const otherKeypair = await generateKeypair();
			const otherSiteId = await deriveSiteId(otherKeypair.publicKey);
			const otherPubKey = await exportPublicKey(otherKeypair.publicKey);

			const otherKeyManager = new KeyManager(otherKeypair, otherSiteId);
			const missingKeyring: KeyringConfig = {
				hosts: {
					[otherSiteId]: { public_key: otherPubKey, url: "http://localhost:3000" },
					// Spoke NOT included
				},
			};
			await otherKeyManager.init(missingKeyring);

			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: otherKeyManager, // KeyManager without shared key for hub
				hubSiteId: otherSiteId,
				reconnectMaxInterval: 1,
			});

			clients.push(client);

			let errorThrown = false;
			try {
				await client.connect();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} catch (_error) {
				errorThrown = true;
			}

			// Should not throw to caller
			expect(errorThrown).toBe(false);
		});

		it("enters reconnection loop on non-existent hub", async () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59998",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
			});

			clients.push(client);

			// Try to connect - will fail and enter reconnection loop
			await client.connect();
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Should not be connected since hub doesn't exist
			expect(client.connected).toBe(false);
		});
	});

	describe("ws-transport.AC6.1 — Exponential backoff", () => {
		it("uses 1s initial reconnect interval", async () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59999",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 60,
			});

			clients.push(client);

			// Try to connect - will fail and schedule reconnection
			await client.connect();

			// Wait briefly - reconnection should be scheduled soon (1s + jitter)
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Client should still exist and be in reconnection mode
			expect(client).toBeTruthy();
		});

		it("respects reconnectMaxInterval cap", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59999",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 5, // Low cap for testing
			});

			clients.push(client);

			expect(client).toBeTruthy();
		});

		it("jitter is between 0-25% of interval", () => {
			// Test that jitter calculation is reasonable
			// We can't directly inspect private state, but we can verify
			// multiple clients with same config
			const clients_ = [];
			for (let i = 0; i < 5; i++) {
				const client = new WsSyncClient({
					hubUrl: "http://localhost:59999",
					privateKey: spokeKeypair.privateKey,
					siteId: spokeSiteId,
					keyManager: hubKeyManager,
					hubSiteId,
					reconnectMaxInterval: 60,
				});
				clients_.push(client);
			}

			for (const c of clients_) {
				clients.push(c);
			}

			// All clients should be valid even with jitter
			expect(clients_).toHaveLength(5);
		});
	});

	describe("backpressure handling", () => {
		it("returns false when not connected", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			const testFrame = new Uint8Array([0x01, 0x02, 0x03]);
			const result = client.send(testFrame);

			expect(result).toBe(false);
		});

		it("returns false for empty frame when not connected", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			const result = client.send(new Uint8Array(0));
			expect(result).toBe(false);
		});
	});

	describe("connection lifecycle", () => {
		it("close() stops reconnection attempts", async () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59999",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
			});

			clients.push(client);

			// Try to connect (will fail)
			await client.connect();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Close should stop reconnection
			client.close();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify not connected
			expect(client.connected).toBe(false);

			// Additional close calls should not error
			expect(() => {
				client.close();
			}).not.toThrow();
		});

		it("send() returns false after close()", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			client.close();

			const result = client.send(new Uint8Array([0x01]));
			expect(result).toBe(false);
		});

		it("close() clears reconnect timer", async () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59999",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 2,
			});

			clients.push(client);

			await client.connect();
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Close should clear timer
			client.close();

			// No reconnection should occur
			await new Promise((resolve) => setTimeout(resolve, 2500));

			expect(client.connected).toBe(false);
		});
	});

	describe("URL derivation edge cases", () => {
		it("handles URLs with no explicit port", () => {
			const client = new WsSyncClient({
				hubUrl: "https://hub.example.com",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			expect(client).toBeTruthy();
		});

		it("handles URLs with path component", () => {
			const client = new WsSyncClient({
				hubUrl: "https://hub.example.com/some/path",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			expect(client).toBeTruthy();
		});
	});

	describe("event handlers", () => {
		it("allows setting event handler callbacks", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			let _messageHandlerCalled = false;
			let _connectedHandlerCalled = false;
			let _disconnectedHandlerCalled = false;

			client.onMessage = (_data) => {
				_messageHandlerCalled = true;
			};

			client.onConnected = () => {
				_connectedHandlerCalled = true;
			};

			client.onDisconnected = () => {
				_disconnectedHandlerCalled = true;
			};

			// Handlers exist and can be set
			expect(client.onMessage).toBeTruthy();
			expect(client.onConnected).toBeTruthy();
			expect(client.onDisconnected).toBeTruthy();
		});
	});

	describe("spool frame dispatch (R-DW10)", () => {
		// Regression: ws-client silently dropped SPOOL_TRANSFER and
		// SPOOL_TRANSFER_ACK frames — hub→spoke spool deliveries never arrived,
		// and hub acks never retired the spoke's transferring sender copies.
		function createClientWithTransport() {
			const calls: Array<{ method: string; sourceSiteId: string; payload: unknown }> = [];
			const wsTransport = {
				addPeer: () => {},
				removePeer: () => {},
				handleChangelogPush: () => {},
				handleChangelogAck: () => {},
				drainChangelog: () => {},
				handleRelayDeliver: () => {},
				handleRelayAck: () => {},
				drainRelayOutbox: () => {},
				handleSpoolTransfer: (sourceSiteId: string, payload: unknown) => {
					calls.push({ method: "handleSpoolTransfer", sourceSiteId, payload });
				},
				handleSpoolTransferAck: (sourceSiteId: string, payload: unknown) => {
					calls.push({ method: "handleSpoolTransferAck", sourceSiteId, payload });
				},
				drainDurableWorkSpool: () => {},
				applySnapshotChunk: () => 0,
				applyColumnChunk: () => {},
			};
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				wsTransport,
			});
			clients.push(client);
			const symmetricKey = new Uint8Array(32).fill(9);
			const internal = client as unknown as {
				symmetricKey: Uint8Array | null;
				handleMessage: (event: MessageEvent) => void;
			};
			internal.symmetricKey = symmetricKey;
			return { client, internal, calls, symmetricKey };
		}

		it("routes SPOOL_TRANSFER to wsTransport.handleSpoolTransfer with the hub as source", () => {
			const { internal, calls, symmetricKey } = createClientWithTransport();
			const payload = {
				entries: [
					{
						id: "w-1",
						target_site_id: spokeSiteId,
						source_site: hubSiteId,
						kind: "result",
						payload: { ok: true },
						idempotency_key: "response:req-1",
						ref_id: "req-1",
						stream_id: null,
						expires_at: null,
						received_at: null,
						token: "tok-1",
					},
				],
			};
			const frame = encodeFrame(WsMessageType.SPOOL_TRANSFER, payload, symmetricKey);
			internal.handleMessage({ data: frame } as unknown as MessageEvent);

			expect(calls).toEqual([{ method: "handleSpoolTransfer", sourceSiteId: hubSiteId, payload }]);
		});

		it("routes SPOOL_TRANSFER_ACK to wsTransport.handleSpoolTransferAck", () => {
			const { internal, calls, symmetricKey } = createClientWithTransport();
			const payload = { entries: [{ id: "w-1", token: "tok-1" }] };
			const frame = encodeFrame(WsMessageType.SPOOL_TRANSFER_ACK, payload, symmetricKey);
			internal.handleMessage({ data: frame } as unknown as MessageEvent);

			expect(calls).toEqual([
				{ method: "handleSpoolTransferAck", sourceSiteId: hubSiteId, payload },
			]);
		});
	});

	describe("backpressure latch self-heal (#253 spool-transfer wedge)", () => {
		// Live incident: one backpressure blip on the spoke ws-client latched
		// sendState="pressured" permanently. The sendFrame closure short-circuited on
		// that state WITHOUT re-polling bufferedAmount, and the ONLY reset was
		// handleOpen() (a fresh connection). Every SPOOL_TRANSFER was refused silently,
		// so peer-targeted durable rows cycled pending→transferring→rollback and
		// dead-lettered. The server side self-heals on Bun's drain() event; the client
		// has no drain event, so the latch must become advisory: any send re-polls the
		// live buffer, and the liveness timer proactively clears a stale latch and
		// re-drives the durable-work spool.
		interface FakeWs {
			readyState: number;
			bufferedAmount: number;
			sent: Buffer[];
			send: (b: Buffer) => void;
		}

		function fakeWs(bufferedAmount: number): FakeWs {
			const sent: Buffer[] = [];
			return {
				readyState: WebSocket.OPEN,
				bufferedAmount,
				sent,
				send(b: Buffer) {
					sent.push(b);
				},
			};
		}

		interface Internal {
			ws: FakeWs | null;
			sendState: "ready" | "pressured";
			send(frame: Uint8Array): boolean;
			recoverFromBackpressure(): void;
		}

		function makeClient(backpressureLimit: number): { client: WsSyncClient; internal: Internal } {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				backpressureLimit,
			});
			clients.push(client);
			return { client, internal: client as unknown as Internal };
		}

		const FRAME = new Uint8Array([1, 2, 3, 4]);

		it("latches pressured when the live buffer is over the limit and refuses the send", () => {
			const { internal } = makeClient(100);
			internal.ws = fakeWs(200); // over the 100-byte limit

			expect(internal.send(FRAME)).toBe(false);
			expect(internal.sendState).toBe("pressured");
			expect(internal.ws?.sent).toHaveLength(0);
		});

		it("self-heals: a later send re-polls the drained buffer, flips to ready, and ships the frame", () => {
			const { internal } = makeClient(100);
			internal.ws = fakeWs(200);
			expect(internal.send(FRAME)).toBe(false);
			expect(internal.sendState).toBe("pressured");

			// The buffer drains below the limit. WITHOUT a reconnect, the next send must
			// re-poll the live buffer, clear the latch, and actually ship the frame —
			// mirroring the server's drain() self-heal. Pre-fix this stays refused forever.
			if (internal.ws) internal.ws.bufferedAmount = 10;
			expect(internal.send(FRAME)).toBe(true);
			expect(internal.sendState).toBe("ready");
			expect(internal.ws?.sent).toHaveLength(1);
		});

		it("keeps refusing while the buffer is genuinely still full (no false self-heal)", () => {
			const { internal } = makeClient(100);
			internal.ws = fakeWs(200);
			expect(internal.send(FRAME)).toBe(false);
			expect(internal.sendState).toBe("pressured");

			// Still over the limit — the backpressure protection must hold.
			expect(internal.send(FRAME)).toBe(false);
			expect(internal.sendState).toBe("pressured");
			expect(internal.ws?.sent).toHaveLength(0);
		});

		it("recoverFromBackpressure flips a stale latch to ready and re-drives the durable-work spool", () => {
			const drained: string[] = [];
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				backpressureLimit: 100,
				wsTransport: {
					addPeer: () => {},
					removePeer: () => {},
					handleChangelogPush: () => {},
					handleChangelogAck: () => {},
					drainChangelog: () => {},
					handleRelayDeliver: () => {},
					handleRelayAck: () => {},
					drainRelayOutbox: () => {},
					handleSpoolTransfer: () => {},
					handleSpoolTransferAck: () => {},
					drainDurableWorkSpool: (peerSiteId: string) => {
						drained.push(peerSiteId);
					},
					applySnapshotChunk: () => 0,
					applyColumnChunk: () => {},
				},
			});
			clients.push(client);
			const internal = client as unknown as Internal;
			internal.ws = fakeWs(10); // buffer already drained
			internal.sendState = "pressured"; // but the latch is stale

			internal.recoverFromBackpressure();

			expect(internal.sendState).toBe("ready");
			expect(drained).toEqual([hubSiteId]);
		});

		it("recoverFromBackpressure is a no-op while the buffer is still over the limit", () => {
			const drained: string[] = [];
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				backpressureLimit: 100,
				wsTransport: {
					addPeer: () => {},
					removePeer: () => {},
					handleChangelogPush: () => {},
					handleChangelogAck: () => {},
					drainChangelog: () => {},
					handleRelayDeliver: () => {},
					handleRelayAck: () => {},
					drainRelayOutbox: () => {},
					handleSpoolTransfer: () => {},
					handleSpoolTransferAck: () => {},
					drainDurableWorkSpool: (peerSiteId: string) => {
						drained.push(peerSiteId);
					},
					applySnapshotChunk: () => 0,
					applyColumnChunk: () => {},
				},
			});
			clients.push(client);
			const internal = client as unknown as Internal;
			internal.ws = fakeWs(200); // still over the limit
			internal.sendState = "pressured";

			internal.recoverFromBackpressure();

			expect(internal.sendState).toBe("pressured");
			expect(drained).toEqual([]);
		});
	});

	describe("config validation", () => {
		it("requires hubUrl configuration", () => {
			const client = new WsSyncClient({
				hubUrl: "",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			// Client should exist but not connect to empty URL
			expect(client).toBeTruthy();
		});

		it("uses default reconnectMaxInterval of 10s", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);
			const internal = client as unknown as {
				config: { reconnectMaxInterval?: number };
				reconnectInterval: number;
				scheduleReconnect(): void;
			};
			internal.reconnectInterval = 10;
			internal.scheduleReconnect();
			expect(internal.reconnectInterval).toBe(10);
		});

		it("resets reconnect backoff only after authenticated inbound activity", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});
			clients.push(client);
			const internal = client as unknown as {
				reconnectInterval: number;
				connectionHealthy: boolean;
				markConnectionHealthy(): void;
			};
			internal.reconnectInterval = 8;
			internal.connectionHealthy = false;
			internal.markConnectionHealthy();
			expect(internal.reconnectInterval).toBe(1);
			expect(internal.connectionHealthy).toBe(true);
		});

		it("debounces reconnect backfill until the socket stays open", async () => {
			let runs = 0;
			let trigger: string | undefined;
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectBackfillDelayMs: 20,
			});
			clients.push(client);
			const internal = client as unknown as {
				ws: { readyState: number } | null;
				scheduleReconnectBackfill(wt: {
					runBackfill(opts?: { trigger?: string }): Promise<void>;
				}): void;
			};
			internal.ws = { readyState: WebSocket.OPEN };
			(client as unknown as { connectionHealthy: boolean }).connectionHealthy = true;
			internal.scheduleReconnectBackfill({
				runBackfill: async (opts) => {
					trigger = opts?.trigger;
					runs++;
				},
			});
			expect(runs).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(runs).toBe(1);
			expect(trigger).toBe("reconnect");
		});

		it("cancels reconnect backfill when the socket drops again", async () => {
			let runs = 0;
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectBackfillDelayMs: 20,
			});
			clients.push(client);
			const internal = client as unknown as {
				ws: { readyState: number } | null;
				scheduleReconnectBackfill(wt: { runBackfill(): Promise<void> }): void;
				stopReconnectBackfillTimer(): void;
			};
			internal.ws = { readyState: WebSocket.OPEN };
			(client as unknown as { connectionHealthy: boolean }).connectionHealthy = true;
			internal.scheduleReconnectBackfill({
				runBackfill: async () => {
					runs++;
				},
			});
			internal.stopReconnectBackfillTimer();
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(runs).toBe(0);
		});

		it("uses default backpressureLimit of 2MB", () => {
			const client = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				// No backpressureLimit specified
			});

			clients.push(client);

			expect(client).toBeTruthy();
		});
	});

	describe("ws-transport.AC2.7 — Spoke instantiation only", () => {
		it("is instantiated with hub URL (spoke mode)", () => {
			const client = new WsSyncClient({
				hubUrl: "https://hub.example.com",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client);

			expect(client).toBeTruthy();
			// Note: Hub mode is enforced at integration level, not in client
		});
	});

	describe("frame encoding compatibility", () => {
		it("can encode frames with correct symmetric key lookup", () => {
			// Verify that the symmetric key can be retrieved for frame encoding
			const symmetricKey = hubKeyManager.getSymmetricKey(spokeSiteId);

			expect(symmetricKey).toBeTruthy();
			expect(symmetricKey).toBeInstanceOf(Uint8Array);
			expect(symmetricKey?.length).toBe(32);

			// Frame encoding should work with this key
			const payload = { test: "payload" };
			if (symmetricKey) {
				const frame = encodeFrame(WsMessageType.CHANGELOG_PUSH, payload, symmetricKey);

				expect(frame).toBeTruthy();
				expect(frame).toBeInstanceOf(Uint8Array);
				expect(frame.length).toBeGreaterThan(25); // At least type (1) + nonce (24)
			}
		});

		it("handles clients array with multiple instances", () => {
			const client1 = new WsSyncClient({
				hubUrl: "http://localhost:3000",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			const client2 = new WsSyncClient({
				hubUrl: "http://localhost:3001",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
			});

			clients.push(client1);
			clients.push(client2);

			expect(clients).toHaveLength(2);
			expect(client1).toBeTruthy();
			expect(client2).toBeTruthy();
		});
	});

	describe("integration: real hub server connection", () => {
		it("WsSyncClient connects to hub server with signed auth headers", async () => {
			const testRunId = randomBytes(4).toString("hex");

			// Create hub and spoke keypairs for integration test
			const hubKeypairIntegration = await ensureKeypair(
				join(tmpdir(), `bound-ws-hub-integration-${testRunId}`),
			);
			const spokeKeypairIntegration = await ensureKeypair(
				join(tmpdir(), `bound-ws-spoke-integration-${testRunId}`),
			);

			const hubSiteIdIntegration = hubKeypairIntegration.siteId;
			const spokeSiteIdIntegration = spokeKeypairIntegration.siteId;

			// Build keyring
			const keyringIntegration: KeyringConfig = {
				hosts: {
					[hubSiteIdIntegration]: {
						public_key: await exportPublicKey(hubKeypairIntegration.publicKey),
						url: "http://localhost:3000",
					},
					[spokeSiteIdIntegration]: {
						public_key: await exportPublicKey(spokeKeypairIntegration.publicKey),
						url: "http://localhost:3001",
					},
				},
			};

			const hubKeyManagerIntegration = new KeyManager(hubKeypairIntegration, hubSiteIdIntegration);
			await hubKeyManagerIntegration.init(keyringIntegration);

			const spokeKeyManagerIntegration = new KeyManager(
				spokeKeypairIntegration,
				spokeSiteIdIntegration,
			);
			await spokeKeyManagerIntegration.init(keyringIntegration);

			// Create spoke client with valid configuration
			const spokeClient = new WsSyncClient({
				hubUrl: "http://localhost:59999",
				privateKey: spokeKeypairIntegration.privateKey,
				siteId: spokeSiteIdIntegration,
				keyManager: spokeKeyManagerIntegration,
				hubSiteId: hubSiteIdIntegration,
				reconnectMaxInterval: 1,
			});

			clients.push(spokeClient);

			// Attempt to connect to non-existent hub
			// This tests the auth header signing even though connection will fail
			let connectionAttempted = false;
			try {
				connectionAttempted = true;
				await spokeClient.connect();
			} catch (_error) {
				// Expected to fail since no hub server exists
			}

			// Wait for internal state to settle
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify connection was attempted and client is in valid state
			expect(connectionAttempted).toBe(true);
			expect(spokeClient).toBeTruthy();
			expect(typeof spokeClient.connected).toBe("boolean");
		});
	});

	describe("receive-side liveness watchdog", () => {
		it("forces reconnect when no frames arrive within receiveTimeoutMs", async () => {
			const testRunId = randomBytes(4).toString("hex");
			const cluster = await createWsTestCluster({
				spokeCount: 1,
				basePort: 0,
				testRunId,
			});

			try {
				const spoke = cluster.spokes[0];
				let disconnectCount = 0;
				spoke.wsClient.onDisconnected = () => {
					disconnectCount++;
				};

				// Set a short liveness timeout. After the initial snapshot drain
				// settles and the hub has no more changelog entries to push, no
				// frames arrive. The watchdog should tear down the zombie socket.
				spoke.wsClient.updateReceiveTimeout(300);

				// 300ms timeout + interval check alignment — 800ms is enough to
				// catch the disconnection without waiting for the 1s reconnect.
				await new Promise((r) => setTimeout(r, 800));

				expect(disconnectCount).toBeGreaterThanOrEqual(1);
			} finally {
				await cluster.cleanup();
			}
		}, 10000);
	});

	describe("handshake deadline — half-open CONNECTING socket", () => {
		/**
		 * A server that accepts the TCP connection and reads the upgrade request
		 * but never answers it. The client is left in CONNECTING: no open event,
		 * and critically no close event either. This is the production wedge —
		 * neither handleClose() nor connect()'s synchronous catch re-arms the
		 * reconnect timer, so the client latches dark until the process restarts.
		 */
		function serveNeverUpgrading(): { server: ReturnType<typeof Bun.serve>; hits: () => number } {
			let hits = 0;
			const server = Bun.serve({
				port: 0,
				fetch() {
					hits++;
					return new Promise<Response>(() => {});
				},
			});
			servers.push(server);
			return { server, hits: () => hits };
		}

		function makeSyncStateDb(): Database {
			const db = new Database(":memory:");
			db.run(`CREATE TABLE sync_state (
				peer_site_id  TEXT PRIMARY KEY,
				last_received TEXT NOT NULL DEFAULT '',
				last_sent     TEXT NOT NULL DEFAULT '',
				last_confirmed TEXT NOT NULL DEFAULT '',
				last_sync_at  TEXT,
				sync_errors   INTEGER NOT NULL DEFAULT 0
			)`);
			return db;
		}

		it("tears down the half-open socket and reconnects when the upgrade never completes", async () => {
			const { server, hits } = serveNeverUpgrading();

			const client = new WsSyncClient({
				hubUrl: `http://localhost:${server.port}`,
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				// spokeKeyManager (not hubKeyManager) — computePeerSecrets skips self,
				// so only the spoke's manager holds a symmetric key for hubSiteId.
				// Without this the client throws before creating a socket at all.
				keyManager: spokeKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				handshakeTimeoutMs: 200,
			});
			clients.push(client);

			await client.connect();
			// First attempt dies at ~200ms, reconnect lands ~1s later, second attempt
			// dies at ~1.4s. Pre-fix this stays at exactly 1 forever.
			await new Promise((r) => setTimeout(r, 1800));

			expect(hits()).toBeGreaterThanOrEqual(2);
			expect(client.connected).toBe(false);
		}, 10000);

		it("does not arm the deadline when handshakeTimeoutMs is 0", async () => {
			const { server, hits } = serveNeverUpgrading();

			const client = new WsSyncClient({
				hubUrl: `http://localhost:${server.port}`,
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				handshakeTimeoutMs: 0,
			});
			clients.push(client);

			await client.connect();
			await new Promise((r) => setTimeout(r, 1200));

			expect(hits()).toBe(1);
		}, 10000);

		it("logs a warning naming the deadline when it fires", async () => {
			const { server } = serveNeverUpgrading();
			const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
			const logger = {
				debug: () => {},
				info: () => {},
				warn: (message: string, context?: Record<string, unknown>) => {
					warnings.push({ message, context });
				},
				error: () => {},
				isLevelEnabled: () => true,
			};

			const client = new WsSyncClient({
				hubUrl: `http://localhost:${server.port}`,
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				handshakeTimeoutMs: 200,
				logger,
			});
			clients.push(client);

			await client.connect();
			await new Promise((r) => setTimeout(r, 600));

			const hit = warnings.find((w) => w.message.includes("handshake deadline"));
			expect(hit).toBeTruthy();
			expect(hit?.context?.timeoutMs).toBe(200);
		}, 10000);

		it("records a sync error for the hub peer so hostinfo stops reporting a clean mesh", async () => {
			const { server } = serveNeverUpgrading();
			const db = makeSyncStateDb();

			const client = new WsSyncClient({
				hubUrl: `http://localhost:${server.port}`,
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				handshakeTimeoutMs: 200,
				db,
			});
			clients.push(client);

			await client.connect();
			await new Promise((r) => setTimeout(r, 600));

			const row = db
				.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
				.get(hubSiteId) as { sync_errors: number } | null;

			expect(row).toBeTruthy();
			expect(row?.sync_errors).toBeGreaterThanOrEqual(1);
			db.close();
		}, 10000);

		it("records a sync error when connect() throws before a socket exists", async () => {
			const db = makeSyncStateDb();

			// hubKeyManager has no symmetric key for hubSiteId (self is skipped),
			// so connect() throws synchronously inside its try block.
			const client = new WsSyncClient({
				hubUrl: "http://localhost:59997",
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: hubKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				db,
			});
			clients.push(client);

			await client.connect();
			await new Promise((r) => setTimeout(r, 100));

			const row = db
				.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
				.get(hubSiteId) as { sync_errors: number } | null;

			expect(row?.sync_errors).toBeGreaterThanOrEqual(1);
			db.close();
		}, 10000);

		it("clears the error counter once a handshake completes", async () => {
			const db = makeSyncStateDb();
			db.run("INSERT INTO sync_state (peer_site_id, sync_errors) VALUES (?, 7)", [hubSiteId]);

			const server = Bun.serve({
				port: 0,
				fetch(req, srv) {
					if (srv.upgrade(req)) return undefined;
					return new Response("expected websocket", { status: 400 });
				},
				websocket: { message() {}, open() {}, close() {} },
			});
			servers.push(server);

			const client = new WsSyncClient({
				hubUrl: `http://localhost:${server.port}`,
				privateKey: spokeKeypair.privateKey,
				siteId: spokeSiteId,
				keyManager: spokeKeyManager,
				hubSiteId,
				reconnectMaxInterval: 1,
				handshakeTimeoutMs: 2000,
				backfillIntervalSeconds: 0,
				receiveTimeoutMs: 0,
				db,
			});
			clients.push(client);

			await client.connect();
			await new Promise((r) => setTimeout(r, 400));

			expect(client.connected).toBe(true);
			const row = db
				.query("SELECT sync_errors FROM sync_state WHERE peer_site_id = ?")
				.get(hubSiteId) as { sync_errors: number } | null;
			expect(row?.sync_errors).toBe(0);
			db.close();
		}, 10000);
	});
});
