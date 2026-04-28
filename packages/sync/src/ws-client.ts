import type { Logger } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { signRequest } from "./signing.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	SnapshotAckPayload,
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
} from "./ws-frames.js";
import { WsMessageType, decodeFrame, encodeFrame } from "./ws-frames.js";

export interface WsClientConfig {
	hubUrl: string; // e.g., "https://polaris.karashiiro.moe"
	privateKey: CryptoKey;
	siteId: string;
	keyManager: KeyManager;
	hubSiteId: string;
	wsTransport?: {
		addPeer: (
			peerSiteId: string,
			sendFrame: (frame: Uint8Array) => boolean,
			symmetricKey: Uint8Array,
		) => void;
		removePeer: (peerSiteId: string) => void;
		handleChangelogPush: (peerSiteId: string, payload: ChangelogPushPayload) => void;
		handleChangelogAck: (peerSiteId: string, payload: ChangelogAckPayload) => void;
		drainChangelog: (peerSiteId: string) => void;
		handleRelayDeliver: (sourceSiteId: string, payload: RelayDeliverPayload) => void;
		handleRelayAck: (sourceSiteId: string, payload: RelayAckPayload) => void;
		drainRelayOutbox: (peerSiteId: string) => void;
		/** Apply a snapshot chunk to the local DB (spoke-side). */
		applySnapshotChunk: (tableName: string, rows: Array<Record<string, unknown>>) => number;
	};
	logger?: Logger;
	reconnectMaxInterval?: number; // seconds, default 60
	backpressureLimit?: number; // bytes, default 2097152
	/** If true, sends RESEED_REQUEST to the hub after connecting. */
	reseed?: boolean;
}

/**
 * WsSyncClient manages a persistent WebSocket connection from spoke to hub.
 * Handles authenticated connection establishment, exponential backoff reconnection,
 * and backpressure tracking via bufferedAmount.
 */
export class WsSyncClient {
	private ws: WebSocket | null = null;
	private symmetricKey: Uint8Array | null = null;
	private sendState: "ready" | "pressured" = "ready";
	private reconnectInterval = 1;
	private reconnectTimer: Timer | null = null;
	private stopped = false;

	/** Snapshot seeding state (spoke-side): tracks the current snapshot_hlc. */
	private snapshotHlc: string | null = null;
	/** Count of rows applied during the current snapshot session. */
	private snapshotRowCount = 0;
	/** Guard: only send RESEED_REQUEST once per WsSyncClient lifetime.
	 *  Prevents duplicate snapshots on every reconnection. */
	private reseedSent = false;
	/** Timer for periodic heartbeat during snapshot reception.
	 *  Keeps the WebSocket connection alive when the spoke is only receiving
	 *  data and not sending anything for minutes at a time. */
	private heartbeatTimer: Timer | null = null;

	onMessage: ((data: Uint8Array) => void) | null = null;
	onConnected: (() => void) | null = null;
	onDisconnected: (() => void) | null = null;

	constructor(private config: WsClientConfig) {}

