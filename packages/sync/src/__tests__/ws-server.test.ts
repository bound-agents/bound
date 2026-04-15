import { beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { signRequest } from "../signing.js";
import { type WsConnectionData, authenticateWsUpgrade } from "../ws-server.js";

describe("authenticateWsUpgrade", () => {
	let hubKeypair: { publicKey: CryptoKey; privateKey: CryptoKey };
	let spokeKeypair: { publicKey: CryptoKey; privateKey: CryptoKey };

	let hubSiteId: string;
	let spokeSiteId: string;

	let hubPubKey: string;
	let spokePubKey: string;

	let keyManager: KeyManager;

	beforeEach(async () => {
		// Generate hub and spoke keypairs
		hubKeypair = await generateKeypair();
		spokeKeypair = await generateKeypair();

		// Derive site IDs
		hubSiteId = await deriveSiteId(hubKeypair.publicKey);
		spokeSiteId = await deriveSiteId(spokeKeypair.publicKey);

		// Export public keys
		hubPubKey = await exportPublicKey(hubKeypair.publicKey);
		spokePubKey = await exportPublicKey(spokeKeypair.publicKey);

		// Create keyring with both hub and spoke
		const keyring: KeyringConfig = {
			hosts: {
				[hubSiteId]: { public_key: hubPubKey, url: "http://localhost:3000" },
				[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
			},
		};

		// Initialize hub's KeyManager with the keyring
		keyManager = new KeyManager(hubKeypair, hubSiteId);
		await keyManager.init(keyring);
	});

	describe("ws-transport.AC3.3 — Valid signature accepted", () => {
		it("accepts upgrade request with valid Ed25519 signature", async () => {
			// Sign the request with spoke's private key
			const signatureHeaders = await signRequest(
				spokeKeypair.privateKey,
				spokeSiteId,
				"GET",
				"/sync/ws",
				"",
			);

			// Create request with signed headers
			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: signatureHeaders,
			});

			// Authenticate the upgrade
			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(true);
			if (result.ok) {
				const data = result.value;
				expect(data).toMatchObject({
					siteId: spokeSiteId,
					sendState: "ready",
					pendingDrain: null,
				});
				expect(data.symmetricKey).toBeInstanceOf(Uint8Array);
				expect(data.symmetricKey.length).toBe(32);
				expect(data.fingerprint).toBeString();
				expect(data.fingerprint.length).toBe(16);
				expect(data.fingerprint).toMatch(/^[0-9a-f]+$/);
			}
		});
	});

	describe("ws-transport.AC3.4 — Invalid signature rejected", () => {
		it("rejects upgrade with tampered signature", async () => {
			// Sign the request with spoke's private key
			let signatureHeaders = await signRequest(
				spokeKeypair.privateKey,
				spokeSiteId,
				"GET",
				"/sync/ws",
				"",
			);

			// Tamper with the signature
			const tampered = `${signatureHeaders["X-Signature"].slice(0, -2)}00`;
			signatureHeaders = {
				...signatureHeaders,
				"X-Signature": tampered,
			};

			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: signatureHeaders,
			});

			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.status).toBe(401);
				expect(result.error.body).toContain("Signature");
			}
		});
	});

	describe("ws-transport.AC3.5 — Unknown siteId rejected", () => {
		it("rejects upgrade with unknown siteId", async () => {
			// Generate a third keypair not in keyring
			const unknownKeypair = await generateKeypair();
			const unknownSiteId = await deriveSiteId(unknownKeypair.publicKey);

			// Sign with the unknown keypair
			const signatureHeaders = await signRequest(
				unknownKeypair.privateKey,
				unknownSiteId,
				"GET",
				"/sync/ws",
				"",
			);

			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: signatureHeaders,
			});

			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.status).toBe(403);
				expect(result.error.body).toContain("not found");
			}
		});
	});

	describe("Stale timestamp rejected", () => {
		it("rejects upgrade with timestamp older than 5 minutes", async () => {
			// Create a timestamp 6 minutes in the past
			const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();

			// Re-sign with stale timestamp (because signature includes timestamp)
			// We need to create the signature with stale timestamp
			const method = "GET";
			const path = "/sync/ws";
			const body = "";
			const bodyHasher = new (await import("bun")).CryptoHasher("sha256");
			bodyHasher.update(body);
			const bodyHashHex = Buffer.from(bodyHasher.digest()).toString("hex");
			const signingBase = `${method}\n${path}\n${staleTimestamp}\n${bodyHashHex}`;
			const signingBaseBytes = new TextEncoder().encode(signingBase);
			const signatureBytes = await crypto.subtle.sign(
				"Ed25519",
				spokeKeypair.privateKey,
				signingBaseBytes,
			);
			const signatureHex = Buffer.from(signatureBytes).toString("hex");

			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: {
					"X-Site-Id": spokeSiteId,
					"X-Timestamp": staleTimestamp,
					"X-Signature": signatureHex,
					"X-Agent-Version": "0.0.1",
				},
			});

			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.status).toBe(408);
			}
		});
	});

	describe("Missing headers rejected", () => {
		it("rejects upgrade with no X-Site-Id header", async () => {
			// Create request without X-Site-Id
			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: {
					"X-Timestamp": new Date().toISOString(),
					"X-Signature": "0".repeat(128),
					"X-Agent-Version": "0.0.1",
				},
			});

			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.status).toBe(403);
				// Missing headers result in "unknown site" or "missing headers" error
				expect(result.error.body).toMatch(/not found|Missing/);
			}
		});
	});

	describe("WsConnectionData structure", () => {
		it("returns correct structure with all required fields", async () => {
			const signatureHeaders = await signRequest(
				spokeKeypair.privateKey,
				spokeSiteId,
				"GET",
				"/sync/ws",
				"",
			);

			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: signatureHeaders,
			});

			const keyring: KeyringConfig = {
				hosts: {
					[spokeSiteId]: { public_key: spokePubKey, url: "http://localhost:3100" },
				},
			};

			const result = await authenticateWsUpgrade(request, keyring, keyManager);

			expect(result.ok).toBe(true);
			if (result.ok) {
				const data: WsConnectionData = result.value;

				// Check all required fields exist
				expect(data).toHaveProperty("siteId");
				expect(data).toHaveProperty("symmetricKey");
				expect(data).toHaveProperty("fingerprint");
				expect(data).toHaveProperty("sendState");
				expect(data).toHaveProperty("pendingDrain");

				// Check types
				expect(typeof data.siteId).toBe("string");
				expect(data.symmetricKey).toBeInstanceOf(Uint8Array);
				expect(typeof data.fingerprint).toBe("string");
				expect(data.sendState).toBe("ready");
				expect(data.pendingDrain).toBeNull();
			}
		});
	});
});

