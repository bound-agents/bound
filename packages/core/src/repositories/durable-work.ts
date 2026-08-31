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
