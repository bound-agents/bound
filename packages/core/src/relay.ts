import type { Database } from "bun:sqlite";
import type { RelayInboxEntry, RelayOutboxEntry, TypedEventEmitter } from "@bound/shared";
import { RELAY_KINDS } from "@bound/shared";
import { trace } from "@opentelemetry/api";
import { recordRelayOutboxOperation, withCoreSpan } from "./telemetry";

const MAX_PAYLOAD_BYTES_DEFAULT = 2 * 1024 * 1024;

let relayOutboxEventBus: TypedEventEmitter | null = null;

const MAX_RELAY_ENTRY_COUNT = 10_000;

function boundedRelayKind(kind: string): string {
	return RELAY_KINDS.includes(kind as (typeof RELAY_KINDS)[number]) ? kind : "other";
}

function boundedEntryCount(entryCount: number): number {
	return Math.min(Math.max(Math.floor(entryCount), 0), MAX_RELAY_ENTRY_COUNT);
}

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const TRACESTATE_KEY_PATTERN =
	/^(?:[a-z0-9][_0-9a-z*/-]{0,255}|[a-z0-9][_0-9a-z*/-]{0,240}@[a-z0-9][_0-9a-z*/-]{0,13})$/;

function validTracestate(value: string): boolean {
	if (value.length === 0 || value.length > 512) return false;
	const members = value.split(",");
	if (members.length > 32) return false;
	const seen = new Set<string>();
	for (const member of members) {
		const separator = member.indexOf("=");
		if (separator <= 0) return false;
		const key = member.slice(0, separator).trim();
		const memberValue = member.slice(separator + 1).trim();
		if (!TRACESTATE_KEY_PATTERN.test(key) || seen.has(key)) return false;
		if (memberValue.length === 0 || memberValue.length > 256) return false;
		for (const character of memberValue) {
			const code = character.charCodeAt(0);
			if (code < 0x20 || code > 0x7e || character === "," || character === "=") return false;
		}
		seen.add(key);
	}
	return true;
}

function hasValidTraceContext(value?: string | null): boolean {
	if (!value || value.length > 2048) return false;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "traceparent" && key !== "tracestate"))
			return false;
		if (typeof record.traceparent !== "string") return false;
		const match = TRACEPARENT_PATTERN.exec(record.traceparent);
		if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return false;
		if (record.tracestate !== undefined && typeof record.tracestate !== "string") return false;
		return typeof record.tracestate !== "string" || validTracestate(record.tracestate);
	} catch {
		return false;
	}
}

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
	const carrierState = hasValidTraceContext(entry.trace_context)
		? "extracted"
		: entry.trace_context != null
			? "invalid"
			: trace.getActiveSpan()
				? "active"
				: "absent";
	return withCoreSpan(
		"relay_outbox.operation",
		{
			"relay.trigger": "push-write",
			"relay.path": "outbox.write",
			"relay.direction": "outbound",
			"relay.kind": boundedRelayKind(entry.kind),
			"relay.carrier_state": carrierState,
			"relay.entry_count": 1,
			"relay.persistence.operation": "write",
		},
		(span) => {
			let result: { changes: number };
			try {
				result = db.run(
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
			} catch (error) {
				span.setAttribute?.("relay.persistence.outcome", "failed");
				throw error;
			}

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
				span.setAttribute?.("relay.persistence.outcome", "duplicate");
				span.addEvent?.("relay_outbox.write", { outcome: "duplicate" });
				return false;
			}
			recordRelayOutboxOperation("write", "inserted");
			span.setAttribute?.("relay.persistence.outcome", "inserted");

			// Use module-level eventBus if set, otherwise use passed-in eventBus (for backward compat)
			const bus = eventBus ?? relayOutboxEventBus;
			if (bus) {
				bus.emit("relay:outbox-written", {
					id: entry.id,
					target_site_id: entry.target_site_id,
				});
			}
			span.addEvent?.("relay_outbox.write", { outcome: "inserted" });
			return true;
		},
	);
}

