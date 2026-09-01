import type { KeyringConfig, Logger, Result } from "@bound/shared";
import { err, ok } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { verifyRequest } from "./signing.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	ConsistencyRequestPayload,
	RelayAckPayload,
	RelaySendPayload,
	RowPullAckPayload,
	RowPullRequestPayload,
	SnapshotAckPayload,
	SpoolTransferAckPayload,
	SpoolTransferPayload,
} from "./ws-frames.js";
import { WsMessageType, decodeFrame, isSpoolFrameByte } from "./ws-frames.js";

const AUTH_FAILURE_BODY = "Unauthorized";
const AUTH_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const seenUpgradeSignatures = new Map<string, number>();

function pruneSeenUpgradeSignatures(now: number): void {
	for (const [key, expiresAt] of seenUpgradeSignatures) {
		if (expiresAt <= now) {
			seenUpgradeSignatures.delete(key);
		}
	}
}

function markUpgradeSignatureSeen(headers: Record<string, string>): boolean {
	const siteId = headers["x-site-id"];
	const timestamp = headers["x-timestamp"];
	const signature = headers["x-signature"];
	if (!siteId || !timestamp || !signature) return false;

	const now = Date.now();
	pruneSeenUpgradeSignatures(now);
	const key = `${siteId}:${timestamp}:${signature}`;
	if (seenUpgradeSignatures.has(key)) {
		return false;
	}
	seenUpgradeSignatures.set(key, now + AUTH_REPLAY_WINDOW_MS);
	return true;
}

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
		let statusCode: 401 | 408;

		if (error.code === "stale_timestamp") {
			statusCode = 408;
		} else {
			statusCode = 401;
		}

		logger?.warn("WS upgrade signature verification failed", {
			error: error.code,
			message: error.message,
		});

		return err({ status: statusCode, body: AUTH_FAILURE_BODY });
	}

	const { siteId } = verifyResult.value;

	if (!markUpgradeSignatureSeen(headers)) {
		logger?.warn("WS upgrade replay rejected", { siteId });
		return err({ status: 401, body: AUTH_FAILURE_BODY });
	}

	// Step 2: Look up symmetric key via KeyManager
	const symmetricKey = keyManager.getSymmetricKey(siteId);
	if (!symmetricKey) {
		logger?.warn("WS upgrade: symmetric key not found", { siteId });
		return err({
			status: 401,
			body: AUTH_FAILURE_BODY,
		});
	}

	// Step 3: Look up fingerprint via KeyManager
	const fingerprint = keyManager.getFingerprint(siteId);
	if (!fingerprint) {
		logger?.warn("WS upgrade: fingerprint not found", { siteId });
		return err({
			status: 401,
			body: AUTH_FAILURE_BODY,
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
	wsTransport?: {
		addPeer: (
			peerSiteId: string,
			sendFrame: (frame: Uint8Array) => boolean,
			symmetricKey: Uint8Array,
			ping?: () => void,
			ownerId?: string,
		) => void;
		removePeer: (peerSiteId: string) => void;
		handleChangelogPush: (peerSiteId: string, payload: ChangelogPushPayload) => void;
		handleChangelogAck: (peerSiteId: string, payload: ChangelogAckPayload) => void;
		drainChangelog: (peerSiteId: string) => void;
		handleRelaySend: (sourceSiteId: string, payload: RelaySendPayload) => void;
		handleRelayAck: (sourceSiteId: string, payload: RelayAckPayload) => void;
		drainRelayInbox: (spokesSiteId: string) => void;
		handleSpoolTransfer: (sourceSiteId: string, payload: SpoolTransferPayload) => void;
		handleSpoolTransferAck: (sourceSiteId: string, payload: SpoolTransferAckPayload) => void;
		drainDurableWorkSpool: (peerSiteId: string, reason?: "reconnect" | "sweep") => void;
		/** Seed a newly-connected peer with a full DB snapshot. */
		seedNewPeer: (peerSiteId: string) => void;
		/** Called when a spoke acks the final snapshot. Triggers changelog drain. */
		handleSnapshotAck: (peerSiteId: string, payload: SnapshotAckPayload) => void;
		/** Resume snapshot seeding after backpressure clears. */
		continueSnapshotSeed: (peerSiteId: string) => void;
		/** Handle a spoke's request for a full DB reseed. */
		handleReseedRequest: (peerSiteId: string, payload: unknown) => void;
		handleConsistencyRequest: (peerSiteId: string, payload: ConsistencyRequestPayload) => void;
		handleRowPullRequest: (peerSiteId: string, payload: RowPullRequestPayload) => void;
		handleRowPullAck: (peerSiteId: string, payload: RowPullAckPayload) => void;
		continueRowPull: (peerSiteId: string) => void;
		continueConsistencyStream: (peerSiteId: string) => void;
	};
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
	handleUpgrade: (req: Request, server: Server<WsConnectionData>) => Promise<Response | undefined>;
} {
	const {
		connectionManager,
		keyring,
		keyManager,
		logger,
		idleTimeout = 120,
		backpressureLimit = 2097152,
	} = config;
	const sendFailureWarnings = new Map<string, number>();
	const SEND_FAILURE_WARNING_INTERVAL_MS = 60_000;

	const handleUpgrade = async (
		req: Request,
		server: Server<WsConnectionData>,
	): Promise<Response | undefined> => {
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

			// Wire up WsTransport peer
			if (config.wsTransport) {
				const sendFrame = (frame: Uint8Array): boolean => {
					if (ws.data.sendState === "pressured") {
						return false;
					}
					try {
						const result = ws.send(frame, true);
						// result >= 1: success
						// result -1: backpressure, set pressured state and return false
						// result 0: socket closed, close and return false
						if (result >= 1) {
							return true;
						}
						if (result === -1) {
							// Data was queued — report success so the caller advances
							// its cursor. Mark pressured so the NEXT send waits for drain.
							ws.data.sendState = "pressured";
							return true;
						}
						// result === 0: socket closed
						logger?.warn("WS send returned 0 (socket closed)", {
							siteId: ws.data.siteId,
							frameSize: frame.length,
							sendState: ws.data.sendState,
						});
						ws.close(1011, "Internal server error");
						return false;
					} catch {
						const now = Date.now();
						const lastWarningAt = sendFailureWarnings.get(ws.data.siteId) ?? 0;
						if (now - lastWarningAt >= SEND_FAILURE_WARNING_INTERVAL_MS) {
							sendFailureWarnings.set(ws.data.siteId, now);
							logger?.warn("WS send threw", {
								peer_site_id: ws.data.siteId,
								frame_size: frame.length,
							});
						}
						return false;
					}
				};

				const ping = (): void => {
					try {
						(ws as unknown as { ping(data?: unknown): void }).ping();
					} catch {
						/* best effort — older Bun builds may lack .ping() */
					}
				};
				config.wsTransport.addPeer(
					ws.data.siteId,
					sendFrame,
					ws.data.symmetricKey,
					ping,
					ws.data.siteId,
				);

				// Seed new peers with a full DB snapshot before the normal
				// changelog drain (which only contains entries newer than
				// what the pruning window already deleted).
				config.wsTransport.seedNewPeer(ws.data.siteId);

				config.wsTransport.drainChangelog(ws.data.siteId);
				config.wsTransport.drainRelayInbox(ws.data.siteId);
				config.wsTransport.drainDurableWorkSpool(ws.data.siteId, "reconnect");
			}
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

			// #253 spool-wedge canary: one info per spool-family raw frame BEFORE decodeFrame,
			// so a frame that reaches the hub's message() handler is logged even if decode
			// later fails. frame[0] is the PLAINTEXT type byte (encodeFrame offset 0). Only
			// spool-family (SPOOL_TRANSFER / SPOOL_TRANSFER_ACK) is logged — changelog is
			// high-volume. Silence here for a spoke-logged sent=true frame means the bytes
			// never reached this handler (wire/proxy drop or a write into a different socket).
			if (isSpoolFrameByte(frame[0])) {
				logger?.info("WsServer spool frame received", {
					siteId: ws.data.siteId,
					frameTypeByte: frame[0],
					frameBytes: frame.length,
				});
			}

			// Decode frame
			const decodeResult = decodeFrame(frame, ws.data.symmetricKey);

			// #253 spool-wedge canary #2: for spool-family frames only, one info naming
			// the decode outcome BEFORE the !ok gate below — proves whether decode
			// succeeds, what type it yields, and whether a transport is wired to receive
			// it. Silence of this line for a received spool frame means decodeFrame threw
			// or returned without reaching here; a decoded type that matches no dispatch
			// branch is caught by the fell-off-chain warn below.
			if (isSpoolFrameByte(frame[0])) {
				logger?.info("WsServer spool decode outcome", {
					siteId: ws.data.siteId,
					ok: decodeResult.ok,
					decodedType: decodeResult.ok ? decodeResult.value.type : null,
					error: decodeResult.ok ? null : decodeResult.error,
					hasWsTransport: Boolean(config.wsTransport),
				});
			}
			if (!decodeResult.ok) {
				logger?.warn("WS frame decode failed", {
					siteId: ws.data.siteId,
					error: decodeResult.error,
					frameTypeByte: frame[0],
					frameSize: frame.length,
				});
				return;
			}

			const decodedFrame = decodeResult.value;

			// Dispatch failures indicate a local storage/reducer/invariant problem, not
			// malformed peer input. Close to stop further mutation on this connection.
			if (config.wsTransport) {
				try {
					if (decodedFrame.type === WsMessageType.CHANGELOG_PUSH) {
						config.wsTransport.handleChangelogPush(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.CHANGELOG_ACK) {
						config.wsTransport.handleChangelogAck(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.RELAY_SEND) {
						config.wsTransport.handleRelaySend(
							ws.data.siteId,
							decodedFrame.payload as RelaySendPayload,
						);
					} else if (decodedFrame.type === WsMessageType.RELAY_DELIVER) {
						logger?.warn("WS received relay_deliver from spoke (unexpected)", {
							siteId: ws.data.siteId,
						});
					} else if (decodedFrame.type === WsMessageType.RELAY_ACK) {
						config.wsTransport.handleRelayAck(
							ws.data.siteId,
							decodedFrame.payload as RelayAckPayload,
						);
					} else if (decodedFrame.type === WsMessageType.SNAPSHOT_ACK) {
						config.wsTransport.handleSnapshotAck(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.RESEED_REQUEST) {
						config.wsTransport.handleReseedRequest(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.CONSISTENCY_REQUEST) {
						config.wsTransport.handleConsistencyRequest(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.ROW_PULL_REQUEST) {
						config.wsTransport.handleRowPullRequest(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.ROW_PULL_ACK) {
						config.wsTransport.handleRowPullAck(ws.data.siteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.SPOOL_TRANSFER) {
						config.wsTransport.handleSpoolTransfer(
							ws.data.siteId,
							decodedFrame.payload as SpoolTransferPayload,
						);
					} else if (decodedFrame.type === WsMessageType.SPOOL_TRANSFER_ACK) {
						config.wsTransport.handleSpoolTransferAck(
							ws.data.siteId,
							decodedFrame.payload as SpoolTransferAckPayload,
						);
					} else if (isSpoolFrameByte(frame[0])) {
						// #253 spool-wedge canary #2: a spool-family raw frame whose decoded
						// type matched NO branch above. Narrowly scoped to spool bytes so the
						// dispatch chain stays behavior-identical for every other frame type
						// (unknown non-spool types still fall through with no side effect).
						logger?.warn("WsServer spool frame fell off dispatch chain", {
							siteId: ws.data.siteId,
							decodedType: decodedFrame.type,
							frameTypeByte: frame[0],
						});
					}
				} catch (error) {
					logger?.error("WS transport frame dispatch failed", {
						peer_site_id: ws.data.siteId,
						frame_type: WsMessageType[decodedFrame.type],
						error_class: error instanceof Error ? error.constructor.name : "NonError",
					});
					ws.close(1011, "Internal server error");
				}
			}
		},

		close(ws, code, reason) {
			logger?.info("WS connection closed", {
				siteId: ws.data.siteId,
				code,
				reason,
			});

			// Remove WsTransport peer
			if (config.wsTransport) {
				config.wsTransport.removePeer(ws.data.siteId);
			}

			connectionManager.remove(ws.data.siteId);
		},

		drain(ws) {
			ws.data.sendState = "ready";
			// Resume any paused stream on backpressure clear.
			if (config.wsTransport) {
				config.wsTransport.continueSnapshotSeed(ws.data.siteId);
				config.wsTransport.continueRowPull(ws.data.siteId);
				config.wsTransport.continueConsistencyStream(ws.data.siteId);
			}
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

type Server<T = unknown> = {
	upgrade(request: Request, options: { data: T; headers?: HeadersInit }): boolean;
};

type WebSocketHandler<T = unknown> = {
	open?(ws: ServerWebSocket<T>): void;
	message(ws: ServerWebSocket<T>, message: string | Uint8Array): void;
	close?(ws: ServerWebSocket<T>, code: number, reason: string): void;
	drain?(ws: ServerWebSocket<T>): void;
	idleTimeout?: number;
	backpressureLimit?: number;
};
