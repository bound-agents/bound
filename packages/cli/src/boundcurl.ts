#!/usr/bin/env bun
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { KeyringConfig } from "@bound/shared";
import { ensureKeypair } from "@bound/sync";
import { KeyManager, SyncTransport } from "@bound/sync";
import { decryptBody } from "@bound/sync";

export function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Resolves target peer siteId from --peer flag or by matching URL against keyring hosts.
 * Returns the resolved siteId or null if not found.
 */
export function resolvePeerSiteId(
	args: string[],
	url: string | undefined,
	keyring: KeyringConfig,
): string | null {
	const peer = getArgValue(args, "--peer");
	let targetSiteId = peer || null;

	if (!targetSiteId && url) {
		// Try to find peer by URL match in keyring
		for (const [hostId, hostConfig] of Object.entries(keyring.hosts)) {
			if (url.startsWith((hostConfig as { url: string }).url)) {
				targetSiteId = hostId;
				break;
			}
		}
	}

	return targetSiteId;
}

/**
 * Splits nonce and ciphertext from input buffer.
 * If nonceHex is provided, uses explicit nonce and treats entire input as ciphertext.
 * Otherwise, extracts first 24 bytes as nonce and remainder as ciphertext.
 * Throws if input is too short for nonce-prefixed mode.
 */
export function splitNonceAndCiphertext(
	input: Uint8Array,
	nonceHex?: string,
): { nonce: Uint8Array; ciphertext: Uint8Array } {
	if (nonceHex) {
		// Explicit nonce: entire input is ciphertext
		const nonce = Buffer.from(nonceHex, "hex");
		const ciphertext = input;
		return { nonce, ciphertext };
	}

	// Nonce-prefixed: first 24 bytes are nonce, remainder is ciphertext
	if (input.length < 24) {
		throw new Error("Input too short: need at least 24 bytes for nonce");
	}

	const nonce = input.slice(0, 24);
	const ciphertext = input.slice(24);
	return { nonce, ciphertext };
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		printUsage();
		process.exit(0);
	}

	const configDir = getArgValue(args, "--config-dir") || "config";
	const dataDir = getArgValue(args, "--data-dir") || "data";

	// Load keypair
	const keypair = await ensureKeypair(dataDir);

	// Load keyring
	const keyringPath = resolve(configDir, "keyring.json");
	let keyring: KeyringConfig;
	try {
		keyring = JSON.parse(readFileSync(keyringPath, "utf-8")) as KeyringConfig;
	} catch {
		console.error(`Failed to load keyring from ${keyringPath}`);
		process.exit(1);
	}

	// Initialize KeyManager
	const keyManager = new KeyManager(keypair, keypair.siteId);
	await keyManager.init(keyring);

	if (args.includes("--decrypt")) {
		await decryptMode(args, keyManager);
	} else {
		await requestMode(args, keypair, keyManager, keyring);
	}
}

async function requestMode(
	args: string[],
	keypair: { publicKey: CryptoKey; privateKey: CryptoKey; siteId: string },
	keyManager: KeyManager,
	keyring: KeyringConfig,
) {
	// Parse: boundcurl METHOD URL [--data BODY] [--peer SITE_ID]
	const method = args.find((a) => !a.startsWith("-") && a === a.toUpperCase()) || "GET";
	const url = args.find((a) => a.startsWith("http://") || a.startsWith("https://"));
	const data = getArgValue(args, "--data") || getArgValue(args, "-d") || "";

	if (!url) {
		console.error(
			"Error: URL required. Usage: boundcurl POST http://hub:3000/sync/pull --data '{...}'",
		);
		process.exit(1);
	}

	// Resolve peer siteId — if not provided, try to resolve from URL and keyring
	const targetSiteId = resolvePeerSiteId(args, url, keyring);
	if (!targetSiteId) {
		console.error("Error: Could not resolve target peer. Use --peer SITE_ID.");
		process.exit(1);
	}

	const transport = new SyncTransport(keyManager, keypair.privateKey, keypair.siteId);
	const path = new URL(url).pathname;

	try {
		const response = await transport.send(method, url, path, data, targetSiteId);
		// Pretty-print JSON response
		try {
			const json = JSON.parse(response.body);
			console.log(JSON.stringify(json, null, 2));
		} catch {
			console.log(response.body);
		}
		process.exit(response.status >= 400 ? 1 : 0);
	} catch (err) {
		console.error("Request failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

async function decryptMode(args: string[], keyManager: KeyManager) {
	// Parse: boundcurl --decrypt --peer SITE_ID [--nonce HEX]
	const peer = getArgValue(args, "--peer");
	const nonceHex = getArgValue(args, "--nonce");

	if (!peer) {
		console.error("Error: --peer SITE_ID required for decrypt mode.");
		process.exit(1);
	}

	const symmetricKey = keyManager.getSymmetricKey(peer);
	if (!symmetricKey) {
		console.error(`Error: No shared secret for peer ${peer}. Check keyring.json.`);
		process.exit(1);
	}

	// Read stdin
	const chunks: Uint8Array[] = [];
	const reader = Bun.stdin.stream().getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const input = Buffer.concat(chunks);

	let nonce: Uint8Array;
	let ciphertext: Uint8Array;

	try {
		const split = splitNonceAndCiphertext(input, nonceHex);
		nonce = split.nonce;
		ciphertext = split.ciphertext;
	} catch (err) {
		console.error("Error:", err instanceof Error ? err.message : err);
		process.exit(1);
	}

	try {
		const plaintext = decryptBody(ciphertext, nonce, symmetricKey);
		const text = new TextDecoder().decode(plaintext);
		// Pretty-print if JSON
		try {
			console.log(JSON.stringify(JSON.parse(text), null, 2));
		} catch {
			process.stdout.write(text);
		}
	} catch (err) {
		console.error("Decryption failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

function printUsage() {
	console.log(`boundcurl — Authenticated encrypted sync endpoint diagnostic tool

Usage:
  boundcurl METHOD URL [options]           Send encrypted request
  boundcurl --decrypt --peer ID [options]  Decrypt captured traffic

Request mode:
  boundcurl POST http://hub:3000/sync/pull --data '{"since_hlc":""}'
  boundcurl POST http://hub:3000/sync/push --data '...' --peer abc123

Decrypt mode:
  cat captured.bin | boundcurl --decrypt --peer abc123
  cat captured.bin | boundcurl --decrypt --peer abc123 --nonce deadbeef...

Options:
  --data, -d BODY     Request body (JSON string)
  --peer SITE_ID      Target peer site ID (auto-resolved from URL if omitted)
  --decrypt           Decrypt mode: read ciphertext from stdin
  --nonce HEX         Explicit nonce (48 hex chars). Without this, first 24 bytes of stdin are nonce.
  --config-dir DIR    Config directory (default: "config")
  --data-dir DIR      Data directory (default: "data")
  --help, -h          Show this help`);
}

// Only run main if this is the entry point (not imported as a module)
if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal:", err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
