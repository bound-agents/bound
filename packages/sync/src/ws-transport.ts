import type { Database, Statement } from "bun:sqlite";
import {
	createChangeLogEntry,
	getBackfillablePksSorted,
	getPkColumn as getPkColumnTyped,
	insertInbox,
	markDelivered,
	mergeDiffPks,
	readUndelivered,
	writeOutbox,
} from "@bound/core";
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
import {
	applyColumnChunk as applyColumnChunkFn,
	applySnapshotRows,
	getPkColumn,
	replayEvents,
} from "./reducers.js";
import { MicrotaskCoalescer } from "./ws-coalescer.js";
import type {
	ChangelogAckPayload,
	ChangelogPushPayload,
	RelayAckPayload,
	RelayDeliverPayload,
	RelaySendPayload,
	RowPullRequestPayload,
	RowPullResponsePayload,
	SnapshotAckPayload,
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
	ping: () => void;
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
/**
 * Max encoded frame size for a single snapshot chunk (4 MB).
 * Bun's default maxPayloadLength is 16 MB — staying well under this
 * prevents the server from dropping oversized frames. Tables like
 * `files` can have rows with large content blobs that easily exceed
 * 16 MB when 100 rows are batched together.
 */
const MAX_SNAPSHOT_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CHANGELOG_FRAME_BYTES = MAX_SNAPSHOT_FRAME_BYTES;

function encodeChangelogFrames(
	entries: Array<{
		hlc: string;
		table_name: string;
		row_id: string;
		site_id: string;
		timestamp: string;
		row_data: Record<string, unknown>;
	}>,
	symmetricKey: Uint8Array,
): Uint8Array[] {
	if (entries.length === 0) return [];
	const payload: ChangelogPushPayload = { entries };
	const frame = encodeFrame(WsMessageType.CHANGELOG_PUSH, payload, symmetricKey);
	if (frame.length <= MAX_CHANGELOG_FRAME_BYTES) return [frame];

	if (entries.length === 1) return [frame];

	const mid = Math.floor(entries.length / 2);
	return [
		...encodeChangelogFrames(entries.slice(0, mid), symmetricKey),
		...encodeChangelogFrames(entries.slice(mid), symmetricKey),
	];
}

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
	tableIndex: number;
	offset: number;
	lastRowid: number;
	snapshotHlc: string;
	draining: boolean;
	stmt: Statement | null;
	/** Rows from the current DB query, split across multiple send cycles. */
	pendingRows?: Array<Record<string, unknown>>;
	/** Current position within pendingRows. */
	pendingCursor?: number;
	/** Raw rows (with _bound_rowid) for cursor rewind on backpressure. */
	pendingRowsRaw?: Array<Record<string, unknown>>;
	/** Whether the current batch is the last for this table. */
	pendingIsLastBatch?: boolean;
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
		ping?: () => void,
	): void {
		this.peerConnections.set(peerSiteId, {
			peerSiteId,
			sendFrame,
			ping: ping ?? (() => {}),
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

		const state = this.snapshotStates.get(peerSiteId);
		const wasSeeding = !!state;
		if (state?.stmt) {
			try {
				state.stmt.finalize();
			} catch {
				/* best effort */
			}
		}
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

	applyColumnChunk(
		tableName: string,
		pkValue: string,
		columnName: string,
		chunkIndex: number,
		chunkData: string,
	): void {
		applyColumnChunkFn(
			this.config.db,
			tableName,
			pkValue,
			columnName,
			chunkIndex,
			chunkData,
			this.config.logger,
		);
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
			// Skip peers that are mid-snapshot — the post-snapshot drain handles catchup.
			if (this.snapshotStates.has(peerSiteId)) {
				continue;
			}

			// Echo suppression: filter out entries from this peer
			const entriesToSend = entries.filter((entry) => entry.site_id !== peerSiteId);

			if (entriesToSend.length === 0) {
				continue;
			}

			const wireEntries = entriesToSend.map((entry) => ({
				hlc: entry.hlc,
				table_name: entry.table_name,
				row_id: entry.row_id,
				site_id: entry.site_id,
				timestamp: entry.timestamp,
				row_data: JSON.parse(entry.row_data) as Record<string, unknown>,
			}));

			const frames = encodeChangelogFrames(wireEntries, peer.symmetricKey);
			let allSent = true;
			for (const frame of frames) {
				if (!peer.sendFrame(frame)) {
					this.config.logger?.warn("WsTransport changelog_push backpressured", {
						peerSiteId,
						entryCount: entriesToSend.length,
					});
					allSent = false;
					break;
				}
			}
			if (allSent) {
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

		const batchSize = 100;
		let backpressured = false;

		for (let i = 0; i < allEntries.length && !backpressured; i += batchSize) {
			const batch = allEntries.slice(i, i + batchSize);

			const wireEntries = batch.map((entry) => ({
				hlc: entry.hlc,
				table_name: entry.table_name,
				row_id: entry.row_id,
				site_id: entry.site_id,
				timestamp: entry.timestamp,
				row_data: JSON.parse(entry.row_data) as Record<string, unknown>,
			}));

			const frames = encodeChangelogFrames(wireEntries, peer.symmetricKey);
			for (const frame of frames) {
				if (!peer.sendFrame(frame)) {
					this.config.logger?.warn("WsTransport drain backpressured", {
						peerSiteId,
						batchIndex: i / batchSize,
						totalBatches: Math.ceil(allEntries.length / batchSize),
					});
					backpressured = true;
					break;
				}
			}
			if (!backpressured) {
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
		// No-op: spoke-initiated consistency pull replaces hub-initiated snapshot seeding.
		// The spoke calls runBackfill() on connect, which handles first-connect via row pull.
		if (!this.config.isHub) return;

		// Ensure a sync_state row exists so the peer is tracked for changelog drain.
		updatePeerCursor(this.config.db, peerSiteId, {});

		this.config.logger?.debug("[snapshot] seedNewPeer is no-op — spoke will pull via consistency", {
			peerSiteId,
		});
	}

	/**
	 * Called by the hub when the spoke sends SNAPSHOT_ACK (all snapshot rows applied).
	 * Cleans up seeding state and triggers the normal changelog drain to catch up
	 * on any entries that arrived during seeding.
	 */
	handleSnapshotAck(peerSiteId: string, _payload: SnapshotAckPayload): void {
		const state = this.snapshotStates.get(peerSiteId);
		const snapshotHlc = state?.snapshotHlc;
		this.snapshotStates.delete(peerSiteId);
		this.config.logger?.info("[snapshot] Spoke acknowledged snapshot", { peerSiteId });

		// Advance cursors to the snapshot HLC so the changelog drain starts
		// from the right point and the pruner knows the spoke has everything
		// up to this HLC. Without this, last_sent stays at HLC_ZERO and the
		// drain relies on un-pruned changelog entries that may already be gone.
		if (snapshotHlc) {
			updatePeerCursor(this.config.db, peerSiteId, {
				last_received: snapshotHlc,
				last_sent: snapshotHlc,
			});
		}

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

		// Guard against duplicate reseed requests while a snapshot is already
		// in progress (race: hub auto-starts seeding on connect, spoke sends
		// RESEED_REQUEST before receiving SNAPSHOT_BEGIN).
		if (this.snapshotStates.has(peerSiteId)) {
			this.config.logger?.debug("[reseed] Ignoring duplicate request — snapshot already active", {
				peerSiteId,
			});
			return;
		}

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

		// Send a WebSocket ping to reset the server-side idle timer.
		// uWebSockets (underlying Bun's WS) does NOT reset its idle timer
		// on application-level message frames from the client. Only sends
		// from the server (including ping frames) reset it. During long
		// snapshot transfers the hub may pause between tables (DB queries,
		// backpressure waits), and without this ping the idle timer fires
		// and kills the connection mid-seed.
		peer.ping();

		// Iterate tables
		while (state.tableIndex < SNAPSHOT_TABLE_ORDER.length) {
			const table = SNAPSHOT_TABLE_ORDER[state.tableIndex];
			if (!this.sendSnapshotTableChunks(peerSiteId, table)) {
				// Backpressure or yielded to event loop — stop for now.
				return;
			}

			// Table fully sent — advance to next.
			state.tableIndex++;
			state.offset = 0;
			state.lastRowid = 0;
			state.stmt = null;
			this.clearPendingRows(state);
			this.config.logger?.debug("[snapshot] Advancing to next table", {
				peerSiteId,
				nextTable: SNAPSHOT_TABLE_ORDER[state.tableIndex],
			});
		}

		// All tables done.
		this.sendSnapshotEnd(peerSiteId);
	}

	/**
	 * Send exactly one chunk for a single table. Returns false if we should stop
	 * (backpressured or yielded to event loop), true if table is fully sent.
	 *
	 * The prepared statement is stored in SnapshotState.stmt and reused across
	 * calls for the same table. This avoids re-parsing SQL on every chunk while
	 * still yielding to the event loop after each chunk so WebSocket keepalives
	 * can fire.
	 */
	private sendSnapshotTableChunks(peerSiteId: string, table: string): boolean {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return false;

		const state = this.snapshotStates.get(peerSiteId);
		if (!state) return false;

		// If we have pending rows from a previous invocation (batch was split
		// across multiple event-loop yields), continue from where we left off
		// instead of re-querying the DB.
		if (state.pendingRows && state.pendingCursor !== undefined) {
			return this.sendOneSubChunk(peerSiteId, table, peer, state);
		}

		const chunkSize = 100;

		if (!state.stmt) {
			try {
				state.stmt = this.config.db.prepare(
					`SELECT rowid AS _bound_rowid, * FROM ${table} WHERE deleted = 0 AND rowid > ? ORDER BY rowid LIMIT ?`,
				);
			} catch {
				try {
					state.stmt = this.config.db.prepare(
						`SELECT rowid AS _bound_rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
					);
				} catch {
					this.config.logger?.warn("[snapshot] Skipping missing table during seed", {
						table,
						peerSiteId,
					});
					return true;
				}
			}
		}

		const rowsRaw = state.stmt.all(state.lastRowid, chunkSize) as Array<Record<string, unknown>>;

		if (rowsRaw.length === 0) {
			state.stmt.finalize();
			state.stmt = null;
			return true;
		}

		const lastRowid = rowsRaw[rowsRaw.length - 1]?._bound_rowid as number;
		if (typeof lastRowid === "number") {
			state.lastRowid = lastRowid;
		}

		const allRows = rowsRaw.map((r) => {
			const { _bound_rowid, ...rest } = r;
			return rest;
		});

		const isLastBatch = rowsRaw.length < chunkSize;

		// Store the batch for incremental sub-chunk sending. Each invocation
		// sends exactly ONE sub-chunk then yields to the event loop. This
		// prevents flooding the TCP send buffer with multiple multi-MB frames
		// in a tight loop (which causes ws.send() to return 0 = dropped).
		state.pendingRows = allRows;
		state.pendingCursor = 0;
		state.pendingRowsRaw = rowsRaw;
		state.pendingIsLastBatch = isLastBatch;

		return this.sendOneSubChunk(peerSiteId, table, peer, state);
	}

	private sendOneSubChunk(
		peerSiteId: string,
		table: string,
		peer: PeerConnection,
		state: SnapshotState,
	): boolean {
		if (!state.pendingRows || state.pendingCursor === undefined) {
			return true;
		}
		const rows = state.pendingRows;
		const isLastBatch = state.pendingIsLastBatch ?? false;
		const rowCursor = state.pendingCursor;

		let sliceEnd = rows.length;
		let frame: Uint8Array | null = null;

		while (sliceEnd > rowCursor) {
			const slice = rows.slice(rowCursor, sliceEnd);
			const isLast = isLastBatch && sliceEnd === rows.length;
			const payload: SnapshotChunkPayload = {
				table_name: table,
				offset: state.offset,
				rows: slice,
				last: isLast,
			};

			const candidate = encodeFrame(WsMessageType.SNAPSHOT_CHUNK, payload, peer.symmetricKey);

			if (candidate.length <= MAX_SNAPSHOT_FRAME_BYTES) {
				frame = candidate;
				break;
			}

			if (sliceEnd - rowCursor === 1) {
				const isLastRow = isLastBatch && sliceEnd === rows.length;
				const result = this.sendOversizedRow(peerSiteId, table, rows[rowCursor], state, isLastRow);
				if (!result) {
					state.draining = true;
					return false;
				}
				state.offset += 1;
				state.pendingCursor = sliceEnd;
				return this.finishSubChunk(peerSiteId, state);
			}

			sliceEnd = rowCursor + Math.max(1, Math.floor((sliceEnd - rowCursor) / 2));
		}

		if (!frame) {
			this.clearPendingRows(state);
			return true;
		}

		const sent = peer.sendFrame(frame);
		if (!sent) {
			// Keep pendingRows intact — continueSnapshotSeed will resume from
			// the current pendingCursor after the drain event fires.
			state.draining = true;
			this.config.logger?.debug("[snapshot] Backpressured, waiting for drain", {
				peerSiteId,
				table,
				offset: state.offset,
				lastRowid: state.lastRowid,
			});
			return false;
		}

		const sentCount = sliceEnd - rowCursor;
		state.offset += sentCount;
		state.pendingCursor = sliceEnd;

		this.config.logger?.debug("[snapshot] Sent chunk", {
			peerSiteId,
			table,
			rows: sentCount,
			totalOffset: state.offset,
			lastRowid: state.lastRowid,
			frameBytes: frame.length,
		});

		return this.finishSubChunk(peerSiteId, state);
	}

	private finishSubChunk(peerSiteId: string, state: SnapshotState): boolean {
		if ((state.pendingCursor ?? 0) >= (state.pendingRows?.length ?? 0)) {
			const isLastBatch = state.pendingIsLastBatch;
			this.clearPendingRows(state);
			if (isLastBatch) {
				state.stmt?.finalize();
				state.stmt = null;
				return true;
			}
		}
		// Yield to event loop after each sub-chunk so Bun can flush the TCP
		// send buffer and process ping/pong frames.
		setTimeout(() => this.sendSnapshotChunks(peerSiteId), 100);
		return false;
	}

	private clearPendingRows(state: SnapshotState): void {
		state.pendingRows = undefined;
		state.pendingCursor = undefined;
		state.pendingRowsRaw = undefined;
		state.pendingIsLastBatch = undefined;
	}

	/**
	 * Send a single oversized row using skeleton-then-column-chunk protocol.
	 * Returns true if all frames sent successfully, false on backpressure.
	 */
	private sendOversizedRow(
		peerSiteId: string,
		table: string,
		row: Record<string, unknown>,
		state: SnapshotState,
		isLastRowInTable: boolean,
	): boolean {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return false;

		const pkColumn = getPkColumn(table);
		const pkValue = String(row[pkColumn] ?? "");

		// Identify oversized TEXT columns (encoded size > half the frame budget).
		const oversizedColumns: Array<{ column: string; value: string }> = [];
		for (const [col, val] of Object.entries(row)) {
			if (typeof val === "string" && val.length > MAX_SNAPSHOT_FRAME_BYTES / 4) {
				oversizedColumns.push({ column: col, value: val });
			}
		}

		// Build skeleton row with oversized columns replaced by empty strings.
		const skeleton: Record<string, unknown> = { ...row };
		for (const { column } of oversizedColumns) {
			skeleton[column] = "";
		}

		// Send skeleton row. last=true only if there are no column chunks to follow.
		const skeletonIsLast = isLastRowInTable && oversizedColumns.length === 0;
		const skeletonPayload: SnapshotChunkPayload = {
			table_name: table,
			offset: state.offset,
			rows: [skeleton],
			last: skeletonIsLast,
		};
		const skeletonFrame = encodeFrame(
			WsMessageType.SNAPSHOT_CHUNK,
			skeletonPayload,
			peer.symmetricKey,
		);
		if (!peer.sendFrame(skeletonFrame)) return false;

		this.config.logger?.debug("[snapshot] Sent oversized row skeleton", {
			peerSiteId,
			table,
			pkValue,
			oversizedColumns: oversizedColumns.map((c) => c.column),
		});

		// Send column chunks for each oversized column.
		for (let colIdx = 0; colIdx < oversizedColumns.length; colIdx++) {
			const { column, value } = oversizedColumns[colIdx];
			const isLastColumn = colIdx === oversizedColumns.length - 1;

			let charOffset = 0;
			let chunkIndex = 0;
			while (charOffset < value.length) {
				// Binary-search for the largest substring that fits in a frame.
				let lo = 1;
				let hi = value.length - charOffset;
				let bestLen = 1;

				while (lo <= hi) {
					const mid = Math.floor((lo + hi) / 2);
					const candidate = value.slice(charOffset, charOffset + mid);
					const isFinal = charOffset + mid >= value.length;
					const isLast = isLastRowInTable && isLastColumn && isFinal;
					const payload: SnapshotChunkPayload = {
						table_name: table,
						offset: state.offset,
						rows: [],
						last: isLast,
						col_chunk_row_id: pkValue,
						col_chunk_column: column,
						col_chunk_index: chunkIndex,
						col_chunk_final: isFinal,
						col_chunk_data: candidate,
					};
					const frame = encodeFrame(WsMessageType.SNAPSHOT_CHUNK, payload, peer.symmetricKey);
					if (frame.length <= MAX_SNAPSHOT_FRAME_BYTES) {
						bestLen = mid;
						lo = mid + 1;
					} else {
						hi = mid - 1;
					}
				}

				const chunk = value.slice(charOffset, charOffset + bestLen);
				const isFinal = charOffset + bestLen >= value.length;
				const isLast = isLastRowInTable && isLastColumn && isFinal;
				const payload: SnapshotChunkPayload = {
					table_name: table,
					offset: state.offset,
					rows: [],
					last: isLast,
					col_chunk_row_id: pkValue,
					col_chunk_column: column,
					col_chunk_index: chunkIndex,
					col_chunk_final: isFinal,
					col_chunk_data: chunk,
				};
				const frame = encodeFrame(WsMessageType.SNAPSHOT_CHUNK, payload, peer.symmetricKey);
				if (!peer.sendFrame(frame)) return false;

				this.config.logger?.debug("[snapshot] Sent column chunk", {
					peerSiteId,
					table,
					pkValue,
					column,
					chunkIndex,
					charOffset,
					chunkLen: bestLen,
					isFinal,
					frameBytes: frame.length,
				});

				charOffset += bestLen;
				chunkIndex++;
			}
		}

		return true;
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
		// Missing tables (e.g. in test DBs) contribute 0.
		const totalRows = SNAPSHOT_TABLE_ORDER.reduce((sum, table) => {
			try {
				const row = this.config.db
					.query(`SELECT COUNT(*) as cnt FROM ${table} WHERE deleted = 0`)
					.get() as { cnt: number } | null;
				return sum + (row?.cnt ?? 0);
			} catch {
				return sum;
			}
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

	// ── Consistency check ────────────────────────────────────────────────

	private static readonly CONSISTENCY_PAGE_SIZE = 5000;

	handleConsistencyRequest(
		peerSiteId: string,
		payload: { tables: string[]; request_id?: string },
	): void {
		if (!this.config.isHub) return;

		const allTables: SyncedTableName[] = [
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

		const requestedNames = payload.tables.length > 0 ? payload.tables : allTables.map(String);
		const tables = allTables.filter((t) => requestedNames.includes(t));

		if (tables.length === 0) {
			this.config.logger?.warn("[consistency] No valid tables in request", {
				peerSiteId,
			});
			return;
		}

		this.config.logger?.debug("[consistency] Starting PK stream", {
			peerSiteId,
			tableCount: tables.length,
		});

		this.streamConsistencyPages(peerSiteId, tables, 0, 0, payload.request_id);
	}

	private streamConsistencyPages(
		peerSiteId: string,
		tables: SyncedTableName[],
		tableIndex: number,
		offset: number,
		requestId?: string,
	): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return;

		const table = tables[tableIndex];
		const pkCol = getPkColumn(table);
		const pageSize = WsTransport.CONSISTENCY_PAGE_SIZE;

		const countRow = this.config.db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
			c: number;
		};

		const rows = this.config.db
			.query(`SELECT ${pkCol} AS pk FROM ${table} ORDER BY ${pkCol} ASC LIMIT ? OFFSET ?`)
			.all(pageSize + 1, offset) as Array<{ pk: string }>;

		const hasMore = rows.length > pageSize;
		const pks = rows.slice(0, pageSize).map((r) => r.pk);
		const isLastTable = tableIndex === tables.length - 1;
		const allDone = isLastTable && !hasMore;

		const frame = encodeFrame(
			WsMessageType.CONSISTENCY_RESPONSE,
			{
				table,
				pks,
				count: countRow.c,
				has_more: hasMore,
				table_index: tableIndex,
				table_count: tables.length,
				all_done: allDone,
				request_id: requestId,
			},
			peer.symmetricKey,
		);
		const sent = peer.sendFrame(frame);
		if (!sent) {
			this.config.logger?.warn("[consistency] sendFrame returned false (backpressure)", {
				peerSiteId,
				table,
				tableIndex,
			});
		}

		if (allDone) {
			this.config.logger?.debug("[consistency] PK stream complete", {
				peerSiteId,
				tableCount: tables.length,
			});
			return;
		}

		const nextTableIndex = hasMore ? tableIndex : tableIndex + 1;
		const nextOffset = hasMore ? offset + pageSize : 0;

		setTimeout(() => {
			this.streamConsistencyPages(peerSiteId, tables, nextTableIndex, nextOffset, requestId);
		}, 0);
	}

	// ── Spoke-side: request + collect ────────────────────────────────────

	private pendingConsistencyRequests = new Map<
		string,
		{
			resolve: (data: Map<string, { count: number; pks: string[] }>) => void;
			reject: (err: Error) => void;
			data: Map<string, { count: number; pks: string[] }>;
			timer: Timer;
			idleTimer: Timer | null;
		}
	>();

	requestConsistency(tables: string[]): Promise<Map<string, { count: number; pks: string[] }>> {
		const hubPeer = this.peerConnections.values().next().value as PeerConnection | undefined;
		if (!hubPeer) {
			return Promise.reject(new Error("Not connected to hub"));
		}

		const requestId = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const frame = encodeFrame(
			WsMessageType.CONSISTENCY_REQUEST,
			{ tables, request_id: requestId },
			hubPeer.symmetricKey,
		);
		if (!hubPeer.sendFrame(frame)) {
			return Promise.reject(new Error("Failed to send consistency request"));
		}

		this.config.logger?.debug("[consistency] Request sent", { requestId });

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingConsistencyRequests.delete(requestId);
				reject(new Error("Consistency check timed out (60s)"));
			}, 60_000);
			this.pendingConsistencyRequests.set(requestId, {
				resolve,
				reject,
				data: new Map(),
				timer,
				idleTimer: null,
			});
		});
	}

	handleConsistencyResponse(payload: {
		table: string;
		pks: string[];
		count: number;
		has_more?: boolean;
		table_index?: number;
		table_count?: number;
		all_done?: boolean;
		request_id?: string;
	}): void {
		const rid = payload.request_id;
		if (!rid) return;
		const req = this.pendingConsistencyRequests.get(rid);
		if (!req) return;

		const existing = req.data.get(payload.table);
		if (existing) {
			existing.pks.push(...payload.pks);
			existing.count = payload.count;
		} else {
			req.data.set(payload.table, {
				count: payload.count,
				pks: [...payload.pks],
			});
		}

		if (payload.all_done) {
			this.resolveConsistency(rid, "all_done flag");
			return;
		}

		const tc = payload.table_count;
		if (!payload.has_more && typeof tc === "number" && tc > 0 && req.data.size >= tc) {
			this.resolveConsistency(rid, "table_count match");
			return;
		}

		if (req.idleTimer) clearTimeout(req.idleTimer);
		req.idleTimer = setTimeout(() => {
			if (this.pendingConsistencyRequests.has(rid) && req.data.size > 0) {
				this.resolveConsistency(rid, "idle timeout (10s)");
			}
		}, 10_000);
	}

	private resolveConsistency(requestId: string, reason: string): void {
		const req = this.pendingConsistencyRequests.get(requestId);
		if (!req) return;
		this.config.logger?.debug("[consistency] Resolving", {
			reason,
			requestId,
			tables: req.data.size,
		});
		clearTimeout(req.timer);
		if (req.idleTimer) clearTimeout(req.idleTimer);
		this.pendingConsistencyRequests.delete(requestId);
		req.resolve(req.data);
	}

	private async requestConsistencyWithTimeout(): Promise<
		Map<string, { count: number; pks: string[] }>
	> {
		return Promise.race([
			this.requestConsistency([]),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Consistency request timed out (30s)")), 30_000),
			),
		]);
	}

	// ── Auto-backfill: push local-only rows as changelog entries ─────────

	private static readonly BACKFILL_BATCH_SIZE = 1000;

	private static readonly SYNCED_TABLES: SyncedTableName[] = [
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

	clearSyncedTables(): void {
		this.config.db.exec("BEGIN IMMEDIATE");
		try {
			for (const table of WsTransport.SYNCED_TABLES) {
				this.config.db.exec(`DELETE FROM ${table}`);
			}
			this.config.db.exec("COMMIT");
		} catch (err) {
			try {
				this.config.db.exec("ROLLBACK");
			} catch {
				// original error takes priority
			}
			throw err;
		}
		this.config.logger?.info("[reseed] All synced tables cleared");
	}
	private static readonly BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;
	private backfillRunning = false;
	private lastBackfillAt = 0;

	async runBackfill(opts?: {
		isFirstConnect?: boolean;
	}): Promise<{ backfilled: number; tables: number; pulled: number }> {
		if (this.backfillRunning) {
			throw new Error("Backfill already in progress");
		}
		const elapsed = Date.now() - this.lastBackfillAt;
		if (this.lastBackfillAt > 0 && elapsed < WsTransport.BACKFILL_COOLDOWN_MS) {
			this.config.logger?.debug("[backfill] Skipping — cooldown active", {
				remainingMs: WsTransport.BACKFILL_COOLDOWN_MS - elapsed,
			});
			return { backfilled: 0, tables: 0, pulled: 0 };
		}
		this.backfillRunning = true;
		try {
			const result = await this.executeBackfill(opts?.isFirstConnect);
			this.lastBackfillAt = Date.now();
			return result;
		} finally {
			this.backfillRunning = false;
		}
	}

	private async executeBackfill(
		isFirstConnect?: boolean,
	): Promise<{ backfilled: number; tables: number; pulled: number }> {
		const remoteTables = await this.requestConsistencyWithTimeout();

		const allSyncedTables = WsTransport.SYNCED_TABLES;

		let backfilled = 0;
		let tablesWithDrift = 0;
		const remoteOnlyByTable: Array<{ table: string; pks: string[] }> = [];

		for (const table of allSyncedTables) {
			const remote = remoteTables.get(table);
			if (!remote) continue;

			const pkCol = getPkColumnTyped(table);
			const localPks = getBackfillablePksSorted(this.config.db, table);
			const remotePksSorted = remote.pks.slice().sort();
			const diff = mergeDiffPks(localPks, remotePksSorted);

			if (diff.remoteOnly.length > 0) {
				remoteOnlyByTable.push({ table, pks: diff.remoteOnly });
			}

			if (diff.localOnly.length === 0) continue;
			tablesWithDrift++;

			this.config.logger?.info("[backfill] Table needs backfill", {
				table,
				localOnly: diff.localOnly.length,
				remoteOnly: diff.remoteOnly.length,
			});

			const batchSize = WsTransport.BACKFILL_BATCH_SIZE;
			for (let i = 0; i < diff.localOnly.length; i += batchSize) {
				const batch = diff.localOnly.slice(i, i + batchSize);
				const hlcs: string[] = [];

				this.config.db.exec("BEGIN IMMEDIATE");
				try {
					for (const pk of batch) {
						const row = this.config.db
							.query(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
							.get(pk) as Record<string, unknown> | null;
						if (!row) continue;
						const hlc = createChangeLogEntry(this.config.db, table, pk, this.config.siteId, row);
						hlcs.push(hlc);
					}
					this.config.db.exec("COMMIT");
				} catch (err) {
					try {
						this.config.db.exec("ROLLBACK");
					} catch {
						// original error takes priority
					}
					throw err;
				}

				for (const hlc of hlcs) {
					this.config.eventBus.emit("changelog:written", {
						hlc,
						tableName: table,
						siteId: this.config.siteId,
					});
				}

				backfilled += hlcs.length;

				await new Promise((r) => setTimeout(r, 0));
			}
		}

		let pulled = 0;
		if (remoteOnlyByTable.length > 0) {
			const totalRemoteOnly = remoteOnlyByTable.reduce((sum, t) => sum + t.pks.length, 0);
			this.config.logger?.info("[backfill] Pulling remote-only rows", {
				tables: remoteOnlyByTable.length,
				rows: totalRemoteOnly,
			});
			await this.requestRowPull(remoteOnlyByTable);
			pulled = totalRemoteOnly;
		}

		if (isFirstConnect) {
			this.sendRowPullAck(`rp_ack_${Date.now()}`);
		}

		if (backfilled > 0 || pulled > 0) {
			this.config.logger?.info("[backfill] Complete", {
				backfilled,
				pulled,
				tables: tablesWithDrift,
			});
		}

		return { backfilled, tables: tablesWithDrift, pulled };
	}

	// ── Hub-side: row pull ───────────────────────────────────────────────

	private static readonly ROW_PULL_BATCH_SIZE = 100;

	handleRowPullRequest(peerSiteId: string, payload: RowPullRequestPayload): void {
		if (!this.config.isHub) return;

		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return;

		this.config.logger?.debug("[row-pull] Request received", {
			peerSiteId,
			requestId: payload.request_id,
			tables: payload.tables.length,
		});

		this.streamRowPullPages(peerSiteId, payload.request_id, payload.tables, 0, 0);
	}

	private pendingRowPullState = new Map<
		string,
		{
			requestId: string;
			tables: Array<{ table: string; pks: string[] }>;
			tableIndex: number;
			pkOffset: number;
			pendingRows: Array<Record<string, unknown>>;
			pendingRowCursor: number;
			pendingIsLast: boolean;
			pendingTable: string;
		}
	>();

	private streamRowPullPages(
		peerSiteId: string,
		requestId: string,
		tables: Array<{ table: string; pks: string[] }>,
		tableIndex: number,
		pkOffset: number,
	): void {
		const peer = this.peerConnections.get(peerSiteId);
		if (!peer) return;

		if (tableIndex >= tables.length) {
			const frame = encodeFrame(
				WsMessageType.ROW_PULL_RESPONSE,
				{ request_id: requestId, table_name: "", rows: [], last: true },
				peer.symmetricKey,
			);
			peer.sendFrame(frame);
			this.pendingRowPullState.delete(peerSiteId);
			this.config.logger?.debug("[row-pull] Stream complete", { peerSiteId, requestId });
			return;
		}

		const { table, pks } = tables[tableIndex];
		const pkCol = getPkColumn(table);
		const batchSize = WsTransport.ROW_PULL_BATCH_SIZE;
		const batch = pks.slice(pkOffset, pkOffset + batchSize);

		if (batch.length === 0) {
			setTimeout(() => {
				this.streamRowPullPages(peerSiteId, requestId, tables, tableIndex + 1, 0);
			}, 0);
			return;
		}

		const placeholders = batch.map(() => "?").join(", ");
		const rows = this.config.db
			.query(`SELECT * FROM ${table} WHERE ${pkCol} IN (${placeholders})`)
			.all(...batch) as Array<Record<string, unknown>>;

		const nextPkOffset = pkOffset + batchSize;
		const hasMoreInTable = nextPkOffset < pks.length;
		const isLastTable = tableIndex === tables.length - 1;
		const isLast = !hasMoreInTable && isLastTable;

		if (rows.length > 0) {
			this.pendingRowPullState.set(peerSiteId, {
				requestId,
				tables,
				tableIndex,
				pkOffset: nextPkOffset,
				pendingRows: rows,
				pendingRowCursor: 0,
				pendingIsLast: isLast,
				pendingTable: table,
			});
			this.sendRowPullSubChunk(peerSiteId);
			return;
		}

		if (isLast) {
			const frame = encodeFrame(
				WsMessageType.ROW_PULL_RESPONSE,
				{ request_id: requestId, table_name: table, rows: [], last: true },
				peer.symmetricKey,
			);
			peer.sendFrame(frame);
			this.pendingRowPullState.delete(peerSiteId);
			return;
		}

		const nextTableIdx = hasMoreInTable ? tableIndex : tableIndex + 1;
		const nextOffset = hasMoreInTable ? nextPkOffset : 0;
		setTimeout(() => {
			this.streamRowPullPages(peerSiteId, requestId, tables, nextTableIdx, nextOffset);
		}, 0);
	}

	private sendRowPullSubChunk(peerSiteId: string): void {
		const peer = this.peerConnections.get(peerSiteId);
		const state = this.pendingRowPullState.get(peerSiteId);
		if (!peer || !state) return;

		const { pendingRows, pendingRowCursor, pendingIsLast, pendingTable, requestId } = state;
		const remaining = pendingRows.slice(pendingRowCursor);

		if (remaining.length === 0) {
			if (pendingIsLast) {
				this.pendingRowPullState.delete(peerSiteId);
				return;
			}
			const hasMoreInTable = state.pkOffset < state.tables[state.tableIndex].pks.length;
			const nextTableIdx = hasMoreInTable ? state.tableIndex : state.tableIndex + 1;
			const nextOffset = hasMoreInTable ? state.pkOffset : 0;
			this.pendingRowPullState.delete(peerSiteId);
			setTimeout(() => {
				this.streamRowPullPages(peerSiteId, requestId, state.tables, nextTableIdx, nextOffset);
			}, 0);
			return;
		}

		let sliceEnd = remaining.length;
		let frame: Uint8Array | null = null;
		const isLastFrame = pendingIsLast && sliceEnd === remaining.length;

		while (sliceEnd > 0) {
			const slice = remaining.slice(0, sliceEnd);
			const candidate = encodeFrame(
				WsMessageType.ROW_PULL_RESPONSE,
				{
					request_id: requestId,
					table_name: pendingTable,
					rows: slice,
					last: isLastFrame && sliceEnd === remaining.length,
				},
				peer.symmetricKey,
			);
			if (candidate.length <= MAX_CHANGELOG_FRAME_BYTES) {
				frame = candidate;
				break;
			}
			if (sliceEnd === 1) {
				frame = candidate;
				break;
			}
			sliceEnd = Math.max(1, Math.floor(sliceEnd / 2));
		}

		if (!frame) return;

		const sent = peer.sendFrame(frame);
		state.pendingRowCursor += sliceEnd;

		if (!sent) {
			return;
		}

		setTimeout(() => this.sendRowPullSubChunk(peerSiteId), 0);
	}

	continueRowPull(peerSiteId: string): void {
		if (this.pendingRowPullState.has(peerSiteId)) {
			this.sendRowPullSubChunk(peerSiteId);
		}
	}

	handleRowPullAck(peerSiteId: string, _payload: { request_id: string }): void {
		if (!this.config.isHub) return;

		const now = new Date().toISOString();
		const pullHlc = generateHlc(now, null, this.config.siteId);

		updatePeerCursor(this.config.db, peerSiteId, {
			last_received: pullHlc,
			last_sent: pullHlc,
		});

		this.config.logger?.info("[row-pull] ACK received, cursor advanced", {
			peerSiteId,
			pullHlc,
		});

		this.drainChangelog(peerSiteId);
	}

	// ── Spoke-side: row pull request + response ──────────────────────────

	private pendingRowPullRequests = new Map<
		string,
		{
			resolve: () => void;
			reject: (err: Error) => void;
			timer: Timer;
		}
	>();

	requestRowPull(tables: Array<{ table: string; pks: string[] }>): Promise<void> {
		const hubPeer = this.peerConnections.values().next().value as PeerConnection | undefined;
		if (!hubPeer) {
			return Promise.reject(new Error("Not connected to hub"));
		}

		const requestId = `rp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const frame = encodeFrame(
			WsMessageType.ROW_PULL_REQUEST,
			{ request_id: requestId, tables },
			hubPeer.symmetricKey,
		);
		if (!hubPeer.sendFrame(frame)) {
			return Promise.reject(new Error("Failed to send row pull request"));
		}

		this.config.logger?.debug("[row-pull] Request sent", { requestId, tables: tables.length });

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRowPullRequests.delete(requestId);
				reject(new Error("Row pull request timed out (60s)"));
			}, 60_000);
			this.pendingRowPullRequests.set(requestId, { resolve, reject, timer });
		});
	}

	handleRowPullResponse(payload: RowPullResponsePayload): void {
		if (payload.rows.length > 0) {
			applySnapshotRows(this.config.db, payload.table_name, payload.rows, this.config.logger);
		}

		if (payload.col_chunk_row_id && payload.col_chunk_column && payload.col_chunk_data != null) {
			applyColumnChunkFn(
				this.config.db,
				payload.table_name,
				payload.col_chunk_row_id,
				payload.col_chunk_column,
				payload.col_chunk_index ?? 0,
				payload.col_chunk_data,
				this.config.logger,
			);
		}

		if (payload.last) {
			const req = payload.request_id
				? this.pendingRowPullRequests.get(payload.request_id)
				: undefined;
			if (req) {
				clearTimeout(req.timer);
				this.pendingRowPullRequests.delete(payload.request_id);
				req.resolve();
			}
		}
	}

	sendRowPullAck(requestId: string): void {
		const hubPeer = this.peerConnections.values().next().value as PeerConnection | undefined;
		if (!hubPeer) return;

		const frame = encodeFrame(
			WsMessageType.ROW_PULL_ACK,
			{ request_id: requestId },
			hubPeer.symmetricKey,
		);
		hubPeer.sendFrame(frame);
		this.config.logger?.debug("[row-pull] ACK sent", { requestId });
	}
}
