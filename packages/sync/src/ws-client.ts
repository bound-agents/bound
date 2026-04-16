import type { Logger } from "@bound/shared";
import type { KeyManager } from "./key-manager.js";
import { signRequest } from "./signing.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
} from "./ws-frames.js";
import { WsMessageType, decodeFrame } from "./ws-frames.js";

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
	};
	logger?: Logger;
	reconnectMaxInterval?: number; // seconds, default 60
	backpressureLimit?: number; // bytes, default 2097152
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

		this.onConnected?.();
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
			}

			this.onMessage?.(data);
		}
	}

	private handleClose(): void {
		this.config.logger?.debug("WsSyncClient: connection closed");
		this.ws = null;

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
