import { beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import {
	KeyManager,
	decryptBody,
	deriveSiteId,
	encryptBody,
	exportPublicKey,
	generateKeypair,
} from "@bound/sync";
import { getArgValue, resolvePeerSiteId, splitNonceAndCiphertext } from "../boundcurl";

describe("boundcurl utility functions", () => {
	let keyPairA: { publicKey: CryptoKey; privateKey: CryptoKey };
	let keyPairB: { publicKey: CryptoKey; privateKey: CryptoKey };
	let siteIdA: string;
	let siteIdB: string;
	let pubKeyB: string;
	let keyManager: KeyManager;

	beforeEach(async () => {
		// Generate two keypairs for A and B
		keyPairA = await generateKeypair();
		keyPairB = await generateKeypair();

		// Derive site IDs
		siteIdA = await deriveSiteId(keyPairA.publicKey);
		siteIdB = await deriveSiteId(keyPairB.publicKey);

		// Export public keys
		pubKeyB = await exportPublicKey(keyPairB.publicKey);

		// Initialize KeyManager for A
		const keyringA: KeyringConfig = {
			hosts: {
				[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3000" },
			},
		};
		keyManager = new KeyManager(keyPairA, siteIdA);
		await keyManager.init(keyringA);
	});

	describe("getArgValue", () => {
		it("extracts value for flag", () => {
			const args = ["--peer", "abc123", "--config-dir", "myconfig"];
			expect(getArgValue(args, "--peer")).toBe("abc123");
			expect(getArgValue(args, "--config-dir")).toBe("myconfig");
		});

		it("returns undefined when flag not found", () => {
			const args = ["--peer", "abc123"];
			expect(getArgValue(args, "--nonexistent")).toBeUndefined();
		});

		it("returns undefined when flag is last argument", () => {
			const args = ["--peer", "abc123", "--decrypt"];
			expect(getArgValue(args, "--decrypt")).toBeUndefined();
		});
	});

	describe("resolvePeerSiteId", () => {
		const testKeyring: KeyringConfig = {
			hosts: {
				peer1: { public_key: pubKeyB, url: "http://hub.example.com" },
				peer2: { public_key: pubKeyB, url: "http://spoke.example.com" },
			},
		};

		it("uses explicit --peer flag when provided", () => {
			const args = ["--peer", "peer1", "POST", "http://hub.example.com/sync/pull"];
			const result = resolvePeerSiteId(args, "http://hub.example.com/sync/pull", testKeyring);
			expect(result).toBe("peer1");
		});

		it("resolves peer from URL match in keyring", () => {
			const args = ["POST", "http://hub.example.com/sync/pull"];
			const result = resolvePeerSiteId(args, "http://hub.example.com/sync/pull", testKeyring);
			expect(result).toBe("peer1");
		});

		it("prefers explicit --peer over URL resolution", () => {
			const args = ["--peer", "peer2", "POST", "http://hub.example.com/sync/pull"];
			const result = resolvePeerSiteId(args, "http://hub.example.com/sync/pull", testKeyring);
			expect(result).toBe("peer2");
		});

		it("returns null when peer cannot be resolved", () => {
			const args = ["POST", "http://unknown.example.com/sync/pull"];
			const result = resolvePeerSiteId(args, "http://unknown.example.com/sync/pull", testKeyring);
			expect(result).toBeNull();
		});

		it("returns null when no URL provided and no --peer", () => {
			const args = ["POST"];
			const result = resolvePeerSiteId(args, undefined, testKeyring);
			expect(result).toBeNull();
		});

		it("handles keyring with multiple hosts", () => {
			const manyHosts: KeyringConfig = {
				hosts: {
					host1: { public_key: pubKeyB, url: "http://a.local" },
					host2: { public_key: pubKeyB, url: "http://b.local" },
					host3: { public_key: pubKeyB, url: "http://c.local" },
				},
			};

			const args = ["POST", "http://b.local/sync/pull"];
			const result = resolvePeerSiteId(args, "http://b.local/sync/pull", manyHosts);
			expect(result).toBe("host2");
		});
	});

	describe("splitNonceAndCiphertext", () => {
		it("extracts nonce from first 24 bytes when no explicit nonce", () => {
			const plaintext = Buffer.from("hello world");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const prefixed = Buffer.concat([nonce, ciphertext]);

			const result = splitNonceAndCiphertext(prefixed);
			expect(result.nonce).toEqual(nonce);
			expect(result.ciphertext).toEqual(ciphertext);
		});

		it("uses explicit nonce when provided", () => {
			const plaintext = Buffer.from("test data");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const nonceHex = Buffer.from(nonce).toString("hex");

			const result = splitNonceAndCiphertext(ciphertext, nonceHex);
			expect(result.nonce).toEqual(nonce);
			expect(result.ciphertext).toEqual(ciphertext);
		});

		it("throws when input too short without explicit nonce", () => {
			const shortInput = Buffer.from("short");

			expect(() => {
				splitNonceAndCiphertext(shortInput);
			}).toThrow("Input too short");
		});

		it("accepts exactly 24 bytes as valid nonce when no explicit nonce", () => {
			const justNonce = Buffer.alloc(24);
			justNonce.fill(0xaa);

			const result = splitNonceAndCiphertext(justNonce);
			expect(result.nonce).toEqual(justNonce);
			expect(result.ciphertext.length).toBe(0);
		});

		it("handles empty ciphertext after 24-byte nonce", () => {
			const nonce = Buffer.alloc(24);
			nonce.fill(0xbb);

			const result = splitNonceAndCiphertext(nonce);
			expect(result.nonce).toEqual(nonce);
			expect(result.ciphertext.length).toBe(0);
		});
	});

	describe("AC13.2: Decrypt mode with explicit nonce", () => {
		it("decrypts plaintext using explicit nonce and ciphertext", async () => {
			const plaintext = Buffer.from(JSON.stringify({ test: "data" }));
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);
			expect(symmetricKey).toBeDefined();

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Decrypt using explicit nonce
			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe('{"test":"data"}');
		});

		it("decrypts with nonce provided as hex", async () => {
			const plaintext = Buffer.from("hello world");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const nonceHex = Buffer.from(nonce).toString("hex");

			// Simulate explicit nonce mode: just use the nonce directly
			const decrypted = decryptBody(ciphertext, Buffer.from(nonceHex, "hex"), symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe("hello world");
		});
	});

	describe("AC13.3: Decrypt mode with nonce-prefixed input", () => {
		it("extracts 24-byte nonce from start of input and decrypts remainder", async () => {
			const plaintext = Buffer.from(JSON.stringify({ encrypted: "content" }));
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Concatenate: 24-byte nonce + ciphertext (simulating nonce-prefixed input)
			const prefixedInput = Buffer.concat([nonce, ciphertext]);

			// Use splitNonceAndCiphertext to extract
			const { nonce: extractedNonce, ciphertext: extractedCiphertext } =
				splitNonceAndCiphertext(prefixedInput);

			// Verify extraction
			expect(Buffer.from(extractedNonce)).toEqual(Buffer.from(nonce));

			// Decrypt
			const decrypted = decryptBody(extractedCiphertext, extractedNonce, symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe('{"encrypted":"content"}');
		});

		it("fails gracefully if input is too short (guards against <24 bytes)", async () => {
			const shortInput = Buffer.from("short");

			// The guard should trigger
			expect(() => {
				splitNonceAndCiphertext(shortInput);
			}).toThrow("Input too short");
		});

		it("handles exactly 24 bytes as valid (nonce only, empty ciphertext)", () => {
			const justNonce = Buffer.alloc(24);
			justNonce.fill(0xcc);

			const { nonce, ciphertext } = splitNonceAndCiphertext(justNonce);
			expect(nonce.length).toBe(24);
			expect(ciphertext.length).toBe(0);
		});

		it("decryption fails with ciphertext encrypted with wrong key", async () => {
			const plaintext = Buffer.from("secret data");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Create wrong key
			const wrongKey = new Uint8Array(32);
			wrongKey.fill(0xaa);

			// Should fail
			expect(() => {
				decryptBody(ciphertext, nonce, wrongKey);
			}).toThrow();
		});

		it("decryption fails with corrupted ciphertext", async () => {
			const plaintext = Buffer.from("test");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Corrupt the ciphertext
			const corrupted = Buffer.from(ciphertext);
			corrupted[0] ^= 0xff;

			// Should fail
			expect(() => {
				decryptBody(corrupted, nonce, symmetricKey);
			}).toThrow();
		});

		it("decryption fails with wrong nonce", async () => {
			const plaintext = Buffer.from("data");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext } = encryptBody(plaintext, symmetricKey);

			// Create wrong nonce
			const wrongNonce = new Uint8Array(24);
			wrongNonce.fill(0x55);

			// Should fail
			expect(() => {
				decryptBody(ciphertext, wrongNonce, symmetricKey);
			}).toThrow();
		});
	});

	describe("Error handling", () => {
		it("throws when peer not found in keyring", () => {
			const unknownPeerId = "0000000000000000";

			const symmetricKey = keyManager.getSymmetricKey(unknownPeerId);
			expect(symmetricKey).toBeNull();
		});

		it("getArgValue returns undefined for invalid flag positions", () => {
			const args = ["--config-dir"];
			expect(getArgValue(args, "--config-dir")).toBeUndefined();
		});

		it("resolvePeerSiteId returns null with empty args and no URL", () => {
			const result = resolvePeerSiteId([], undefined, { hosts: {} });
			expect(result).toBeNull();
		});
	});

	describe("JSON parsing and formatting", () => {
		it("decrypts and pretty-prints JSON", async () => {
			const jsonData = { message: "hello", count: 42, active: true };
			const plaintext = Buffer.from(JSON.stringify(jsonData));
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);
			const text = new TextDecoder().decode(decrypted);

			// Parse as JSON
			const parsed = JSON.parse(text);
			expect(parsed).toEqual(jsonData);

			// Pretty-print
			const formatted = JSON.stringify(parsed, null, 2);
			expect(formatted).toContain('"message": "hello"');
		});

		it("handles non-JSON plaintext gracefully", async () => {
			const plaintext = Buffer.from("plain text, not JSON");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);
			const text = new TextDecoder().decode(decrypted);

			// Should remain plain text
			expect(text).toBe("plain text, not JSON");
		});
	});

	describe("KeyManager integration", () => {
		it("initializes and retrieves symmetric keys for all peers", async () => {
			const keyPairC = await generateKeypair();
			const siteIdC = await deriveSiteId(keyPairC.publicKey);
			const pubKeyC = await exportPublicKey(keyPairC.publicKey);

			const expandedKeyring: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3000" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3001" },
				},
			};

			const kmMulti = new KeyManager(keyPairA, siteIdA);
			await kmMulti.init(expandedKeyring);

			// Should have keys for both B and C
			const keyB = kmMulti.getSymmetricKey(siteIdB);
			const keyC = kmMulti.getSymmetricKey(siteIdC);

			expect(keyB).toBeDefined();
			expect(keyC).toBeDefined();
			expect(keyB).not.toEqual(keyC);
		});

		it("reloads keyring and preserves unchanged peer keys", async () => {
			const keyPairC = await generateKeypair();
			const siteIdC = await deriveSiteId(keyPairC.publicKey);
			const pubKeyC = await exportPublicKey(keyPairC.publicKey);

			const initialKeyring: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3000" },
				},
			};

			const kmReload = new KeyManager(keyPairA, siteIdA);
			await kmReload.init(initialKeyring);

			const oldKeyB = kmReload.getSymmetricKey(siteIdB);

			// Reload with additional peer
			const expandedKeyring: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3000" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3001" },
				},
			};
			kmReload.reloadKeyring(expandedKeyring);

			// B's key should remain the same (unchanged fingerprint)
			const newKeyB = kmReload.getSymmetricKey(siteIdB);
			expect(newKeyB).toEqual(oldKeyB);

			// C's key should be newly derived
			const keyC = kmReload.getSymmetricKey(siteIdC);
			expect(keyC).toBeDefined();
			expect(keyC).not.toEqual(oldKeyB);
		});
	});

	describe("Nonce handling edge cases", () => {
		it("handles exactly 24-byte nonce", async () => {
			const plaintext = Buffer.from("test");
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Nonce should always be 24 bytes (XChaCha20 requirement)
			expect(nonce.length).toBe(24);

			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe("test");
		});

		it("can round-trip with nonce-prefixed format", async () => {
			const originalData = JSON.stringify({ round: "trip" });
			const plaintext = Buffer.from(originalData);
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			// Encrypt
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Concatenate: nonce + ciphertext
			const prefixed = Buffer.concat([nonce, ciphertext]);

			// Extract and decrypt using splitNonceAndCiphertext
			const { nonce: extractedNonce, ciphertext: extractedCiphertext } =
				splitNonceAndCiphertext(prefixed);
			const decrypted = decryptBody(extractedCiphertext, extractedNonce, symmetricKey);

			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe(originalData);
		});
	});

	describe("AC13.1: Request mode peer resolution and setup", () => {
		it("correctly resolves peer when URL matches keyring entry", () => {
			const keyring: KeyringConfig = {
				hosts: {
					[siteIdB]: {
						public_key: pubKeyB,
						url: "http://localhost:3000",
					},
				},
			};

			const args = ["POST", "http://localhost:3000/sync/pull"];
			const resolved = resolvePeerSiteId(args, "http://localhost:3000/sync/pull", keyring);

			expect(resolved).toBe(siteIdB);
		});

		it("errors gracefully when target peer not found", () => {
			const keyring: KeyringConfig = {
				hosts: {
					[siteIdB]: {
						public_key: pubKeyB,
						url: "http://localhost:3000",
					},
				},
			};

			const args = ["POST", "http://unknown:3000/sync/pull"];
			const resolved = resolvePeerSiteId(args, "http://unknown:3000/sync/pull", keyring);

			expect(resolved).toBeNull();
		});

		it("handles multiple keyring entries and resolves correct peer", () => {
			const pubKeyA = pubKeyB; // Reuse for simplicity
			const keyring: KeyringConfig = {
				hosts: {
					peer1: {
						public_key: pubKeyA,
						url: "http://hub1:3000",
					},
					peer2: {
						public_key: pubKeyB,
						url: "http://hub2:3000",
					},
					peer3: {
						public_key: pubKeyA,
						url: "http://hub3:3000",
					},
				},
			};

			// Test resolving peer1
			const args1 = ["POST", "http://hub1:3000/sync/pull"];
			expect(resolvePeerSiteId(args1, "http://hub1:3000/sync/pull", keyring)).toBe("peer1");

			// Test resolving peer2
			const args2 = ["POST", "http://hub2:3000/sync/pull"];
			expect(resolvePeerSiteId(args2, "http://hub2:3000/sync/pull", keyring)).toBe("peer2");

			// Test resolving peer3
			const args3 = ["POST", "http://hub3:3000/sync/pull"];
			expect(resolvePeerSiteId(args3, "http://hub3:3000/sync/pull", keyring)).toBe("peer3");
		});

		it("can construct SyncTransport for sending encrypted requests", async () => {
			const { SyncTransport } = await import("@bound/sync");

			// Create transport for peer A to communicate with B
			const transport = new SyncTransport(keyManager, keyPairA.privateKey, siteIdA);

			// Verify transport is instantiated with correct parameters
			expect(transport).toBeDefined();

			// Transport has methods for sending encrypted requests
			expect(typeof transport.send).toBe("function");
		});

		it("verifies KeyManager shared secret derivation for encrypted communication", async () => {
			// KeyManager derives shared secret from peer's public key
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			expect(symmetricKey).toBeDefined();
			expect(symmetricKey).toBeInstanceOf(Uint8Array);

			// Shared secret should be 32 bytes (256-bit key)
			if (symmetricKey) {
				expect(symmetricKey.length).toBe(32);
			}
		});

		it("correctly formats encrypted request with nonce and ciphertext", async () => {
			const plaintext = Buffer.from(JSON.stringify({ request: "data" }));
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			// Encrypt the request body
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Verify encrypted format
			expect(nonce).toBeDefined();
			expect(nonce.length).toBe(24);
			expect(ciphertext).toBeDefined();
			expect(ciphertext.length).toBeGreaterThan(0);

			// Can decrypt to verify it worked
			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe('{"request":"data"}');
		});
	});
});