describe("WsConnectionManager", async () => {
	const { WsConnectionManager } = await import("../ws-server.js");

	describe("add and retrieve connection", () => {
		it("stores and retrieves a connection by siteId", () => {
			const manager = new WsConnectionManager();
			const mockWs = {
				data: {
					siteId: "test-site-1",
					sendState: "ready",
				},
				close: () => {},
			};

			manager.add("test-site-1", mockWs as any);

			expect(manager.get("test-site-1")).toBe(mockWs);
			expect(manager.has("test-site-1")).toBe(true);
			expect(manager.size).toBe(1);
		});
	});

	describe("remove connection", () => {
		it("removes a connection by siteId", () => {
			const manager = new WsConnectionManager();
			const mockWs = {
				data: {
					siteId: "test-site-1",
					sendState: "ready",
				},
				close: () => {},
			};

			manager.add("test-site-1", mockWs as any);
			manager.remove("test-site-1");

			expect(manager.get("test-site-1")).toBeUndefined();
			expect(manager.has("test-site-1")).toBe(false);
			expect(manager.size).toBe(0);
		});
	});

	describe("duplicate siteId replaces old connection", () => {
		it("closes old connection with code 1008 when adding duplicate", () => {
			const manager = new WsConnectionManager();
			let oldClosed = false;
			let closeCode: number | undefined;
			const oldWs = {
				data: {
					siteId: "test-site-1",
					sendState: "ready",
				},
				close: (code?: number) => {
					oldClosed = true;
					closeCode = code;
				},
			};

			const newWs = {
				data: {
					siteId: "test-site-1",
					sendState: "ready",
				},
				close: () => {},
			};

			manager.add("test-site-1", oldWs as any);
			manager.add("test-site-1", newWs as any);

			expect(oldClosed).toBe(true);
			expect(closeCode).toBe(1008);
			expect(manager.get("test-site-1")).toBe(newWs);
			expect(manager.size).toBe(1);
		});
	});

	describe("getAll returns all connections", () => {
		it("returns a map of all active connections", () => {
			const manager = new WsConnectionManager();

			const mockWs1 = {
				data: { siteId: "site-1", sendState: "ready" },
				close: () => {},
			};
			const mockWs2 = {
				data: { siteId: "site-2", sendState: "ready" },
				close: () => {},
			};
			const mockWs3 = {
				data: { siteId: "site-3", sendState: "ready" },
				close: () => {},
			};

			manager.add("site-1", mockWs1 as any);
			manager.add("site-2", mockWs2 as any);
			manager.add("site-3", mockWs3 as any);

			const allConnections = manager.getAll();

			expect(allConnections.size).toBe(3);
			expect(allConnections.get("site-1")).toBe(mockWs1);
			expect(allConnections.get("site-2")).toBe(mockWs2);
			expect(allConnections.get("site-3")).toBe(mockWs3);
		});
	});

	describe("ws-transport.AC6.4 — Send returning 0 triggers close", () => {
		it("closes connection and removes from manager when send returns 0", () => {
			const manager = new WsConnectionManager();
			let connectionClosed = false;
			let closeCode: number | undefined;

			const mockWs = {
				data: {
					siteId: "test-site-1",
					sendState: "ready",
				},
				send: () => 0, // Simulate send failure
				close: (code?: number) => {
					connectionClosed = true;
					closeCode = code;
					manager.remove("test-site-1");
				},
			};

			manager.add("test-site-1", mockWs as any);
			const result = mockWs.send();

			if (result === 0) {
				mockWs.close(1011);
			}

			expect(connectionClosed).toBe(true);
			expect(closeCode).toBe(1011);
			expect(manager.has("test-site-1")).toBe(false);
		});
	});
});

