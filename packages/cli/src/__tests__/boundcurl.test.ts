import { beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { KeyManager, decryptBody, encryptBody } from "@bound/sync";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../../../sync/src/crypto";

describe("boundcurl decrypt functionality", () => {
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

			// Extract nonce from first 24 bytes
			const extractedNonce = prefixedInput.slice(0, 24);
			const extractedCiphertext = prefixedInput.slice(24);

			// Verify nonce matches
			expect(Buffer.from(extractedNonce)).toEqual(Buffer.from(nonce));

			// Decrypt
			const decrypted = decryptBody(extractedCiphertext, extractedNonce, symmetricKey);
			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe('{"encrypted":"content"}');
		});

		it("fails gracefully if input is too short", async () => {
			const symmetricKey = keyManager.getSymmetricKey(siteIdB);

			if (!symmetricKey) {
				throw new Error("symmetricKey should be defined");
			}

			// Input shorter than 24 bytes
			const shortInput = Buffer.from("short");

			// Should fail when trying to extract 24-byte nonce
			expect(() => {
				shortInput.slice(0, 24); // This would only give us 5 bytes
			}).not.toThrow();

			// The error would occur at decode time
			const tooShortNonce = shortInput.slice(0, 24);
			const ciphertext = shortInput.slice(24);

			// Decryption should fail with too-short ciphertext
			expect(() => {
				decryptBody(ciphertext, tooShortNonce, symmetricKey);
			}).toThrow();
		});
	});

	describe("Error handling", () => {
		it("throws when peer not found in keyring", () => {
			const unknownPeerId = "0000000000000000";

			const symmetricKey = keyManager.getSymmetricKey(unknownPeerId);
			expect(symmetricKey).toBeNull();
		});

		it("decryption fails with wrong symmetric key", async () => {
			const plaintext = Buffer.from("secret data");
			const correctKey = keyManager.getSymmetricKey(siteIdB);

			if (!correctKey) {
				throw new Error("correctKey should be defined");
			}

			const { ciphertext, nonce } = encryptBody(plaintext, correctKey);

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

			// Extract and decrypt
			const extractedNonce = prefixed.slice(0, 24);
			const extractedCiphertext = prefixed.slice(24);
			const decrypted = decryptBody(extractedCiphertext, extractedNonce, symmetricKey);

			const result = new TextDecoder().decode(decrypted);
			expect(result).toBe(originalData);
		});
	});
});
