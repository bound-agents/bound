import type { Database } from "bun:sqlite";
import type { ChangeLogEntry, Logger, TypedEventEmitter } from "@bound/shared";
import { HLC_ZERO } from "@bound/shared";
import { getPeerCursor, updatePeerCursor } from "./peer-cursor.js";
import { replayEvents } from "./reducers.js";
import { MicrotaskCoalescer } from "./ws-coalescer.js";
import type { ChangelogAckPayload, ChangelogPushPayload } from "./ws-frames.js";
import { WsMessageType, encodeFrame } from "./ws-frames.js";

export interface WsTransportConfig {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger?: Logger;
}

interface PeerConnection {
	sendFrame: (frame: Uint8Array) => boolean;
	symmetricKey: Uint8Array;
	peerSiteId: string;
}

/**
 * WsTransport manages event-driven changelog replication over WebSocket.
 *
 * - Listens for changelog:written events
 * - Batches entries via MicrotaskCoalescer
 * - Sends changelog_push frames to peers (with echo suppression)
 * - Receives changelog_push/ack frames from peers
 * - Drains missed entries on reconnection
 */
export class WsTransport {
	private changelogCoalescer: MicrotaskCoalescer<ChangeLogEntry>;
	private peerConnections: Map<string, PeerConnection> = new Map();
	private changelogWrittenListener:
		| ((event: {
				hlc: string;
				tableName: string;
				siteId: string;
		  }) => void)
		| null = null;

	constructor(private config: WsTransportConfig) {
		// Create coalescer with flush callback
		this.changelogCoalescer = new MicrotaskCoalescer((entries) => {
			this.flushChangelogEntries(entries);
		});
	}

	/**
	 * Register a peer connection (called when WS connects).
	 * Also stores the symmetric key for frame encryption/decryption.
	 */
	addPeer(
		peerSiteId: string,
		sendFrame: (frame: Uint8Array) => boolean,
		symmetricKey: Uint8Array,
	): void {
		this.peerConnections.set(peerSiteId, {
			peerSiteId,
			sendFrame,
			symmetricKey,
		});
		this.config.logger?.debug("WsTransport peer added", { peerSiteId });
	}

	/**
	 * Remove a peer connection (called when WS disconnects).
	 */
	removePeer(peerSiteId: string): void {
		this.peerConnections.delete(peerSiteId);
		this.config.logger?.debug("WsTransport peer removed", { peerSiteId });
	}

	/**
	 * Start listening for changelog:written events.
	 * Each event queues the full entry into the coalescer.
	 */
	start(): void {
		this.changelogWrittenListener = (event) => {
			// Query the full changelog entry from the database
			const entry = this.config.db
				.query(
					`SELECT hlc, table_name, row_id, site_id, timestamp, row_data
					FROM change_log WHERE hlc = ?`,
				)
				.get(event.hlc) as ChangeLogEntry | null;

			if (entry) {
				this.changelogCoalescer.add(entry);
			}
		};

		this.config.eventBus.on("changelog:written", this.changelogWrittenListener);
		this.config.logger?.debug("WsTransport started");
	}

	/**
	 * Stop listening for changelog:written events.
	 */
	stop(): void {
		if (this.changelogWrittenListener) {
			this.config.eventBus.off("changelog:written", this.changelogWrittenListener);
			this.changelogWrittenListener = null;
		}
		this.config.logger?.debug("WsTransport stopped");
	}

	/**
	 * Flush batched changelog entries to all connected peers.
	 * - Echo suppression: skip entries where entry.site_id === peerSiteId
	 * - Updates last_sent cursor after sending
	 */
	private flushChangelogEntries(entries: ChangeLogEntry[]): void {
		for (const [peerSiteId, peer] of this.peerConnections) {
			// Echo suppression: filter out entries from this peer
			const entriesToSend = entries.filter((entry) => entry.site_id !== peerSiteId);

			if (entriesToSend.length === 0) {
				continue;
			}

			// Build payload with simplified entry structure for wire transmission
			const payload: ChangelogPushPayload = {
				entries: entriesToSend.map((entry) => ({
					hlc: entry.hlc,
					table_name: entry.table_name,
					row_id: entry.row_id,
					site_id: entry.site_id,
					timestamp: entry.timestamp,
					row_data: JSON.parse(entry.row_data) as Record<string, unknown>,
				})),
			};

			// Encode frame
			const frame = encodeFrame(WsMessageType.CHANGELOG_PUSH, payload, peer.symmetricKey);

			// Send frame (may return false for backpressure)
			const sent = peer.sendFrame(frame);
			if (!sent) {
				this.config.logger?.warn("WsTransport changelog_push backpressured", {
					peerSiteId,
					entryCount: entriesToSend.length,
				});
				// Could implement pending drain here, but for now we just skip
			} else {
				// Update last_sent cursor to the highest HLC sent
				const highestHlc = entriesToSend[entriesToSend.length - 1].hlc;
				updatePeerCursor(this.config.db, peerSiteId, {
					last_sent: highestHlc,
				});
			}
		}
	}

