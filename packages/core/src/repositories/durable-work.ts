import type { Database } from "bun:sqlite";
import type { DurableWorkInspectionRow, DurableWorkRow } from "../durable-work";

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
