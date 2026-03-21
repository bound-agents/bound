import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deriveSiteId,
	ensureKeypair,
	exportPrivateKey,
	exportPublicKey,
	generateKeypair,
	importPrivateKey,
	importPublicKey,
} from "../crypto";

describe("crypto module", () => {
	let testDataDir: string;

	beforeEach(() => {
		testDataDir = join(tmpdir(), `bound-test-${Date.now()}-${Math.random()}`);
	});

	afterEach(() => {
		if (existsSync(testDataDir)) {
			rmSync(testDataDir, { recursive: true });
		}
	});

	describe("generateKeypair", () => {
		it("generates an Ed25519 keypair", async () => {
			const { publicKey, privateKey } = await generateKeypair();
			expect(publicKey).toBeDefined();
			expect(privateKey).toBeDefined();
			expect(publicKey.type).toBe("public");
			expect(privateKey.type).toBe("private");
			expect(publicKey.algorithm.name).toBe("Ed25519");
			expect(privateKey.algorithm.name).toBe("Ed25519");
		});
	});

	describe("exportPublicKey and importPublicKey", () => {
		it("exports public key as base64-encoded SPKI with prefix", async () => {
			const { publicKey } = await generateKeypair();
			const encoded = await exportPublicKey(publicKey);
			expect(encoded).toMatch(/^ed25519:.+$/);
		});

		it("reimports exported public key", async () => {
			const { publicKey: original } = await generateKeypair();
			const encoded = await exportPublicKey(original);
			const reimported = await importPublicKey(encoded);
			expect(reimported.type).toBe("public");
			expect(reimported.algorithm.name).toBe("Ed25519");
		});

		it("rejects public key without prefix", async () => {
			await expect(importPublicKey("no-prefix")).rejects.toThrow("Invalid public key format");
		});
	});

	describe("exportPrivateKey and importPrivateKey", () => {
		it("exports private key as PKCS#8 bytes", async () => {
			const { privateKey } = await generateKeypair();
			const bytes = await exportPrivateKey(privateKey);
			expect(bytes).toBeInstanceOf(Uint8Array);
			expect(bytes.length).toBeGreaterThan(0);
		});

		it("reimports exported private key", async () => {
			const { privateKey: original } = await generateKeypair();
			const bytes = await exportPrivateKey(original);
			const reimported = await importPrivateKey(bytes);
			expect(reimported.type).toBe("private");
			expect(reimported.algorithm.name).toBe("Ed25519");
		});
	});

	describe("deriveSiteId", () => {
		it("produces a 32-character hex string (16 bytes)", async () => {
			const { publicKey } = await generateKeypair();
			const siteId = await deriveSiteId(publicKey);
			expect(siteId).toMatch(/^[0-9a-f]{32}$/);
		});

		it("is deterministic for the same key", async () => {
			const { publicKey } = await generateKeypair();
			const siteId1 = await deriveSiteId(publicKey);
			const siteId2 = await deriveSiteId(publicKey);
			expect(siteId1).toBe(siteId2);
		});

		it("differs for different keys", async () => {
			const { publicKey: key1 } = await generateKeypair();
			const { publicKey: key2 } = await generateKeypair();
			const siteId1 = await deriveSiteId(key1);
			const siteId2 = await deriveSiteId(key2);
			expect(siteId1).not.toBe(siteId2);
		});
	});

	describe("ensureKeypair", () => {
		it("generates new keypair on first call", async () => {
			const result = await ensureKeypair(testDataDir);
			expect(result.publicKey).toBeDefined();
			expect(result.privateKey).toBeDefined();
			expect(result.siteId).toMatch(/^[0-9a-f]{32}$/);
		});

		it("creates host.key and host.pub files", async () => {
			await ensureKeypair(testDataDir);
			const keyPath = join(testDataDir, "host.key");
			const pubPath = join(testDataDir, "host.pub");
			expect(existsSync(keyPath)).toBe(true);
			expect(existsSync(pubPath)).toBe(true);
		});

		it("creates host.key with restrictive permissions (0600)", async () => {
			await ensureKeypair(testDataDir);
			const keyPath = join(testDataDir, "host.key");
			const stat = require("node:fs").statSync(keyPath);
			const mode = stat.mode & 0o777;
			expect(mode).toBe(0o600);
		});

		it("reuses existing keypair on second call", async () => {
			const result1 = await ensureKeypair(testDataDir);
			const result2 = await ensureKeypair(testDataDir);
			expect(result1.siteId).toBe(result2.siteId);
		});

		it("derives the same site_id from reloaded keypair", async () => {
			const { siteId: originalSiteId } = await ensureKeypair(testDataDir);
			const { siteId: reloadedSiteId } = await ensureKeypair(testDataDir);
			expect(originalSiteId).toBe(reloadedSiteId);
		});
	});

	describe("round-trip export/import", () => {
		it("preserves keypair through export and reimport", async () => {
			const { publicKey, privateKey } = await generateKeypair();
			const originalSiteId = await deriveSiteId(publicKey);

			const pubEncoded = await exportPublicKey(publicKey);
			const privBytes = await exportPrivateKey(privateKey);

			const reimportedPub = await importPublicKey(pubEncoded);
			await importPrivateKey(privBytes);

			const reimportedSiteId = await deriveSiteId(reimportedPub);
			expect(originalSiteId).toBe(reimportedSiteId);
		});
	});
});
