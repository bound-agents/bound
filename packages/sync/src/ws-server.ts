import type { KeyringConfig, Logger, Result } from "@bound/shared";
import { err, ok } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { verifyRequest } from "./signing.js";

/**
 * Per-connection metadata attached to a WebSocket connection.
 * Contains authentication info and backpressure state for the sync protocol.
 */
export interface WsConnectionData {
	siteId: string;
	symmetricKey: Uint8Array;
	fingerprint: string;
	sendState: "ready" | "pressured";
	pendingDrain: (() => void) | null;
}

/**
 * Authenticates a WebSocket upgrade request from a spoke.
 * Adapts the sync auth middleware pipeline for WS upgrade context:
 * 1. Validate Ed25519 signature headers
 * 2. Lookup symmetric key via KeyManager
 * 3. Lookup fingerprint via KeyManager
 * 4. Return populated WsConnectionData on success
 *
 * The WS upgrade request has no body (empty string ""),
 * method "GET", path "/sync/ws".
 */
export async function authenticateWsUpgrade(
	request: Request,
	keyring: KeyringConfig,
	keyManager: KeyManager,
	logger?: Logger,
): Promise<Result<WsConnectionData, { status: number; body: string }>> {
	const method = "GET";
	const path = "/sync/ws";
	const body = "";

	// Extract headers (case-insensitive lookup)
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});

	// Step 1: Verify signature headers
	const verifyResult = await verifyRequest(keyring, method, path, headers, body);
	if (!verifyResult.ok) {
		const error = verifyResult.error;
		let statusCode: 401 | 403 | 408;

		if (error.code === "unknown_site") {
			statusCode = 403;
		} else if (error.code === "invalid_signature") {
			statusCode = 401;
		} else if (error.code === "stale_timestamp") {
			statusCode = 408;
		} else {
			statusCode = 401; // Fallback for unknown error codes
		}

		logger?.warn("WS upgrade signature verification failed", {
			error: error.code,
			message: error.message,
		});

		return err({ status: statusCode, body: error.message });
	}

	const { siteId } = verifyResult.value;

	// Step 2: Look up symmetric key via KeyManager
	const symmetricKey = keyManager.getSymmetricKey(siteId);
	if (!symmetricKey) {
		logger?.warn("WS upgrade: symmetric key not found", { siteId });
		return err({
			status: 403,
			body: `Symmetric key not found for site ${siteId}`,
		});
	}

	// Step 3: Look up fingerprint via KeyManager
	const fingerprint = keyManager.getFingerprint(siteId);
	if (!fingerprint) {
		logger?.warn("WS upgrade: fingerprint not found", { siteId });
		return err({
			status: 403,
			body: `Fingerprint not found for site ${siteId}`,
		});
	}

	// Step 4: Return success with populated WsConnectionData
	const connectionData: WsConnectionData = {
		siteId,
		symmetricKey,
		fingerprint,
		sendState: "ready",
		pendingDrain: null,
	};

	logger?.debug("WS upgrade authenticated", { siteId, fingerprint });

	return ok(connectionData);
}
