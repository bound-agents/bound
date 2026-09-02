import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Logger } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { incrementSyncErrors, resetSyncErrors } from "./peer-cursor.js";
import { signRequest } from "./signing.js";
import { type HandshakeSpan, startWsHandshake } from "./telemetry.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	SnapshotAckPayload,
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
	SpoolTransferAckPayload,
	SpoolTransferPayload,
} from "./ws-frames.js";
import { WsMessageType, decodeFrame, encodeFrame, isSpoolFrameByte } from "./ws-frames.js";

/**
 * Dead-but-OPEN socket detector cadence (#253, third leg). Aligned with the 30s
 * durable-work transfer sweep so two consecutive stuck-buffer observations (~60s)
 * force-close and reconnect, BOUNDING the phantom-success window rather than
 * out-racing the sweep's 3-attempt dead-letter cap: the two timers run on
 * independent phases, so a row near the cap when the socket silently dies can still
 * dead-letter before the second observation lands. The reconnect's budgeted
 * auto-redrive leg (reclassifyTransferExhaustedDeadLetters) recovers that residue.
 * Deliberately faster than the 60s receive-liveness cadence, which would only fire
 * at ~120s. See checkDeadButOpenSocket for the full rationale.
 */
const DEAD_SOCKET_CHECK_INTERVAL_MS = 30_000;

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
			ping?: () => void,
			ownerId?: string,
		) => void;
		removePeer: (peerSiteId: string) => void;
		handleChangelogPush: (peerSiteId: string, payload: ChangelogPushPayload) => void;
		handleChangelogAck: (peerSiteId: string, payload: ChangelogAckPayload) => void;
		drainChangelog: (peerSiteId: string) => void;
		handleRelayDeliver: (sourceSiteId: string, payload: RelayDeliverPayload) => void;
		handleRelayAck: (sourceSiteId: string, payload: RelayAckPayload) => void;
		drainRelayOutbox: (peerSiteId: string) => void;
		/** Receive a hub→spoke durable-work spool transfer (R-DW10). */
		handleSpoolTransfer: (
			sourceSiteId: string,
			payload: SpoolTransferPayload,
			senderIsOriginator?: boolean,
		) => void;
		/** Retire sender copies the hub acknowledged as durable (R-DW10). */
		handleSpoolTransferAck: (sourceSiteId: string, payload: SpoolTransferAckPayload) => void;
		/** Reconnect drain of pending/transferring peer-targeted spool rows toward the hub. */
		drainDurableWorkSpool: (peerSiteId: string, reason?: "reconnect" | "sweep") => void;
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
	reconnectMaxInterval?: number; // seconds, default 10
	/** Internal/test override; reconnect backfill waits 15s by default. */
	reconnectBackfillDelayMs?: number;
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
	private reconnectBackfillTimer: Timer | null = null;
	private hasOpenedOnce = false;
	private connectionHealthy = false;
	private stopped = false;

	/** Stable per-WsSyncClient identity (#253 spool-wedge canary). 8 hex chars minted
	 *  once at construction so every log this instance emits can be tied back to a
	 *  single object — distinguishing frames written into THIS live socket from ones
	 *  written into a stale closure bound to a superseded instance. Passed as the
	 *  peer's ownerId at addPeer time so "WsTransport spool send" names the instance. */
	readonly instanceId: string = randomBytes(4).toString("hex");
	/** Incremented at the top of every handleOpen (#253). A given instanceId can open
	 *  more than one socket over its lifetime (reconnects); the generation disambiguates
	 *  which physical socket a spool write entered. */
	private socketGeneration = 0;

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
	/** Dedicated dead-socket detector timer (#253, third leg). Runs on its own
	 *  30s cadence — see checkDeadButOpenSocket for why it is NOT folded into the
	 *  60s receive-liveness cadence (its ~60s detection BOUNDS the phantom-success
	 *  window against the 30s transfer sweep's 3-attempt dead-letter cap; it does not
	 *  provably out-race it, so the budgeted reconnect auto-redrive recovers the
	 *  residue). */
	private deadSocketTimer: Timer | null = null;

	/** Dead-but-OPEN detection (#253, third leg): the bufferedAmount seen at the
	 *  previous dead-socket check while the socket was OPEN and sendState ready. A
	 *  buffer that is non-zero and non-decreasing across two consecutive checks means
	 *  frames are parked in a socket that claims OPEN but never flushes — force-close
	 *  so the reconnect path re-establishes a live channel. null = no prior sample. */
	private lastStuckBufferedAmount: number | null = null;

	/** Handshake deadline: armed when a socket is created, cleared on the first
	 *  `open` or `close`. If it fires, the socket reached neither — a half-open
	 *  CONNECTING zombie that no other path will ever reconnect. */
	private handshakeTimer: Timer | null = null;
	private handshakeSpan: HandshakeSpan | null = null;

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

		this.handshakeSpan?.complete("failed", new Error("superseded handshake"));
		this.handshakeSpan = startWsHandshake();
		try {
			const { wsUrl } = this.deriveWsUrl(this.config.hubUrl);
			const signedHeaders = await signRequest(
				this.config.privateKey,
				this.config.siteId,
				"GET",
				"/sync/ws",
				"",
			);
			this.symmetricKey = this.config.keyManager.getSymmetricKey(this.config.hubSiteId);
			if (!this.symmetricKey)
				throw new Error(`Symmetric key not found for hub ${this.config.hubSiteId}`);
			// biome-ignore lint/suspicious/noExplicitAny: Bun WebSocket API requires any for non-standard options
			this.ws = new WebSocket(wsUrl, { headers: signedHeaders } as any);
			this.ws.binaryType = "nodebuffer" as BinaryType;
			this.ws.onopen = () => this.handleOpen();
			this.ws.onmessage = (event) => this.handleMessage(event);
			this.ws.onclose = () => this.handleClose();
			this.ws.onerror = (event) => this.handleError(event);
			this.startHandshakeTimer();
		} catch (error) {
			this.config.logger?.error("WsSyncClient: failed to establish connection", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.recordHandshakeFailure(error instanceof Error ? error.message : String(error));
			this.finishHandshake("failed", error);
			this.scheduleReconnect();
		}
	}

	private finishHandshake(outcome: "connected" | "failed" | "timeout", error?: unknown): void {
		this.handshakeSpan?.complete(outcome, error);
		this.handshakeSpan = null;
	}

	/**
	 * Send a binary frame to the hub.
	 * Returns false if not connected or backpressured, true otherwise.
	 */
	send(frame: Uint8Array): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		// Backpressure gate. The client has no `drain` event (unlike the server side,
		// which resets sendState from Bun's drain(ws) — see ws-server.ts), so the latch
		// must be ADVISORY: re-poll the live buffer on every send. If it is over the
		// limit, latch pressured and refuse; if it has fallen back to/under the limit,
		// clear a stale latch and proceed. Without this re-poll a single blip set
		// sendState="pressured" until the next reconnect, silently refusing every
		// SPOOL_TRANSFER forever (#253 incident).
		const limit = this.config.backpressureLimit ?? 2097152;
		if (this.ws.bufferedAmount > limit) {
			if (this.sendState !== "pressured") {
				this.sendState = "pressured";
				this.config.logger?.warn("WsSyncClient: send backpressured — latching pressured", {
					peerSiteId: this.config.hubSiteId,
					bufferedAmount: this.ws.bufferedAmount,
					backpressureLimit: limit,
				});
			}
			return false;
		}
		if (this.sendState === "pressured") {
			// The buffer drained below the limit without a reconnect — clear the latch.
			this.sendState = "ready";
			this.config.logger?.warn("WsSyncClient: backpressure cleared — pressured→ready", {
				peerSiteId: this.config.hubSiteId,
				bufferedAmount: this.ws.bufferedAmount,
				backpressureLimit: limit,
			});
		}

		try {
			// Convert Uint8Array to Buffer for compatibility
			const buffer = Buffer.from(frame);
			// Bun's CLIENT WebSocket has no per-frame delivery signal: send() does not
			// throw and returns undefined whether the frame flushed synchronously or was
			// queued into bufferedAmount for later transmission — and a queued frame on a
			// HEALTHY socket (slow WAN, TLS buffering, a kernel that can't synchronously
			// accept the write) still genuinely delivers. So a queued-but-not-thrown write
			// MUST report success: treating a single-send bufferedAmount delta as a refusal
			// livelocks the spool (every transfer that briefly queues rolls its row back to
			// pending and invalidates the generation token, so no row ever holds a
			// transferring token long enough for its ack to retire it). A socket that is
			// OPEN per readyState but dead over TCP is caught out-of-band by
			// checkDeadButOpenSocket on its own dead-socket cadence (buffer non-decreasing
			// across two ticks → force-close → reconnect → re-drain), not per frame here.
			// #253 spool-wedge canary: one info per spool-family write (SPOOL_TRANSFER /
			// SPOOL_TRANSFER_ACK, ~2/min at production cadence — no spam). Binds the frame
			// to THIS instance's live socket (instanceId + socketGeneration) and captures
			// bufferedAmount across the send so a frame parked in the buffer vs. flushed is
			// visible. Non-spool frames (changelog, high-volume) are NOT logged here — the
			// handleOpen instanceId log plus changelog's working ACKs already bind the live
			// socket. frame[0] is the PLAINTEXT type byte written at encodeFrame offset 0.
			const isSpool = isSpoolFrameByte(frame[0]);
			const bufferedBefore = isSpool ? this.ws.bufferedAmount : 0;
			this.ws.send(buffer);
			if (isSpool) {
				this.config.logger?.info("WsSyncClient spool frame write", {
					instanceId: this.instanceId,
					socketGeneration: this.socketGeneration,
					peerSiteId: this.config.hubSiteId,
					frameTypeByte: frame[0],
					frameBytes: frame.length,
					readyState: this.ws.readyState,
					bufferedBefore,
					bufferedAfter: this.ws.bufferedAmount,
				});
			}
			return true;
		} catch (error) {
			this.config.logger?.error("WsSyncClient: send() failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Proactive backpressure recovery. The client has no `drain` event, so a latched
	 * `pressured` state can outlive the buffer pressure that set it if no organic
	 * write happens to re-poll (the send-path self-heal only fires when something
	 * tries to send). Called from the liveness timer: if the latch is stale (the live
	 * buffer is at/under the limit), flip back to `ready` and re-drive the
	 * durable-work spool toward the hub so parked peer-targeted rows re-send at once
	 * instead of waiting for the next organic write or the 30s transfer sweep.
	 * Mirrors the semantics of the server's drain() handler. A genuinely full buffer
	 * is left latched — the backpressure protection still holds.
	 */
	private recoverFromBackpressure(): void {
		if (this.sendState !== "pressured") return;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const limit = this.config.backpressureLimit ?? 2097152;
		if (this.ws.bufferedAmount > limit) return; // still genuinely full — keep refusing

		this.sendState = "ready";
		this.config.logger?.warn("WsSyncClient: backpressure recovered — pressured→ready", {
			peerSiteId: this.config.hubSiteId,
			bufferedAmount: this.ws.bufferedAmount,
			backpressureLimit: limit,
		});
		// Re-drive the spool so rows parked while latched re-send now, not on the next
		// organic write or reconnect.
		this.config.wsTransport?.drainDurableWorkSpool(this.config.hubSiteId);
	}

	/**
	 * Dead-but-OPEN socket detector (#253, third leg). A socket can read `OPEN` per
	 * `readyState` yet be dead over TCP: Bun's client `send()` neither throws nor
	 * flushes — the frame is queued into `bufferedAmount` and never leaves. With no
	 * per-frame delivery signal (see `send()`), a queued write reports success, so a
	 * peer-targeted durable-work row flips to `transferring` and waits for an ack that
	 * never comes. The 30s transfer sweep then reclaims the row to `pending`, charges
	 * an attempt, re-drives — which queues another dead frame — and marches
	 * `attempt_count` to the cap (3), dead-lettering every peer-targeted row (the #253
	 * incident: 908 platform_request rows dead-lettered, zero consumed).
	 *
	 * The signal that distinguishes a dead socket from a merely slow one is
	 * PERSISTENCE, never a single-send delta: a healthy socket over a slow WAN can
	 * grow `bufferedAmount` transiently and still deliver. A buffer that is non-zero
	 * and has NOT drained across two consecutive detector ticks — while nothing is
	 * backpressured — is a socket that claims OPEN but is not flushing. Force-close it
	 * so `handleClose → removePeer → reconnect → handleOpen → addPeer +
	 * drainDurableWorkSpool` re-establishes a live channel and re-drives the spool.
	 *
	 * CADENCE (bounding the phantom-success window). This runs on its OWN timer at
	 * `DEAD_SOCKET_CHECK_INTERVAL_MS` (30s), aligned with the transfer sweep — NOT on
	 * the receive-liveness cadence (min(receiveTimeoutMs/2, 60s) = 60s by default,
	 * which would only force-close ~120s in, long after the sweep dead-letters at ~90s
	 * = three 30s attempts). Two 30s ticks = detection at ~60s = two sweep attempts,
	 * one under the cap. But the detector and the sweep run on INDEPENDENT phases: a
	 * row already near the cap when the socket silently dies can be re-driven onto the
	 * dead socket and dead-lettered by the sweep's next attempt before the detector's
	 * second observation lands. So this bounds — does not eliminate — the window in
	 * which a row can dead-letter from this failure mode. The residue is recovered on
	 * reconnect by reclassifyTransferExhaustedDeadLetters (in ws-transport's spool
	 * drain), which returns exactly those transfer-exhausted dead letters to `pending`
	 * under a per-row budget; past the budget the row is left for `workspool redrive`.
	 * We do NOT raise the global attempt cap to buy time; we detect faster and recover
	 * on reconnect instead.
	 *
	 * Conservative and orthogonal to the backpressure latch: only fires when the
	 * socket is OPEN, `sendState` is `ready` (a genuinely full over-limit buffer is the
	 * latch's regime, left alone here), and the buffer is non-zero and unchanged-or-
	 * grown since the prior tick. A draining buffer resets the sample so a later
	 * re-grow starts a fresh two-tick window rather than tripping immediately.
	 */
	private checkDeadButOpenSocket(): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.lastStuckBufferedAmount = null;
			return;
		}
		// Only the `ready` regime with a non-zero buffer is a candidate. A latched
		// `pressured` socket is genuine backpressure (buffer over the limit) — the
		// latch owns it; a zero buffer is a healthy idle socket.
		if (this.sendState !== "ready" || this.ws.bufferedAmount <= 0) {
			this.lastStuckBufferedAmount = null;
			return;
		}
		const buffered = this.ws.bufferedAmount;
		if (this.lastStuckBufferedAmount !== null && buffered >= this.lastStuckBufferedAmount) {
			// Second consecutive non-decreasing observation — the socket is parking
			// frames and not flushing. Force-close so the reconnect path re-drives.
			this.config.logger?.warn(
				"WsSyncClient: dead-but-OPEN socket — buffer stuck across two ticks, forcing reconnect",
				{
					peerSiteId: this.config.hubSiteId,
					bufferedAmount: buffered,
					priorBufferedAmount: this.lastStuckBufferedAmount,
				},
			);
			this.lastStuckBufferedAmount = null;
			try {
				this.ws.close();
			} catch {
				// best effort — handleClose fires the reconnect regardless
			}
			return;
		}
		// First observation of a non-zero buffer (or it grew after a drain reset the
		// sample) — record it and wait one more tick before acting.
		this.lastStuckBufferedAmount = buffered;
	}

	/**
	 * Close the connection and stop reconnection attempts.
	 */
	close(): void {
		this.stopped = true;
		this.stopBackfillTimer();
		this.stopReconnectBackfillTimer();
		this.stopLivenessTimer();
		this.stopDeadSocketTimer();
		this.stopHandshakeTimer();
		this.finishHandshake("failed", new Error("client closed during handshake"));
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
		this.socketGeneration += 1;
		this.config.logger?.info("WsSyncClient socket open", {
			instanceId: this.instanceId,
			socketGeneration: this.socketGeneration,
			peerSiteId: this.config.hubSiteId,
		});

		// The handshake completed — disarm the deadline before it can tear down
		// a socket that is now healthy.
		this.stopHandshakeTimer();
		this.recordHandshakeSuccess();
		this.finishHandshake("connected");
		this.connectionHealthy = false;
		this.sendState = "ready";

		// Wire up WsTransport peer
		if (this.config.wsTransport && this.symmetricKey) {
			const sendFrame = (frame: Uint8Array): boolean => {
				if (this.sendState === "pressured") {
					return false;
				}
				return this.send(frame);
			};

			this.config.wsTransport.addPeer(
				this.config.hubSiteId,
				sendFrame,
				this.symmetricKey,
				undefined,
				this.instanceId,
			);
			this.config.wsTransport.drainChangelog(this.config.hubSiteId);
			this.config.wsTransport.drainRelayOutbox(this.config.hubSiteId);
			// Resume in-flight spool transfers (retained token) and begin pending
			// peer-targeted ones (R-DW10) — the push path only covers rows written
			// while connected; reconnect must drain what accumulated while dark.
			this.config.wsTransport.drainDurableWorkSpool(this.config.hubSiteId, "reconnect");
		}

		if (this.config.wsTransport) {
			const wt = this.config.wsTransport as unknown as {
				runBackfill?: (opts?: {
					isFirstConnect?: boolean;
					trigger?: "initial" | "reconnect" | "periodic";
				}) => Promise<unknown>;
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
				const isFirstConnect = !this.hasOpenedOnce;
				if (isFirstConnect) {
					wt.runBackfill({ isFirstConnect, trigger: "initial" }).catch((err: Error) => {
						this.config.logger?.warn("[backfill] Failed", { error: err.message });
					});
				} else {
					this.scheduleReconnectBackfill(wt);
				}
			}
			this.hasOpenedOnce = true;
		}

		this.startBackfillTimer();
		this.startLivenessTimer();
		this.startDeadSocketTimer();
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
						frameTypeByte: data[0],
						frameSize: data.length,
					});
					return;
				}

				const decodedFrame = decodeResult.value;
				this.markConnectionHealthy();

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
					} else if (decodedFrame.type === WsMessageType.SPOOL_TRANSFER) {
						// Hub→spoke durable-work spool delivery (R-DW10): without this
						// dispatch, spool responses targeted at this spoke are silently
						// dropped and the hub's sender copies stay transferring forever.
						// senderIsOriginator defaults to false: a hub-delivered row may be a
						// FORWARDED multi-hop request whose true origin is upstream of the
						// hub, so a missing source_site must NOT be backfilled with the hub
						// (that would misaddress the response to the forwarder, #253).
						this.config.wsTransport.handleSpoolTransfer(
							this.config.hubSiteId,
							decodedFrame.payload as SpoolTransferPayload,
						);
					} else if (decodedFrame.type === WsMessageType.SPOOL_TRANSFER_ACK) {
						this.config.wsTransport.handleSpoolTransferAck(
							this.config.hubSiteId,
							decodedFrame.payload as SpoolTransferAckPayload,
						);
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

				if (decodedFrame.type === WsMessageType.ERROR && this.config.wsTransport) {
					(
						this.config.wsTransport as unknown as {
							handleConsistencyError?: (payload: unknown) => void;
						}
					).handleConsistencyError?.(decodedFrame.payload);
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
	private markConnectionHealthy(): void {
		if (this.connectionHealthy) return;
		this.connectionHealthy = true;
		this.reconnectInterval = 1;
	}

	private scheduleReconnectBackfill(wt: {
		runBackfill?: (opts?: {
			isFirstConnect?: boolean;
			trigger?: "initial" | "reconnect" | "periodic";
		}) => Promise<unknown>;
	}): void {
		this.stopReconnectBackfillTimer();
		const delayMs = this.config.reconnectBackfillDelayMs ?? 15_000;
		this.reconnectBackfillTimer = setTimeout(() => {
			this.reconnectBackfillTimer = null;
			if (!this.connected || !this.connectionHealthy || typeof wt.runBackfill !== "function")
				return;
			wt.runBackfill({ trigger: "reconnect" }).catch((err: Error) => {
				this.config.logger?.warn("[backfill] Failed", { error: err.message });
			});
		}, delayMs);
	}

	private stopReconnectBackfillTimer(): void {
		if (!this.reconnectBackfillTimer) return;
		clearTimeout(this.reconnectBackfillTimer);
		this.reconnectBackfillTimer = null;
	}

	private handleClose(): void {
		this.config.logger?.debug("WsSyncClient: connection closed");
		this.ws = null;
		this.stopBackfillTimer();
		this.stopReconnectBackfillTimer();
		this.stopLivenessTimer();
		this.stopDeadSocketTimer();
		// A close observed before the handshake landed is already a full teardown;
		// disarm the deadline so it can't fire against the next socket.
		this.stopHandshakeTimer();
		this.finishHandshake("failed", new Error("socket closed during handshake"));

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
				runBackfill?: (opts?: {
					isFirstConnect?: boolean;
					trigger?: "initial" | "reconnect" | "periodic";
				}) => Promise<unknown>;
			};
			if (typeof wt?.runBackfill === "function") {
				wt.runBackfill({ trigger: "periodic" }).catch((err: Error) => {
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
			// Proactive backpressure recovery: the client has no drain event, so a
			// latched `pressured` state can outlive its cause. Re-poll here so parked
			// durable-work rows re-send within a check interval rather than waiting for
			// the next organic write or the 30s transfer sweep.
			this.recoverFromBackpressure();
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
	 * Dead-but-OPEN socket detector, on its OWN 30s cadence (see
	 * checkDeadButOpenSocket for the full rationale). Kept separate from the 60s
	 * receive-liveness timer so ~60s detection bounds the phantom-success window
	 * against the 30s transfer sweep's 3-attempt cap: two 30s ticks (~60s) force-close
	 * and reconnect early, but independent timer phases mean rows can still dead-letter
	 * mid-window; the reconnect's budgeted auto-redrive leg recovers that residue.
	 */
	private startDeadSocketTimer(): void {
		this.stopDeadSocketTimer();
		this.lastStuckBufferedAmount = null;
		this.deadSocketTimer = setInterval(() => {
			if (!this.connected) return;
			this.checkDeadButOpenSocket();
		}, DEAD_SOCKET_CHECK_INTERVAL_MS);
	}

	private stopDeadSocketTimer(): void {
		if (this.deadSocketTimer) {
			clearInterval(this.deadSocketTimer);
			this.deadSocketTimer = null;
		}
		this.lastStuckBufferedAmount = null;
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
			this.finishHandshake("timeout", new Error("handshake deadline exceeded"));

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
			this.stopReconnectBackfillTimer();
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
	 * Double interval for next attempt, cap at reconnectMaxInterval (default 10s)
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
			nextInterval: Math.min(this.reconnectInterval * 2, this.config.reconnectMaxInterval ?? 10),
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
			this.config.reconnectMaxInterval ?? 10,
		);
	}
}
