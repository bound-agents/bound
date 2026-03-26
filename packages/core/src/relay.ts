import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";

const MAX_PAYLOAD_BYTES_DEFAULT = 2 * 1024 * 1024;

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
): void {
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	db.run(
		`INSERT INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, created_at, expires_at, delivered)
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
		.query(
			"SELECT * FROM relay_inbox WHERE ref_id = ? AND processed = 0 ORDER BY received_at ASC LIMIT 1",
		)
		.get(refId) as RelayInboxEntry | null;
}

export function readInboxByStreamId(db: Database, streamId: string): RelayInboxEntry[] {
	return db
		.query(
			"SELECT * FROM relay_inbox WHERE stream_id = ? AND processed = 0 ORDER BY received_at ASC",
		)
		.all(streamId) as RelayInboxEntry[];
}
