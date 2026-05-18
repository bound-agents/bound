import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayOutboxEntry, TypedEventEmitter } from "@bound/shared";

const MAX_PAYLOAD_BYTES_DEFAULT = 2 * 1024 * 1024;

let relayOutboxEventBus: TypedEventEmitter | null = null;

/**
 * Set the event bus for relay:outbox-written events.
 * Called at startup to enable push-on-write for relay entries.
 */
export function setRelayOutboxEventBus(eventBus: TypedEventEmitter): void {
	relayOutboxEventBus = eventBus;
}

export class PayloadTooLargeError extends Error {
	constructor(size: number, limit: number) {
		super(`Relay payload size ${size} exceeds limit ${limit}`);
		this.name = "PayloadTooLargeError";
	}
}

function enforcePayloadLimit(payload: string, maxBytes: number): void {
	const size = new TextEncoder().encode(payload).byteLength;
	if (size > maxBytes) {
		throw new PayloadTooLargeError(size, maxBytes);
	}
}

export function writeOutbox(
	db: Database,
	entry: Omit<RelayOutboxEntry, "delivered">,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
	eventBus?: TypedEventEmitter,
): void {
	if (!entry.source_site_id) {
		throw new Error("writeOutbox: source_site_id is required for relay routing");
	}
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	// INSERT OR IGNORE: when the primary key `id` matches an existing row, OR
	// when idempotency_key + target_site_id matches an existing row (via
	// idx_relay_outbox_idempotency), the duplicate is silently discarded.
	// Entries with NULL idempotency_key are never deduplicated by idempotency
	// (partial index excludes NULLs), but PK conflicts on `id` still ignore.
	const result = db.run(
		`INSERT OR IGNORE INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, created_at, expires_at, delivered)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.target_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.stream_id,
			entry.payload,
			entry.created_at,
			entry.expires_at,
		],
	);

	// Emit event ONLY when a new row was actually inserted. Emitting on a
	// no-op INSERT-OR-IGNORE creates an infinite synchronous recursion when
	// the listener calls back into writeOutbox with the same id (e.g. the
	// hub-side offline-async-buffer path in WsTransport.handleRelaySend, which
	// re-buffers an entry that's already in relay_outbox). The Node
	// EventEmitter is synchronous, so duplicate emits stack-recurse until V8
	// throws RangeError around depth ~5000 — observed in production as
	// 286k log lines / 99.3% of total log volume in a 26-minute window, with
	// the hub crash-restarting 35 times.
	//
	// Correct semantic: "a new outbox row was added, please route it." A
	// no-op INSERT means no work to do — silently no-op the emit too.
	if (result.changes === 0) return;

	// Use module-level eventBus if set, otherwise use passed-in eventBus (for backward compat)
	const bus = eventBus ?? relayOutboxEventBus;
	if (bus) {
		bus.emit("relay:outbox-written", {
			id: entry.id,
			target_site_id: entry.target_site_id,
		});
	}
}

export function readUndelivered(db: Database, targetSiteId?: string): RelayOutboxEntry[] {
	if (targetSiteId) {
		return db
			.query(
				"SELECT * FROM relay_outbox WHERE delivered = 0 AND target_site_id = ? ORDER BY created_at ASC",
			)
			.all(targetSiteId) as RelayOutboxEntry[];
	}
	return db
		.query("SELECT * FROM relay_outbox WHERE delivered = 0 ORDER BY created_at ASC")
		.all() as RelayOutboxEntry[];
}

export function markDelivered(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	db.run(`UPDATE relay_outbox SET delivered = 1 WHERE id IN (${placeholders})`, ids);
}

export function readUnprocessed(db: Database): RelayInboxEntry[] {
	return db
		.query("SELECT * FROM relay_inbox WHERE processed = 0 ORDER BY received_at ASC")
		.all() as RelayInboxEntry[];
}

export function insertInbox(
	db: Database,
	entry: RelayInboxEntry,
	maxPayloadBytes: number = MAX_PAYLOAD_BYTES_DEFAULT,
): boolean {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	const result = db.run(
		`INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		[
			entry.id,
			entry.source_site_id,
			entry.kind,
			entry.ref_id,
			entry.idempotency_key,
			entry.stream_id,
			entry.payload,
			entry.expires_at,
			entry.received_at,
		],
	);
	return result.changes > 0;
}

export function markProcessed(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	db.run(`UPDATE relay_inbox SET processed = 1 WHERE id IN (${placeholders})`, ids);
}

export function pruneRelayTables(
	db: Database,
	retentionSeconds = 300,
): { outboxPruned: number; inboxPruned: number } {
	const cutoff = new Date(Date.now() - retentionSeconds * 1000).toISOString();

	const outboxResult = db.run("DELETE FROM relay_outbox WHERE delivered = 1 AND created_at < ?", [
		cutoff,
	]);
	const inboxResult = db.run("DELETE FROM relay_inbox WHERE processed = 1 AND received_at < ?", [
		cutoff,
	]);

	return {
		outboxPruned: outboxResult.changes,
		inboxPruned: inboxResult.changes,
	};
}

export function readInboxByRefId(db: Database, refId: string): RelayInboxEntry | null {
	return db
		.query("SELECT * FROM relay_inbox WHERE ref_id = ? ORDER BY received_at ASC LIMIT 1")
		.get(refId) as RelayInboxEntry | null;
}

/**
 * Returns ALL unprocessed inbox entries for a given ref_id (e.g. a thread_id),
 * oldest first. Used by the event-task wakeup path to drain pending webhook
 * envelopes (or other intake payloads) into the agent context — `readInboxByRefId`
 * only returns the earliest single entry, which is the wrong shape when multiple
 * events have queued up between scheduler runs.
 */
export function readUnprocessedInboxByRefId(db: Database, refId: string): RelayInboxEntry[] {
	return db
		.query("SELECT * FROM relay_inbox WHERE ref_id = ? AND processed = 0 ORDER BY received_at ASC")
		.all(refId) as RelayInboxEntry[];
}

export function readInboxByStreamId(db: Database, streamId: string): RelayInboxEntry[] {
	return db
		.query(
			"SELECT * FROM relay_inbox WHERE stream_id = ? AND processed = 0 ORDER BY received_at ASC",
		)
		.all(streamId) as RelayInboxEntry[];
}
