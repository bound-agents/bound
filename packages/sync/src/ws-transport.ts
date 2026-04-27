import type { Database } from "bun:sqlite";
import { insertInbox, markDelivered, readUndelivered, writeOutbox } from "@bound/core";
import type {
	ChangeLogEntry,
	Logger,
	Message,
	RelayInboxEntry,
	RelayKind,
	RelayOutboxEntry,
	SyncedTableName,
	TypedEventEmitter,
} from "@bound/shared";
import { HLC_ZERO, generateHlc } from "@bound/shared";
import { getPeerCursor, updatePeerCursor } from "./peer-cursor.js";
import { applySnapshotRows, replayEvents } from "./reducers.js";
import { MicrotaskCoalescer } from "./ws-coalescer.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	RelaySendPayload,
	SnapshotAckPayload,
	SnapshotBeginPayload,
	SnapshotChunkPayload,
	SnapshotEndPayload,
} from "./ws-frames.js";
import { WsMessageType, encodeFrame } from "./ws-frames.js";

export interface WsTransportConfig {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger?: Logger;
	isHub?: boolean;
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
/**
 * Canonical order for snapshot seeding: parent tables before children,
 * so foreign-key dependencies are satisfied on INSERT OR REPLACE.
 */
const SNAPSHOT_TABLE_ORDER: SyncedTableName[] = [
	"users",
	"hosts",
	"cluster_config",
	"threads",
	"messages",
	"turns",
	"semantic_memory",
	"memory_edges",
	"tasks",
	"files",
	"advisories",
	"skills",
	"overlay_index",
];

/** Per-peer snapshot seeding progress (hub-side). */
interface SnapshotState {
	/** Index into SNAPSHOT_TABLE_ORDER for the current table. */
	tableIndex: number;
	/** Row count offset — purely for diagnostics in payload. */
	offset: number;
	/** Cursor for fast pagination: next query uses rowid > lastRowid.
	 *  Replaces OFFSET which degrades linearly in SQLite. */
	lastRowid: number;
	/** HLC at the moment seeding started. */
	snapshotHlc: string;
	/** Whether we're waiting for backpressure to clear. */
	draining: boolean;
}

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
	/** Per-peer snapshot seeding progress. */
	private snapshotStates = new Map<string, SnapshotState>();

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
	 * Also cleans up the sync_state row if the peer was mid-seed
	 * (HLC_ZERO cursor would permanently block pruning).
	 */
	removePeer(peerSiteId: string): void {
		this.peerConnections.delete(peerSiteId);

		const wasSeeding = this.snapshotStates.has(peerSiteId);
		this.snapshotStates.delete(peerSiteId);

		if (wasSeeding) {
			// Remove the HLC_ZERO cursor so pruning can resume for other peers.
			this.config.db.run("DELETE FROM sync_state WHERE peer_site_id = ?", [peerSiteId]);
			this.config.logger?.info(
				"[snapshot] Cleaned up stalled snapshot state for disconnected peer",
				{
					peerSiteId,
				},
			);
		}

		this.config.logger?.debug("WsTransport peer removed", { peerSiteId });
	}