export function readUndelivered(db: Database, targetSiteId?: string): RelayOutboxEntry[] {
	const startedAt = performance.now();
	const carrierState = trace.getActiveSpan() ? "active" : "absent";
	const attributes = {
		"relay.trigger": "connection-drain",
		"relay.path": "outbox.read",
		"relay.direction": "outbound",
		"relay.kind": "batch",
		"relay.carrier_state": carrierState,
		"relay.entry_count": 0,
		"relay.persistence.operation": "read",
	};
	let rows: RelayOutboxEntry[];
	try {
		rows = targetSiteId
			? (db
					.query(
						"SELECT * FROM relay_outbox WHERE delivered = 0 AND target_site_id = ? ORDER BY created_at ASC",
					)
					.all(targetSiteId) as RelayOutboxEntry[])
			: (db
					.query("SELECT * FROM relay_outbox WHERE delivered = 0 ORDER BY created_at ASC")
					.all() as RelayOutboxEntry[]);
	} catch (error) {
		recordRelayOutboxOperation("read", "failed", 1, performance.now() - startedAt);
		return withCoreSpan("relay_outbox.operation", attributes, (span) => {
			span.setAttribute?.("relay.persistence.outcome", "failed");
			throw error;
		});
	}

	const outcome = rows.length > 0 ? "hit" : "miss";
	recordRelayOutboxOperation("read", outcome, 1, performance.now() - startedAt);
	if (rows.length === 0 && carrierState === "absent") return rows;

	return withCoreSpan("relay_outbox.operation", attributes, (span) => {
		span.setAttribute?.("relay.entry_count", boundedEntryCount(rows.length));
		span.setAttribute?.("relay.persistence.outcome", outcome);
		span.addEvent?.("relay_outbox.read", { entry_count: rows.length });
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

// ── Legacy relay-table retirement (slice 4E) ─────────────────────────────
//
// The durable_work spool is the local-only work store; relay_outbox/relay_inbox
// are transitional and dropped per-host once every live peer advertises spool
// support (R-DW14) and this host's own legacy tables are empty. The drop is a
// one-way, per-host event: a spoke that dropped records the fact in local_flags
// so every legacy code path early-returns instead of touching a table that no
// longer exists on THIS host. See
// docs/design/specs/2026-08-31-durable-work-consolidation.md §7 and #253.

/** local_flags key set once this host drops its legacy relay tables. */
export const LEGACY_RELAY_DROPPED_FLAG = "relay_legacy_tables_dropped";

/**
 * Per-process memo of the one-way drop marker, keyed by db handle. The drop is
 * irreversible, so once a given db reads the marker as set we can cache `true`
 * forever for that handle and skip the local_flags PK lookup on the hot legacy
 * paths that guard on it. Keyed by the Database object (not a process-global
 * boolean) because a single process routinely holds many independent DBs
 * (every in-memory test DB, spoke + hub in cluster tests); a global would leak
 * one DB's retirement onto another. We only ever cache the `true` state — a
 * handle absent from the map falls through to a live read, so a fresh DB is
 * never wrongly reported retired. `dropLegacyRelayTables` primes this on the
 * handle that performs the drop.
 */
const droppedMarkerCache = new WeakMap<Database, true>();

/** Record that `db` has retired its legacy relay tables (one-way). */
function markDroppedInCache(db: Database): void {
	droppedMarkerCache.set(db, true);
}

/**
 * Whether this host has retired its legacy relay tables. Reads local_flags —
 * a non-synced, per-host table — so the answer reflects THIS host only. A
 * dropped host must never touch relay_outbox/relay_inbox again; callers guard
 * every legacy read/write on this. Cheap enough to call on hot legacy paths
 * (memoized after the first `true`, else a single indexed PK lookup); returns
 * false on a synthetic DB lacking the table. The memo only caches `true`, so a
 * not-yet-dropped host keeps reading live until the drop lands.
 */
export function hasDroppedLegacyRelayTables(db: Database): boolean {
	if (droppedMarkerCache.has(db)) return true;
	try {
		const row = db
			.query("SELECT value FROM local_flags WHERE key = ?")
			.get(LEGACY_RELAY_DROPPED_FLAG) as { value: string } | null;
		const dropped = row?.value === "1";
		if (dropped) markDroppedInCache(db);
		return dropped;
	} catch {
		return false;
	}
}

/** Count of rows remaining in a legacy relay table, or null if the table is absent (already dropped). */
function countLegacyRelayRows(db: Database, table: "relay_outbox" | "relay_inbox"): number | null {
	try {
		const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
			count: number;
		} | null;
		return row?.count ?? 0;
	} catch {
		return null; // table dropped
	}
}

/** True IFF both legacy relay tables exist and hold zero rows (not merely zero undelivered/unprocessed). */
export function legacyRelayTablesEmpty(db: Database): boolean {
	const outbox = countLegacyRelayRows(db, "relay_outbox");
	const inbox = countLegacyRelayRows(db, "relay_inbox");
	// A dropped table (null) counts as "empty" — nothing left to observe.
	return (outbox === null || outbox === 0) && (inbox === null || inbox === 0);
}

/**
 * Physically drop this host's legacy relay tables and record the one-way marker,
 * all under one BEGIN IMMEDIATE so a crash can never leave the tables dropped
 * without the marker (which would let legacy paths hit a missing table) or the
 * marker set with tables intact. `relay_outbox`/`relay_inbox` are local-only
 * (invariant #3), so DROP TABLE has no sync impact and routes through the
 * sanctioned raw-write bypass. `relay_cycles` is telemetry and is NOT dropped.
 *
 * TOCTOU guard (demolition permit): the emptiness gate in the caller runs
 * OUTSIDE any transaction, so a legacy writer could insert between that check
 * and the BEGIN IMMEDIATE write lock. This function RE-VERIFIES both tables
 * hold zero rows AFTER the write lock is held and BEFORE the DROP statements; a
 * non-empty recheck rolls back and returns false (no drop, no marker) so the
 * would-be-destroyed row survives and the caller retries next pass. The drop is
 * irreversible, so a false negative (skip a legitimate drop) is cheap while a
 * false positive (destroy a live row) is unrecoverable.
 *
 * Idempotent: a second call is a no-op once the marker is set. Returns true if
 * this call performed the drop.
 */
export function dropLegacyRelayTables(db: Database, reason: string): boolean {
	if (!reason || reason.trim().length === 0) {
		throw new Error("dropLegacyRelayTables: a non-empty reason is required");
	}
	if (hasDroppedLegacyRelayTables(db)) return false;
	db.exec("BEGIN IMMEDIATE");
	try {
		// Re-verify emptiness under the write lock — the outer gate is racy.
		const outboxCount = (
			db.query("SELECT COUNT(*) AS count FROM relay_outbox").get() as { count: number }
		).count;
		const inboxCount = (
			db.query("SELECT COUNT(*) AS count FROM relay_inbox").get() as { count: number }
		).count;
		if (outboxCount > 0 || inboxCount > 0) {
			// A row snuck in after the outer check. Abort the drop entirely.
			db.exec("ROLLBACK");
			return false;
		}
		db.run("DROP TABLE IF EXISTS relay_outbox");
		db.run("DROP TABLE IF EXISTS relay_inbox");
		db.run("INSERT OR REPLACE INTO local_flags (key, value, set_at) VALUES (?, '1', ?)", [
			LEGACY_RELAY_DROPPED_FLAG,
			new Date().toISOString(),
		]);
		db.exec("COMMIT");
		markDroppedInCache(db);
		return true;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* original error wins */
		}
		throw error;
	}
}
