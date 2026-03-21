import { createHash } from "node:crypto";

export function randomUUID(): string {
	return crypto.randomUUID();
}

export function deterministicUUID(namespace: string, name: string): string {
	// Create SHA-1 hash of namespace string + name string
	const hash = createHash("sha1");
	hash.update(namespace);
	hash.update(name);
	const digest = hash.digest();

	// Format as UUID v5 per RFC 4122
	// Set version bits (5) and variant bits (RFC 4122)
	digest[6] = (digest[6] & 0x0f) | 0x50;
	digest[8] = (digest[8] & 0x3f) | 0x80;

	return bytesToUuid(digest);
}

function bytesToUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join("-");
}
