import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

const HKDF_SALT = new TextEncoder().encode("bound");
const HKDF_INFO = new TextEncoder().encode("sync-v1");
const SYMMETRIC_KEY_LENGTH = 32;

/**
 * Extract raw Ed25519 key bytes from CryptoKey objects via JWK export.
 * Returns 32-byte private seed (from JWK "d" field) and 32-byte public point (from JWK "x" field).
 */
export async function extractRawEd25519Keys(keypair: {
	publicKey: CryptoKey;
	privateKey: CryptoKey;
}): Promise<{ pubRaw: Uint8Array; privRaw: Uint8Array }> {
	const [pubJwk, privJwk] = await Promise.all([
		crypto.subtle.exportKey("jwk", keypair.publicKey),
		crypto.subtle.exportKey("jwk", keypair.privateKey),
	]);

	if (!pubJwk.x || !privJwk.d) {
		throw new Error("Failed to extract raw Ed25519 key bytes from JWK export");
	}

	const pubRaw = base64urlToBytes(pubJwk.x);
	const privRaw = base64urlToBytes(privJwk.d);
	return { pubRaw, privRaw };
}

/**
 * Convert Ed25519 public key (32 bytes) to X25519 public key (32 bytes).
 * Uses the birational map from Edwards to Montgomery form.
 */
export function ed25519ToX25519Public(ed25519PubRaw: Uint8Array): Uint8Array {
	return ed25519.utils.toMontgomery(ed25519PubRaw);
}

/**
 * Convert Ed25519 private key seed (32 bytes) to X25519 private key (32 bytes).
 * Hashes the seed and applies scalar clamping per RFC 7748.
 */
export function ed25519ToX25519Private(ed25519PrivRaw: Uint8Array): Uint8Array {
	return ed25519.utils.toMontgomerySecret(ed25519PrivRaw);
}

/**
 * Compute ECDH shared secret and derive symmetric key via HKDF-SHA256.
 * Salt: "bound", Info: "sync-v1", Output: 32 bytes.
 */
export function deriveSharedSecret(
	localX25519Priv: Uint8Array,
	peerX25519Pub: Uint8Array,
): Uint8Array {
	const rawSecret = x25519.getSharedSecret(localX25519Priv, peerX25519Pub);
	return hkdf(sha256, rawSecret, HKDF_SALT, HKDF_INFO, SYMMETRIC_KEY_LENGTH);
}

/**
 * Compute fingerprint: first 8 bytes (16 hex chars) of SHA-256 of X25519 public key.
 */
export function computeFingerprint(x25519PubRaw: Uint8Array): string {
	const hash = sha256(x25519PubRaw);
	return Buffer.from(hash.slice(0, 8)).toString("hex");
}

/**
 * Encrypt plaintext with XChaCha20-Poly1305.
 * Generates a random 24-byte nonce. Returns ciphertext (includes 16-byte auth tag) and nonce.
 */
export function encryptBody(
	plaintext: Uint8Array,
	symmetricKey: Uint8Array,
): { ciphertext: Uint8Array; nonce: Uint8Array } {
	const nonce = crypto.getRandomValues(new Uint8Array(24));
	const cipher = xchacha20poly1305(symmetricKey, nonce);
	const ciphertext = cipher.encrypt(plaintext);
	return { ciphertext, nonce };
}

/**
 * Decrypt ciphertext with XChaCha20-Poly1305.
 * Ciphertext must include 16-byte auth tag appended by encrypt.
 * Throws on authentication failure (tampered/corrupted data).
 */
export function decryptBody(
	ciphertext: Uint8Array,
	nonce: Uint8Array,
	symmetricKey: Uint8Array,
): Uint8Array {
	const cipher = xchacha20poly1305(symmetricKey, nonce);
	return cipher.decrypt(ciphertext);
}

/** Decode base64url string to Uint8Array. */
function base64urlToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
	return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}
