import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayOutboxEntry, TypedEventEmitter } from "@bound/shared";
import { recordRelayOutboxOperation, withCoreSpan } from "./telemetry";

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
): boolean {
	if (!entry.source_site_id) {
		throw new Error("writeOutbox: source_site_id is required for relay routing");
	}
	enforcePayloadLimit(entry.payload, maxPayloadBytes);
	// INSERT OR IGNORE: when the primary key `id` matches an existing row, OR
	// when idempotency_key + target_site_id matches an existing row (via
	// idx_relay_outbox_idempotency), the duplicate is silently discarded.
	// Entries with NULL idempotency_key are never deduplicated by idempotency
	// (partial index excludes NULLs), but PK conflicts on `id` still ignore.
	return withCoreSpan("relay_outbox.operation", (span) => {
		const result = db.run(
			`INSERT OR IGNORE INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, created_at, expires_at, delivered, trace_context)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
				entry.trace_context ?? null,
			],
		);

		// Emit event ONLY when a new row was actually inserted. Emitting on a
		// no-op INSERT-OR-IGNORE creates an infinite synchronous recursion when
		// the listener calls back into writeOutbox with the same id (e.g. the
		// hub-side offline-async-buffer path in WsTransport.handleRelaySend, which
		// re-buffers an entry that's already in relay_outbox). The Node
		// EventEmitter is synchronous, so duplicate emits stack-recurse until V8
		// throws RangeError.
		//
		// Returns whether a row was actually inserted (mirrors insertInbox), so
		// callers using per-event idempotency keys can gate dependent writes on
		// the dedupe outcome (e.g. deliverBatch skips the developer message for a
		// crash-replayed event the outbox already carries).
		if (result.changes === 0) {
			recordRelayOutboxOperation("write", "duplicate");
			return false;
		}
		recordRelayOutboxOperation("write", "inserted");

		// Use module-level eventBus if set, otherwise use passed-in eventBus (for backward compat)
		const bus = eventBus ?? relayOutboxEventBus;
		if (bus) {
			bus.emit("relay:outbox-written", {
				id: entry.id,
				target_site_id: entry.target_site_id,
			});
		}
		span.addEvent("relay_outbox.write", { outcome: "inserted" });
		return true;
	});
}

export function readUndelivered(db: Database, targetSiteId?: string): RelayOutboxEntry[] {
	return withCoreSpan("relay_outbox.operation", (span) => {
		const rows = targetSiteId
			? (db
					.query(
						"SELECT * FROM relay_outbox WHERE delivered = 0 AND target_site_id = ? ORDER BY created_at ASC",
					)
					.all(targetSiteId) as RelayOutboxEntry[])
			: (db
					.query("SELECT * FROM relay_outbox WHERE delivered = 0 ORDER BY created_at ASC")
					.all() as RelayOutboxEntry[]);
		recordRelayOutboxOperation("read", rows.length > 0 ? "hit" : "miss");
		span.addEvent("relay_outbox.read", { entry_count: rows.length });
		return rows;
	});
}

export function markDelivered(db: Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	const result = db.run(
		`UPDATE relay_outbox SET delivered = 1 WHERE delivered = 0 AND id IN (${placeholders})`,
		ids,
	);
	if (result.changes > 0) recordRelayOutboxOperation("ack", "delivered", result.changes);
}

export function markDeliveredForTarget(db: Database, ids: string[], targetSiteId: string): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(", ");
	const result = db.run(
		`UPDATE relay_outbox SET delivered = 1 WHERE delivered = 0 AND id IN (${placeholders}) AND target_site_id = ?`,
		[...ids, targetSiteId],
	);
	if (result.changes > 0) recordRelayOutboxOperation("ack", "delivered", result.changes);
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
		`INSERT OR IGNORE INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed, trace_context)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
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
			entry.trace_context ?? null,
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
 *
 * The optional `kind` filter restricts results to a specific relay kind. The
 * scheduler's event-task wakeup path passes `kind="webhook_intake"` to ensure
 * it only folds rows that the webhook handler wrote — without the filter,
 * stray rows of other kinds (e.g. platform-MCP `intake` with a totally
 * different payload schema) sharing a `ref_id` would be opaquely re-emitted
 * as if they were webhook envelopes. Callers that genuinely need every
 * unprocessed row regardless of kind may omit the filter.
 */
export function readUnprocessedInboxByRefId(
	db: Database,
	refId: string,
	kind?: string,
): RelayInboxEntry[] {
	if (kind === undefined) {
		return db
			.query(
				"SELECT * FROM relay_inbox WHERE ref_id = ? AND processed = 0 ORDER BY received_at ASC",
			)
			.all(refId) as RelayInboxEntry[];
	}
	return db
		.query(
			"SELECT * FROM relay_inbox WHERE ref_id = ? AND processed = 0 AND kind = ? ORDER BY received_at ASC",
		)
		.all(refId, kind) as RelayInboxEntry[];
}

/**
 * One stale-intake group: all unprocessed inbox rows of a given kind that share
 * a `ref_id` and were received before a staleness cutoff. `oldest_received_at`
 * is the earliest row's timestamp, so a caller can report how long the binding
 * has been dark.
 */
export interface StaleIntakeGroup {
	ref_id: string;
	kind: string;
	count: number;
	oldest_received_at: string;
}

/**
 * Finds unprocessed inbox rows of `kind` whose `received_at` predates
 * `staleBeforeIso`, grouped by `ref_id`. This is the dead-letter signal for the
 * webhook intake pipeline: a healthy event handler drains its `webhook_intake`
 * rows the moment it runs (markProcessed via buildEventWakeupContent), so a row
 * that stays unprocessed past the staleness window means the bound handler is
 * dark — cancelled, evicted-to-failed, declined by an incapable host, or lost to
 * a deploy gap. We don't try to attribute the cause here; the unprocessed-and-old
 * condition is sufficient to raise a catch-of-last-resort advisory, since the
 * intake itself is durable (7-day TTL) and any revived handler bound to the same
 * thread drains the backlog. Rows with a null `ref_id` are skipped — they cannot
 * be tied back to a handler thread.
 *
 * ISO-8601 timestamps sort lexically, so the `received_at < ?` comparison is a
 * plain string compare (no SQLite `datetime()` coercion — see gotchas).
 */
export function findStaleUnprocessedIntake(
	db: Database,
	kind: string,
	staleBeforeIso: string,
): StaleIntakeGroup[] {
	return db
		.query(
			`SELECT ref_id, kind, COUNT(*) AS count, MIN(received_at) AS oldest_received_at
			 FROM relay_inbox
			 WHERE processed = 0 AND kind = ? AND ref_id IS NOT NULL AND received_at < ?
			 GROUP BY ref_id
			 ORDER BY oldest_received_at ASC`,
		)
		.all(kind, staleBeforeIso) as StaleIntakeGroup[];
}

export function readInboxByStreamId(db: Database, streamId: string): RelayInboxEntry[] {
	return db
		.query(
			"SELECT * FROM relay_inbox WHERE stream_id = ? AND processed = 0 ORDER BY received_at ASC",
		)
		.all(streamId) as RelayInboxEntry[];
}
