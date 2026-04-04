import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringConfig } from "@bound/shared";
import { Hono } from "hono";
import { deriveSiteId, ensureKeypair, exportPublicKey } from "../crypto.js";
import { decryptBody, encryptBody } from "../encryption.js";
import { KeyManager } from "../key-manager.js";
import { verifyRequest } from "../signing.js";
import { SyncTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TransportTestPeer {
	siteId: string;
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	publicKeyEncoded: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const tempDirs: string[] = [];

async function createTestPeer(keypairDir: string): Promise<TransportTestPeer> {
	const keypair = await ensureKeypair(keypairDir);
	const publicKeyEncoded = await exportPublicKey(keypair.publicKey);
	const siteId = await deriveSiteId(keypair.publicKey);

	return {
		siteId,
		publicKey: keypair.publicKey,
		privateKey: keypair.privateKey,
		publicKeyEncoded,
	};
}

function tempKeypairDir(label: string): string {
	const dir = join(tmpdir(), `bound-transport-test-${label}-${randomBytes(4).toString("hex")}`);
	tempDirs.push(dir);
	return dir;
}

afterAll(async () => {
	for (const server of servers) {
		server.stop();
	}
	for (const dir of tempDirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncTransport", () => {
	let spoke: TransportTestPeer;
	let hub: TransportTestPeer;
	let spokeKeyring: KeyringConfig;
	let hubKeyring: KeyringConfig;
	let transport: SyncTransport;
	let serverPort: number;
	let capturedRequests: Array<{
		headers: Record<string, string>;
		body: Uint8Array;
	}> = [];

	beforeEach(async () => {
		capturedRequests = [];

		// Create two peers
		spoke = await createTestPeer(tempKeypairDir("spoke"));
		hub = await createTestPeer(tempKeypairDir("hub"));

		// Build keyrings: each peer knows about the other
		spokeKeyring = {
			hosts: {
				[hub.siteId]: {
					public_key: hub.publicKeyEncoded,
					url: "http://localhost:0", // Will be set after server starts
				},
			},
		};

		hubKeyring = {
			hosts: {
				[spoke.siteId]: {
					public_key: spoke.publicKeyEncoded,
					url: "http://localhost:0",
				},
			},
		};

		// Create KeyManager for spoke
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		// Create SyncTransport
		transport = new SyncTransport(keyManager, spoke.privateKey, spoke.siteId);

		// Start a Hono server that echoes back encrypted responses
		const app = new Hono();

		app.post("/sync/push", async (c) => {
			const headerRecord: Record<string, string> = {};
			c.req.raw.headers.forEach((value, key) => {
				headerRecord[key.toLowerCase()] = value;
			});

			const body = new Uint8Array(await c.req.arrayBuffer());
			capturedRequests.push({ headers: headerRecord, body });

			// Verify headers are present
			if (!headerRecord["x-encryption"]) {
				return c.text("Missing X-Encryption header", 400);
			}

			// Echo back plain response
			return c.json({ ok: true });
		});

		app.post("/sync/pull", async (c) => {
			const headerRecord: Record<string, string> = {};
			c.req.raw.headers.forEach((value, key) => {
				headerRecord[key.toLowerCase()] = value;
			});

			const body = new Uint8Array(await c.req.arrayBuffer());
			capturedRequests.push({ headers: headerRecord, body });

			// For pull, return encrypted response
			const responseData = { events: [], source_seq_end: 0 };
			const responseJson = JSON.stringify(responseData);
			const plaintext = new TextEncoder().encode(responseJson);

			// Get hub's symmetric key with spoke to encrypt response
			const keyManager = new KeyManager(
				{ publicKey: hub.publicKey, privateKey: hub.privateKey },
				hub.siteId,
			);
			await keyManager.init(hubKeyring);
			const hubSymmetricKey = keyManager.getSymmetricKey(spoke.siteId);
			if (!hubSymmetricKey) {
				return c.text("Cannot compute symmetric key for response", 500);
			}

			const { ciphertext: responseCiphertext, nonce: responseNonce } = encryptBody(
				plaintext,
				hubSymmetricKey,
			);

			const responseHeaders = new Headers();
			responseHeaders.set("X-Encryption", "xchacha20");
			responseHeaders.set("X-Nonce", Buffer.from(responseNonce).toString("hex"));

			return new Response(Buffer.from(responseCiphertext), {
				status: 200,
				headers: responseHeaders,
			});
		});

		const server = Bun.serve({ port: 0, fetch: app.fetch });
		servers.push(server);
		serverPort = server.port;

		// Update keyrings with actual URL
		spokeKeyring.hosts[hub.siteId].url = `http://localhost:${serverPort}`;
	});

	it("sync-encryption.AC4.1: encrypts request body with XChaCha20-Poly1305", async () => {
		const requestBody = JSON.stringify({ events: [], source_seq_end: 0 });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			requestBody,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];

		// Received body should NOT be the original JSON
		const receivedText = new TextDecoder().decode(captured.body);
		expect(receivedText).not.toBe(requestBody);

		// Received body should be valid ciphertext (>16 bytes for auth tag + plaintext)
		expect(captured.body.length).toBeGreaterThanOrEqual(16);

		// Verify it can be decrypted with hub's symmetric key
		const keyManager = new KeyManager(
			{ publicKey: hub.publicKey, privateKey: hub.privateKey },
			hub.siteId,
		);
		const hubKeyringReversed = {
			hosts: {
				[spoke.siteId]: {
					public_key: spoke.publicKeyEncoded,
					url: "http://localhost:0",
				},
			},
		};
		await keyManager.init(hubKeyringReversed);
		const hubSymmetricKey = keyManager.getSymmetricKey(spoke.siteId);
		if (!hubSymmetricKey) {
			throw new Error("Cannot get symmetric key");
		}

		const nonceHex = captured.headers["x-nonce"] || captured.headers["X-Nonce"];
		const nonce = Buffer.from(nonceHex, "hex");
		const decrypted = decryptBody(captured.body, nonce, hubSymmetricKey);
		const decryptedText = new TextDecoder().decode(decrypted);

		expect(decryptedText).toBe(requestBody);
	});

	it("sync-encryption.AC4.2: generates random 192-bit nonce per message", async () => {
		const body1 = JSON.stringify({ events: [], source_seq_end: 0 });
		const body2 = JSON.stringify({ events: [], source_seq_end: 1 });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body1,
			hub.siteId,
		);
		const nonce1 = capturedRequests[0].headers["x-nonce"] || capturedRequests[0].headers["X-Nonce"];

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body2,
			hub.siteId,
		);
		const nonce2 = capturedRequests[1].headers["x-nonce"] || capturedRequests[1].headers["X-Nonce"];

		// Nonces should differ
		expect(nonce1).not.toBe(nonce2);

		// Each should be valid hex (48 chars for 24 bytes)
		expect(nonce1).toMatch(/^[0-9a-f]{48}$/);
		expect(nonce2).toMatch(/^[0-9a-f]{48}$/);
	});

	it("sync-encryption.AC4.3: empty body produces valid ciphertext", async () => {
		const emptyBody = "";

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			emptyBody,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];

		// Empty plaintext should produce 16-byte ciphertext (auth tag only)
		expect(captured.body.length).toBe(16);

		// Should still be decryptable
		const keyManager = new KeyManager(
			{ publicKey: hub.publicKey, privateKey: hub.privateKey },
			hub.siteId,
		);
		const hubKeyringReversed = {
			hosts: {
				[spoke.siteId]: {
					public_key: spoke.publicKeyEncoded,
					url: "http://localhost:0",
				},
			},
		};
		await keyManager.init(hubKeyringReversed);
		const hubSymmetricKey = keyManager.getSymmetricKey(spoke.siteId);
		if (!hubSymmetricKey) {
			throw new Error("Cannot get symmetric key");
		}

		const nonceHex = captured.headers["x-nonce"] || captured.headers["X-Nonce"];
		const nonce = Buffer.from(nonceHex, "hex");
		const decrypted = decryptBody(captured.body, nonce, hubSymmetricKey);
		const decryptedText = new TextDecoder().decode(decrypted);

		expect(decryptedText).toBe("");
	});

	it("sync-encryption.AC5.1: includes X-Encryption: xchacha20 header", async () => {
		const body = JSON.stringify({ events: [] });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];
		const encryption = captured.headers["x-encryption"] || captured.headers["X-Encryption"];

		expect(encryption).toBe("xchacha20");
	});

	it("sync-encryption.AC5.2: X-Nonce is 48 hex characters (24 bytes)", async () => {
		const body = JSON.stringify({ events: [] });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];
		const nonce = captured.headers["x-nonce"] || captured.headers["X-Nonce"];

		expect(nonce).toMatch(/^[0-9a-f]{48}$/);
		expect(nonce.length).toBe(48);
	});

	it("sync-encryption.AC5.3: Content-Type set to application/octet-stream", async () => {
		const body = JSON.stringify({ events: [] });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];
		const contentType = captured.headers["content-type"] || captured.headers["Content-Type"];

		expect(contentType).toBe("application/octet-stream");
	});

	it("sync-encryption.AC5.4: signature covers ciphertext, not plaintext", async () => {
		const body = JSON.stringify({ events: [] });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];

		// Extract signature headers
		const headerRecord = captured.headers;

		// Verify signature against ciphertext (not plaintext)
		const result = await verifyRequest(
			hubKeyring,
			"POST",
			"/sync/push",
			headerRecord,
			captured.body,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.siteId).toBe(spoke.siteId);
		}

		// Verify that signature does NOT validate against plaintext
		const plaintextBody = new TextEncoder().encode(body);
		const resultPlaintext = await verifyRequest(
			hubKeyring,
			"POST",
			"/sync/push",
			headerRecord,
			plaintextBody,
		);

		expect(resultPlaintext.ok).toBe(false);
	});

	it("decrypts encrypted response with X-Encryption header", async () => {
		const body = JSON.stringify({ since_seq: 0 });

		const response = await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/pull`,
			"/sync/pull",
			body,
			hub.siteId,
		);

		expect(response.status).toBe(200);
		// Response body should be decrypted JSON
		const parsed = JSON.parse(response.body);
		expect(parsed.events).toBeDefined();
		expect(parsed.source_seq_end).toBe(0);
	});

	it("handles plaintext error response (no X-Encryption header)", async () => {
		const app = new Hono();

		app.post("/sync/error", (c) => {
			// Return plaintext error (no X-Encryption header)
			return c.text(JSON.stringify({ error: "test error" }), 500);
		});

		const server = Bun.serve({ port: 0, fetch: app.fetch });
		servers.push(server);
		const errorServerPort = server.port;

		try {
			const body = JSON.stringify({ events: [] });

			const response = await transport.send(
				"POST",
				`http://localhost:${errorServerPort}/sync/error`,
				"/sync/error",
				body,
				hub.siteId,
			);

			expect(response.status).toBe(500);
			expect(response.body).toContain("test error");
		} finally {
			server.stop();
		}
	});

	it("throws when symmetric key not found for target peer", async () => {
		const unknownSiteId = "unknown-site-id-0000000000000000";
		const body = JSON.stringify({ events: [] });

		try {
			await transport.send(
				"POST",
				`http://localhost:${serverPort}/sync/push`,
				"/sync/push",
				body,
				unknownSiteId,
			);

			expect.unreachable("Should have thrown");
		} catch (error) {
			if (error instanceof Error) {
				expect(error.message).toContain("No symmetric key for peer");
			}
		}
	});

	it("includes X-Key-Fingerprint header", async () => {
		const body = JSON.stringify({ events: [] });

		await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/push`,
			"/sync/push",
			body,
			hub.siteId,
		);

		expect(capturedRequests.length).toBe(1);
		const captured = capturedRequests[0];
		const fingerprint =
			captured.headers["x-key-fingerprint"] || captured.headers["X-Key-Fingerprint"];

		expect(fingerprint).toBeDefined();
		expect(fingerprint).toMatch(/^[0-9a-f]{16}$/); // 8 bytes = 16 hex chars
	});
});
