import type { Database } from "bun:sqlite";
import { PASSIVE_INTAKE_KINDS, RELAY_RESPONSE_KINDS } from "@bound/shared";
import { type NotNull, sql } from "kysely";
import {
	type DurableWorkClaimState,
	type DurableWorkInspectionRow,
	type DurableWorkRow,
	LOCAL_WORK_TARGET,
} from "../durable-work";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** `DurableWorkRow.claim_state` is the closed state union; the column is plain TEXT. */
const fullDurableWorkRows = () =>
	queryBuilder
		.selectFrom("durable_work")
		.selectAll()
		.$narrowType<{ claim_state: DurableWorkClaimState }>();

export function listDurableWorkForInspection(
	db: Database,
	staleBefore: string,
): DurableWorkInspectionRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.select(
				sql<number>`CAST((julianday('now') - julianday(created_at)) * 86400000 AS INTEGER)`.as(
					"age_ms",
				),
			)
			.where((eb) =>
				eb.or([
					eb("claim_state", "=", "dead_letter"),
					eb.and([
						eb("claim_state", "in", ["pending", "processing"]),
						eb("created_at", "<=", staleBefore),
					]),
					eb.and([
						eb("claim_state", "=", "transferring"),
						eb("claimed_at", "is not", null),
						eb("claimed_at", "<=", staleBefore),
					]),
				]),
			)
			.orderBy("created_at", "asc"),
	);
}

export function getDurableWork(db: Database, id: string): DurableWorkRow | null {
	return getOne(db, fullDurableWorkRows().where("id", "=", id));
}

export function listDeadLetterDurableWork(db: Database, kind: string): DurableWorkRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.where("kind", "=", kind)
			.where("claim_state", "=", "dead_letter")
			.orderBy("created_at"),
	);
}

/**
 * Earliest pending durable response row targeted at self for `refId`. Ordered
 * oldest-first so a redelivered response and its original resolve
 * deterministically to the same row identity. Scoped to `dispatch: "response"`
 * kinds so a request or cancel sharing the correlation id is never mistaken for
 * a response (R-DW10, R-DW13).
 */
export function readDurableResponseByRefId(
	db: Database,
	refId: string,
	ownSiteId: string,
): DurableWorkRow | null {
	return getOne(
		db,
		fullDurableWorkRows()
			.where("ref_id", "=", refId)
			.where("target_site_id", "in", [ownSiteId, LOCAL_WORK_TARGET])
			.where("claim_state", "=", "pending")
			.where("kind", "in", RELAY_RESPONSE_KINDS)
			.orderBy("created_at", "asc")
			.limit(1),
	);
}

/** All pending durable response rows targeted at self for `streamId`, oldest first. */
export function readDurableResponsesByStreamId(
	db: Database,
	streamId: string,
	ownSiteId: string,
): DurableWorkRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.where("stream_id", "=", streamId)
			.where("target_site_id", "in", [ownSiteId, LOCAL_WORK_TARGET])
			.where("claim_state", "=", "pending")
			.where("kind", "in", RELAY_RESPONSE_KINDS)
			.orderBy("created_at", "asc"),
	);
}

/**
 * All pending durable REQUEST rows of `kind` targeted at self for `streamId`,
 * oldest first. Multipart inference rides `inference_part` request rows keyed by
 * `stream_id = request_id`; {@link readDurableResponsesByStreamId} filters
 * {@link RELAY_RESPONSE_KINDS} and physically cannot see request kinds, so
 * `handleInferencePart` reassembles the split payload through this reader. The
 * caller passes the concrete request kind (`inference_part`) so a response row
 * sharing the same `stream_id` is never mistaken for a part.
 */
export function readDurablePartsByStreamId(
	db: Database,
	streamId: string,
	ownSiteId: string,
	kind: string,
): DurableWorkRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.where("stream_id", "=", streamId)
			.where("target_site_id", "in", [ownSiteId, LOCAL_WORK_TARGET])
			.where("claim_state", "in", ["pending", "processing"])
			.where("kind", "=", kind)
			.orderBy("created_at", "asc"),
	);
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
	const receivedOrCreated = sql<string>`COALESCE(received_at, created_at)`;
	return getAll(
		db,
		queryBuilder
			.selectFrom("durable_work")
			.select((eb) => [
				"ref_id",
				"kind",
				eb.fn.countAll<number>().as("count"),
				eb.fn.min<string>(receivedOrCreated).as("oldest_received_at"),
			])
			.where("claim_state", "=", "pending")
			.where("kind", "=", kind)
			.where("ref_id", "is not", null)
			.where(receivedOrCreated, "<", staleBeforeIso)
			.groupBy("ref_id")
			.orderBy("oldest_received_at", "asc")
			.$narrowType<{ ref_id: NotNull }>(),
	);
}

export function listPendingIntakeDurableWork(
	db: Database,
	kind: string,
	refId: string,
): DurableWorkRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.where("kind", "=", kind)
			.where("ref_id", "=", refId)
			.where("claim_state", "=", "pending")
			.orderBy(sql`COALESCE(received_at, created_at)`, "asc"),
	);
}

export function listPendingIntakeDurableWorkForRef(db: Database, refId: string): DurableWorkRow[] {
	return getAll(
		db,
		fullDurableWorkRows()
			.where("ref_id", "=", refId)
			.where("kind", "in", PASSIVE_INTAKE_KINDS)
			.where("claim_state", "=", "pending")
			.orderBy(sql`COALESCE(received_at, created_at)`, "asc"),
	);
}

export function countPendingIntakeDurableWork(db: Database, refId: string): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("durable_work")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("ref_id", "=", refId)
			.where("kind", "in", PASSIVE_INTAKE_KINDS)
			.where("claim_state", "=", "pending"),
	);
	return row?.count ?? 0;
}

/**
 * Count peer-targeted rows that must drain before a hub switch: pending rows and
 * transferring rows whose sender copies remain durable until receiver acknowledgement.
 * Excludes LOCAL_WORK_TARGET sentinel rows (in-process dispatch wakeups) — they
 * never transfer, so they must not block a hub switch.
 */
export function countPendingPeerTargetedDurableWork(db: Database, ownSiteId: string): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("durable_work")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("target_site_id", "!=", ownSiteId)
			.where("target_site_id", "!=", LOCAL_WORK_TARGET)
			.where("claim_state", "in", ["pending", "transferring"]),
	);
	return row?.count ?? 0;
}
