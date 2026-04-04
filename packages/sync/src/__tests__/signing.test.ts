import { beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../crypto";
import { type SignatureError, detectClockSkew, signRequest, verifyRequest } from "../signing";

describe("signing module", () => {
	let siteId: string;
	let publicKey: CryptoKey;
	let privateKey: CryptoKey;
	let keyring: KeyringConfig;

	beforeEach(async () => {
		const keyPair = await generateKeypair();
		publicKey = keyPair.publicKey;
		privateKey = keyPair.privateKey;
		siteId = await deriveSiteId(publicKey);

		const publicKeyEncoded = await exportPublicKey(publicKey);
		keyring = {
			hosts: {
				[siteId]: {
					public_key: publicKeyEncoded,
					url: "http://localhost:3100",
				},
			},
		};
	});

	describe("signRequest", () => {
		it("generates required headers", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			expect(headers["X-Site-Id"]).toBe(siteId);
			expect(headers["X-Timestamp"]).toBeDefined();
			expect(headers["X-Signature"]).toBeDefined();
			expect(headers["X-Agent-Version"]).toBe("0.0.1");
		});

		it("creates a valid ISO 8601 timestamp", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			const timestamp = new Date(headers["X-Timestamp"]);
			expect(timestamp.getTime()).toBeGreaterThan(0);
		});

		it("creates hex-encoded signature", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			expect(headers["X-Signature"]).toMatch(/^[0-9a-f]+$/);
		});

		it("produces different signatures for different bodies", async () => {
			const sig1 = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			const sig2 = await signRequest(privateKey, siteId, "POST", "/sync/push", '{"a":1}');
			expect(sig1["X-Signature"]).not.toBe(sig2["X-Signature"]);
		});
	});

	describe("verifyRequest", () => {
		it("verifies a signed request", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, "{}");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.siteId).toBe(siteId);
				expect(result.value.hostName).toBe(siteId);
			}
		});

		it("rejects unknown site", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			headers["X-Site-Id"] = "unknown-site-id";
			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, "{}");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const error = result.error as SignatureError;
				expect(error.code).toBe("unknown_site");
			}
		});

		it("rejects invalid signature", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			headers["X-Signature"] = "0".repeat(128);
			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, "{}");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const error = result.error as SignatureError;
				expect(error.code).toBe("invalid_signature");
			}
		});

		it("rejects stale timestamp (older than 5 minutes)", async () => {
			const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
			const body = "{}";
			const bodyHasher = new (await import("bun")).CryptoHasher("sha256");
			bodyHasher.update(body);
			const bodyHashHex = Buffer.from(bodyHasher.digest()).toString("hex");

			const signingBase = `POST\n/sync/push\n${oldTimestamp}\n${bodyHashHex}`;
			const signingBaseBytes = new TextEncoder().encode(signingBase);
			const signatureBytes = await crypto.subtle.sign("Ed25519", privateKey, signingBaseBytes);
			const signatureHex = Buffer.from(signatureBytes).toString("hex");

			const headers = {
				"X-Site-Id": siteId,
				"X-Timestamp": oldTimestamp,
				"X-Signature": signatureHex,
			};

			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, body);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const error = result.error as SignatureError;
				expect(error.code).toBe("stale_timestamp");
			}
		});

		it("rejects request with tampered body", async () => {
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", "{}");
			const result = await verifyRequest(
				keyring,
				"POST",
				"/sync/push",
				headers,
				'{"tampered":true}',
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const error = result.error as SignatureError;
				expect(error.code).toBe("invalid_signature");
			}
		});

		it("rejects missing headers", async () => {
			const result = await verifyRequest(keyring, "POST", "/sync/push", {}, "{}");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const error = result.error as SignatureError;
				expect(error.code).toBe("unknown_site");
			}
		});
	});

	describe("detectClockSkew", () => {
		it("returns null for timestamps within 30-second threshold", () => {
			const now = new Date().toISOString();
			const skew = detectClockSkew(now, now);
			expect(skew).toBeNull();
		});

		it("returns null for timestamps 10 seconds apart", () => {
			const now = new Date().getTime();
			const local = new Date(now).toISOString();
			const remote = new Date(now + 10000).toISOString();
			const skew = detectClockSkew(local, remote);
			expect(skew).toBeNull();
		});

		it("returns skew value for timestamps 45 seconds apart", () => {
			const now = new Date().getTime();
			const local = new Date(now).toISOString();
			const remote = new Date(now + 45000).toISOString();
			const skew = detectClockSkew(local, remote);
			expect(skew).toBeGreaterThan(40);
			expect(skew).toBeLessThan(50);
		});

		it("returns skew value for timestamps 2 minutes apart", () => {
			const now = new Date().getTime();
			const local = new Date(now).toISOString();
			const remote = new Date(now + 120000).toISOString();
			const skew = detectClockSkew(local, remote);
			expect(skew).toBeGreaterThan(110);
		});

		it("returns positive skew regardless of direction", () => {
			const now = new Date().getTime();
			const local = new Date(now).toISOString();
			const remote = new Date(now - 45000).toISOString();
			const skew = detectClockSkew(local, remote);
			expect(skew).toBeGreaterThan(40);
			expect(skew).toBeLessThan(50);
		});
	});

	describe("round-trip signing and verification", () => {
		it("successfully signs and verifies multiple requests", async () => {
			const requests = [
				{ method: "POST", path: "/sync/push", body: '{"events":[]}' },
				{ method: "POST", path: "/sync/pull", body: '{"since_seq":5}' },
				{ method: "POST", path: "/sync/ack", body: '{"last_received":10}' },
			];

			for (const req of requests) {
				const headers = await signRequest(privateKey, siteId, req.method, req.path, req.body);
				const result = await verifyRequest(keyring, req.method, req.path, headers, req.body);
				expect(result.ok).toBe(true);
			}
		});
	});

	describe("signRequest with Uint8Array body", () => {
		it("binary body round-trip: sign and verify with Uint8Array", async () => {
			const binaryBody = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", binaryBody);

			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, binaryBody);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.siteId).toBe(siteId);
				expect(result.value.hostName).toBe(siteId);
			}
		});

		it("string-to-bytes equivalence: same hash for string and encoded Uint8Array", async () => {
			const stringBody = "hello world";
			const bytesBody = new TextEncoder().encode(stringBody);

			const headersString = await signRequest(privateKey, siteId, "POST", "/sync/push", stringBody);

			const headersBytes = await signRequest(privateKey, siteId, "POST", "/sync/push", bytesBody);

			expect(headersString["X-Signature"]).toBe(headersBytes["X-Signature"]);
		});

		it("empty Uint8Array round-trip", async () => {
			const emptyBody = new Uint8Array(0);
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", emptyBody);

			const result = await verifyRequest(keyring, "POST", "/sync/push", headers, emptyBody);

			expect(result.ok).toBe(true);
		});

		it("verifyRequest with Uint8Array body validates signature against binary content", async () => {
			const binaryBody = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
			const headers = await signRequest(privateKey, siteId, "POST", "/sync/push", binaryBody);

			// Verify with same binary body
			const resultMatch = await verifyRequest(keyring, "POST", "/sync/push", headers, binaryBody);
			expect(resultMatch.ok).toBe(true);

			// Verify with different binary body should fail
			const differentBody = new Uint8Array([0xaa, 0xbb, 0xcc, 0xde]);
			const resultNoMatch = await verifyRequest(
				keyring,
				"POST",
				"/sync/push",
				headers,
				differentBody,
			);
			expect(resultNoMatch.ok).toBe(false);
		});
	});
});
