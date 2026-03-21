import { CryptoHasher } from "bun";
import type { KeyringConfig, Result } from "@bound/shared";
import { err, ok } from "@bound/shared";

export interface SignatureError {
	code: "unknown_site" | "invalid_signature" | "stale_timestamp";
	message: string;
}

const VERSION = "0.0.1";
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const CLOCK_SKEW_THRESHOLD_S = 30; // 30 seconds

export async function signRequest(
	privateKey: CryptoKey,
	siteId: string,
	method: string,
	path: string,
	body: string,
): Promise<{
	"X-Site-Id": string;
	"X-Timestamp": string;
	"X-Signature": string;
	"X-Agent-Version": string;
}> {
	const timestamp = new Date().toISOString();
	const bodyHash = new CryptoHasher("sha256");
	bodyHash.update(body);
	const bodyHashHex = Buffer.from(bodyHash.digest()).toString("hex");

	const signingBase = `${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
	const signingBaseBytes = new TextEncoder().encode(signingBase);
	const signatureBytes = await crypto.subtle.sign(
		"Ed25519",
		privateKey,
		signingBaseBytes,
	);
	const signatureHex = Buffer.from(signatureBytes).toString("hex");

	return {
		"X-Site-Id": siteId,
		"X-Timestamp": timestamp,
		"X-Signature": signatureHex,
		"X-Agent-Version": VERSION,
	};
}

export async function verifyRequest(
	keyring: KeyringConfig,
	method: string,
	path: string,
	headers: Record<string, string>,
	body: string,
): Promise<Result<{ siteId: string; hostName: string }, SignatureError>> {
	const siteId = headers["X-Site-Id"];
	const timestamp = headers["X-Timestamp"];
	const signature = headers["X-Signature"];

	if (!siteId || !timestamp || !signature) {
		return err({
			code: "unknown_site",
			message: "Missing required signature headers",
		});
	}

	// Find host by siteId
	let hostName: string | null = null;
	let publicKeyEncoded: string | null = null;
	for (const [name, hostConfig] of Object.entries(
		keyring.hosts as Record<
			string,
			{ public_key: string; url: string }
		>,
	)) {
		if (name === siteId) {
			hostName = name;
			publicKeyEncoded = hostConfig.public_key;
			break;
		}
	}

	if (!hostName || !publicKeyEncoded) {
		return err({
			code: "unknown_site",
			message: `Site ID '${siteId}' not found in keyring`,
		});
	}

	// Check timestamp freshness
	const remoteTime = new Date(timestamp).getTime();
	const localTime = new Date().getTime();
	const timeDiff = Math.abs(localTime - remoteTime);
	if (timeDiff > TIMESTAMP_TOLERANCE_MS) {
		return err({
			code: "stale_timestamp",
			message: `Timestamp difference: ${timeDiff}ms exceeds tolerance of ${TIMESTAMP_TOLERANCE_MS}ms`,
		});
	}

	// Reconstruct and verify signature
	const bodyHasher = new CryptoHasher("sha256");
	bodyHasher.update(body);
	const bodyHashHex = Buffer.from(bodyHasher.digest()).toString("hex");

	const signingBase = `${method}\n${path}\n${timestamp}\n${bodyHashHex}`;
	const signingBaseBytes = new TextEncoder().encode(signingBase);
	const signatureBytes = Buffer.from(signature, "hex");

	try {
		const publicKey = await crypto.subtle.importKey(
			"spki",
			Buffer.from(publicKeyEncoded.slice("ed25519:".length), "base64"),
			"Ed25519",
			true,
			["verify"],
		);

		const isValid = await crypto.subtle.verify(
			"Ed25519",
			publicKey,
			signatureBytes,
			signingBaseBytes,
		);

		if (!isValid) {
			return err({
				code: "invalid_signature",
				message: "Signature verification failed",
			});
		}

		return ok({ siteId, hostName });
	} catch (_error) {
		return err({
			code: "invalid_signature",
			message: "Failed to verify signature",
		});
	}
}

export function detectClockSkew(
	localTimestamp: string,
	remoteTimestamp: string,
): number | null {
	const localTime = new Date(localTimestamp).getTime();
	const remoteTime = new Date(remoteTimestamp).getTime();
	const skewMs = Math.abs(localTime - remoteTime);
	const skewS = skewMs / 1000;

	if (skewS > CLOCK_SKEW_THRESHOLD_S) {
		return skewS;
	}

	return null;
}
