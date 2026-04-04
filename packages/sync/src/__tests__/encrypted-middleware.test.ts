import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyringConfig } from "@bound/shared";
import { Hono } from "hono";
import { deriveSiteId, ensureKeypair, exportPublicKey } from "../crypto.js";
import { KeyManager } from "../key-manager.js";
import { createSyncAuthMiddleware } from "../middleware.js";
import { SyncTransport } from "../transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MiddlewareTestPeer {
	siteId: string;
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	publicKeyEncoded: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const tempDirs: string[] = [];

async function createTestPeer(keypairDir: string): Promise<MiddlewareTestPeer> {
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
	const dir = join(tmpdir(), `bound-middleware-test-${label}-${randomBytes(4).toString("hex")}`);
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

describe("createSyncAuthMiddleware (encryption)", () => {
	let spoke: MiddlewareTestPeer;
	let hub: MiddlewareTestPeer;
	let spokeKeyring: KeyringConfig;
	let hubKeyring: KeyringConfig;
	let transport: SyncTransport;
	let serverPort: number;

	beforeEach(async () => {
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
		const spokeKeyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await spokeKeyManager.init(spokeKeyring);

		// Create SyncTransport
		transport = new SyncTransport(spokeKeyManager, spoke.privateKey, spoke.siteId);

		// Create KeyManager for hub
		const hubKeyManager = new KeyManager(
			{ publicKey: hub.publicKey, privateKey: hub.privateKey },
			hub.siteId,
		);
		await hubKeyManager.init(hubKeyring);

		// Create Hono app with encrypted middleware
		const app = new Hono();

		// Add the middleware with encryption support
		app.use("/sync/*", createSyncAuthMiddleware(hubKeyring, hubKeyManager));
		app.use("/api/relay-deliver", createSyncAuthMiddleware(hubKeyring, hubKeyManager));

		// Echo route that returns the decrypted body it received
		app.post("/sync/echo", async (c) => {
			const rawBody = c.get("rawBody");
			return c.json({ echo: JSON.parse(rawBody) });
		});

		// Route that throws an error (tests error encryption)
		app.post("/sync/error-route", async (_c) => {
			throw new Error("Intentional error for testing");
		});

		// Start server
		const server = Bun.serve({ port: 0, fetch: app.fetch });
		servers.push(server);
		serverPort = server.port;

		// Update keyrings with actual URL
		spokeKeyring.hosts[hub.siteId].url = `http://localhost:${serverPort}`;
	});

	// AC6.1: Hub decrypts incoming request and provides plaintext JSON to handlers
	it("sync-encryption.AC6.1: decrypts incoming request body and provides plaintext JSON to route handlers", async () => {
		const requestData = { events: [], source_seq_end: 42 };
		const requestJson = JSON.stringify(requestData);

		const response = await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/echo`,
			"/sync/echo",
			requestJson,
			hub.siteId,
		);

		expect(response.status).toBe(200);
		const responseData = JSON.parse(response.body);
		expect(responseData.echo).toEqual(requestData);
	});

	// AC6.3: Corrupted ciphertext rejected with HTTP 400
	it("sync-encryption.AC6.3: rejects corrupted ciphertext with HTTP 400 and generic hint", async () => {
		const requestData = { events: [], source_seq_end: 0 };
		const requestJson = JSON.stringify(requestData);

		// We need to manually craft a corrupt request
		// Use transport to get encrypted body, then flip a byte
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const { signRequest } = await import("../signing.js");
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

		// Flip a byte in the ciphertext to corrupt it
		ciphertext[0] ^= 0xff;

		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);
		const nonceHex = Buffer.from(nonce).toString("hex");

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("decryption_failed");
		// Should have generic hint, not expose internal error details
		expect(errorData.hint).toContain("keyring.json");
	});

	// AC6.4: Malformed X-Nonce rejected
	it("sync-encryption.AC6.4: rejects malformed X-Nonce (wrong length) with HTTP 400", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [] });
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);

		// Send with wrong nonce length (46 chars instead of 48)
		const wrongNonceHex = Buffer.from(nonce).toString("hex").slice(0, 46);

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": wrongNonceHex,
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("malformed_encryption_headers");
		expect(errorData.message).toContain("48 hex characters");
	});

	// AC6.4: Missing X-Nonce rejected
	it("sync-encryption.AC6.4: rejects missing X-Nonce with HTTP 400", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [] });
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext } = encryptBody(plaintext, symmetricKey);

		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);

		// Send with X-Encryption but NO X-Nonce
		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				// X-Nonce is missing
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("malformed_encryption_headers");
	});

	// AC7.1 & 7.2: Response encrypted with spoke's key and includes headers
	it("sync-encryption.AC7.1 & 7.2: response encrypted and includes X-Encryption and X-Nonce headers", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [], source_seq_end: 42 });
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);
		const nonceHex = Buffer.from(nonce).toString("hex");

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(200);

		// Response should have encryption headers
		const encryptionHeader = response.headers.get("X-Encryption");
		const nonceHeader = response.headers.get("X-Nonce");
		expect(encryptionHeader).toBe("xchacha20");
		expect(nonceHeader).toBeDefined();
		expect(nonceHeader).toMatch(/^[0-9a-f]{48}$/); // 48 hex chars = 24 bytes

		// Response body should be encrypted (not plain JSON)
		const responseBody = await response.arrayBuffer();
		const responseText = new TextDecoder().decode(new Uint8Array(responseBody));
		// Should not be valid JSON directly
		expect(() => JSON.parse(responseText)).toThrow();
	});

	// AC3.4: Response headers do not include X-Key-Fingerprint for successful encrypted responses
	it("sync-encryption.AC3.4: response headers lack X-Key-Fingerprint for encrypted response", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [], source_seq_end: 42 });
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);
		const nonceHex = Buffer.from(nonce).toString("hex");

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(200);

		// Verify X-Key-Fingerprint is NOT present in response headers
		const fingerprintHeader = response.headers.get("X-Key-Fingerprint");
		expect(fingerprintHeader).toBeNull();

		// But encryption headers should still be present
		expect(response.headers.get("X-Encryption")).toBe("xchacha20");
		expect(response.headers.get("X-Nonce")).toBeDefined();
	});

	// AC7.3: Spoke decrypts response successfully
	it("sync-encryption.AC7.3: spoke successfully decrypts response", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [], source_seq_end: 99 });

		const response = await transport.send(
			"POST",
			`http://localhost:${serverPort}/sync/echo`,
			"/sync/echo",
			requestJson,
			hub.siteId,
		);

		expect(response.status).toBe(200);
		const responseData = JSON.parse(response.body);
		// Verify the response contains the expected echo
		expect(responseData.echo.source_seq_end).toBe(99);
	});

	// AC7.4: Plaintext error responses for encryption-layer errors
	it("sync-encryption.AC7.4: encryption-layer errors return plaintext JSON", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const { signRequest } = await import("../signing.js");
		const plaintext = new TextEncoder().encode(JSON.stringify({ events: [] }));
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext } = encryptBody(plaintext, symmetricKey);

		// Corrupt the nonce by making it too short
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			ciphertext,
		);

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": "abcd", // Too short
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		expect(response.status).toBe(400);

		// Error response should be plaintext JSON (not encrypted)
		const encryptionHeader = response.headers.get("X-Encryption");

		expect(encryptionHeader).toBeNull(); // No encryption header for error
		const errorData = await response.json();
		expect(errorData.error).toBe("malformed_encryption_headers");
	});

	// AC8.1: Plaintext request rejected
	it("sync-encryption.AC8.1: rejects plaintext request (missing X-Encryption) with HTTP 400", async () => {
		const requestJson = JSON.stringify({ events: [] });

		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			requestJson,
		);

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// No X-Encryption header
				...signHeaders,
			},
			body: requestJson,
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("plaintext_rejected");
		expect(errorData.message).toContain("Upgrade to a version with sync encryption");
	});

	// AC8.2: X-Nonce without X-Encryption is ambiguous
	it("sync-encryption.AC8.2: rejects X-Nonce without X-Encryption as ambiguous", async () => {
		const requestJson = JSON.stringify({ events: [] });

		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			requestJson,
		);

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Nonce": "1234567890abcdef1234567890abcdef12345678", // Present but no X-Encryption
				...signHeaders,
			},
			body: requestJson,
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("malformed_encryption_headers");
		expect(errorData.message).toContain("X-Nonce present without X-Encryption");
	});

	// AC8.3: X-Encryption without X-Nonce is malformed
	it("sync-encryption.AC8.3: rejects X-Encryption without X-Nonce as malformed", async () => {
		const requestJson = JSON.stringify({ events: [] });

		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/echo",
			requestJson,
		);

		const response = await fetch(`http://localhost:${serverPort}/sync/echo`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Encryption": "xchacha20",
				// X-Nonce is missing
				...signHeaders,
			},
			body: requestJson,
		});

		expect(response.status).toBe(400);
		const errorData = await response.json();
		expect(errorData.error).toBe("malformed_encryption_headers");
	});

	// AC10.2: Application-layer errors (handler exceptions) are returned encrypted
	it("sync-encryption.AC10.2: application-layer errors are returned encrypted", async () => {
		const keyManager = new KeyManager(
			{ publicKey: spoke.publicKey, privateKey: spoke.privateKey },
			spoke.siteId,
		);
		await keyManager.init(spokeKeyring);

		const requestJson = JSON.stringify({ events: [] });
		const plaintext = new TextEncoder().encode(requestJson);
		const symmetricKey = keyManager.getSymmetricKey(hub.siteId);
		if (!symmetricKey) {
			throw new Error("No symmetric key");
		}

		const { encryptBody } = await import("../encryption.js");
		const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/error-route",
			ciphertext,
		);
		const nonceHex = Buffer.from(nonce).toString("hex");

		const response = await fetch(`http://localhost:${serverPort}/sync/error-route`, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Encryption": "xchacha20",
				"X-Nonce": nonceHex,
				"X-Key-Fingerprint": keyManager.getLocalFingerprint(),
				...signHeaders,
			},
			body: Buffer.from(ciphertext),
		});

		// Handler throws an error, so expect 500
		expect(response.status).toBe(500);

		// Error response should be encrypted (has encryption headers)
		const encryptionHeader = response.headers.get("X-Encryption");
		const responseNonceHeader = response.headers.get("X-Nonce");
		expect(encryptionHeader).toBe("xchacha20");
		expect(responseNonceHeader).toBeDefined();
		expect(responseNonceHeader).toMatch(/^[0-9a-f]{48}$/);

		// Response body should be encrypted (not plain JSON)
		const responseBody = await response.arrayBuffer();
		const responseText = new TextDecoder().decode(new Uint8Array(responseBody));
		// Should not be valid JSON directly (it's encrypted binary)
		expect(() => JSON.parse(responseText)).toThrow();
	});

	// Backward compatibility: keyManager=undefined allows plaintext (single-node mode)
	it("backward compatibility: keyManager=undefined allows plaintext requests", async () => {
		const app = new Hono();

		// Middleware WITHOUT keyManager (single-node mode)
		// Use hubKeyring which has spoke's public key (since it's for hub)
		app.use("/sync/*", createSyncAuthMiddleware(hubKeyring));

		app.post("/sync/test", async (c) => {
			const rawBody = c.get("rawBody");
			return c.json({ received: JSON.parse(rawBody) });
		});

		const testServer = Bun.serve({ port: 0, fetch: app.fetch });
		servers.push(testServer);
		const testPort = testServer.port;

		const requestJson = JSON.stringify({ test: "data" });
		const { signRequest } = await import("../signing.js");
		const signHeaders = await signRequest(
			spoke.privateKey,
			spoke.siteId,
			"POST",
			"/sync/test",
			requestJson,
		);

		const response = await fetch(`http://localhost:${testPort}/sync/test`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// No X-Encryption
				...signHeaders,
			},
			body: requestJson,
		});

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.received.test).toBe("data");
	});
});
