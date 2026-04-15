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
