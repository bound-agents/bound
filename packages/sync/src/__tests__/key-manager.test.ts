import { beforeEach, describe, expect, it } from "bun:test";
import type { KeyringConfig } from "@bound/shared";
import { deriveSiteId, exportPublicKey, generateKeypair } from "../crypto";
import { KeyManager } from "../key-manager";

describe("KeyManager class", () => {
	let keyPairA: { publicKey: CryptoKey; privateKey: CryptoKey };
	let keyPairB: { publicKey: CryptoKey; privateKey: CryptoKey };
	let keyPairC: { publicKey: CryptoKey; privateKey: CryptoKey };

	let siteIdA: string;
	let siteIdB: string;
	let siteIdC: string;

	let pubKeyA: string;
	let pubKeyB: string;
	let pubKeyC: string;

	beforeEach(async () => {
		// Generate three keypairs
		keyPairA = await generateKeypair();
		keyPairB = await generateKeypair();
		keyPairC = await generateKeypair();

		// Derive site IDs
		siteIdA = await deriveSiteId(keyPairA.publicKey);
		siteIdB = await deriveSiteId(keyPairB.publicKey);
		siteIdC = await deriveSiteId(keyPairC.publicKey);

		// Export public keys
		pubKeyA = await exportPublicKey(keyPairA.publicKey);
		pubKeyB = await exportPublicKey(keyPairB.publicKey);
		pubKeyC = await exportPublicKey(keyPairC.publicKey);
	});

	describe("init", () => {
		it("initializes X25519 keys and peer secrets", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			// Should be able to get symmetric key for B
			const symmetricKey = km.getSymmetricKey(siteIdB);
			expect(symmetricKey).toBeInstanceOf(Uint8Array);
			expect(symmetricKey?.length).toBe(32);
		});

		it("computes local fingerprint on init", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const fingerprint = km.getLocalFingerprint();
			expect(fingerprint).toBeString();
			expect(fingerprint.length).toBe(16); // 8 bytes = 16 hex chars
			expect(fingerprint).toMatch(/^[0-9a-f]+$/);
		});

		it("throws on JWK export failure", async () => {
			// Create a mock keypair with an invalid privateKey
			const mockKeypair = {
				publicKey: keyPairA.publicKey,
				privateKey: {
					type: "private",
					// biome-ignore lint/suspicious/noExplicitAny: mock non-exportable CryptoKey for AC1.5 failure test
				} as any,
			};

			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(mockKeypair, siteIdA);
			expect(async () => {
				await km.init(keyringAB);
			}).toThrow();
		});

		it("accepts keyring with multiple peers", async () => {
			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringABC);

			const keyB = km.getSymmetricKey(siteIdB);
			const keyC = km.getSymmetricKey(siteIdC);

			expect(keyB).toBeInstanceOf(Uint8Array);
			expect(keyC).toBeInstanceOf(Uint8Array);
			expect(keyB?.length).toBe(32);
			expect(keyC?.length).toBe(32);

			// Keys should differ
			expect(keyB).not.toEqual(keyC);
		});

		it("excludes self from peer list", async () => {
			const keyringWithSelf: KeyringConfig = {
				hosts: {
					[siteIdA]: { public_key: pubKeyA, url: "http://localhost:3100" },
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringWithSelf);

			// Should not have self
			const selfKey = km.getSymmetricKey(siteIdA);
			expect(selfKey).toBeNull();

			// Should have peer
			const peerKey = km.getSymmetricKey(siteIdB);
			expect(peerKey).toBeInstanceOf(Uint8Array);
		});
	});

	describe("getSymmetricKey", () => {
		it("returns null for unknown siteId", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const unknownKey = km.getSymmetricKey("unknown_site_id");
			expect(unknownKey).toBeNull();
		});

		it("returns Uint8Array for known siteId", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const key = km.getSymmetricKey(siteIdB);
			expect(key).toBeInstanceOf(Uint8Array);
			expect(key?.length).toBe(32);
		});

		it("returns same key reference on repeated calls", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const key1 = km.getSymmetricKey(siteIdB);
			const key2 = km.getSymmetricKey(siteIdB);

			expect(key1).toBe(key2); // Same reference
		});
	});

	describe("getFingerprint", () => {
		it("returns null for unknown siteId", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const fingerprint = km.getFingerprint("unknown_site_id");
			expect(fingerprint).toBeNull();
		});

		it("returns 16-char hex fingerprint for known siteId", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const fingerprint = km.getFingerprint(siteIdB);
			expect(fingerprint).toBeString();
			expect(fingerprint?.length).toBe(16);
			expect(fingerprint).toMatch(/^[0-9a-f]+$/);
		});
	});

	describe("getLocalFingerprint", () => {
		it("returns 16-char hex fingerprint after init", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const fingerprint = km.getLocalFingerprint();
			expect(fingerprint).toBeString();
			expect(fingerprint.length).toBe(16);
			expect(fingerprint).toMatch(/^[0-9a-f]+$/);
		});

		it("throws before init", () => {
			const km = new KeyManager(keyPairA, siteIdA);
			expect(() => km.getLocalFingerprint()).toThrow("KeyManager not initialized");
		});

		it("local fingerprint differs from peer fingerprints", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const localFingerprint = km.getLocalFingerprint();
			const peerFingerprint = km.getFingerprint(siteIdB);

			expect(localFingerprint).not.toBe(peerFingerprint);
		});
	});

	describe("ECDH symmetry", () => {
		it("A->B and B->A produce same symmetric key", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdA]: { public_key: pubKeyA, url: "http://localhost:3100" },
				},
			};

			const keyringBA: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const kmA = new KeyManager(keyPairA, siteIdA);
			const kmB = new KeyManager(keyPairB, siteIdB);

			await kmA.init(keyringAB);
			await kmB.init(keyringBA);

			const keyAB = kmA.getSymmetricKey(siteIdB);
			const keyBA = kmB.getSymmetricKey(siteIdA);

			expect(keyAB).toEqual(keyBA);
		});

		it("fingerprints are reciprocal", async () => {
			// A needs B in its keyring, B needs A in its keyring
			const keyringA: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const keyringB: KeyringConfig = {
				hosts: {
					[siteIdA]: { public_key: pubKeyA, url: "http://localhost:3100" },
				},
			};

			const kmA = new KeyManager(keyPairA, siteIdA);
			const kmB = new KeyManager(keyPairB, siteIdB);

			await kmA.init(keyringA);
			await kmB.init(keyringB);

			const fpALocal = kmA.getLocalFingerprint();
			const fpAViaB = kmB.getFingerprint(siteIdA);

			const fpBLocal = kmB.getLocalFingerprint();
			const fpBViaA = kmA.getFingerprint(siteIdB);

			expect(fpALocal).toBe(fpAViaB);
			expect(fpBLocal).toBe(fpBViaA);
		});
	});

	describe("reloadKeyring", () => {
		it("preserves unchanged peers", async () => {
			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringABC);

			const keyB1 = km.getSymmetricKey(siteIdB);
			const keyC1 = km.getSymmetricKey(siteIdC);

			// Reload with same keyring
			km.reloadKeyring(keyringABC);

			const keyB2 = km.getSymmetricKey(siteIdB);
			const keyC2 = km.getSymmetricKey(siteIdC);

			// Same reference (not recomputed)
			expect(keyB2).toBe(keyB1);
			expect(keyC2).toBe(keyC1);
		});

		it("adds new peers", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			expect(km.getSymmetricKey(siteIdC)).toBeNull();

			km.reloadKeyring(keyringABC);

			const keyC = km.getSymmetricKey(siteIdC);
			expect(keyC).toBeInstanceOf(Uint8Array);
			expect(keyC?.length).toBe(32);
		});

		it("removes deleted peers", async () => {
			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringABC);

			expect(km.getSymmetricKey(siteIdC)).toBeInstanceOf(Uint8Array);

			km.reloadKeyring(keyringAB);

			expect(km.getSymmetricKey(siteIdC)).toBeNull();
		});

		it("recomputes changed peer keys", async () => {
			// Generate a second keypair for B with different key
			const keyPairB2 = await generateKeypair();
			const pubKeyB2 = await exportPublicKey(keyPairB2.publicKey);

			const keyringAB1: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const keyringAB2: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB2, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB1);

			const key1 = km.getSymmetricKey(siteIdB);

			km.reloadKeyring(keyringAB2);

			const key2 = km.getSymmetricKey(siteIdB);

			// Different keys (different public key for B)
			expect(key1).not.toEqual(key2);
		});

		it("throws if called before init", () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);

			expect(() => km.reloadKeyring(keyringAB)).toThrow("KeyManager not initialized");
		});

		it("handles empty keyring", async () => {
			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const emptyKeyring: KeyringConfig = {
				hosts: {},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringABC);

			km.reloadKeyring(emptyKeyring);

			expect(km.getSymmetricKey(siteIdB)).toBeNull();
			expect(km.getSymmetricKey(siteIdC)).toBeNull();
		});
	});

	describe("key derivation determinism", () => {
		it("same keypair produces same X25519 keys on repeated init", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km1 = new KeyManager(keyPairA, siteIdA);
			await km1.init(keyringAB);
			const key1 = km1.getSymmetricKey(siteIdB);
			const fp1 = km1.getLocalFingerprint();

			const km2 = new KeyManager(keyPairA, siteIdA);
			await km2.init(keyringAB);
			const key2 = km2.getSymmetricKey(siteIdB);
			const fp2 = km2.getLocalFingerprint();

			expect(key1).toEqual(key2);
			expect(fp1).toBe(fp2);
		});
	});

	describe("security properties", () => {
		it("symmetric keys are not exposed in string form", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const key = km.getSymmetricKey(siteIdB);

			// Should be Uint8Array, not string
			expect(key).toBeInstanceOf(Uint8Array);
			expect(typeof key).not.toBe("string");
		});

		it("reloadKeyring preserves internal state isolation", async () => {
			const keyringAB: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
				},
			};

			const keyringABC: KeyringConfig = {
				hosts: {
					[siteIdB]: { public_key: pubKeyB, url: "http://localhost:3101" },
					[siteIdC]: { public_key: pubKeyC, url: "http://localhost:3102" },
				},
			};

			const km = new KeyManager(keyPairA, siteIdA);
			await km.init(keyringAB);

			const keyBefore = km.getSymmetricKey(siteIdB);
			km.reloadKeyring(keyringABC);
			const keyAfter = km.getSymmetricKey(siteIdB);

			// Unchanged peer preserved
			expect(keyBefore).toBe(keyAfter);

			// New peer available
			expect(km.getSymmetricKey(siteIdC)).toBeInstanceOf(Uint8Array);
		});
	});
});