	/**
	 * Apply a snapshot chunk to the local DB (spoke-side).
	 * Delegates to the reducers layer; rows are upserted without changelog entries.
	 * @returns Number of rows applied.
	 */
	applySnapshotChunk(tableName: string, rows: Array<Record<string, unknown>>): number {
		return applySnapshotRows(this.config.db, tableName, rows, this.config.logger);
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

		// Replay entries through reducers. onApplied fires (post-commit) for
		// every applied row so the local event bus mirrors what would have been
		// emitted if the row had been produced locally. Without this hook the
		// TUI / web clients don't see messages synced in from remote-model
		// sessions running on another node until they manually refresh.
		const { applied, skipped } = replayEvents(this.config.db, entries, {
			logger: this.config.logger,
			onApplied: (info) => {
				if (info.table_name !== "messages") return;
				// Rehydrate the full row from the DB after commit rather than
				// trusting the wire payload — listeners expect the same shape
				// the rest of the system emits (post-trigger defaults, coerced
				// types, etc.).
				try {
					const message = this.config.db
						.prepare("SELECT * FROM messages WHERE id = ?")
						.get(info.row_id) as Message | undefined;
					if (!message) return;
					this.config.eventBus.emit("message:broadcast", {
						message,
						thread_id: message.thread_id,
					});
				} catch (err) {
					this.config.logger?.warn("WsTransport onApplied broadcast failed", {
						row_id: info.row_id,
						err: err instanceof Error ? err.message : String(err),
					});
				}
			},
		});
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

		// Skip changelog drain while snapshot seeding is in progress — the
		// snapshot already covers all historical data, and the post-snapshot
		// drain in handleSnapshotAck() handles catchup. Draining concurrently
		// causes redundant data transfer and potential ordering issues.
		if (this.snapshotStates.has(peerSiteId)) {
			this.config.logger?.debug("WsTransport drain skipped - snapshot seeding active", {
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
	 * - If spoke (not isHub): send relay_send frame to hub
	 * - If hub (isHub): route locally (forward to spoke, insert into own inbox, or broadcast)
	 */
	private sendRelayOutboxEntry(entry: RelayOutboxEntry): void {
		if (!this.config.isHub) {
			// Spoke mode: find the hub connection (typically there's one)
			for (const [, peer] of this.peerConnections) {
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
				break; // Send to the first (only) hub connection
			}
		} else {
			// Hub mode: route using the same logic as spoke-originated relay_send.
			// The hub's own agent loop can write relay outbox entries (e.g., inference
			// requests targeting a spoke). These must be routed just like entries
			// received from a spoke via handleRelaySend.
			this.config.logger?.info("WsTransport: hub routing outbox entry", {
				kind: entry.kind,
				targetSiteId: entry.target_site_id,
				isSelf: entry.target_site_id === this.config.siteId,
				entryId: entry.id,
			});
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
			this.handleRelaySend(this.config.siteId, payload);
			// Mark as delivered — no WS ack for hub-local routing
			markDelivered(this.config.db, [entry.id]);
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
			// Idempotency check on hub side — skip when source is self, because
			// hub-originated entries are already in our own relay_outbox (we just
			// wrote them). Without this guard the check always finds the entry we
			// just inserted and silently skips routing.
			if (entry.idempotency_key && sourceSiteId !== this.config.siteId) {
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

				// Also insert into hub's own relay_inbox and emit event
				const hubInboxEntry: RelayInboxEntry = {
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

				if (insertInbox(this.config.db, hubInboxEntry)) {
					this.config.eventBus.emit("relay:inbox", {
						ref_id: hubInboxEntry.ref_id || undefined,
						stream_id: hubInboxEntry.stream_id || undefined,
						kind: hubInboxEntry.kind,
					});
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

				const inserted = insertInbox(this.config.db, inboxEntry);

				// Only emit relay:inbox event and track as delivered if this is a new entry
				if (inserted) {
					this.config.eventBus.emit("relay:inbox", {
						ref_id: inboxEntry.ref_id || undefined,
						stream_id: inboxEntry.stream_id || undefined,
						kind: inboxEntry.kind,
					});

					deliveredIds.push(entry.id);
				}

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

	// ── Snapshot seeding (new-spoke initial state handoff) ────────────────

	/**
	 * Seed a newly-connected peer with a full snapshot of all synced tables.
	 *
	 * Detects whether the peer needs seeding (cursor is HLC_ZERO, meaning it has
	 * never received any data from this node). If so, sends a SNAPSHOT_BEGIN frame
	 * followed by chunked SNAPSHOT_CHUNK frames for every synced table.
	 *
	 * On the hub, this is called from ws-server's open handler right after addPeer().
	 * On a spoke, this is a no-op (spokes don't seed other spokes).
	 */
	seedNewPeer(peerSiteId: string): void {
		// Only the hub seeds new peers. A spoke receiving a connection from
		// another spoke shouldn't dump its local state.
		if (!this.config.isHub) return;

		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return;

		// Only seed if this peer has never received data from us.
		const cursor = getPeerCursor(this.config.db, peerSiteId);
		if (cursor && cursor.last_received !== HLC_ZERO) return;

		// Snapshot HLC: everything in the DB up to this point is included.
		// Post-snapshot changelog catchup starts from here.
		const now = new Date().toISOString();
		const snapshotHlc = generateHlc(now, null, this.config.siteId);

		this.snapshotStates.set(peerSiteId, {
			tableIndex: 0,
			offset: 0,
			lastRowid: 0,
			snapshotHlc,
			draining: false,
		});

		// Create a sync_state row early so pruning is blocked while seeding
		// (getMinConfirmedHlc sees HLC_ZERO → pruning paused).
		updatePeerCursor(this.config.db, peerSiteId, {});

		// Send SNAPSHOT_BEGIN with the table list and snapshot HLC.
		const beginPayload: SnapshotBeginPayload = {
			snapshot_hlc: snapshotHlc,
			tables: SNAPSHOT_TABLE_ORDER.slice(),
		};
		const beginFrame = encodeFrame(WsMessageType.SNAPSHOT_BEGIN, beginPayload, peer.symmetricKey);
		peer.sendFrame(beginFrame);

		this.config.logger?.info("[snapshot] Seeding new peer", {
			peerSiteId,
			snapshotHlc,
			tableCount: SNAPSHOT_TABLE_ORDER.length,
		});

		// Start sending chunks (yield to event loop so the SNAPSHOT_BEGIN frame
		// is flushed before we start pushing table data).
		setTimeout(() => this.continueSnapshotSeed(peerSiteId), 0);
	}

	/**
	 * Called by the hub when the spoke sends SNAPSHOT_ACK (all snapshot rows applied).
	 * Cleans up seeding state and triggers the normal changelog drain to catch up
	 * on any entries that arrived during seeding.
	 */
	handleSnapshotAck(peerSiteId: string, _payload: SnapshotAckPayload): void {
		this.snapshotStates.delete(peerSiteId);
		this.config.logger?.info("[snapshot] Spoke acknowledged snapshot", { peerSiteId });

		// Now run the normal changelog drain (from the snapshot HLC forward).
		this.drainChangelog(peerSiteId);
	}

	/**
	 * Handle a RESEED_REQUEST from a spoke that wants a full DB snapshot.
	 *
	 * Used when a spoke has an existing cursor but knows its local state is
	 * incomplete (e.g. it was restored from an old backup or missed pruned
	 * changelog entries). Clears the peer's sync_state so seedNewPeer()
	 * treats it as a fresh node and sends the full snapshot.
	 */
	handleReseedRequest(peerSiteId: string, _payload: unknown): void {
		// Only the hub handles reseed requests.
		if (!this.config.isHub) return;

		this.config.logger?.info("[reseed] Spoke requested full reseed", { peerSiteId });

		// Reset the peer's cursor to HLC_ZERO so seedNewPeer triggers.
		updatePeerCursor(this.config.db, peerSiteId, {
			last_received: HLC_ZERO,
			last_sent: HLC_ZERO,
		});

		// Now seed as if this were a brand-new peer.
		this.seedNewPeer(peerSiteId);
	}

	/**
	 * Resume snapshot seeding after backpressure clears.
	 * Called by ws-server's drain handler when the WebSocket buffer flushes.
	 */
	continueSnapshotSeed(peerSiteId: string): void {
		const state = this.snapshotStates.get(peerSiteId);
		if (!state) return;
		if (!state.draining) return;

		state.draining = false;
		this.sendSnapshotChunks(peerSiteId);
	}

	// ── Private snapshot helpers ──────────────────────────────────────────

	/**
	 * Send chunks for the current table (and subsequent tables) until
	 * backpressure or completion.
	 */
	private sendSnapshotChunks(peerSiteId: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) {
			this.snapshotStates.delete(peerSiteId);
			return;
		}

		const state = this.snapshotStates.get(peerSiteId);
		if (!state) return;

		// Iterate tables
		while (state.tableIndex < SNAPSHOT_TABLE_ORDER.length) {
			const table = SNAPSHOT_TABLE_ORDER[state.tableIndex];
			if (!this.sendSnapshotTableChunks(peerSiteId, table)) {
				// Backpressure or chunk limit reached — stop for now.
				return;
			}

			// Table fully sent — advance to next.
			state.tableIndex++;
			state.offset = 0;
			state.lastRowid = 0;
		}

		// All tables done.
		this.sendSnapshotEnd(peerSiteId);
	}

	/**
	 * Send chunks for a single table. Returns false if we should stop
	 * (backpressured or yielded to event loop), true if table is fully sent.
	 */
	private sendSnapshotTableChunks(peerSiteId: string, table: string): boolean {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return false;

		const state = this.snapshotStates.get(peerSiteId);
		if (!state) return false;

		const chunkSize = 500; // rows per chunk
		let chunksSent = 0;

		while (true) {
			// Cursor-based pagination via rowid — O(chunkSize) per query regardless
			// of position in the table. OFFSET degrades linearly in SQLite because
			// it must scan and discard all rows up to the offset.
			// NOTE: ORDER BY rowid assumes no synced table is WITHOUT ROWID.
			const rowsRaw = this.config.db
				.query(
					`SELECT rowid AS _bound_rowid, * FROM ${table} WHERE deleted = 0 AND rowid > ? ORDER BY rowid LIMIT ?`,
				)
				.all(state.lastRowid, chunkSize) as Array<Record<string, unknown>>;

			if (rowsRaw.length === 0) return true; // Table done.

			// Advance the rowid cursor so the next query starts after this batch.
			const lastRowid = rowsRaw[rowsRaw.length - 1]?._bound_rowid as number;
			if (typeof lastRowid === "number") {
				state.lastRowid = lastRowid;
			}

			// Strip the internal rowid column before sending rows to the spoke.
			const rows = rowsRaw.map((r) => {
				const { _bound_rowid, ...rest } = r;
				return rest;
			});

			const isLast = rowsRaw.length < chunkSize;
			const chunkPayload: SnapshotChunkPayload = {
				table_name: table,
				offset: state.offset,
				rows,
				last: isLast,
			};

			const frame = encodeFrame(WsMessageType.SNAPSHOT_CHUNK, chunkPayload, peer.symmetricKey);
			const sent = peer.sendFrame(frame);

			if (!sent) {
				state.draining = true;
				this.config.logger?.debug("[snapshot] Backpressured, waiting for drain", {
					peerSiteId,
					table,
					offset: state.offset,
					lastRowid: state.lastRowid,
				});
				return false;
			}

			state.offset += rows.length;
			chunksSent++;

			if (isLast) return true; // Table done.

			// Yield to event loop every 20 chunks (10,000 rows) to avoid
			// blocking the hub for too long during large-table seeding.
			if (chunksSent % 20 === 0) {
				setTimeout(() => this.sendSnapshotChunks(peerSiteId), 0);
				return false;
			}
		}
	}

	/**
	 * Send SNAPSHOT_END frame indicating all tables have been seeded.
	 */
	private sendSnapshotEnd(peerSiteId: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return;

		const state = this.snapshotStates.get(peerSiteId);
		if (!state) return;

		// Count total rows seeded across all tables for the payload.
		const totalRows = SNAPSHOT_TABLE_ORDER.reduce((sum, table) => {
			const row = this.config.db
				.query(`SELECT COUNT(*) as cnt FROM ${table} WHERE deleted = 0`)
				.get() as { cnt: number } | null;
			return sum + (row?.cnt ?? 0);
		}, 0);

		const endPayload: SnapshotEndPayload = {
			table_count: SNAPSHOT_TABLE_ORDER.length,
			row_count: totalRows,
		};
		const frame = encodeFrame(WsMessageType.SNAPSHOT_END, endPayload, peer.symmetricKey);
		peer.sendFrame(frame);

		this.config.logger?.info("[snapshot] Snapshot seeding complete", {
			peerSiteId,
			tables: SNAPSHOT_TABLE_ORDER.length,
			rows: totalRows,
		});
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
