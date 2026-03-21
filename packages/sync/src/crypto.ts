import { CryptoHasher } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function generateKeypair(): Promise<{
	publicKey: CryptoKey;
	privateKey: CryptoKey;
}> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: "Ed25519" },
		true,
		["sign", "verify"],
	);
	return {
		publicKey: keyPair.publicKey,
		privateKey: keyPair.privateKey,
	};
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
	const spkiBuffer = await crypto.subtle.exportKey("spki", key);
	const base64 = Buffer.from(spkiBuffer).toString("base64");
	return `ed25519:${base64}`;
}

export async function exportPrivateKey(key: CryptoKey): Promise<Uint8Array> {
	const pkcs8Buffer = await crypto.subtle.exportKey("pkcs8", key);
	return new Uint8Array(pkcs8Buffer);
}

export async function importPublicKey(encoded: string): Promise<CryptoKey> {
	if (!encoded.startsWith("ed25519:")) {
		throw new Error("Invalid public key format: must start with 'ed25519:'");
	}
	const base64 = encoded.slice("ed25519:".length);
	const spkiBuffer = Buffer.from(base64, "base64");
	return crypto.subtle.importKey("spki", spkiBuffer, "Ed25519", true, [
		"verify",
	]);
}

export async function importPrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
	const buffer = Buffer.from(bytes);
	return crypto.subtle.importKey("pkcs8", buffer, "Ed25519", true, ["sign"]);
}

export async function deriveSiteId(publicKey: CryptoKey): Promise<string> {
	const spkiBuffer = await crypto.subtle.exportKey("spki", publicKey);
	const hasher = new CryptoHasher("sha256");
	hasher.update(spkiBuffer);
	const hashBytes = hasher.digest();
	const first16Bytes = hashBytes.slice(0, 16);
	return Buffer.from(first16Bytes).toString("hex");
}

export async function ensureKeypair(dataDir: string): Promise<{
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	siteId: string;
}> {
	const privateKeyPath = join(dataDir, "host.key");
	const publicKeyPath = join(dataDir, "host.pub");

	if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
		const privateKeyBytes = readFileSync(privateKeyPath);
		const publicKeyEncoded = readFileSync(publicKeyPath, "utf-8");

		const privateKey = await importPrivateKey(
			new Uint8Array(privateKeyBytes),
		);
		const publicKey = await importPublicKey(publicKeyEncoded);
		const siteId = await deriveSiteId(publicKey);

		return { publicKey, privateKey, siteId };
	}

	const { publicKey, privateKey } = await generateKeypair();
	const privateKeyBytes = await exportPrivateKey(privateKey);
	const publicKeyEncoded = await exportPublicKey(publicKey);

	mkdirSync(dataDir, { recursive: true });
	writeFileSync(privateKeyPath, privateKeyBytes, { mode: 0o600 });
	writeFileSync(publicKeyPath, publicKeyEncoded, "utf-8");

	const siteId = await deriveSiteId(publicKey);

	return { publicKey, privateKey, siteId };
}
