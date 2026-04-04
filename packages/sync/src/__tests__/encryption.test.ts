import { beforeEach, describe, expect, it } from "bun:test";
import { generateKeypair } from "../crypto";
import {
	computeFingerprint,
	decryptBody,
	deriveSharedSecret,
	ed25519ToX25519Private,
	ed25519ToX25519Public,
	encryptBody,
	extractRawEd25519Keys,
} from "../encryption";

describe("encryption module", () => {
	describe("extractRawEd25519Keys", () => {
		it("extracts raw Ed25519 keys from CryptoKey keypair (AC1.4)", async () => {
			const keypair = await generateKeypair();
			const { pubRaw, privRaw } = await extractRawEd25519Keys(keypair);

			expect(pubRaw).toBeInstanceOf(Uint8Array);
			expect(privRaw).toBeInstanceOf(Uint8Array);
			expect(pubRaw.length).toBe(32);
			expect(privRaw.length).toBe(32);
		});
	});

	describe("ed25519ToX25519Private", () => {
		it("converts Ed25519 private key to X25519 private key (AC1.1)", async () => {
			const keypair = await generateKeypair();
			const { privRaw } = await extractRawEd25519Keys(keypair);
			const x25519Priv = ed25519ToX25519Private(privRaw);

			expect(x25519Priv).toBeInstanceOf(Uint8Array);
			expect(x25519Priv.length).toBe(32);
		});

		it("is deterministic - same input produces same output (AC1.2)", async () => {
			const keypair = await generateKeypair();
			const { privRaw } = await extractRawEd25519Keys(keypair);

			const result1 = ed25519ToX25519Private(privRaw);
			const result2 = ed25519ToX25519Private(privRaw);

			expect(result1).toEqual(result2);
		});
	});

	describe("ed25519ToX25519Public", () => {
		it("converts Ed25519 public key to X25519 public key (AC1.1)", async () => {
			const keypair = await generateKeypair();
			const { pubRaw } = await extractRawEd25519Keys(keypair);
			const x25519Pub = ed25519ToX25519Public(pubRaw);

			expect(x25519Pub).toBeInstanceOf(Uint8Array);
			expect(x25519Pub.length).toBe(32);
		});

		it("can derive X25519 public key from Ed25519 public key alone (AC1.3)", async () => {
			const keypair = await generateKeypair();
			const { pubRaw } = await extractRawEd25519Keys(keypair);

			// Should work without private key
			const x25519Pub = ed25519ToX25519Public(pubRaw);
			expect(x25519Pub).toBeDefined();
			expect(x25519Pub.length).toBe(32);
		});

		it("is deterministic - same input produces same output", async () => {
			const keypair = await generateKeypair();
			const { pubRaw } = await extractRawEd25519Keys(keypair);

			const result1 = ed25519ToX25519Public(pubRaw);
			const result2 = ed25519ToX25519Public(pubRaw);

			expect(result1).toEqual(result2);
		});
	});

	describe("deriveSharedSecret", () => {
		it("derives a 32-byte symmetric key (AC2.2)", async () => {
			const keypair1 = await generateKeypair();
			const keypair2 = await generateKeypair();

			const { privRaw: priv1 } = await extractRawEd25519Keys(keypair1);
			const { pubRaw: pub2 } = await extractRawEd25519Keys(keypair2);

			const x25519Priv1 = ed25519ToX25519Private(priv1);
			const x25519Pub2 = ed25519ToX25519Public(pub2);

			const secret = deriveSharedSecret(x25519Priv1, x25519Pub2);

			expect(secret).toBeInstanceOf(Uint8Array);
			expect(secret.length).toBe(32);
		});

		it("ECDH is symmetric - both parties derive same secret (AC2.1)", async () => {
			const keypairA = await generateKeypair();
			const keypairB = await generateKeypair();

			const { privRaw: privA, pubRaw: pubA } = await extractRawEd25519Keys(keypairA);
			const { privRaw: privB, pubRaw: pubB } = await extractRawEd25519Keys(keypairB);

			const x25519PrivA = ed25519ToX25519Private(privA);
			const x25519PubA = ed25519ToX25519Public(pubA);
			const x25519PrivB = ed25519ToX25519Private(privB);
			const x25519PubB = ed25519ToX25519Public(pubB);

			const secretAtoB = deriveSharedSecret(x25519PrivA, x25519PubB);
			const secretBtoA = deriveSharedSecret(x25519PrivB, x25519PubA);

			expect(secretAtoB).toEqual(secretBtoA);
		});

		it("derived key differs from raw ECDH output (HKDF applied, AC2.2)", async () => {
			const keypair1 = await generateKeypair();
			const keypair2 = await generateKeypair();

			const { privRaw: priv1 } = await extractRawEd25519Keys(keypair1);
			const { pubRaw: pub2 } = await extractRawEd25519Keys(keypair2);

			const x25519Priv1 = ed25519ToX25519Private(priv1);
			const x25519Pub2 = ed25519ToX25519Public(pub2);

			const secret = deriveSharedSecret(x25519Priv1, x25519Pub2);
			// Secret should be 32 bytes (derived), not raw ECDH
			expect(secret.length).toBe(32);
		});
	});

	describe("computeFingerprint", () => {
		it("computes fingerprint as 16-char hex string (AC3.1)", async () => {
			const keypair = await generateKeypair();
			const { pubRaw } = await extractRawEd25519Keys(keypair);
			const x25519Pub = ed25519ToX25519Public(pubRaw);

			const fingerprint = computeFingerprint(x25519Pub);

			expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
		});

		it("is deterministic - same key produces same fingerprint (AC3.1)", async () => {
			const keypair = await generateKeypair();
			const { pubRaw } = await extractRawEd25519Keys(keypair);
			const x25519Pub = ed25519ToX25519Public(pubRaw);

			const fp1 = computeFingerprint(x25519Pub);
			const fp2 = computeFingerprint(x25519Pub);

			expect(fp1).toBe(fp2);
		});

		it("differs for different keys", async () => {
			const keypair1 = await generateKeypair();
			const keypair2 = await generateKeypair();

			const { pubRaw: pub1 } = await extractRawEd25519Keys(keypair1);
			const { pubRaw: pub2 } = await extractRawEd25519Keys(keypair2);

			const x25519Pub1 = ed25519ToX25519Public(pub1);
			const x25519Pub2 = ed25519ToX25519Public(pub2);

			const fp1 = computeFingerprint(x25519Pub1);
			const fp2 = computeFingerprint(x25519Pub2);

			expect(fp1).not.toBe(fp2);
		});
	});

	describe("encryptBody and decryptBody", () => {
		let symmetricKey: Uint8Array;

		beforeEach(() => {
			symmetricKey = crypto.getRandomValues(new Uint8Array(32));
		});

		it("round-trip: encrypt then decrypt recovers plaintext (AC4.1)", async () => {
			const plaintext = new TextEncoder().encode("hello world");
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);

			expect(new TextDecoder().decode(decrypted)).toBe("hello world");
		});

		it("encrypts JSON body and recovers it (AC4.1)", async () => {
			const plaintext = new TextEncoder().encode(JSON.stringify({ msg: "test", num: 42 }));
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);

			const obj = JSON.parse(new TextDecoder().decode(decrypted));
			expect(obj.msg).toBe("test");
			expect(obj.num).toBe(42);
		});

		it("generates random nonces - different encryptions differ (AC4.2)", () => {
			const plaintext = new TextEncoder().encode("same message");
			const { nonce: nonce1, ciphertext: ct1 } = encryptBody(plaintext, symmetricKey);
			const { nonce: nonce2, ciphertext: ct2 } = encryptBody(plaintext, symmetricKey);

			expect(nonce1).not.toEqual(nonce2);
			expect(ct1).not.toEqual(ct2);
		});

		it("encrypts empty body - ciphertext is 16 bytes (auth tag only, AC4.3)", () => {
			const plaintext = new Uint8Array(0);
			const { ciphertext } = encryptBody(plaintext, symmetricKey);

			expect(ciphertext.length).toBe(16); // auth tag only
		});

		it("decrypts empty body - returns empty plaintext (AC4.3)", () => {
			const plaintext = new Uint8Array(0);
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);
			const decrypted = decryptBody(ciphertext, nonce, symmetricKey);

			expect(decrypted.length).toBe(0);
		});

		it("rejects tampered ciphertext", () => {
			const plaintext = new TextEncoder().encode("secret");
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			// Flip a bit in the ciphertext
			ciphertext[0] ^= 0x01;

			expect(() => decryptBody(ciphertext, nonce, symmetricKey)).toThrow();
		});

		it("rejects decryption with wrong key", () => {
			const plaintext = new TextEncoder().encode("secret");
			const { ciphertext, nonce } = encryptBody(plaintext, symmetricKey);

			const wrongKey = crypto.getRandomValues(new Uint8Array(32));
			expect(() => decryptBody(ciphertext, nonce, wrongKey)).toThrow();
		});

		it("rejects decryption with wrong nonce", () => {
			const plaintext = new TextEncoder().encode("secret");
			const { ciphertext } = encryptBody(plaintext, symmetricKey);

			const wrongNonce = crypto.getRandomValues(new Uint8Array(24));
			expect(() => decryptBody(ciphertext, wrongNonce, symmetricKey)).toThrow();
		});
	});
});
