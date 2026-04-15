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

/**
 * Tracks active WebSocket connections by siteId.
 * Replaces disconnected spokes by closing old connections with code 1008.
 */
export class WsConnectionManager {
	private connections = new Map<string, ServerWebSocket<WsConnectionData>>();

	/**
	 * Add a connection, replacing any existing connection for this siteId.
	 * Old connections are closed with code 1008 (policy violation).
	 */
	add(siteId: string, ws: ServerWebSocket<WsConnectionData>): void {
		const existing = this.connections.get(siteId);
		if (existing) {
			existing.close(1008, "Duplicate connection");
		}
		this.connections.set(siteId, ws);
	}

	/**
	 * Remove a connection by siteId.
	 */
	remove(siteId: string): void {
		this.connections.delete(siteId);
	}

	/**
	 * Get a connection by siteId, or undefined if not found.
	 */
	get(siteId: string): ServerWebSocket<WsConnectionData> | undefined {
		return this.connections.get(siteId);
	}

	/**
	 * Get all connections as a Map.
	 */
	getAll(): Map<string, ServerWebSocket<WsConnectionData>> {
		return new Map(this.connections);
	}

	/**
	 * Check if a connection exists for this siteId.
	 */
	has(siteId: string): boolean {
		return this.connections.has(siteId);
	}

	/**
	 * Get the number of active connections.
	 */
	get size(): number {
		return this.connections.size;
	}
}

export interface WsServerConfig {
	connectionManager: WsConnectionManager;
	keyring: KeyringConfig;
	keyManager: KeyManager;
	logger?: Logger;
	idleTimeout?: number; // seconds, default 120
	backpressureLimit?: number; // bytes, default 2097152 (2MB)
}

/**
 * Create WebSocket handlers and upgrade logic for the sync server.
 * Binds keyring and keyManager at creation time, so handleUpgrade(req, server)
 * can be called without additional parameters.
 */
export function createWsHandlers(config: WsServerConfig): {
	websocket: WebSocketHandler<WsConnectionData>;
	handleUpgrade: (req: Request, server: Server) => Promise<Response | undefined>;
} {
	const {
		connectionManager,
		keyring,
		keyManager,
		logger,
		idleTimeout = 120,
		backpressureLimit = 2097152,
	} = config;

	const handleUpgrade = async (req: Request, server: Server): Promise<Response | undefined> => {
		const authResult = await authenticateWsUpgrade(req, keyring, keyManager, logger);

		if (!authResult.ok) {
			return new Response(authResult.error.body, {
				status: authResult.error.status,
			});
		}

		const upgraded = server.upgrade(req, { data: authResult.value });
		if (!upgraded) {
			logger?.warn("WS upgrade failed to upgrade connection");
			return new Response("WebSocket upgrade failed", { status: 500 });
		}

		return undefined;
	};

	const websocket: WebSocketHandler<WsConnectionData> = {
		open(ws) {
			logger?.debug("WS connection opened", { siteId: ws.data.siteId });
			connectionManager.add(ws.data.siteId, ws);
		},

		message(ws, message) {
			// Validate binary frame (reject text messages with close code 1003)
			if (typeof message === "string") {
				logger?.warn("WS received text message, closing connection", {
					siteId: ws.data.siteId,
				});
				ws.close(1003, "Text frames not supported");
				return;
			}

			// Message is Uint8Array (Buffer is a subclass)
			const frame = message as Uint8Array;
			logger?.debug("WS received binary frame", {
				siteId: ws.data.siteId,
				size: frame.length,
			});
			// Frame dispatch to handlers comes in Phase 4/5
		},

		close(ws, code, reason) {
			logger?.debug("WS connection closed", {
				siteId: ws.data.siteId,
				code,
				reason,
			});
			connectionManager.remove(ws.data.siteId);
		},

		drain(ws) {
			ws.data.sendState = "ready";
			if (ws.data.pendingDrain) {
				ws.data.pendingDrain();
				ws.data.pendingDrain = null;
			}
		},

		idleTimeout,
		backpressureLimit,
	};

	return {
		websocket,
		handleUpgrade,
	};
}

/**
 * Local type approximations for Bun WebSocket types.
 * We cannot import these directly from Bun (they are not exported in the public API),
 * so we define local types that match the API contract used in this module.
 * These are sufficient for the WebSocket handler lifecycle and frame dispatch.
 */
type ServerWebSocket<T = unknown> = {
	send(data: string | Uint8Array, binary?: boolean): number;
	close(code?: number, reason?: string): void;
	data: T;
};

type Server = {
	upgrade<T = unknown>(request: Request, options?: { data?: T }): boolean;
};

type WebSocketHandler<T = unknown> = {
	open?(ws: ServerWebSocket<T>): void;
	message(ws: ServerWebSocket<T>, message: string | Uint8Array): void;
	close?(ws: ServerWebSocket<T>, code: number, reason: string): void;
	drain?(ws: ServerWebSocket<T>): void;
	idleTimeout?: number;
	backpressureLimit?: number;
};
