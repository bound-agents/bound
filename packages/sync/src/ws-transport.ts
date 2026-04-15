import type { Database } from "bun:sqlite";
import { insertInbox, markDelivered, readUndelivered, writeOutbox } from "@bound/core";
import type {
	ChangeLogEntry,
	Logger,
	RelayInboxEntry,
	RelayKind,
	RelayOutboxEntry,
	TypedEventEmitter,
} from "@bound/shared";
import { HLC_ZERO } from "@bound/shared";
import { getPeerCursor, updatePeerCursor } from "./peer-cursor.js";
import { replayEvents } from "./reducers.js";
import { MicrotaskCoalescer } from "./ws-coalescer.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	RelaySendPayload,
} from "./ws-frames.js";
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
	private relayOutboxWrittenListener:
		| ((event: { id: string; target_site_id: string }) => void)
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
	 * Start listening for changelog:written and relay:outbox-written events.
	 * - changelog:written events queue entries into the coalescer
	 * - relay:outbox-written events trigger immediate relay send for connected hub
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

		this.relayOutboxWrittenListener = (event) => {
			// Query the relay outbox entry and send to appropriate peer
			const entry = this.config.db
				.query("SELECT * FROM relay_outbox WHERE id = ?")
				.get(event.id) as RelayOutboxEntry | null;

			if (entry) {
				this.sendRelayOutboxEntry(entry);
			}
		};

		this.config.eventBus.on("changelog:written", this.changelogWrittenListener);
		this.config.eventBus.on("relay:outbox-written", this.relayOutboxWrittenListener);
		this.config.logger?.debug("WsTransport started");
	}

	/**
	 * Stop listening for changelog:written and relay:outbox-written events.
	 */
	stop(): void {
		if (this.changelogWrittenListener) {
			this.config.eventBus.off("changelog:written", this.changelogWrittenListener);
			this.changelogWrittenListener = null;
		}
		if (this.relayOutboxWrittenListener) {
			this.config.eventBus.off("relay:outbox-written", this.relayOutboxWrittenListener);
			this.relayOutboxWrittenListener = null;
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

	/**
	 * Send a relay outbox entry to its destination.
	 * - If spoke (hub connection exists): send to hub
	 * - If hub (spoke connections exist): handled by handleRelaySend
	 */
	private sendRelayOutboxEntry(entry: RelayOutboxEntry): void {
		// Spoke mode: send to hub if connected
		// Hub mode: relay routing happens in handleRelaySend
		// For now, we only send to hub if we have a hub connection
		// (spokes have exactly one hub connection)
		if (this.peerConnections.size === 1) {
			const [, peer] = Array.from(this.peerConnections.entries())[0];

			const payload: RelaySendPayload = {
				entries: [
					{
						id: entry.id,
						target_site_id: entry.target_site_id,
						kind: entry.kind,
						ref_id: entry.ref_id,
						idempotency_key: entry.idempotency_key,
						stream_id: entry.stream_id,
						expires_at: entry.expires_at,
						payload: JSON.parse(entry.payload),
					},
				],
			};

			const frame = encodeFrame(WsMessageType.RELAY_SEND, payload, peer.symmetricKey);
			peer.sendFrame(frame);
		}
	}

	/**
	 * Handle incoming relay_send frame from a spoke (hub-side).
	 * Implements the same routing logic as HTTP /sync/relay handler:
	 * - Broadcast fan-out to all connected spokes except source
	 * - Hub-local dispatch to relay_inbox
	 * - Forward to another spoke
	 */
	handleRelaySend(sourceSiteId: string, payload: RelaySendPayload): void {
		if (!payload.entries || payload.entries.length === 0) {
			return;
		}

		const deliveredIds: string[] = [];

		for (const entry of payload.entries) {
			// Idempotency check on hub side
			if (entry.idempotency_key) {
				const existing = this.config.db
					.query("SELECT id FROM relay_outbox WHERE idempotency_key = ? AND target_site_id = ?")
					.get(entry.idempotency_key, entry.target_site_id) as { id: string } | null;
				if (existing) {
					deliveredIds.push(entry.id);
					continue;
				}
			}

			// Broadcast: fan-out to all connected spokes except the source
			if (entry.target_site_id === "*") {
				for (const [peerSiteId] of this.peerConnections) {
					if (peerSiteId === sourceSiteId) {
						continue;
					}

					const inboxEntry: RelayInboxEntry = {
						id: entry.id,
						source_site_id: sourceSiteId,
						kind: entry.kind as RelayKind,
						ref_id: entry.ref_id,
						idempotency_key: entry.idempotency_key,
						stream_id: entry.stream_id,
						payload: JSON.stringify(entry.payload),
						expires_at: entry.expires_at,
						received_at: new Date().toISOString(),
						processed: 0,
					};

					this.sendRelayDeliver(peerSiteId, [inboxEntry]);
				}
				deliveredIds.push(entry.id);
				continue;
			}

			// Hub-local: insert into relay_inbox for RelayProcessor
			if (entry.target_site_id === this.config.siteId) {
				const inboxEntry: RelayInboxEntry = {
					id: entry.id,
					source_site_id: sourceSiteId,
					kind: entry.kind as RelayKind,
					ref_id: entry.ref_id ?? entry.id,
					idempotency_key: entry.idempotency_key,
					stream_id: entry.stream_id,
					payload: JSON.stringify(entry.payload),
					expires_at: entry.expires_at,
					received_at: new Date().toISOString(),
					processed: 0,
				};

				insertInbox(this.config.db, inboxEntry);

				// Emit relay:inbox event
				this.config.eventBus.emit("relay:inbox", {
					ref_id: inboxEntry.ref_id || undefined,
					stream_id: inboxEntry.stream_id || undefined,
					kind: inboxEntry.kind,
				});

				deliveredIds.push(entry.id);
				continue;
			}

			// Forward to another spoke
			const targetPeer = this.peerConnections.get(entry.target_site_id);
			if (targetPeer) {
				// Spoke is connected: send immediately
				const inboxEntry: RelayInboxEntry = {
					id: entry.id,
					source_site_id: sourceSiteId,
					kind: entry.kind as RelayKind,
					ref_id: entry.ref_id ?? entry.id,
					idempotency_key: entry.idempotency_key,
					stream_id: entry.stream_id,
					payload: JSON.stringify(entry.payload),
					expires_at: entry.expires_at,
					received_at: new Date().toISOString(),
					processed: 0,
				};

				this.sendRelayDeliver(entry.target_site_id, [inboxEntry]);
			} else {
				// Spoke is NOT connected: write to hub's own outbox for delivery on reconnect
				writeOutbox(this.config.db, {
					id: entry.id,
					source_site_id: sourceSiteId,
					target_site_id: entry.target_site_id,
					kind: entry.kind as RelayKind,
					ref_id: entry.ref_id ?? entry.id,
					idempotency_key: entry.idempotency_key,
					stream_id: entry.stream_id,
					payload: JSON.stringify(entry.payload),
					created_at: new Date().toISOString(),
					expires_at: entry.expires_at,
				});
			}

			deliveredIds.push(entry.id);
		}

		// Send relay_ack back to source
		this.sendRelayAck(sourceSiteId, deliveredIds);
	}

	/**
	 * Handle incoming relay_deliver frame from hub (spoke-side).
	 * Inserts entries into relay_inbox and emits relay:inbox events.
	 */
	handleRelayDeliver(sourceSiteId: string, payload: RelayDeliverPayload): void {
		if (!payload.entries || payload.entries.length === 0) {
			return;
		}

		const receivedIds: string[] = [];

		for (const entry of payload.entries) {
			const inboxEntry: RelayInboxEntry = {
				id: entry.id,
				source_site_id: entry.source_site_id,
				kind: entry.kind as RelayKind,
				ref_id: entry.ref_id ?? null,
				idempotency_key: entry.idempotency_key ?? null,
				stream_id: entry.stream_id ?? null,
				payload: JSON.stringify(entry.payload),
				expires_at: entry.expires_at,
				received_at: new Date().toISOString(),
				processed: 0,
			};

			const inserted = insertInbox(this.config.db, inboxEntry);
			if (inserted) {
				receivedIds.push(entry.id);

				// Emit relay:inbox event for new entries
				this.config.eventBus.emit("relay:inbox", {
					ref_id: inboxEntry.ref_id || undefined,
					stream_id: inboxEntry.stream_id || undefined,
					kind: inboxEntry.kind,
				});
			}
		}

		// Send relay_ack back to hub
		this.sendRelayAck(sourceSiteId, receivedIds);
	}

	/**
	 * Handle incoming relay_ack frame from peer.
	 * Marks outbox entries as delivered.
	 */
	handleRelayAck(sourceSiteId: string, payload: RelayAckPayload): void {
		if (!payload.ids || payload.ids.length === 0) {
			return;
		}

		markDelivered(this.config.db, payload.ids);

		this.config.logger?.debug("WsTransport relay_ack received", {
			sourceSiteId,
			idCount: payload.ids.length,
		});
	}

	/**
	 * Drain undelivered relay outbox entries on reconnection (spoke-side).
	 * Sends all entries with delivered = 0.
	 */
	drainRelayOutbox(peerSiteId: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			this.config.logger?.debug("WsTransport relay drain skipped - peer not connected", {
				peerSiteId,
			});
			return;
		}

		const allEntries = readUndelivered(this.config.db) as RelayOutboxEntry[];

		if (allEntries.length === 0) {
			this.config.logger?.debug("WsTransport relay drain - no missed entries", {
				peerSiteId,
			});
			return;
		}

		// Batch entries in chunks of 100
		const batchSize = 100;
		let backpressured = false;

		for (let i = 0; i < allEntries.length && !backpressured; i += batchSize) {
			const batch = allEntries.slice(i, i + batchSize);

			const payload: RelaySendPayload = {
				entries: batch.map((entry) => ({
					id: entry.id,
					target_site_id: entry.target_site_id,
					kind: entry.kind,
					ref_id: entry.ref_id,
					idempotency_key: entry.idempotency_key,
					stream_id: entry.stream_id,
					expires_at: entry.expires_at,
					payload: JSON.parse(entry.payload),
				})),
			};

			const frame = encodeFrame(WsMessageType.RELAY_SEND, payload, peer.symmetricKey);
			const sent = peer.sendFrame(frame);

			if (!sent) {
				this.config.logger?.warn("WsTransport relay drain backpressured", {
					peerSiteId,
					batchIndex: i / batchSize,
					totalBatches: Math.ceil(allEntries.length / batchSize),
				});
				backpressured = true;
			}
		}

		if (!backpressured) {
			this.config.logger?.debug("WsTransport relay drain completed", {
				peerSiteId,
				entryCount: allEntries.length,
			});
		}
	}

	/**
	 * Drain undelivered relay inbox entries targeting a reconnected spoke (hub-side).
	 * Sends relay_deliver frames for entries in hub's outbox targeting the spoke.
	 */
	drainRelayInbox(spokesSiteId: string): void {
		const peer = this.peerConnections.get(spokesSiteId);
		if (!peer) {
			this.config.logger?.debug("WsTransport relay inbox drain skipped - peer not connected", {
				spokesSiteId,
			});
			return;
		}

		const allEntries = readUndelivered(this.config.db, spokesSiteId) as RelayOutboxEntry[];

		if (allEntries.length === 0) {
			return;
		}

		// Batch entries in chunks of 100
		const batchSize = 100;

		for (let i = 0; i < allEntries.length; i += batchSize) {
			const batch = allEntries.slice(i, i + batchSize);

			const inboxEntries: RelayInboxEntry[] = batch.map((entry) => ({
				id: entry.id,
				source_site_id: entry.source_site_id,
				kind: entry.kind,
				ref_id: entry.ref_id,
				idempotency_key: entry.idempotency_key,
				stream_id: entry.stream_id,
				payload: entry.payload,
				expires_at: entry.expires_at,
				received_at: new Date().toISOString(),
				processed: 0,
			}));

			this.sendRelayDeliver(spokesSiteId, inboxEntries);
			markDelivered(
				this.config.db,
				batch.map((e) => e.id),
			);
		}

		this.config.logger?.debug("WsTransport relay inbox drain completed", {
			spokesSiteId,
			entryCount: allEntries.length,
		});
	}

	/**
	 * Send a relay_deliver frame to a peer with relay inbox entries.
	 */
	private sendRelayDeliver(peerSiteId: string, entries: RelayInboxEntry[]): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			return;
		}

		const payload: RelayDeliverPayload = {
			entries: entries.map((entry) => ({
				id: entry.id,
				source_site_id: entry.source_site_id,
				kind: entry.kind,
				ref_id: entry.ref_id,
				idempotency_key: entry.idempotency_key,
				stream_id: entry.stream_id,
				expires_at: entry.expires_at,
				payload: JSON.parse(entry.payload),
			})),
		};

		const frame = encodeFrame(WsMessageType.RELAY_DELIVER, payload, peer.symmetricKey);
		peer.sendFrame(frame);
	}

	/**
	 * Send a relay_ack frame to a peer.
	 */
	private sendRelayAck(peerSiteId: string, ids: string[]): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			return;
		}

		const payload: RelayAckPayload = { ids };
		const frame = encodeFrame(WsMessageType.RELAY_ACK, payload, peer.symmetricKey);

		peer.sendFrame(frame);
	}
}