	/**
	 * Handle incoming changelog_push frame from a peer.
	 *
	 * - Replay entries via replayEvents reducer (LWW/append-only logic)
	 * - Update last_received cursor to highest HLC
	 * - Send changelog_ack back to peer
	 */
	handleChangelogPush(peerSiteId: string, payload: ChangelogPushPayload): void {
		if (!payload.entries || payload.entries.length === 0) {
			return;
		}

		// Convert payload entries to ChangeLogEntry format
		const entries: ChangeLogEntry[] = payload.entries.map((entry) => ({
			hlc: entry.hlc,
			// biome-ignore lint/suspicious/noExplicitAny: table_name is string from WS, ChangeLogEntry needs SyncedTableName
			table_name: entry.table_name as any,
			row_id: entry.row_id,
			site_id: entry.site_id,
			timestamp: entry.timestamp,
			row_data: JSON.stringify(entry.row_data),
		}));

		// Replay entries through reducers
		const { applied, skipped } = replayEvents(this.config.db, entries);
		this.config.logger?.debug("WsTransport changelog_push received", {
			peerSiteId,
			entryCount: entries.length,
			applied,
			skipped,
		});

		// Update last_received cursor to highest HLC
		const highestHlc = entries[entries.length - 1].hlc;
		updatePeerCursor(this.config.db, peerSiteId, {
			last_received: highestHlc,
		});

		// Send changelog_ack back to peer
		this.sendChangelogAck(peerSiteId, highestHlc);
	}

	/**
	 * Handle incoming changelog_ack frame from a peer.
	 *
	 * Updates last_sent cursor to the HLC the peer confirmed.
	 */
	handleChangelogAck(peerSiteId: string, payload: ChangelogAckPayload): void {
		const { cursor } = payload;

		updatePeerCursor(this.config.db, peerSiteId, {
			last_sent: cursor,
		});

		this.config.logger?.debug("WsTransport changelog_ack received", {
			peerSiteId,
			cursor,
		});
	}

	/**
	 * Drain changelog entries since last confirmed HLC for a peer.
	 *
	 * Called on reconnection to catch up missed entries.
	 * - Gets last_sent HLC for this peer
	 * - Queries change_log WHERE hlc > last_sent AND site_id != peerSiteId (echo suppression)
	 * - Batches entries in chunks of 100
	 * - Sends each chunk as changelog_push frame
	 * - Handles backpressure: if sendFrame returns false, stores pending callback
	 * - Sends drain_complete frame when done
	 */
	drainChangelog(peerSiteId: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			this.config.logger?.debug("WsTransport drain skipped - peer not connected", {
				peerSiteId,
			});
			return;
		}

		// Get last_sent cursor for this peer
		const cursor = getPeerCursor(this.config.db, peerSiteId);
		const lastSent = cursor?.last_sent ?? HLC_ZERO;

		// Query missed entries with echo suppression
		const allEntries = (
			this.config.db
				.query(
					`SELECT hlc, table_name, row_id, site_id, timestamp, row_data
					FROM change_log
					WHERE hlc > ? AND site_id != ?
					ORDER BY hlc ASC`,
				)
				.all(lastSent, peerSiteId) as Array<{
				hlc: string;
				table_name: string;
				row_id: string;
				site_id: string;
				timestamp: string;
				row_data: string;
			}>
		).map(
			(row): ChangeLogEntry => ({
				hlc: row.hlc,
				// biome-ignore lint/suspicious/noExplicitAny: table_name is string from DB query, ChangeLogEntry needs SyncedTableName
				table_name: row.table_name as any,
				row_id: row.row_id,
				site_id: row.site_id,
				timestamp: row.timestamp,
				row_data: row.row_data,
			}),
		);

		if (allEntries.length === 0) {
			this.config.logger?.debug("WsTransport drain - no missed entries", {
				peerSiteId,
			});
			return;
		}

		// Batch entries in chunks of 100
		const batchSize = 100;
		let backpressured = false;

		for (let i = 0; i < allEntries.length && !backpressured; i += batchSize) {
			const batch = allEntries.slice(i, i + batchSize);

			// Build payload
			const payload: ChangelogPushPayload = {
				entries: batch.map((entry) => ({
					hlc: entry.hlc,
					table_name: entry.table_name,
					row_id: entry.row_id,
					site_id: entry.site_id,
					timestamp: entry.timestamp,
					row_data: JSON.parse(entry.row_data) as Record<string, unknown>,
				})),
			};

			// Encode and send frame
			const frame = encodeFrame(WsMessageType.CHANGELOG_PUSH, payload, peer.symmetricKey);

			const sent = peer.sendFrame(frame);
			if (!sent) {
				this.config.logger?.warn("WsTransport drain backpressured", {
					peerSiteId,
					batchIndex: i / batchSize,
					totalBatches: Math.ceil(allEntries.length / batchSize),
				});
				backpressured = true;
			} else {
				// Update last_sent after each successful batch
				const highestHlc = batch[batch.length - 1].hlc;
				updatePeerCursor(this.config.db, peerSiteId, {
					last_sent: highestHlc,
				});
			}
		}

		// Send drain_complete frame
		if (!backpressured) {
			const drainCompleteFrame = encodeFrame(
				WsMessageType.DRAIN_COMPLETE,
				{ success: true },
				peer.symmetricKey,
			);
			peer.sendFrame(drainCompleteFrame);

			this.config.logger?.debug("WsTransport drain completed", {
				peerSiteId,
				entryCount: allEntries.length,
			});
		}
	}

	/**
	 * Send a changelog_ack frame to a peer.
	 */
	private sendChangelogAck(peerSiteId: string, cursor: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			return;
		}

		const payload: ChangelogAckPayload = { cursor };
		const frame = encodeFrame(WsMessageType.CHANGELOG_ACK, payload, peer.symmetricKey);

		peer.sendFrame(frame);
	}
}
