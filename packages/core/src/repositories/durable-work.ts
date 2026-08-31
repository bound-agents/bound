import type { Database } from "bun:sqlite";
import { RELAY_RESPONSE_KINDS } from "@bound/shared";
import {
	type DurableWorkInspectionRow,
	type DurableWorkRow,
	LOCAL_WORK_TARGET,
} from "../durable-work";

export function listDurableWorkForInspection(
	db: Database,
	staleBefore: string,
): DurableWorkInspectionRow[] {
	return db
		.query(
			`SELECT *, CAST((julianday('now') - julianday(created_at)) * 86400000 AS INTEGER) AS age_ms
			 FROM durable_work
			 WHERE claim_state = 'dead_letter'
			    OR (claim_state IN ('pending', 'processing') AND created_at <= ?)
			 ORDER BY created_at ASC`,
		)
		.all(staleBefore) as DurableWorkInspectionRow[];
}

export function getDurableWork(db: Database, id: string): DurableWorkRow | null {
	return db.query("SELECT * FROM durable_work WHERE id = ?").get(id) as DurableWorkRow | null;
}

export function listDeadLetterDurableWork(db: Database, kind: string): DurableWorkRow[] {
	return db
		.query(
			"SELECT * FROM durable_work WHERE kind = ? AND claim_state = 'dead_letter' ORDER BY created_at",
		)
		.all(kind) as DurableWorkRow[];
}

const PASSIVE_INTAKE_KINDS = ["webhook_intake", "rss_intake", "connector_intake"] as const;

/**
 * 4D-D union-await consumer readers. An awaiting requester (relay-wait$ /
 * relay-stream$) reads the UNION of legacy relay_inbox response rows and pending
 * durable_work response rows targeted at self, then consumes each durable row
 * exactly-once via the token-fenced claim/ack lifecycle. Response rows arrive
 * over 4D-B SPOOL_TRANSFER as fresh PENDING rows on this host, targeted at self
 * (`target_site_id = ownSiteId`) and carrying the request's `ref_id` (for
 * scalar responses) or `stream_id` (for chunks). Both readers scope strictly to
 * `dispatch: "response"` kinds so a durable REQUEST or cancel sharing the same
 * correlation id is never mistaken for a response. See
 * docs/design/specs/2026-08-31-durable-work-consolidation.md (R-DW10, R-DW13).
 */
const RESPONSE_KIND_PLACEHOLDERS = RELAY_RESPONSE_KINDS.map(() => "?").join(", ");

/**
 * Earliest pending durable response row targeted at self for `refId`, mirroring
 * {@link readInboxByRefId}. Ordered oldest-first (created_at) so a redelivered
 * response and its original resolve deterministically to the same row identity.
 */
export function readDurableResponseByRefId(
	db: Database,
	refId: string,
	ownSiteId: string,
): DurableWorkRow | null {
	return db
		.query(
			`SELECT * FROM durable_work
			 WHERE ref_id = ? AND target_site_id = ? AND claim_state = 'pending'
			   AND kind IN (${RESPONSE_KIND_PLACEHOLDERS})
			 ORDER BY created_at ASC LIMIT 1`,
		)
		.get(refId, ownSiteId, ...RELAY_RESPONSE_KINDS) as DurableWorkRow | null;
}

/**
 * All pending durable response rows targeted at self for `streamId`, oldest
 * first, mirroring {@link readInboxByStreamId}. The relay-stream$ reducer folds
 * these into the same seq-dedup buffer as legacy inbox chunk rows.
 */
export function readDurableResponsesByStreamId(
	db: Database,
	streamId: string,
	ownSiteId: string,
): DurableWorkRow[] {
	return db
		.query(
			`SELECT * FROM durable_work
			 WHERE stream_id = ? AND target_site_id = ? AND claim_state = 'pending'
			   AND kind IN (${RESPONSE_KIND_PLACEHOLDERS})
			 ORDER BY created_at ASC`,
		)
		.all(streamId, ownSiteId, ...RELAY_RESPONSE_KINDS) as DurableWorkRow[];
}

export interface StalePendingIntakeDurableWorkGroup {
	ref_id: string;
	kind: string;
	count: number;
	oldest_received_at: string;
}

/**
 * Finds pending passive-intake durable work older than the recovery threshold,
 * grouped by the binding thread. `received_at` is the source-event timestamp;
 * pre-provenance rows use `created_at` as their recovery age.
 */
export function findStalePendingIntakeDurableWork(
	db: Database,
	kind: string,
	staleBeforeIso: string,
): StalePendingIntakeDurableWorkGroup[] {
	return db
		.query(
			`SELECT ref_id, kind, COUNT(*) AS count,
			        MIN(COALESCE(received_at, created_at)) AS oldest_received_at
			 FROM durable_work
			 WHERE claim_state = 'pending' AND kind = ? AND ref_id IS NOT NULL
			   AND COALESCE(received_at, created_at) < ?
			 GROUP BY ref_id
			 ORDER BY oldest_received_at ASC`,
		)
		.all(kind, staleBeforeIso) as StalePendingIntakeDurableWorkGroup[];
}

export function listPendingIntakeDurableWork(
	db: Database,
	kind: string,
	refId: string,
): DurableWorkRow[] {
	return db
		.query(
			`SELECT * FROM durable_work WHERE kind = ? AND ref_id = ? AND claim_state = 'pending' ORDER BY COALESCE(received_at, created_at) ASC`,
		)
		.all(kind, refId) as DurableWorkRow[];
}

export function listPendingIntakeDurableWorkForRef(db: Database, refId: string): DurableWorkRow[] {
	return db
		.query(
			`SELECT * FROM durable_work WHERE ref_id = ? AND kind IN (${PASSIVE_INTAKE_KINDS.map(() => "?").join(", ")}) AND claim_state = 'pending' ORDER BY COALESCE(received_at, created_at) ASC`,
		)
		.all(refId, ...PASSIVE_INTAKE_KINDS) as DurableWorkRow[];
}

export function findDurableWorkByKindAndIdempotencyKeys(
	db: Database,
	pairs: readonly (readonly [string, string])[],
): DurableWorkRow[] {
	if (pairs.length === 0) return [];
	const where = pairs.map(() => "(kind = ? AND idempotency_key = ?)").join(" OR ");
	return db
		.query(`SELECT * FROM durable_work WHERE ${where}`)
		.all(...pairs.flat()) as DurableWorkRow[];
}

export function countPendingIntakeDurableWork(db: Database, refId: string): number {
	return (
		db
			.query(
				`SELECT COUNT(*) AS count FROM durable_work WHERE ref_id = ? AND kind IN (${PASSIVE_INTAKE_KINDS.map(() => "?").join(", ")}) AND claim_state = 'pending'`,
			)
			.get(refId, ...PASSIVE_INTAKE_KINDS) as { count: number }
	).count;
}

/**
 * Count peer-targeted rows that must drain before a hub switch: pending rows and
 * transferring rows whose sender copies remain durable until receiver acknowledgement.
 * Excludes LOCAL_WORK_TARGET sentinel rows (in-process dispatch wakeups) — they
 * never transfer, so they must not block a hub switch.
 */
export function countPendingPeerTargetedDurableWork(db: Database, ownSiteId: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS count FROM durable_work WHERE target_site_id != ? AND target_site_id != ? AND claim_state IN ('pending', 'transferring')",
			)
			.get(ownSiteId, LOCAL_WORK_TARGET) as { count: number }
	).count;
}