	/**
	 * Establish WebSocket connection to hub with Ed25519 authentication.
	 *
	 * 1. Derive WS URL from hubUrl (https -> wss, http -> ws) + /sync/ws
	 * 2. Sign upgrade request to get auth headers
	 * 3. Get symmetric key from keyManager
	 * 4. Create WebSocket with signed headers
	 * 5. Set up event handlers (open, message, close, error)
	 */
	async connect(): Promise<void> {
		if (this.stopped) {
			this.config.logger?.debug("WsSyncClient: connect() called while stopped, ignoring");
			return;
		}

		try {
			// Step 1: Derive WS URL
			const { wsUrl } = this.deriveWsUrl(this.config.hubUrl);

			// Step 2: Sign the upgrade request
			const signedHeaders = await signRequest(
				this.config.privateKey,
				this.config.siteId,
				"GET",
				"/sync/ws",
				"",
			);

			// Step 3: Get symmetric key from keyManager
			this.symmetricKey = this.config.keyManager.getSymmetricKey(this.config.hubSiteId);
			if (!this.symmetricKey) {
				throw new Error(`Symmetric key not found for hub ${this.config.hubSiteId}`);
			}

			// Step 4: Create WebSocket with signed headers
			// Bun's WebSocket constructor supports custom headers via { headers } option
			// biome-ignore lint/suspicious/noExplicitAny: Bun WebSocket API requires any for non-standard options
			this.ws = new WebSocket(wsUrl, { headers: signedHeaders } as any);

			// Set binary type for binary frame handling
			this.ws.binaryType = "nodebuffer" as BinaryType;

			// Step 5: Wire up event handlers
			this.ws.onopen = () => this.handleOpen();
			this.ws.onmessage = (event) => this.handleMessage(event);
			this.ws.onclose = () => this.handleClose();
			this.ws.onerror = (event) => this.handleError(event);
		} catch (error) {
			this.config.logger?.error("WsSyncClient: failed to establish connection", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Schedule reconnection on connection failure
			this.scheduleReconnect();
		}
	}

	/**
	 * Send a binary frame to the hub.
	 * Returns false if not connected or backpressured, true otherwise.
	 */
	send(frame: Uint8Array): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		// Check backpressure
		if (this.ws.bufferedAmount > (this.config.backpressureLimit ?? 2097152)) {
			this.sendState = "pressured";
			return false;
		}

		try {
			// Convert Uint8Array to Buffer for compatibility
			const buffer = Buffer.from(frame);
			this.ws.send(buffer);
			return true;
		} catch (error) {
			this.config.logger?.error("WsSyncClient: send() failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Close the connection and stop reconnection attempts.
	 */
	close(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			try {
				this.ws.close();
			} catch (error) {
				this.config.logger?.debug("WsSyncClient: close() error", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.ws = null;
		}
	}

	/**
	 * Check if connected and ready to send.
	 */
	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Update reconnect configuration. Takes effect on next reconnection.
	 */
	updateReconnectConfig(maxInterval?: number): void {
		if (maxInterval !== undefined) {
			this.config.reconnectMaxInterval = maxInterval;
		}
	}

	/**
	 * Update backpressure limit. Takes effect on next send.
	 */
	updateBackpressureLimit(limit?: number): void {
		if (limit !== undefined) {
			this.config.backpressureLimit = limit;
		}
	}

	/**
	 * Derive WS URL from hub URL.
	 * https:// -> wss://, http:// -> ws://
	 * Append /sync/ws and preserve port.
	 */
	private deriveWsUrl(hubUrl: string): { wsUrl: string } {
		const url = new URL(hubUrl);

		if (url.protocol === "https:") {
			url.protocol = "wss:";
		} else if (url.protocol === "http:") {
			url.protocol = "ws:";
		} else {
			throw new Error(`Unsupported protocol: ${url.protocol}`);
		}

		url.pathname = "/sync/ws";
		return { wsUrl: url.toString() };
	}

	private handleOpen(): void {
		this.config.logger?.debug("WsSyncClient: connection opened");

		// Reset reconnect interval on successful connection
		this.reconnectInterval = 1;
		this.sendState = "ready";

		// Wire up WsTransport peer
		if (this.config.wsTransport && this.symmetricKey) {
			const sendFrame = (frame: Uint8Array): boolean => {
				if (this.sendState === "pressured") {
					return false;
				}
				return this.send(frame);
			};

			this.config.wsTransport.addPeer(this.config.hubSiteId, sendFrame, this.symmetricKey);
			this.config.wsTransport.drainChangelog(this.config.hubSiteId);
			this.config.wsTransport.drainRelayOutbox(this.config.hubSiteId);
		}

		// If --reseed was requested, tell the hub to send a full snapshot.
		// Guard against re-sending on every reconnection.
		if (this.config.reseed && this.symmetricKey && !this.reseedSent) {
			this.reseedSent = true;
			this.sendReseedRequest();
		}

		this.onConnected?.();
	}

	/**
	 * Send a RESEED_REQUEST frame to the hub asking for a full DB snapshot.
	 * Called after connection open when the --reseed flag is set.
	 */
	private sendReseedRequest(): void {
		if (!this.symmetricKey) return;
		const payload = { reason: "spoke requested full reseed via --reseed flag" };
		const frame = encodeFrame(WsMessageType.RESEED_REQUEST, payload, this.symmetricKey);
		this.send(frame);
		this.config.logger?.info("[reseed] Sent RESEED_REQUEST to hub");
	}

	private handleMessage(event: MessageEvent): void {
		let data: Uint8Array | null = null;
		if (event.data instanceof ArrayBuffer) {
			data = new Uint8Array(event.data);
		} else if (event.data instanceof Uint8Array) {
			data = event.data;
		} else if (typeof event.data === "string") {
			this.config.logger?.warn("WsSyncClient: received text message, ignoring", {
				size: event.data.length,
			});
			return;
		}

		if (data) {
			this.config.logger?.debug("WsSyncClient: received binary frame", { size: data.length });

			// Decode frame and dispatch to WsTransport handlers
			if (this.symmetricKey) {
				const decodeResult = decodeFrame(data, this.symmetricKey);
				if (!decodeResult.ok) {
					this.config.logger?.warn("WsSyncClient: frame decode failed", {
						error: decodeResult.error,
					});
					return;
				}

				const decodedFrame = decodeResult.value;

				// Dispatch to WsTransport handlers
				if (this.config.wsTransport) {
					if (decodedFrame.type === WsMessageType.CHANGELOG_PUSH) {
						this.config.wsTransport.handleChangelogPush(
							this.config.hubSiteId,
							decodedFrame.payload,
						);
					} else if (decodedFrame.type === WsMessageType.CHANGELOG_ACK) {
						this.config.wsTransport.handleChangelogAck(this.config.hubSiteId, decodedFrame.payload);
					} else if (decodedFrame.type === WsMessageType.RELAY_DELIVER) {
						this.config.wsTransport.handleRelayDeliver(
							this.config.hubSiteId,
							decodedFrame.payload as RelayDeliverPayload,
						);
					} else if (decodedFrame.type === WsMessageType.RELAY_ACK) {
						this.config.wsTransport.handleRelayAck(
							this.config.hubSiteId,
							decodedFrame.payload as RelayAckPayload,
						);
					} else if (decodedFrame.type === WsMessageType.RELAY_SEND) {
						this.config.logger?.warn("WsSyncClient: received relay_send from hub (unexpected)", {});
					}
				}

				// Handle snapshot seeding frames (hub → spoke initial state handoff).
				// Applied immediately per-chunk; SNAPSHOT_ACK sent after SNAPSHOT_END.
				if (decodedFrame.type === WsMessageType.SNAPSHOT_BEGIN) {
					try {
						this.handleSnapshotBegin(decodedFrame.payload as SnapshotBeginPayload);
					} catch (err) {
						this.config.logger?.error("[snapshot] Error handling SNAPSHOT_BEGIN", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				} else if (decodedFrame.type === WsMessageType.SNAPSHOT_CHUNK) {
					try {
						this.handleSnapshotChunk(decodedFrame.payload as SnapshotChunkPayload);
					} catch (err) {
						this.config.logger?.error("[snapshot] Error handling SNAPSHOT_CHUNK", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				} else if (decodedFrame.type === WsMessageType.SNAPSHOT_END) {
					try {
						this.handleSnapshotEnd(decodedFrame.payload as SnapshotEndPayload);
					} catch (err) {
						this.config.logger?.error("[snapshot] Error handling SNAPSHOT_END", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}

			this.onMessage?.(data);
		}
	}

	private handleClose(): void {
		this.config.logger?.debug("WsSyncClient: connection closed");
		this.ws = null;

		// Reset snapshot state — a reconnection starts a fresh seeding session.
		this.snapshotHlc = null;
		this.snapshotRowCount = 0;
		this.stopSnapshotHeartbeat();

		// Remove WsTransport peer
		if (this.config.wsTransport) {
			this.config.wsTransport.removePeer(this.config.hubSiteId);
		}

		this.onDisconnected?.();

		// Schedule reconnection if not stopped
		if (!this.stopped) {
			this.scheduleReconnect();
		}
	}

	private handleError(event: Event): void {
		// Error events typically trigger close events which handle reconnection
		this.config.logger?.warn("WsSyncClient: WebSocket error", {
			message: event instanceof ErrorEvent ? event.message : String(event),
		});
	}

	// ── Snapshot seeding handlers (spoke-side) ────────────────────────────

	/**
	 * SNAPSHOT_BEGIN: prepares the spoke to receive a full DB snapshot.
	 * Resets the per-session counter so interrupted seeding can be retried cleanly.
	 */
	private handleSnapshotBegin(payload: SnapshotBeginPayload): void {
		this.snapshotHlc = payload.snapshot_hlc;
		this.snapshotRowCount = 0;
		this.reseedSent = true; // Hub is already seeding us — no need to request reseed
		this.startSnapshotHeartbeat();
		this.config.logger?.info(
			`[snapshot] Receiving snapshot (hlc: ${payload.snapshot_hlc}, tables: ${payload.tables.length})`,
		);
	}

	/**
	 * SNAPSHOT_CHUNK: applies a batch of rows to the spoke's local DB.
	 * Uses INSERT OR REPLACE so chunks are idempotent — safe to resume after
	 * a partial application on reconnect.
	 */
	private handleSnapshotChunk(payload: SnapshotChunkPayload): void {
		if (!this.config.wsTransport) return;

		this.config.logger?.debug(
			`[snapshot] Received chunk: ${payload.rows.length} rows for ${payload.table_name} (offset: ${payload.offset})`,
		);

		const applied = this.config.wsTransport.applySnapshotChunk(payload.table_name, payload.rows);

		this.snapshotRowCount += applied;
		// Log progress every 10k rows to avoid log spam.
		if (this.snapshotRowCount > 0 && this.snapshotRowCount % 10_000 === 0) {
			this.config.logger?.info(
				`[snapshot] Progress: ${this.snapshotRowCount} rows applied (table: ${payload.table_name})`,
			);
		}

		if (payload.last) {
			this.config.logger?.debug(
				`[snapshot] Finished table ${payload.table_name} at offset ${payload.offset}`,
			);
		}
	}

	/**
	 * SNAPSHOT_END: finalizes the snapshot and sends SNAPSHOT_ACK back to the hub.
	 * The hub then triggers the normal changelog drain for catchup.
	 */
	private handleSnapshotEnd(payload: SnapshotEndPayload): void {
		this.config.logger?.info(
			`[snapshot] Snapshot complete: ${payload.table_count} tables, ${this.snapshotRowCount} rows applied`,
		);

		this.stopSnapshotHeartbeat();

		// Send acknowledgement so the hub can clean up and start the changelog drain.
		if (this.snapshotHlc && this.symmetricKey) {
			const ackPayload: SnapshotAckPayload = { snapshot_hlc: this.snapshotHlc };
			const frame = encodeFrame(WsMessageType.SNAPSHOT_ACK, ackPayload, this.symmetricKey);
			this.send(frame);
		}

		this.snapshotHlc = null;
		this.snapshotRowCount = 0;
	}

	/**
	 * Start a periodic heartbeat during snapshot reception.
	 * The WebSocket server (hub) has an idle timeout that closes connections
	 * when no data is received from the client for ~120 seconds. During a
	 * long snapshot the spoke only receives data and sends nothing, so the
	 * connection gets killed mid-seed. A lightweight frame every 30 seconds
	 * resets the server's idle timer and keeps the connection alive.
	 */
	private startSnapshotHeartbeat(): void {
		this.stopSnapshotHeartbeat();
		this.config.logger?.info("[snapshot] Starting heartbeat (every 10s)");
		this.heartbeatTimer = setInterval(() => {
			if (!this.symmetricKey) return;
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				this.config.logger?.warn("[snapshot] Heartbeat skipped — WebSocket not open");
				return;
			}
			// Send a DRAIN_REQUEST frame — the hub validates it (lenient:
			// any object is accepted) but does not handle it in the spoke→hub
			// dispatch path, so it's a no-op. This purely resets the server's
			// idle timer so it doesn't close the connection during long
			// snapshots where the spoke only receives data.
			const frame = encodeFrame(
				WsMessageType.DRAIN_REQUEST,
				{ reason: "snapshot heartbeat" },
				this.symmetricKey,
			);
			const sent = this.send(frame);
			if (sent) {
				this.config.logger?.info("[snapshot] Sent heartbeat to hub");
			} else {
				this.config.logger?.warn("[snapshot] Heartbeat send failed (backpressure or closed)");
			}
		}, 10_000);
	}

	private stopSnapshotHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	/**
	 * Schedule a reconnection attempt with exponential backoff and jitter.
	 *
	 * Delay: reconnectInterval seconds + 0-25% jitter
	 * Double interval for next attempt, cap at reconnectMaxInterval (default 60s)
	 */
	private scheduleReconnect(): void {
		if (this.stopped) {
			return;
		}

		// Calculate delay with jitter
		const jitter = Math.random() * 0.25 * this.reconnectInterval;
		const delaySeconds = this.reconnectInterval + jitter;
		const delayMs = delaySeconds * 1000;

		this.config.logger?.info("WsSyncClient: scheduling reconnection", {
			delaySeconds: Math.round(delaySeconds * 100) / 100,
			nextInterval: Math.min(this.reconnectInterval * 2, this.config.reconnectMaxInterval ?? 60),
		});

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch((error) => {
				this.config.logger?.error("WsSyncClient: reconnection attempt failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}, delayMs);

		// Double interval for next attempt, cap at max
		this.reconnectInterval = Math.min(
			this.reconnectInterval * 2,
			this.config.reconnectMaxInterval ?? 60,
		);
	}
}
