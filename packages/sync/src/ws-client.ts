import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { incrementSyncErrors, resetSyncErrors } from "./peer-cursor.js";
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
		/** Apply a column chunk for sub-row seeding of oversized rows. */
		applyColumnChunk: (
			tableName: string,
			pkValue: string,
			columnName: string,
			chunkIndex: number,
			chunkData: string,
		) => void;
	};
	logger?: Logger;
	reconnectMaxInterval?: number; // seconds, default 60
	backpressureLimit?: number; // bytes, default 2097152
	backfillIntervalSeconds?: number; // 0 = disabled, default 300
	/** Receive-side liveness timeout in ms. If no frame is received from the
	 *  hub within this window, the connection is torn down and reconnected.
	 *  0 = disabled, default 300000 (5 min). The hub heartbeat writes every
	 *  ~2 min, so 5 min of silence means 2+ missed cycles = stuck drain. */
	receiveTimeoutMs?: number;
	/** Handshake deadline in ms. A socket that reaches neither `open` nor
	 *  `close` within this window is torn down and reconnected. Without it a
	 *  half-open CONNECTING socket latches the client dark forever: the only
	 *  paths that re-arm the reconnect timer are `handleClose()` and `connect()`'s
	 *  synchronous catch, and a stalled upgrade reaches neither.
	 *  0 = disabled, default 20000 (20s). */
	handshakeTimeoutMs?: number;
	/** Local DB, used to record handshake failures on `sync_state.sync_errors`
	 *  so `hostinfo` / the web UI stop reporting a clean mesh over a dark link. */
	db?: Database;
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
	private backfillTimer: Timer | null = null;
	private stopped = false;

	/** Snapshot seeding state (spoke-side): tracks the current snapshot_hlc. */
	private snapshotHlc: string | null = null;
	/** Count of rows applied during the current snapshot session. */
	private snapshotRowCount = 0;
	/** Guard: only send RESEED_REQUEST once per WsSyncClient lifetime.
	 *  Prevents duplicate snapshots on every reconnection. */
	private reseedSent = false;
	/** @deprecated Heartbeat timer is no longer used — the hub now sends
	 *  WebSocket ping frames during snapshot seeding to keep the connection
	 *  alive. Application-level frames from the spoke do not reset the
	 *  server-side idle timer in uWebSockets/Bun. */
	private heartbeatTimer: Timer | null = null;

	/** Receive-side liveness: last wall-clock time we got a frame from the hub.
	 *  If this goes stale, the changelog drain from hub→spoke is stuck even
	 *  though the TCP connection (kept alive by pings) looks fine. */
	private lastReceivedAt = 0;
	private livenessTimer: Timer | null = null;

	/** Handshake deadline: armed when a socket is created, cleared on the first
	 *  `open` or `close`. If it fires, the socket reached neither — a half-open
	 *  CONNECTING zombie that no other path will ever reconnect. */
	private handshakeTimer: Timer | null = null;

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

			// Step 6: Arm the handshake deadline. A stalled upgrade produces no
			// open AND no close, so without this the client latches dark.
			this.startHandshakeTimer();
		} catch (error) {
			this.config.logger?.error("WsSyncClient: failed to establish connection", {
				error: error instanceof Error ? error.message : String(error),
			});
			// A throw before the socket exists is still a failed attempt against the
			// hub peer — count it, or the mesh reports 0 errors over a dark link.
			this.recordHandshakeFailure(error instanceof Error ? error.message : String(error));
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
		this.stopBackfillTimer();
		this.stopLivenessTimer();
		this.stopHandshakeTimer();
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

		// The handshake completed — disarm the deadline before it can tear down
		// a socket that is now healthy.
		this.stopHandshakeTimer();
		this.recordHandshakeSuccess();

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

		if (this.config.wsTransport) {
			const wt = this.config.wsTransport as unknown as {
				runBackfill?: (opts?: { isFirstConnect?: boolean }) => Promise<unknown>;
				clearSyncedTables?: () => void;
			};

			if (this.config.reseed && !this.reseedSent) {
				this.reseedSent = true;
				if (typeof wt.clearSyncedTables === "function") {
					wt.clearSyncedTables();
					this.config.logger?.info("[reseed] Cleared local tables for consistency-based reseed");
				}
			}

			if (typeof wt.runBackfill === "function") {
				const isFirstConnect = this.config.reseed && this.reseedSent;
				wt.runBackfill({ isFirstConnect: !!isFirstConnect }).catch((err: Error) => {
					this.config.logger?.warn("[backfill] Failed", { error: err.message });
				});
			}
		}

		this.startBackfillTimer();
		this.startLivenessTimer();
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
			// Receive-side liveness: any inbound frame proves the hub→spoke path is alive.
			this.lastReceivedAt = Date.now();

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

				if (decodedFrame.type === WsMessageType.CONSISTENCY_RESPONSE && this.config.wsTransport) {
					(
						this.config.wsTransport as unknown as {
							handleConsistencyResponse?: (payload: unknown) => void;
						}
					).handleConsistencyResponse?.(decodedFrame.payload);
				}

				if (decodedFrame.type === WsMessageType.ROW_PULL_RESPONSE && this.config.wsTransport) {
					(
						this.config.wsTransport as unknown as {
							handleRowPullResponse?: (payload: unknown) => void;
						}
					).handleRowPullResponse?.(decodedFrame.payload);
				}
			}

			this.onMessage?.(data);
		}
	}

	private handleClose(): void {
		this.config.logger?.debug("WsSyncClient: connection closed");
		this.ws = null;
		this.stopBackfillTimer();
		this.stopLivenessTimer();
		// A close observed before the handshake landed is already a full teardown;
		// disarm the deadline so it can't fire against the next socket.
		this.stopHandshakeTimer();

		// Reset snapshot state — a reconnection starts a fresh seeding session.
		this.snapshotHlc = null;
		this.snapshotRowCount = 0;

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

		// Column-chunk frame: append data to an existing row's column.
		if (
			payload.col_chunk_row_id !== undefined &&
			payload.col_chunk_column !== undefined &&
			payload.col_chunk_data !== undefined
		) {
			this.config.logger?.debug(
				`[snapshot] Received column chunk: ${payload.col_chunk_column}[${payload.col_chunk_index}] for ${payload.table_name} pk=${payload.col_chunk_row_id}`,
			);
			this.config.wsTransport.applyColumnChunk(
				payload.table_name,
				payload.col_chunk_row_id,
				payload.col_chunk_column,
				payload.col_chunk_index ?? 0,
				payload.col_chunk_data,
			);
		} else if (payload.rows.length > 0) {
			this.config.logger?.debug(
				`[snapshot] Received chunk: ${payload.rows.length} rows for ${payload.table_name} (offset: ${payload.offset})`,
			);
			const applied = this.config.wsTransport.applySnapshotChunk(payload.table_name, payload.rows);
			this.snapshotRowCount += applied;
			if (this.snapshotRowCount > 0 && this.snapshotRowCount % 10_000 === 0) {
				this.config.logger?.info(
					`[snapshot] Progress: ${this.snapshotRowCount} rows applied (table: ${payload.table_name})`,
				);
			}
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

		// Send acknowledgement so the hub can clean up and start the changelog drain.
		if (this.snapshotHlc && this.symmetricKey) {
			const ackPayload: SnapshotAckPayload = { snapshot_hlc: this.snapshotHlc };
			const frame = encodeFrame(WsMessageType.SNAPSHOT_ACK, ackPayload, this.symmetricKey);
			this.send(frame);
		}

		this.snapshotHlc = null;
		this.snapshotRowCount = 0;
	}

	/** @deprecated No longer used — hub-side pings keep the connection alive. */
	private stopSnapshotHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private startBackfillTimer(): void {
		this.stopBackfillTimer();
		const intervalSeconds = this.config.backfillIntervalSeconds ?? 300;
		if (intervalSeconds <= 0) return;
		this.backfillTimer = setInterval(() => {
			const wt = this.config.wsTransport as unknown as {
				runBackfill?: (opts?: { isFirstConnect?: boolean }) => Promise<unknown>;
			};
			if (typeof wt?.runBackfill === "function") {
				wt.runBackfill().catch((err: Error) => {
					this.config.logger?.warn("[backfill] Periodic backfill failed", {
						error: err.message,
					});
				});
			}
		}, intervalSeconds * 1000);
	}

	private stopBackfillTimer(): void {
		if (this.backfillTimer) {
			clearInterval(this.backfillTimer);
			this.backfillTimer = null;
		}
	}

	/**
	 * Receive-side liveness watchdog. The hub sends application-level frames
	 * (heartbeat changelog entries, changelog pushes, relay deliveries)
	 * roughly every 2 min. If nothing arrives within the timeout window, the
	 * hub→spoke drain is stuck even though pings keep the TCP socket alive.
	 * Tearing down the connection forces a reconnect + fresh drain.
	 */
	private startLivenessTimer(): void {
		this.stopLivenessTimer();
		const timeoutMs = this.config.receiveTimeoutMs ?? 300_000;
		if (timeoutMs <= 0) return;
		// Check at half the timeout interval so we catch a stale connection
		// within one half-life of the threshold.
		const checkInterval = Math.min(timeoutMs / 2, 60_000);
		this.lastReceivedAt = Date.now();
		this.livenessTimer = setInterval(() => {
			if (!this.connected) return;
			const idleMs = Date.now() - this.lastReceivedAt;
			if (idleMs >= timeoutMs) {
				this.config.logger?.warn(
					"WsSyncClient: receive-side liveness timeout — forcing reconnect",
					{
						idleMs,
						timeoutMs,
					},
				);
				this.stopLivenessTimer();
				if (this.ws) {
					try {
						this.ws.close();
					} catch {
						// best effort — handleClose will fire regardless
					}
				}
			}
		}, checkInterval);
	}

	private stopLivenessTimer(): void {
		if (this.livenessTimer) {
			clearInterval(this.livenessTimer);
			this.livenessTimer = null;
		}
	}

	/**
	 * Handshake deadline. A WebSocket that stalls mid-upgrade reaches neither
	 * `open` nor `close` — the TCP connection is accepted, the request is read,
	 * and no response ever comes back. Both re-arm paths for the reconnect timer
	 * (`handleClose()` and `connect()`'s synchronous catch) are therefore unreachable,
	 * and `startLivenessTimer()` only runs from `handleOpen()`, so the receive-side
	 * watchdog never covers this state either. Without this deadline the client
	 * latches dark until the process restarts.
	 */
	private startHandshakeTimer(): void {
		this.stopHandshakeTimer();
		const timeoutMs = this.config.handshakeTimeoutMs ?? 20_000;
		if (timeoutMs <= 0) return;
		this.handshakeTimer = setTimeout(() => {
			this.handshakeTimer = null;
			// Already open (or already gone) — nothing half-open to tear down.
			if (!this.ws || this.ws.readyState === WebSocket.OPEN) return;

			this.config.logger?.warn(
				"WsSyncClient: handshake deadline exceeded — tearing down half-open socket",
				{ timeoutMs, readyState: this.ws.readyState },
			);
			this.recordHandshakeFailure("handshake deadline exceeded");

			// Drop our handlers before closing: a CONNECTING socket may never emit
			// close, so we cannot rely on handleClose() to schedule the retry.
			const dead = this.ws;
			this.ws = null;
			dead.onopen = null;
			dead.onmessage = null;
			dead.onclose = null;
			dead.onerror = null;
			try {
				dead.close();
			} catch {
				// best effort — the socket may not be far enough along to close
			}

			this.stopBackfillTimer();
			this.stopLivenessTimer();
			if (this.config.wsTransport) {
				this.config.wsTransport.removePeer(this.config.hubSiteId);
			}
			this.onDisconnected?.();

			if (!this.stopped) {
				this.scheduleReconnect();
			}
		}, timeoutMs);
	}

	private stopHandshakeTimer(): void {
		if (this.handshakeTimer) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = null;
		}
	}

	/**
	 * Record a failed connection attempt against the hub peer. `hostinfo` and the
	 * web UI read `sync_state.sync_errors`, which only ever counted frame-level
	 * failures — a transport that never completes a handshake left the mesh
	 * reporting "0 errors" over a day of total silence.
	 */
	private recordHandshakeFailure(reason: string): void {
		if (!this.config.db) return;
		try {
			incrementSyncErrors(this.config.db, this.config.hubSiteId);
		} catch (error) {
			this.config.logger?.debug("WsSyncClient: failed to record sync error", {
				reason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private recordHandshakeSuccess(): void {
		if (!this.config.db) return;
		try {
			resetSyncErrors(this.config.db, this.config.hubSiteId);
		} catch (error) {
			this.config.logger?.debug("WsSyncClient: failed to reset sync errors", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	updateBackfillInterval(seconds?: number): void {
		if (seconds !== undefined) {
			this.config.backfillIntervalSeconds = seconds;
		}
		if (this.connected) {
			this.startBackfillTimer();
		}
	}

	updateReceiveTimeout(ms?: number): void {
		if (ms !== undefined) {
			this.config.receiveTimeoutMs = ms;
		}
		if (this.connected) {
			this.startLivenessTimer();
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
