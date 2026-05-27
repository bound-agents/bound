/**
 * Property tests for the XChaCha20-Poly1305 encryption wrapper.
 *
 * The underlying primitive (`@noble/ciphers/chacha`) is well-tested
 * upstream — these properties exist to defend the **wrapper** code
 * (nonce generation, parameter wiring, auth tag handling) from
 * regression. Past audit findings in this codebase have been wrapper
 * bugs (e.g. swapped nonce/key arguments), not primitive bugs.
 *
 * Properties:
 *
 *   E1 Round-trip — `decryptBody(encryptBody(x, k).ciphertext,
 *      encryptBody(x, k).nonce, k) === x` for any plaintext and any
 *      32-byte key.
 *
 *   E2 Authentication — `decryptBody` with a wrong key MUST throw.
 *      No silent decryption to garbage; the auth tag must be
 *      checked.
 *
 *   E3 Nonce uniqueness in tight loop — repeated `encryptBody`
 *      calls with the same plaintext + key produce DIFFERENT
 *      nonces. (XChaCha20-Poly1305's 192-bit nonce makes random
 *      generation collision-safe; this test pins the wrapper
 *      doesn't accidentally reuse a nonce.)
 *
 *   E4 Ciphertext is not the plaintext — for non-empty plaintext,
 *      ciphertext bytes never equal plaintext bytes (a sanity
 *      property catching "encrypt is a no-op" wiring bugs).
 *
 *   E5 Tampered ciphertext rejects — flipping any single byte of
 *      ciphertext or nonce causes decrypt to throw. Defends the
 *      Poly1305 auth tag wiring.
 *
 *   E6 Empty plaintext round-trips — zero-byte plaintext encrypts
 *      and decrypts back to a zero-byte plaintext. Edge case that
 *      naive wrappers sometimes return undefined / null.
 */

import { describe, it } from "bun:test";
import fc from "fast-check";
import { decryptBody, encryptBody } from "../encryption";

const symmetricKey = fc
	.uint8Array({ minLength: 32, maxLength: 32 })
	.map((arr) => new Uint8Array(arr));

const plaintext = fc
	.uint8Array({ minLength: 0, maxLength: 1024 })
	.map((arr) => new Uint8Array(arr));

const nonEmptyPlaintext = fc
	.uint8Array({ minLength: 1, maxLength: 1024 })
	.map((arr) => new Uint8Array(arr));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

describe("encryption — property tests", () => {
	it("E1: round-trip — decrypt(encrypt(x, k), k) === x", () => {
		fc.assert(
			fc.property(plaintext, symmetricKey, (pt, key) => {
				const { ciphertext, nonce } = encryptBody(pt, key);
				const decrypted = decryptBody(ciphertext, nonce, key);
				return bytesEqual(decrypted, pt);
			}),
			{ numRuns: 100 },
		);
	});

	it("E2: wrong key rejects (auth failure)", () => {
		fc.assert(
			fc.property(nonEmptyPlaintext, symmetricKey, symmetricKey, (pt, key1, key2) => {
				if (bytesEqual(key1, key2)) return true; // skip identical keys
				const { ciphertext, nonce } = encryptBody(pt, key1);
				try {
					decryptBody(ciphertext, nonce, key2);
					return false; // should have thrown
				} catch {
					return true;
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("E3: nonce uniqueness across tight-loop encrypts", () => {
		fc.assert(
			fc.property(nonEmptyPlaintext, symmetricKey, (pt, key) => {
				const seen = new Set<string>();
				for (let i = 0; i < 16; i++) {
					const { nonce } = encryptBody(pt, key);
					const hex = Buffer.from(nonce).toString("hex");
					if (seen.has(hex)) return false;
					seen.add(hex);
				}
				return true;
			}),
			{ numRuns: 50 },
		);
	});

	it("E4: ciphertext is not the plaintext", () => {
		// Stream-cipher property note: ciphertext[i] = plaintext[i] XOR keystream[i].
		// For a length-N plaintext, the prefix matches plaintext iff every one of
		// the first N keystream bytes is zero — probability 256^-N. A length-1
		// plaintext flakes at 1/256 per run, which fast-check shrinks toward
		// aggressively. minLength=16 drives the false-positive probability to
		// 256^-16 ≈ 8.6e-39 while still catching the "encrypt is a no-op"
		// wiring bug this property defends against.
		const e4Plaintext = fc
			.uint8Array({ minLength: 16, maxLength: 1024 })
			.map((arr) => new Uint8Array(arr));
		fc.assert(
			fc.property(e4Plaintext, symmetricKey, (pt, key) => {
				const { ciphertext } = encryptBody(pt, key);
				// Ciphertext may be longer (auth tag) — compare prefix.
				const prefix = ciphertext.slice(0, pt.length);
				return !bytesEqual(prefix, pt);
			}),
			{ numRuns: 100 },
		);
	});

	it("E5: tampered ciphertext rejects", () => {
		fc.assert(
			fc.property(
				nonEmptyPlaintext,
				symmetricKey,
				fc.integer({ min: 0, max: 1023 }),
				(pt, key, byteIdx) => {
					const { ciphertext, nonce } = encryptBody(pt, key);
					if (byteIdx >= ciphertext.length) return true;
					const tampered = new Uint8Array(ciphertext);
					tampered[byteIdx] = (tampered[byteIdx] + 1) & 0xff;
					try {
						decryptBody(tampered, nonce, key);
						return false; // tampered cipher must reject
					} catch {
						return true;
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	it("E5b: tampered nonce rejects", () => {
		fc.assert(
			fc.property(
				nonEmptyPlaintext,
				symmetricKey,
				fc.integer({ min: 0, max: 23 }),
				(pt, key, byteIdx) => {
					const { ciphertext, nonce } = encryptBody(pt, key);
					const tampered = new Uint8Array(nonce);
					tampered[byteIdx] = (tampered[byteIdx] + 1) & 0xff;
					try {
						decryptBody(ciphertext, tampered, key);
						return false; // tampered nonce must reject
					} catch {
						return true;
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	it("E6: empty plaintext round-trips", () => {
		fc.assert(
			fc.property(symmetricKey, (key) => {
				const empty = new Uint8Array(0);
				const { ciphertext, nonce } = encryptBody(empty, key);
				const decrypted = decryptBody(ciphertext, nonce, key);
				return decrypted.length === 0;
			}),
			{ numRuns: 50 },
		);
	});
});