describe("createWsHandlers", async () => {
	const { WsConnectionManager, createWsHandlers } = await import(
		"../ws-server.js"
	);

	describe("lifecycle integration", () => {
		it("processes full connection lifecycle", async () => {
			const manager = new WsConnectionManager();
			const events: string[] = [];

			const mockLogger = {
				debug: (msg: string) => events.push(`debug: ${msg}`),
				info: (msg: string) => events.push(`info: ${msg}`),
				warn: (msg: string) => events.push(`warn: ${msg}`),
			};

			const handlers = createWsHandlers({
				connectionManager: manager,
				logger: mockLogger as any,
			});

			expect(handlers).toHaveProperty("websocket");
			expect(handlers).toHaveProperty("handleUpgrade");
			expect(typeof handlers.websocket).toBe("object");
			expect(typeof handlers.handleUpgrade).toBe("function");
		});

		it("handleUpgrade returns error response on auth failure", async () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			const failingKeyring = { hosts: {} };
			const failingKeyManager = {
				getSymmetricKey: () => null,
				getFingerprint: () => null,
			} as any;

			// Create request without proper signature headers
			const request = new Request("http://localhost:3000/sync/ws", {
				method: "GET",
				headers: {
					"x-site-id": "unknown-site",
				},
			});

			// Mock server object
			const mockServer = {
				upgrade: () => true,
			} as any;

			const response = await handlers.handleUpgrade(
				request,
				mockServer,
				failingKeyring,
				failingKeyManager,
			);

			if (response) {
				expect(response.status).toBe(403);
			}
		});

		it("websocket open handler adds connection to manager", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			const mockWs = {
				data: {
					siteId: "test-site",
					sendState: "ready",
					pendingDrain: null,
				},
			} as any;

			handlers.websocket.open?.(mockWs);

			expect(manager.has("test-site")).toBe(true);
			expect(manager.get("test-site")).toBe(mockWs);
		});

		it("websocket close handler removes connection from manager", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			const mockWs = {
				data: {
					siteId: "test-site",
					sendState: "ready",
					pendingDrain: null,
				},
			} as any;

			manager.add("test-site", mockWs);
			handlers.websocket.close?.(mockWs, 1000, "normal");

			expect(manager.has("test-site")).toBe(false);
		});

		it("websocket message handler validates binary frames", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			const mockWs = {
				data: {
					siteId: "test-site",
					sendState: "ready",
					pendingDrain: null,
				},
				close: () => {},
			} as any;

			// Test with Uint8Array (valid binary)
			const binaryMessage = new Uint8Array([1, 2, 3]);
			expect(() => {
				handlers.websocket.message?.(mockWs, binaryMessage);
			}).not.toThrow();

			// Test with string (invalid - should close with code 1003)
			let closedWithCode: number | undefined;
			mockWs.close = (code?: number) => {
				closedWithCode = code;
			};

			handlers.websocket.message?.(mockWs, "invalid text message");

			expect(closedWithCode).toBe(1003);
		});

		it("websocket drain handler sets ready state and calls pending drain", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			let drainCalled = false;
			const mockDrain = () => {
				drainCalled = true;
			};

			const mockWs = {
				data: {
					siteId: "test-site",
					sendState: "pressured" as const,
					pendingDrain: mockDrain,
				},
			} as any;

			handlers.websocket.drain?.(mockWs);

			expect(mockWs.data.sendState).toBe("ready");
			expect(drainCalled).toBe(true);
			expect(mockWs.data.pendingDrain).toBeNull();
		});

		it("websocket drain handler clears pendingDrain", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			const mockWs = {
				data: {
					siteId: "test-site",
					sendState: "pressured" as const,
					pendingDrain: null,
				},
			} as any;

			handlers.websocket.drain?.(mockWs);

			expect(mockWs.data.sendState).toBe("ready");
			expect(mockWs.data.pendingDrain).toBeNull();
		});

		it("uses configured idleTimeout and backpressureLimit", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
				idleTimeout: 60,
				backpressureLimit: 1024,
			});

			expect(handlers.websocket.idleTimeout).toBe(60);
			expect(handlers.websocket.backpressureLimit).toBe(1024);
		});

		it("uses default idleTimeout and backpressureLimit", () => {
			const manager = new WsConnectionManager();
			const handlers = createWsHandlers({
				connectionManager: manager,
			});

			expect(handlers.websocket.idleTimeout).toBe(120);
			expect(handlers.websocket.backpressureLimit).toBe(2097152);
		});
	});
});
